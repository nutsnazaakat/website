import * as bcrypt from 'bcrypt';
import type { DataSource, EntityManager } from 'typeorm';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { UserRole } from '../../entities/enums';
import { requireValue } from './seed-context';
import { assertSeedableEnvironment } from './seedable-environment';

/**
 * The three fixture accounts from `frontend/src/mocks/users.ts`, now with real password
 * hashes so they can actually sign in, plus the address book from
 * `frontend/src/mocks/addresses.ts` and the company profile that gives `b2b@demo.in` bulk
 * access.
 *
 * The password is deliberately a single obvious development value, and `seedUsers` refuses to
 * run unless `NODE_ENV` is positively one of `SEEDABLE_ENVIRONMENTS` — seeding a known credential
 * into a live database is exactly the kind of accident this guard exists to prevent, and an
 * allowlist is what makes an unset or misspelled value refuse rather than proceed.
 *
 * Names and phone numbers are the mock's, not the placeholder ones an earlier draft of the
 * plan carried. They have to be: every address row and every order's `addressSnapshot` in
 * these mocks says "Asha Rao" / "Rakesh Anand" on the phone numbers below, so a different
 * `User.name` or `User.phone` would leave the seeded database disagreeing with itself.
 */
const DEV_PASSWORD = 'Password123!';

interface UserFixture {
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  createdAt: Date;
}

const USER_FIXTURES: UserFixture[] = [
  {
    name: 'Asha Rao',
    email: 'b2c@demo.in',
    phone: '9876543210',
    role: UserRole.CUSTOMER,
    createdAt: new Date('2025-11-04T09:12:00.000Z'),
  },
  {
    name: 'Rakesh Anand',
    email: 'b2b@demo.in',
    phone: '9845012345',
    role: UserRole.BUSINESS,
    createdAt: new Date('2025-06-18T05:40:00.000Z'),
  },
  {
    name: 'Nazaakat Admin',
    email: 'admin@demo.in',
    phone: '9811100011',
    role: UserRole.ADMIN,
    createdAt: new Date('2025-01-09T04:00:00.000Z'),
  },
];

interface AddressFixture {
  email: string;
  label: string;
  isDefault: boolean;
  fullName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

/**
 * The three rows from `addressBook` in `frontend/src/mocks/addresses.ts`, flattened out of the
 * mock's keyed-by-email shape.
 *
 * Exactly one address per user carries `isDefault`, which the partial unique index
 * `uq_addresses_one_default_per_user` requires — a second default for the same user is a
 * database error, not a last-write-wins.
 */
const ADDRESS_FIXTURES: AddressFixture[] = [
  {
    email: 'b2c@demo.in',
    label: 'Home',
    isDefault: true,
    fullName: 'Asha Rao',
    phone: '9876543210',
    line1: '12 Residency Road',
    line2: 'Near Mayo Hall',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560025',
  },
  {
    email: 'b2c@demo.in',
    label: 'Office',
    isDefault: false,
    fullName: 'Asha Rao',
    phone: '9876543210',
    line1: '4th Floor, Prestige Atrium, Central Street',
    line2: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
  },
  {
    email: 'b2b@demo.in',
    label: 'Warehouse',
    isDefault: true,
    fullName: 'Rakesh Anand',
    phone: '9845012345',
    line1: 'Unit 7, Peenya Industrial Area, Phase II',
    line2: 'Goods entrance on the rear road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560058',
  },
];

/** The `company` block on `b2b@demo.in` in `frontend/src/mocks/users.ts`. Brief §19. */
const BUSINESS_FIXTURE = {
  email: 'b2b@demo.in',
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  gstin: '29ABCDE1234F1Z5',
  businessType: 'Sweet shop',
  /** The account's only address doubles as both, which is how a single-site business works. */
  addressLabel: 'Warehouse',
};

/**
 * `users`, `addresses` and `businesses` all upsert by hand rather than through
 * `repository.upsert`.
 *
 * `users` has no plain unique index on `email` — uniqueness is the functional
 * `LOWER("email")` index the migration creates, and `ON CONFLICT ("email")` cannot name an
 * expression index. `addresses` has no unique key on `(user_id, label)` at all. Both natural
 * keys are therefore resolved with a read.
 *
 * What keeps `createdAt` stable across re-runs is **not** the read: `Repository.update` does not
 * strip `@CreateDateColumn` from its payload, and the generated SQL sets the column like any
 * other. It is stable only because each fixture pins `createdAt` to a hardcoded constant, so a
 * reseed rewrites the same value. Anyone giving a fixture a computed date — `new Date()`, or an
 * offset from today — resets that account's age on every reseed, and would need to drop
 * `createdAt` from the update payload to avoid it.
 */
async function upsertUsers(manager: EntityManager, passwordHash: string): Promise<number> {
  const users = manager.getRepository(User);

  for (const fixture of USER_FIXTURES) {
    const existing = await users.findOne({ where: { email: fixture.email }, select: { id: true } });
    if (existing) {
      await users.update(existing.id, { ...fixture, passwordHash, isActive: true });
    } else {
      await users.insert({ ...fixture, passwordHash, isActive: true });
    }
  }

  return USER_FIXTURES.length;
}

async function upsertAddresses(
  manager: EntityManager,
  userIdByEmail: ReadonlyMap<string, string>,
): Promise<number> {
  const addresses = manager.getRepository(Address);

  for (const fixture of ADDRESS_FIXTURES) {
    const userId = requireValue(
      userIdByEmail.get(fixture.email),
      `user "${fixture.email}" for address "${fixture.label}"`,
    );
    // Listed column by column rather than spread. `email` does double duty in the mock — it is
    // both the key `addressBook` groups by and the address's own contact field, the same value
    // in all three rows — and writing the columns out is how that stays obvious.
    const columns = {
      userId,
      label: fixture.label,
      isDefault: fixture.isDefault,
      fullName: fixture.fullName,
      phone: fixture.phone,
      email: fixture.email,
      line1: fixture.line1,
      line2: fixture.line2,
      city: fixture.city,
      state: fixture.state,
      pincode: fixture.pincode,
      deletedAt: null,
    };

    const existing = await addresses.findOne({
      where: { userId, label: fixture.label },
      select: { id: true },
    });
    if (existing) {
      await addresses.update(existing.id, columns);
    } else {
      await addresses.insert(columns);
    }
  }

  return ADDRESS_FIXTURES.length;
}

async function upsertBusiness(
  manager: EntityManager,
  userIdByEmail: ReadonlyMap<string, string>,
): Promise<number> {
  const userId = requireValue(
    userIdByEmail.get(BUSINESS_FIXTURE.email),
    `user "${BUSINESS_FIXTURE.email}" for the seeded business`,
  );

  const address = await manager.getRepository(Address).findOne({
    where: { userId, label: BUSINESS_FIXTURE.addressLabel },
    select: { id: true },
  });
  const addressId = requireValue(
    address?.id,
    `address "${BUSINESS_FIXTURE.addressLabel}" for the seeded business`,
  );

  await manager.getRepository(Business).upsert(
    {
      userId,
      companyName: BUSINESS_FIXTURE.companyName,
      contactPerson: BUSINESS_FIXTURE.contactPerson,
      mobile: BUSINESS_FIXTURE.mobile,
      gstin: BUSINESS_FIXTURE.gstin,
      businessType: BUSINESS_FIXTURE.businessType,
      billingAddressId: addressId,
      shippingAddressId: addressId,
      // Brief §34 assigns a salesperson in admin. Nothing here may claim one has been.
      assignedSalespersonId: null,
    },
    ['userId'],
  );

  return 1;
}

/**
 * The only environments allowed to write a known credential. **An allowlist, not a denylist.**
 *
 * This guard used to read `if (process.env.NODE_ENV === 'production') throw`, which fails *open*:
 * `process.env.NODE_ENV` is `undefined` when unset, and anything that is not the exact string
 * `production` — a typo, `prod`, `staging`, `Production`, an empty value, or nothing at all —
 * seeded `admin@demo.in` with `Password123!` and `isActive: true`. `upsertUsers` resets both on
 * every re-run, so a previously disabled fixture admin comes back too.
 *
 * Named here rather than compared inline because the direction is the whole point: a new
 * environment value is refused until somebody deliberately adds it, which is the opposite of the
 * default this had. Note it reads the raw variable rather than `appConfig().isProduction` — a
 * seeder is a standalone `ts-node` process with no Nest container, so it never sees
 * `env.schema.ts`'s narrowing, which is exactly why the check has to be strict on its own.
 *
 * Found by Milestone 10's security review; `users.seed.spec.ts` pins every case.
 */
export async function seedUsers(dataSource: DataSource): Promise<number> {
  /**
   * Kept **as well as** the runner's identical check, not instead of it.
   *
   * `seed.ts` now guards every seeder before it opens a connection, which is what stops a run
   * against the wrong database from wiping the settings table on its way to this refusal. But
   * `seedUsers` is also called directly — by `users.seed.spec.ts`, and by anything else that
   * imports it — and this is the seeder that writes a *known password* onto an active admin
   * account. Defence in depth is worth one line here.
   *
   * The subject reproduces the previous message exactly, so `users.seed.spec.ts`'s
   * `/Refusing to seed fixture accounts/` still matches without the spec being touched.
   */
  assertSeedableEnvironment('seed fixture accounts with a known password');

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  return dataSource.transaction(async (manager) => {
    let rows = await upsertUsers(manager, passwordHash);

    const users = await manager.getRepository(User).find({ select: { id: true, email: true } });
    const userIdByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user.id]));

    rows += await upsertAddresses(manager, userIdByEmail);
    rows += await upsertBusiness(manager, userIdByEmail);

    return rows;
  });
}
