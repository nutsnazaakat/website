import { HttpStatus } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { DomainError } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';
import type { UsersService } from '../users/users.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

const ASHA_ID = 'f0000000-0000-4000-8000-00000000000a';

/**
 * A `users` row as TypeORM hands one over, **including the columns that must never reach the wire**.
 *
 * `passwordHash` is `select: false` on the entity, so in production `findById` does not even load it —
 * which is exactly why it is populated here. A fixture that omitted it would make every leak assertion
 * in this file vacuous: `expect(answer.passwordHash).toBeUndefined()` passes trivially against a row
 * that never had one, and the mapper could be replaced by a spread with nothing failing.
 */
const row = (overrides: Partial<User> = {}): User => ({
  id: ASHA_ID,
  name: 'Asha Rao',
  email: 'b2c@demo.in',
  phone: '9876543210',
  passwordHash: '$2b$10$vI1nWQzKk0dJ7bFqO0uWpeS3H7yQFqvOnJ0O1a6b1c2d3e4f5g6h7',
  role: UserRole.CUSTOMER,
  isActive: true,
  lastLoginAt: new Date('2026-08-20T06:00:00.000Z'),
  createdAt: new Date('2025-11-04T09:12:00.000Z'),
  updatedAt: new Date('2026-08-20T06:00:00.000Z'),
  business: null,
  addresses: [],
  sessions: [],
  ...overrides,
});

interface Harness {
  profile: ProfileService;
  users: { update: jest.Mock };
  directory: { findById: jest.Mock };
}

function harness(found: User | null = row()): Harness {
  const users = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const directory = { findById: jest.fn().mockResolvedValue(found) };

  return {
    profile: new ProfileService(
      users as unknown as Repository<User>,
      directory as unknown as UsersService,
    ),
    users,
    directory,
  };
}

/**
 * A hand-built body, so a case can hand the service a key the DTO does not declare — which is how the
 * "reaches past the pipe" assertion below is written without turning off the type system elsewhere.
 */
const patch = (body: unknown): UpdateProfileDto => body as UpdateProfileDto;

describe('ProfileService.read', () => {
  it('reads the row named by the session and by nothing else', async () => {
    const { profile, directory } = harness();

    await profile.read(ASHA_ID);

    expect(directory.findById).toHaveBeenCalledWith(ASHA_ID);
  });

  /**
   * **The wire shape, asserted key by key — and what matters is the six keys that are absent.**
   *
   * `AuthUser` has no `passwordHash`, `isActive`, `lastLoginAt`, `updatedAt`, `addresses` or `sessions`
   * member, so returning the entity instead of mapping it would put all six in the response body with
   * **nothing in the type system objecting**: a `User` is assignable to `AuthUser` for every property
   * `AuthUser` declares except `role` and `createdAt`, and a single `as` at the return site silences
   * those. `toEqual` with an exhaustive literal is therefore the only assertion that can see the
   * difference, which is why this is not written as a handful of `toBeUndefined()`s.
   */
  it('answers the mapped wire shape and no internal column', async () => {
    const { profile } = harness();

    await expect(profile.read(ASHA_ID)).resolves.toEqual({
      id: ASHA_ID,
      name: 'Asha Rao',
      email: 'b2c@demo.in',
      phone: '9876543210',
      role: 'b2c',
      createdAt: '2025-11-04T09:12:00.000Z',
    });
  });

  it.each(['passwordHash', 'isActive', 'lastLoginAt', 'updatedAt', 'addresses', 'sessions'])(
    'never puts %s on the wire',
    async (column) => {
      const { profile } = harness();

      const answered: Record<string, unknown> = { ...(await profile.read(ASHA_ID)) };

      expect(Object.keys(answered)).not.toContain(column);
      expect(JSON.stringify(answered)).not.toContain('$2b$');
    },
  );

  /**
   * **`role` is the wire vocabulary, not the database enum**, and the two are one mapper apart.
   * `users.role` is `CUSTOMER`/`BUSINESS`/`ADMIN`; `AuthUser.role` is `b2c`/`b2b`/`admin`, which is what
   * `guards.ts` and every `role === "b2b"` branch in the frontend compare against. Answering the enum
   * would sign a business customer out of the bulk area rather than fail visibly.
   */
  it.each([
    [UserRole.CUSTOMER, 'b2c'],
    [UserRole.BUSINESS, 'b2b'],
    [UserRole.ADMIN, 'admin'],
  ])('translates the %s enum to the wire role %s', async (role, wire) => {
    const { profile } = harness(row({ role }));

    await expect(profile.read(ASHA_ID)).resolves.toMatchObject({ role: wire });
  });

  /**
   * **The company block, which is the reason the read goes through `UsersService.findById`.**
   *
   * That method is what carries `relations: { business: true }`. A local `findOne({ where: { id } })`
   * here would type-check, pass every case above — all written against a `b2c` fixture — and answer a
   * business customer with no company at all, on a page (`/account/profile`) that renders exactly those
   * three fields.
   */
  it('includes the company for a business account', async () => {
    const { profile } = harness(
      row({
        role: UserRole.BUSINESS,
        business: {
          companyName: 'Anand Sweets & Namkeen',
          contactPerson: 'Rakesh Anand',
          businessType: 'Sweet shop',
          gstin: '29ABCDE1234F1Z5',
          mobile: '9845012345',
          assignedSalespersonId: 'f0000000-0000-4000-8000-0000000000ad',
        } as never,
      }),
    );

    await expect(profile.read(ASHA_ID)).resolves.toMatchObject({
      company: {
        companyName: 'Anand Sweets & Namkeen',
        contactPerson: 'Rakesh Anand',
        businessType: 'Sweet shop',
        gstin: '29ABCDE1234F1Z5',
      },
    });
  });

  /**
   * The company block is mapped field by field too: `businesses` carries `mobile`,
   * `assignedSalespersonId`, `billingAddressId` and `shippingAddressId`, and the last of those is
   * internal sales routing that a customer has no business reading about their own account.
   */
  it('does not put the business row’s internal columns on the wire', async () => {
    const { profile } = harness(
      row({
        role: UserRole.BUSINESS,
        business: {
          companyName: 'Anand Sweets & Namkeen',
          contactPerson: 'Rakesh Anand',
          businessType: 'Sweet shop',
          gstin: null,
          mobile: '9845012345',
          assignedSalespersonId: 'f0000000-0000-4000-8000-0000000000ad',
        } as never,
      }),
    );

    const answered = await profile.read(ASHA_ID);

    expect(Object.keys(answered.company ?? {}).sort()).toEqual([
      'businessType',
      'companyName',
      'contactPerson',
    ]);
  });

  /**
   * **A 401 and not a 404**, matching `AuthService.me` letter for letter. The session that reached this
   * far is valid, so a missing row means the account behind it is gone — "no such profile" is not
   * something a client can act on and "sign in again" is. `DomainError` defaults to **422**, so the
   * status is passed explicitly; omit it and no client's expired-session branch would ever run.
   */
  it('answers a vanished account with the same 401 GET /auth/me gives', async () => {
    const { profile } = harness(null);

    const failure: unknown = await profile.read(ASHA_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((failure as DomainError).code).toBe('SESSION_EXPIRED');
    expect((failure as DomainError).message).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  /**
   * **An ownerless read is a crash, because the alternative is a disclosure.**
   *
   * `@CurrentUser()` throws rather than resolving nobody, so this is unreachable over HTTP — which is
   * why it is cheap to hold. TypeORM drops an `undefined` from a find-options `where`, so
   * `findOne({ where: { id: undefined } })` is not a query for a user with no id; it is a query with no
   * criteria, and it answers with whichever `users` row Postgres returns first. On this endpoint that
   * is a stranger's name, email and phone number in a 200.
   */
  it('refuses to read a profile with no owner', async () => {
    const { profile, directory } = harness();

    await expect(profile.read('')).rejects.toThrow(/no meaning without an owner/);
    expect(directory.findById).not.toHaveBeenCalled();
  });
});

describe('ProfileService.update', () => {
  /**
   * **The owner clause, which is the whole security of this write.**
   *
   * `users.id` is the primary key: there is no unique index, no foreign key and no check constraint
   * that a `where`-less `UPDATE users SET name = $1` would violate, so dropping `{ id: userId }` here
   * renames **every account in the database** and nothing objects. That is Task 21's finding with the
   * last protection removed — an index refuses *two* and never *zero*, and here there is not even an
   * index to refuse anything.
   */
  it('scopes the write to the session’s own row', async () => {
    const { profile, users } = harness();

    await profile.update(ASHA_ID, patch({ name: 'Asha R Rao', phone: '9812345678' }));

    expect(users.update).toHaveBeenCalledTimes(1);
    expect(users.update).toHaveBeenCalledWith(
      { id: ASHA_ID },
      { name: 'Asha R Rao', phone: '9812345678' },
    );
  });

  /** A patch, so a one-field request sets one column and leaves the other alone. */
  it.each([
    [{ name: 'Asha R Rao' }, { name: 'Asha R Rao' }],
    [{ phone: '9812345678' }, { phone: '9812345678' }],
  ])('sets only the columns the request carried: %o', async (body, expected) => {
    const { profile, users } = harness();

    await profile.update(ASHA_ID, patch(body));

    expect(users.update).toHaveBeenCalledWith({ id: ASHA_ID }, expected);
  });

  /**
   * **An empty patch issues no statement at all.**
   *
   * `UpdateProfileDto` accepts `{}` — both fields are optional — and `repository.update({ id }, {})`
   * is **not** the `UpdateValuesMissingError` it looks like: that error is for an `undefined` value set,
   * and `{}` is defined. `User extends BaseEntity`, whose `updatedAt` is an `@UpdateDateColumn` that
   * TypeORM adds to every update expression, so the statement succeeds and bumps that column —
   * an audit trail claiming an edit on a request that changed nothing. Measured against real Postgres
   * in `profile.integration.spec.ts`, which is also where the wrong version of this reasoning was
   * caught: an integration row comparison that omitted `updatedAt` could not see the mutant at all.
   */
  it('issues no UPDATE for an empty patch, and still answers the profile', async () => {
    const { profile, users } = harness();

    await expect(profile.update(ASHA_ID, patch({}))).resolves.toMatchObject({ name: 'Asha Rao' });

    expect(users.update).not.toHaveBeenCalled();
  });

  /**
   * **Written out key by key, so the pipe's `whitelist` is not the only thing between a request body
   * and this table.**
   *
   * A spread of the DTO would forward whatever survived validation. That is safe *today* — nothing
   * declares `role` or `isActive`, so `forbidNonWhitelisted` refuses them with a 400 — and it makes the
   * global pipe's configuration the single point of failure for a privilege escalation: one
   * `forbidNonWhitelisted: false`, or one `email?: string` added to the DTO, and the mass assignment is
   * live. This case reaches past the pipe (a hand-built body, as any other service could) and asserts
   * the service refuses to carry the extra keys on its own.
   */
  it('carries no column the DTO does not declare, even when handed one', async () => {
    const { profile, users } = harness();

    await profile.update(
      ASHA_ID,
      patch({
        name: 'Asha R Rao',
        email: 'someone.else@demo.in',
        role: UserRole.ADMIN,
        isActive: false,
        passwordHash: 'not-a-hash',
        id: 'f0000000-0000-4000-8000-00000000000b',
      }),
    );

    expect(users.update).toHaveBeenCalledWith({ id: ASHA_ID }, { name: 'Asha R Rao' });
  });

  /**
   * **Answers the committed row, re-read after the write** — not the body it was sent, and not the row
   * as it was before.
   *
   * The fixture deliberately disagrees with the request: the answer must carry the *row's* name. A
   * service that echoed its own input would look identical on every happy path and would lie the moment
   * a column was normalised, truncated or overwritten by a concurrent edit — and the client writes this
   * answer straight into its session snapshot, so the lie would persist across the page.
   */
  it('answers the row as it now stands, not the request body', async () => {
    const { profile, directory, users } = harness(row({ name: 'Asha Rao (committed)' }));

    await expect(profile.update(ASHA_ID, patch({ name: 'Asha R Rao' }))).resolves.toMatchObject({
      name: 'Asha Rao (committed)',
    });

    // Write, then read: the other order answers with the state the write was about to replace.
    expect(users.update.mock.invocationCallOrder[0]).toBeLessThan(
      directory.findById.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('answers the mapped shape on a write too, with no internal column on it', async () => {
    const { profile } = harness();

    await expect(profile.update(ASHA_ID, patch({ name: 'Asha R Rao' }))).resolves.toEqual({
      id: ASHA_ID,
      name: 'Asha Rao',
      email: 'b2c@demo.in',
      phone: '9876543210',
      role: 'b2c',
      createdAt: '2025-11-04T09:12:00.000Z',
    });
  });

  /**
   * The read's guard again, and here the stake is higher than a disclosure: without it
   * `update({ id: undefined }, patch)` is an `UPDATE` with no `WHERE`. The assertion that matters is
   * that **no statement was issued**, not merely that the call threw.
   */
  it('refuses to write a profile with no owner, without issuing a statement', async () => {
    const { profile, users } = harness();

    await expect(profile.update('', patch({ name: 'Asha R Rao' }))).rejects.toThrow(
      /no meaning without an owner/,
    );
    expect(users.update).not.toHaveBeenCalled();
  });

  it('turns a vanished account into the same 401 the read gives', async () => {
    const { profile } = harness(null);

    const failure: unknown = await profile
      .update(ASHA_ID, patch({ name: 'Asha R Rao' }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });
});
