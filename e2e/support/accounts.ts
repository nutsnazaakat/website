import path from 'node:path';
import { authDir } from './env';

/**
 * The fixture accounts, read from `backend/src/database/seeds/users.seed.ts` rather than guessed.
 *
 * `DEV_PASSWORD` is that file's constant; `seedUsers` refuses to run at all when `NODE_ENV` is
 * production, which is what keeps a known credential out of a live database. The names and phone
 * numbers matter as much as the addresses do: every seeded order's `addressSnapshot` carries them,
 * so a journey that types different ones is describing a different customer.
 */
export const DEV_PASSWORD = 'Password123!';

export type Role = 'customer' | 'business' | 'admin';

export interface FixtureAccount {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  /** The wire role `GET /auth/me` answers with, not the database enum. */
  readonly wireRole: 'b2c' | 'b2b' | 'admin';
}

export const accounts: Readonly<Record<Role, FixtureAccount>> = {
  customer: {
    email: 'b2c@demo.in',
    password: DEV_PASSWORD,
    name: 'Asha Rao',
    wireRole: 'b2c',
  },
  /**
   * The bulk buyer, added for journey 6.
   *
   * A third session rather than an upgrade of the retail one: `/business/*` is guarded on
   * `role === "b2b"` (`requireBusiness` in the storefront's `guards.ts`), and `b2b@demo.in` is the
   * only seeded account that carries a `businesses` row — which is also what gives it a pricing
   * segment, so its bulk prices are resolved the way a real buyer's are rather than as a guest's.
   */
  business: {
    email: 'b2b@demo.in',
    password: DEV_PASSWORD,
    name: 'Rakesh Anand',
    wireRole: 'b2b',
  },
  admin: {
    email: 'admin@demo.in',
    password: DEV_PASSWORD,
    name: 'Nazaakat Admin',
    wireRole: 'admin',
  },
};

/**
 * `b2c@demo.in`'s default address, from `ADDRESS_FIXTURES` in the same seeder.
 *
 * Checkout does not prefill from the address book — `CheckoutForm` opens on `emptyAddress` — so the
 * journey types it. Typing the seeded values keeps the order's snapshot agreeing with the account
 * it was placed from, which is what makes the admin console's "Registered" customer panel readable.
 */
export const customerAddress = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  /** Prefix `5`, which `pincodes.seed.ts` makes serviceable with a 4-day ETA. */
  pincode: '560025',
} as const;

/**
 * `b2b@demo.in`'s company, from `BUSINESS_FIXTURE` and its `Warehouse` address in the same seeder.
 *
 * The RFQ form does not prefill any of it — `NewRfq` opens on empty strings, and the only thing it
 * takes from a link is the product and the weight — so journey 6 types it. Typing the *seeded*
 * values is what makes the enquiry describe the account that raised it: the admin console's
 * `/businesses` screen and the enquiry queue then agree on one company rather than two.
 *
 * The GSTIN satisfies `GSTIN_REGEX` in `shared/src/constants/identifiers.ts`, which both the form
 * and `CreateRfqDto` check, so it is a valid fixture rather than a placeholder that happens to be
 * fifteen characters.
 */
export const businessProfile = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  email: 'b2b@demo.in',
  gstin: '29ABCDE1234F1Z5',
  /** One of `BUSINESS_TYPES`; `CreateRfqDto` validates with `@IsIn`, so it cannot be free text. */
  businessType: 'Sweet shop',
  pincode: '560058',
} as const;

export const storageStatePath = (role: Role): string => path.join(authDir, `${role}.json`);
