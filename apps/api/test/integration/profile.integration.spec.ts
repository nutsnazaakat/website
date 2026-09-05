import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AuthUser } from '@nutwala/shared';
import type { Response } from 'supertest';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  expectError,
  expectSuccess,
  request,
  responseBody,
  useIntegrationApp,
} from './helpers';

/**
 * `GET`/`PATCH /account/profile` against real Postgres — spec §6.3's two profile routes.
 *
 * **Three of the things worth proving here cannot be proved anywhere else.**
 *
 * - **What actually reaches the wire.** A unit test asserts the shape a mapper returns; only a real
 *   request can assert that the serialised body a customer receives carries no `passwordHash`, no
 *   `isActive` and no `lastLoginAt`. `passwordHash` is `select: false`, so the column is not even
 *   loaded in production — which means a unit fixture is the *only* place it can be present, and a
 *   leak assertion that passes there could still be vacuous over the wire. Both directions are
 *   covered: the unit suite feeds a row that has one, this file greps the response text.
 * - **The 22001 boundary.** A name wider than `varchar(120)` is a 400 only because the DTO says so.
 *   Without it the value reaches the driver, nothing catches `QueryFailedError`, and the answer is a
 *   500 — a failure mode no double can model, because a double has no column width.
 * - **The cross-tenant write.** `UPDATE users SET name = $1 WHERE id = $2` with the owner clause
 *   replaced by any other predicate renames every account it matches, and `users.id` being the primary
 *   key means there is no unique index, foreign key or check constraint to object. Two signed-in
 *   customers and one `PATCH` is the only assertion that sees it.
 *
 * **One measured correction to the hazard this file was written around.** `Repository.update`
 * normalises its criteria and then *refuses an empty one*: `EntityManager.normalizeAndValidateWhereCriteria`
 * runs `OrmUtils.normalizeWhereCriteria` — which drops every `undefined` value — and calls `rejectEmpty()`
 * if nothing survives, so both `update({}, patch)` and `update({ id: undefined }, patch)` are
 * *"Empty criteria(s) are not allowed for the update method."* and a **500**, not a silent write to every
 * row. Verified by running both mutants (typeorm 0.3.31, `entity-manager/EntityManager.js:355-370`).
 * The `undefined`-is-dropped hazard is therefore live for **reads** (`find`/`findOne` go through
 * `SelectQueryBuilder`, which drops the criterion and answers with everything) and for raw
 * `manager.query`, but not for this write. What *is* reachable here is a `where` that is non-empty and
 * wrong — `{ isActive: true }` in place of `{ id: userId }` — which renames every active account and
 * raises nothing, and that is the mutant the cross-tenant case below actually kills.
 *
 * Cookie and header names are spelled out rather than imported, for the reason
 * `addresses.integration.spec.ts` gives: they are wire contract, so a rename must break a test here
 * rather than typecheck and leave every client broken.
 */
const CSRF_HEADER = 'X-CSRF-Token';

const PROFILE = '/api/v1/account/profile';
const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';

const B2C = 'b2c@demo.in';
const B2B = 'b2b@demo.in';
const PASSWORD = 'Password123!';

/**
 * Widened to `number` deliberately — supertest types `Response.status` as `number`, so comparing it
 * against an `HttpStatus` member trips `no-unsafe-enum-comparison`.
 */
const OK: number = HttpStatus.OK;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;

interface Refusal {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

const refusalOf = (response: Response): Refusal => {
  expectError(response);
  return responseBody<Refusal>(response);
};

/**
 * The `users` row as the table holds it, `passwordHash` included so a write to it would show.
 *
 * `updatedAt` is in here for the empty-patch case and is load-bearing there: `User extends BaseEntity`,
 * whose `updatedAt` is an `@UpdateDateColumn`, so TypeORM puts that column in **every** update
 * expression whether or not a caller named one. `repository.update({ id }, {})` therefore succeeds and
 * bumps the timestamp rather than raising or being a no-op — and a row comparison that left the column
 * out could not see the difference. Measured: the guard's mutant survived this file until this column
 * was selected.
 */
interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  isActive: boolean;
  passwordHash: string;
  updatedAt: Date;
}

describe('account profile', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests, for the reason `orders.integration.spec.ts` records:
   * `useIntegrationApp` boots one application per file, `POST /auth/login` is capped at five attempts
   * per fifteen minutes per IP, and every supertest request arrives from 127.0.0.1. This file signs in
   * well over five times.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  /** `seedUsers` is the whole fixture: the three accounts, their addresses and the b2b business. */
  beforeEach(async () => {
    await seedUsers(integration.dataSource);
  });

  async function signedIn(email = B2C) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: PASSWORD }).expect(OK);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  type Client = Awaited<ReturnType<typeof signedIn>>['client'];

  const profileOf = async (client: Client): Promise<AuthUser> =>
    expectSuccess<AuthUser>(await client.get(PROFILE).expect(OK));

  const rowOf = async (email: string): Promise<UserRow> => {
    const rows = await integration.dataSource.query<UserRow[]>(
      `SELECT id, name, email, phone, role::text AS role, "isActive", "passwordHash", "updatedAt"
         FROM users WHERE email = $1`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`users.seed did not create ${email}`);
    return row;
  };

  describe('reading', () => {
    it('answers the signed-in customer’s own profile', async () => {
      const { client } = await signedIn();

      expect(await profileOf(client)).toEqual({
        id: (await rowOf(B2C)).id,
        name: 'Asha Rao',
        email: B2C,
        phone: '9876543210',
        role: 'b2c',
        createdAt: '2025-11-04T09:12:00.000Z',
      });
    });

    /**
     * Spec §13's IDOR rule over the wire: the row is named by the session cookie, and there is no
     * `:id` and no `?email=` for a caller to substitute. Two customers ask the identical question and
     * get different answers.
     */
    it('answers a different customer with a different profile', async () => {
      const { client: asha } = await signedIn(B2C);
      const { client: rakesh } = await signedIn(B2B);

      expect((await profileOf(asha)).email).toBe(B2C);
      expect((await profileOf(rakesh)).email).toBe(B2B);
    });

    /**
     * **The company block, and the reason the read goes through `UsersService.findById`** — the method
     * that carries `relations: { business: true }`. A local `findOne({ where: { id } })` would pass
     * every `b2c` assertion in this file and answer a business customer with no company at all.
     *
     * Only the three fields `AuthUser.company` declares. `businesses` also holds `mobile`, `gstin`'s
     * neighbours `billingAddressId` and `shippingAddressId`, and `assignedSalespersonId` — which is
     * internal sales routing, and the one a customer most clearly has no business reading.
     */
    it('carries the company for a business account, and none of its internal columns', async () => {
      const { client } = await signedIn(B2B);

      const profile = await profileOf(client);

      expect(profile.role).toBe('b2b');
      expect(profile.company).toEqual({
        companyName: 'Anand Sweets & Namkeen',
        contactPerson: 'Rakesh Anand',
        businessType: 'Sweet shop',
        gstin: '29ABCDE1234F1Z5',
      });
    });

    /**
     * **What is actually on the wire, asserted against the serialised text.**
     *
     * `toEqual` above already pins the shape, but it pins the shape of a parsed object; this reads the
     * bytes. `passwordHash` is the one that matters and it is also the one a test can most easily be
     * fooled about: the column is `select: false`, so a mapper replaced by a spread would still not
     * leak it here — which is exactly why the assertion is not only about the hash. `isActive`,
     * `lastLoginAt` and `updatedAt` *are* loaded, so a spread puts all three on the wire, and
     * `lastLoginAt` is the interesting one: it is a login-activity timestamp, and this account has just
     * logged in.
     */
    it('serialises no column that AuthUser does not declare', async () => {
      const { client } = await signedIn();

      const response = await client.get(PROFILE).expect(OK);
      const body = JSON.stringify(response.body);

      for (const column of ['passwordHash', 'isActive', 'lastLoginAt', 'updatedAt', 'sessions']) {
        expect(body).not.toContain(column);
      }
      // The seeded hash's own prefix, in case a leak arrives under a renamed key.
      expect(body).not.toContain('$2b$');
      // `CUSTOMER` is the database enum. `b2c` is the wire role, and the response must carry only it:
      // `guards.ts` and every `role === "b2b"` branch in the frontend compare against the latter.
      expect(body).not.toContain('CUSTOMER');
    });

    /**
     * **The same payload as `GET /auth/me`, from the same read and the same mapper.**
     *
     * The assertion that stops `/account/profile` becoming a second, drifting definition of "the
     * current user". Two endpoints answering the same question with two implementations is how one of
     * them ends up missing a relation added later — and nothing on either screen would say so.
     */
    it('answers exactly what GET /auth/me answers', async () => {
      const { client } = await signedIn(B2B);

      const profile = expectSuccess<AuthUser>(await client.get(PROFILE).expect(OK));
      const me = expectSuccess<AuthUser>(await client.get(ME).expect(OK));

      expect(profile).toEqual(me);
    });

    /**
     * **401, never an empty shape.** The route carries no `@Public()`, so the global `JwtAuthGuard`
     * refuses an anonymous caller before the controller is reached.
     */
    it('refuses an anonymous read', async () => {
      const response = await request(integration.app).get(PROFILE).expect(UNAUTHORIZED);

      expect(refusalOf(response).message).toBe('Unauthorized');
    });
  });

  describe('editing', () => {
    it('changes the name and the phone number, and answers the profile as it now stands', async () => {
      const { client, csrf } = await signedIn();

      const answered = expectSuccess<AuthUser>(
        await client
          .patch(PROFILE)
          .set(CSRF_HEADER, csrf)
          .send({ name: 'Asha R Rao', phone: '9812345678' })
          .expect(OK),
      );

      expect(answered).toMatchObject({ name: 'Asha R Rao', phone: '9812345678' });
      expect(await rowOf(B2C)).toMatchObject({ name: 'Asha R Rao', phone: '9812345678' });
    });

    /** A patch, so one field is a legal request and the other column is left alone. */
    it('changes one field without touching the other', async () => {
      const { client, csrf } = await signedIn();

      await client.patch(PROFILE).set(CSRF_HEADER, csrf).send({ name: 'Asha R Rao' }).expect(OK);

      expect(await rowOf(B2C)).toMatchObject({ name: 'Asha R Rao', phone: '9876543210' });
    });

    /**
     * **The edit is visible to `GET /auth/me` too**, because both read the same row through the same
     * method. Worth asserting because the client writes the `PATCH`'s answer into its session snapshot
     * and then re-hydrates from `/auth/me` on the next page load: if the two disagreed, a customer
     * would see their new name until they refreshed and their old one afterwards.
     */
    it('is the same row GET /auth/me reads', async () => {
      const { client, csrf } = await signedIn();

      await client.patch(PROFILE).set(CSRF_HEADER, csrf).send({ name: 'Asha R Rao' }).expect(OK);

      expect(expectSuccess<AuthUser>(await client.get(ME).expect(OK)).name).toBe('Asha R Rao');
    });

    /**
     * **The cross-tenant write, which is the assertion this file exists for.**
     *
     * `UPDATE users SET name = $1 WHERE id = $2` with the owner clause swapped for anything else
     * renames **every account it matches**, and nothing objects: `users.id` is the primary key, so
     * there is no unique index to violate, no foreign key to break and no check constraint to fail.
     * Task 21 found the same shape on `addresses` where a partial unique index at least *looked* like
     * protection; here there is not even that.
     *
     * Measured with `{ isActive: true }` in place of `{ id: userId }` — a non-empty predicate,
     * deliberately, because an *empty* one is refused by TypeORM before any SQL is built (see this
     * file's header). This case is the only one in either suite that fails on the reachable version.
     *
     * The victim is read back through their own session rather than off the table alone, so the
     * assertion is about what the other customer is served and not only about a row.
     */
    it('leaves every other customer’s row alone', async () => {
      const { client: asha, csrf } = await signedIn(B2C);
      const { client: rakesh } = await signedIn(B2B);

      await asha
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ name: 'Asha R Rao', phone: '9812345678' })
        .expect(OK);

      expect(await profileOf(rakesh)).toMatchObject({
        name: 'Rakesh Anand',
        phone: '9845012345',
      });
      expect(await rowOf('admin@demo.in')).toMatchObject({
        name: 'Nazaakat Admin',
        phone: '9811100011',
      });
    });

    /**
     * **The 500-that-should-be-a-400.** `users.name` is `varchar(120)`, so without `@MaxLength(120)`
     * this reaches the driver as SQLSTATE `22001` (*value too long for type character varying(120)*),
     * nothing catches `QueryFailedError`, and the customer is shown "Internal server error" with the
     * edit silently not saved. The row is checked too: a 400 that had already written something would
     * be worse than the 500.
     */
    it('refuses a name wider than the column with a 400, not a 500', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ name: 'A'.repeat(121) })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({
        name: ['name must be shorter than or equal to 120 characters'],
      });
      expect((await rowOf(B2C)).name).toBe('Asha Rao');
    });

    /** The boundary itself is legal, so the bound is not off by one. */
    it('accepts a name exactly as wide as the column', async () => {
      const { client, csrf } = await signedIn();
      const name = 'A'.repeat(120);

      await client.patch(PROFILE).set(CSRF_HEADER, csrf).send({ name }).expect(OK);

      expect((await rowOf(B2C)).name).toBe(name);
    });

    /**
     * **The three fields that are not editable, refused rather than ignored — and the row unchanged.**
     *
     * Both halves matter. The 400 is `forbidNonWhitelisted` over a property the DTO does not declare,
     * so a client that believed it had changed its email address is told otherwise instead of being
     * answered 200. And the column check is what would catch a `patchOf` replaced by a spread on the
     * day someone relaxes the pipe: `role` is the privilege escalation, `isActive` is the self-lockout,
     * and `email` is the login identifier — `uq_users_email` is a case-insensitive unique index, so an
     * email edit is also the one write here that could collide with another account.
     */
    it.each([
      ['email', { email: 'attacker@demo.in' }],
      ['role', { role: 'admin' }],
      ['isActive', { isActive: false }],
      ['passwordHash', { passwordHash: 'not-a-hash' }],
      ['id', { id: '00000000-0000-4000-8000-000000000000' }],
    ])('refuses to change %s', async (field, body) => {
      // Snapshotted *after* the sign-in, not before: `POST /auth/login` writes `lastLoginAt`, which
      // bumps `BaseEntity.updatedAt` — so a `before` taken any earlier would differ for a reason that
      // has nothing to do with this request, and the row comparison would fail on every refusal.
      const { client, csrf } = await signedIn();
      const before = await rowOf(B2C);

      const response = await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send(body)
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({
        [field]: [`property ${field} should not exist`],
      });
      expect(await rowOf(B2C)).toEqual(before);
    });

    /**
     * And the account still works afterwards, which is the observable half of refusing `isActive`:
     * §9's login flow checks that column *after* the bcrypt comparison, so a customer who could flip it
     * would lock themselves out with no route back in and no error that explains it.
     */
    it('leaves the account able to sign in after an isActive attempt', async () => {
      const { client, csrf } = await signedIn();

      await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ isActive: false })
        .expect(BAD_REQUEST);

      await request(integration.app)
        .post(LOGIN)
        .send({ email: B2C, password: PASSWORD })
        .expect(OK);
    });

    it.each([
      ['too short', '98765'],
      ['a landline prefix', '2212345678'],
      ['eleven digits', '98765432100'],
    ])('refuses a phone number that is %s', async (_why, phone) => {
      const { client, csrf } = await signedIn();

      const response = await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ phone })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({
        phone: ['Enter a valid 10-digit Indian mobile number'],
      });
      expect((await rowOf(B2C)).phone).toBe('9876543210');
    });

    /**
     * **A blank name is a 400, not a 200 that blanks the customer's name.**
     *
     * `'  '` satisfies `@MinLength(2)` on its own — it is a present two-character string — so this is
     * only a refusal because the DTO trims *before* validating. Untrimmed, the row would hold either
     * two spaces or, if the service trimmed, `''`: a blank name on every future order and delivery
     * note, delivered by a success response. `users.name` is `NOT NULL varchar(120)` with no check
     * constraint, so the database has no opinion about an empty string.
     */
    it('refuses a name that is only whitespace', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ name: '   ' })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({ name: ['Enter your full name'] });
      expect((await rowOf(B2C)).name).toBe('Asha Rao');
    });

    it('stores a name with its padding trimmed off', async () => {
      const { client, csrf } = await signedIn();

      await client
        .patch(PROFILE)
        .set(CSRF_HEADER, csrf)
        .send({ name: '  Asha R Rao  ' })
        .expect(OK);

      expect((await rowOf(B2C)).name).toBe('Asha R Rao');
    });

    /**
     * **An empty patch is a 200 that writes nothing — including its timestamp.**
     *
     * The DTO accepts `{}` because both fields are optional, and the reason to count the patch's keys
     * is not the one it looks like: `repository.update({ id }, {})` does **not** raise
     * `UpdateValuesMissingError` here, because `User extends BaseEntity` and `BaseEntity.updatedAt` is
     * an `@UpdateDateColumn` that TypeORM adds to every update expression. So the statement succeeds
     * and bumps `updatedAt` — an audit trail claiming the customer edited their profile on a request
     * that changed nothing. `toEqual(before)` over a row that includes that column is what sees it;
     * without the column the mutant survives this whole file.
     */
    it('accepts an empty patch without writing anything, not even a timestamp', async () => {
      // After the sign-in, for the reason recorded above: logging in bumps `updatedAt` itself.
      const { client, csrf } = await signedIn();
      const before = await rowOf(B2C);

      const answered = expectSuccess<AuthUser>(
        await client.patch(PROFILE).set(CSRF_HEADER, csrf).send({}).expect(OK),
      );

      expect(answered.name).toBe('Asha Rao');
      expect(await rowOf(B2C)).toEqual(before);
    });

    /**
     * The global `CsrfGuard` applies — no `@SkipCsrf()` on this controller — so a cross-site form post
     * cannot rename a customer. Asserted here rather than trusted, because the frontend stub
     * deliberately does not model CSRF.
     */
    it('refuses a write whose CSRF token is missing', async () => {
      const { client } = await signedIn();

      const response = await client.patch(PROFILE).send({ name: 'Asha R Rao' }).expect(FORBIDDEN);

      expect(refusalOf(response).code).toBe('CSRF_TOKEN_INVALID');
      expect((await rowOf(B2C)).name).toBe('Asha Rao');
    });

    /**
     * **401 and no write.** `CsrfGuard` runs before `JwtAuthGuard`, so an anonymous write with no
     * token is the cheaper 403 — this one carries a token that was never issued to a session, which is
     * what reaches the auth guard.
     */
    it('refuses an anonymous write', async () => {
      const response = await request(integration.app)
        .patch(PROFILE)
        .send({ name: 'Asha R Rao' })
        .expect(FORBIDDEN);

      expect(refusalOf(response).code).toBe('CSRF_TOKEN_INVALID');
      expect((await rowOf(B2C)).name).toBe('Asha Rao');
    });
  });
});
