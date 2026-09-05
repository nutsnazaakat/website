import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { SavedAddress } from '@nutwala/shared';
import type { Response } from 'supertest';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  responseBody,
  useIntegrationApp,
  waitForABlockedWriter,
} from './helpers';

/**
 * The account address book against real Postgres — spec §6.3's five address routes.
 *
 * **Everything worth proving here needs a database.** The unit suite models
 * `uq_addresses_one_default_per_user` faithfully enough to catch a clear-then-set reversal, but three
 * of the failures this endpoint could ship are properties of Postgres and of the driver rather than of
 * the service:
 *
 * - a label wider than `varchar(40)` raises SQLSTATE **22001** inside the driver, which nothing
 *   catches, so the customer gets a 500 for what is a 400;
 * - a non-uuid path parameter raises **22P02** the same way, and the page this replaces minted exactly
 *   such ids (`adr-b2c-home`);
 * - the unique index's **partial** predicate — `WHERE isDefault = true AND deletedAt IS NULL` — is what
 *   makes the soft delete safe rather than something that quietly wedges the book, and no double can
 *   assert a predicate it was told about.
 *
 * Cookie and header names are spelled out rather than imported, for the reason `orders.integration.
 * spec.ts` gives: they are wire contract, so a rename must break a test here rather than typecheck and
 * leave every client broken.
 */
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const ADDRESSES = '/api/v1/account/addresses';
const CART = '/api/v1/cart';
const LOGIN = '/api/v1/auth/login';

const B2C = 'b2c@demo.in';
const B2B = 'b2b@demo.in';

/**
 * Widened to `number` deliberately — supertest types `Response.status` as `number`, so comparing it
 * against an `HttpStatus` member trips `no-unsafe-enum-comparison`.
 */
const OK: number = HttpStatus.OK;
const CREATED: number = HttpStatus.CREATED;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;

/** `BaseEntity.id` is `@PrimaryGeneratedColumn('uuid')`, which is v4. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The statement `AddressesService.lockOwner` issues, as `pg_stat_activity` reports it. */
const OWNER_LOCK = /FOR NO KEY UPDATE/i;

/** A body the address form really sends, including its empty second line. */
const NEW_ADDRESS = {
  label: 'Studio',
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '9 Langford Road',
  line2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560027',
  isDefault: false,
};

interface Refusal {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function refusalOf(response: Response): Refusal {
  expectError(response);
  return responseBody<Refusal>(response);
}

interface AddressRow {
  id: string;
  label: string;
  isDefault: boolean;
  deletedAt: Date | null;
  line2: string | null;
  city: string;
  fullName: string;
}

describe('account addresses', () => {
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

  /**
   * `seedUsers` is the whole fixture and the only seeder this file needs: it writes the three accounts
   * *and* the three addresses from `frontend/src/mocks/addresses.ts` — `Home` (default) and `Office`
   * for `b2c@demo.in`, `Warehouse` (default) for `b2b@demo.in`.
   */
  beforeEach(async () => {
    await seedUsers(integration.dataSource);
  });

  /** Signs in and returns a cookie-persisting client plus the CSRF token to echo. */
  async function signedIn(email = B2C) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(OK);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  type Client = Awaited<ReturnType<typeof signedIn>>['client'];

  const book = async (client: Client): Promise<SavedAddress[]> =>
    expectSuccess<SavedAddress[]>(await client.get(ADDRESSES).expect(OK));

  const labelsOf = (addresses: SavedAddress[]): string[] =>
    addresses.map((address) => address.label);

  const defaultOf = (addresses: SavedAddress[]): string | undefined =>
    addresses.find((address) => address.isDefault)?.label;

  const userId = async (email: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`users.seed did not create ${email}`);
    return row.id;
  };

  /** Every row of one customer's, deleted ones included — the table, not the book. */
  const rowsOf = async (email: string): Promise<AddressRow[]> =>
    integration.dataSource.query<AddressRow[]>(
      `SELECT a.id, a.label, a."isDefault", a."deletedAt", a.line2, a.city, a."fullName"
         FROM addresses a JOIN users u ON u.id = a.user_id
        WHERE u.email = $1 ORDER BY a."createdAt"`,
      [email],
    );

  const rowNamed = async (email: string, label: string): Promise<AddressRow> => {
    const found = (await rowsOf(email)).find((row) => row.label === label);
    if (found === undefined) throw new Error(`no address labelled ${label} for ${email}`);
    return found;
  };

  /** How many live defaults one customer has. The invariant, read straight off the table. */
  const liveDefaults = async (email: string): Promise<number> =>
    (await rowsOf(email)).filter((row) => row.isDefault && row.deletedAt === null).length;

  describe('reading', () => {
    /**
     * The seeded book, default first — which is the ordering the page promises (*"the default one is
     * offered first"*) and the one checkout prefills from.
     */
    it('answers the signed-in customer’s own book, default first', async () => {
      const { client } = await signedIn();

      const answered = await book(client);

      expect(labelsOf(answered)).toEqual(['Home', 'Office']);
      expect(defaultOf(answered)).toBe('Home');
      expect(answered[0]?.id).toMatch(UUID_V4);
    });

    /**
     * Spec §13's IDOR rule over the wire: the owner comes from the session cookie, so two customers
     * asking the same question get different answers and neither can name the other's account.
     */
    it('answers a different customer with a different book', async () => {
      const { client: asha } = await signedIn(B2C);
      const { client: rakesh } = await signedIn(B2B);

      expect(labelsOf(await book(asha))).toEqual(['Home', 'Office']);
      expect(labelsOf(await book(rakesh))).toEqual(['Warehouse']);
    });

    /**
     * **401, never `[]`.** These routes carry no `@Public()`, so the global `JwtAuthGuard` refuses an
     * anonymous caller before the controller is reached. An empty array would be a plausible answer
     * hiding a missing guard.
     */
    it('refuses an anonymous read with 401 rather than an empty book', async () => {
      const response = await request(integration.app).get(ADDRESSES).expect(UNAUTHORIZED);

      expect(refusalOf(response).message).toBe('Unauthorized');
    });

    /**
     * The wire contract, and what is *not* on it: `SavedAddress` has no `userId`, and the mapper is
     * what keeps the account's primary key out of the body of five endpoints.
     */
    it('publishes no internal column', async () => {
      const { client } = await signedIn();
      const [home] = await book(client);

      expect(Object.keys(home ?? {}).sort()).toEqual([
        'city',
        'email',
        'fullName',
        'id',
        'isDefault',
        'label',
        'line1',
        'line2',
        'phone',
        'pincode',
        'state',
      ]);
    });

    /** `Office` is seeded with `line2: null`, and the wire says nothing rather than `null`. */
    it('omits a second line the row does not have', async () => {
      const { client } = await signedIn();
      const office = (await book(client)).find((address) => address.label === 'Office');

      expect(office).not.toHaveProperty('line2');
    });
  });

  describe('creating', () => {
    it('saves the address and answers the whole book with a server-allocated uuid', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .post(ADDRESSES)
        .set(CSRF_HEADER, csrf)
        .send(NEW_ADDRESS)
        .expect(CREATED);

      const answered = expectSuccess<SavedAddress[]>(response);
      expect(labelsOf(answered)).toEqual(['Home', 'Office', 'Studio']);
      const studio = answered.find((address) => address.label === 'Studio');
      expect(studio?.id).toMatch(UUID_V4);
    });

    /**
     * **The 500-that-should-be-a-400, over the wire.**
     *
     * `addresses.label` is `varchar(40)` and `savedAddressSchema` bounds it with `min(2)` and no
     * maximum, so this is a customer typing a long name rather than an attacker crafting one. Without
     * `@MaxLength(40)` the value reaches the driver as SQLSTATE `22001`, nothing catches the
     * `QueryFailedError`, and the answer is 500 with the address not saved and nothing on screen to say
     * which field was at fault.
     */
    it('refuses a label wider than the column with a 400, not a 500', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .post(ADDRESSES)
        .set(CSRF_HEADER, csrf)
        .send({ ...NEW_ADDRESS, label: 'H'.repeat(41) })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({
        label: ['label must be shorter than or equal to 40 characters'],
      });
      expect(await rowsOf(B2C)).toHaveLength(2);
    });

    /** The boundary is legal, so the bound refuses only what the column would. */
    it('accepts a label exactly as wide as the column', async () => {
      const { client, csrf } = await signedIn();

      await client
        .post(ADDRESSES)
        .set(CSRF_HEADER, csrf)
        .send({ ...NEW_ADDRESS, label: 'H'.repeat(40) })
        .expect(CREATED);

      expect((await rowNamed(B2C, 'H'.repeat(40))).label).toHaveLength(40);
    });

    /**
     * **`line2: ''` is what the form sends for an untouched second line**, and `@IsOptional()` accepts
     * it — an empty string is a present value. Without the service's normalisation the column holds two
     * spellings of "no second line", and this is the only place that can tell them apart: the wire
     * omits `''` and `null` identically.
     */
    it('stores an untouched second line as null rather than an empty string', async () => {
      const { client, csrf } = await signedIn();

      await client.post(ADDRESSES).set(CSRF_HEADER, csrf).send(NEW_ADDRESS).expect(CREATED);

      expect((await rowNamed(B2C, 'Studio')).line2).toBeNull();
    });

    /**
     * **The first address in a book is the default whatever the request said.** `NEW_ADDRESS` carries
     * `isDefault: false`, so a service that only honoured the request leaves this customer with one
     * address, no default badge and nothing for checkout to offer first.
     */
    it('promotes the first address in an empty book', async () => {
      const { client, csrf } = await signedIn();
      await integration.dataSource.query('DELETE FROM addresses WHERE user_id = $1', [
        await userId(B2C),
      ]);

      const answered = expectSuccess<SavedAddress[]>(
        await client.post(ADDRESSES).set(CSRF_HEADER, csrf).send(NEW_ADDRESS).expect(CREATED),
      );

      expect(defaultOf(answered)).toBe('Studio');
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /**
     * **Clear first, then set, proved against the real index.**
     *
     * `uq_addresses_one_default_per_user` is checked per statement and is not deferrable, so a service
     * that set the new default before clearing the old fails here with a constraint violation — a 500
     * on an ordinary save, with the book unchanged.
     */
    it('moves the default rather than adding a second one', async () => {
      const { client, csrf } = await signedIn();

      const answered = expectSuccess<SavedAddress[]>(
        await client
          .post(ADDRESSES)
          .set(CSRF_HEADER, csrf)
          .send({ ...NEW_ADDRESS, isDefault: true })
          .expect(CREATED),
      );

      expect(defaultOf(answered)).toBe('Studio');
      expect(labelsOf(answered)[0]).toBe('Studio');
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /**
     * **A promotion demotes one customer's default and nobody else's.**
     *
     * `clearDefault` is an `UPDATE … SET "isDefault" = false` over a `where`, and a `where` that lost
     * its `userId` would demote **every customer in the database**: no error anywhere, because the
     * unique index only objects to *two* defaults and this leaves zero, and the victim's book is never
     * read under their own id so nothing promotes a replacement. Measured as a survivor of all 91 unit
     * and 34 integration cases before this one existed — which is why the assertion is about `B2B`'s
     * row after a request `B2C` made.
     */
    it('demotes the caller’s own default and nobody else’s', async () => {
      const { client, csrf } = await signedIn(B2C);

      await client
        .post(ADDRESSES)
        .set(CSRF_HEADER, csrf)
        .send({ ...NEW_ADDRESS, isDefault: true })
        .expect(CREATED);

      expect(await liveDefaults(B2C)).toBe(1);
      expect((await rowNamed(B2B, 'Warehouse')).isDefault).toBe(true);
      expect(await liveDefaults(B2B)).toBe(1);
    });

    /**
     * The global `CsrfGuard` applies — no `@SkipCsrf()` anywhere on this controller — so a cross-site
     * form post cannot write to a customer's address book. Asserted here rather than trusted, because
     * the frontend stub deliberately does not model CSRF.
     */
    it('refuses a write whose CSRF token is missing', async () => {
      const { client } = await signedIn();

      const response = await client.post(ADDRESSES).send(NEW_ADDRESS).expect(FORBIDDEN);

      expect(refusalOf(response).code).toBe('CSRF_TOKEN_INVALID');
      expect(await rowsOf(B2C)).toHaveLength(2);
    });

    /** `forbidNonWhitelisted`: the id is the database's to allocate, so sending one is a 400. */
    it('refuses a client-supplied id rather than ignoring it', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .post(ADDRESSES)
        .set(CSRF_HEADER, csrf)
        .send({ ...NEW_ADDRESS, id: 'adr-b2c-home' })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).details).toEqual({ id: ['property id should not exist'] });
    });
  });

  describe('editing', () => {
    it('edits the fields the request carried and leaves the rest alone', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      const answered = expectSuccess<SavedAddress[]>(
        await client
          .patch(`${ADDRESSES}/${office.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ label: 'Studio office', city: 'Mysuru' })
          .expect(OK),
      );

      expect(labelsOf(answered)).toEqual(['Home', 'Studio office']);
      const edited = await rowNamed(B2C, 'Studio office');
      expect(edited.city).toBe('Mysuru');
      expect(edited.fullName).toBe('Asha Rao');
    });

    /**
     * **22P02, and it is reachable today rather than hypothetically.**
     *
     * `addresses.id` is a `uuid` column, so `adr-b2c-home` — the id shape the deleted mock minted, and
     * the one a browser holding a stale copy of it still sends — reaches Postgres as *invalid input
     * syntax for type uuid*. Nothing catches a `QueryFailedError`, so without `ParseUUIDPipe` the
     * answer is a **500**.
     */
    it('refuses a non-uuid id with 400 rather than 500', async () => {
      const { client, csrf } = await signedIn();

      const response = await client
        .patch(`${ADDRESSES}/adr-b2c-home`)
        .set(CSRF_HEADER, csrf)
        .send({ label: 'Home again' })
        .expect(BAD_REQUEST);

      expect(refusalOf(response).message).toMatch(/uuid/i);
    });

    /**
     * **404 for another customer's address, and the row untouched.** Never a 403: `AddressesService`
     * answers `null` for both "no such address" and "not yours" and cannot tell them apart, so two
     * statuses would make the endpoint an oracle for other customers' address ids.
     */
    it('answers 404 for another customer’s address and edits nothing', async () => {
      const { client, csrf } = await signedIn(B2C);
      const warehouse = await rowNamed(B2B, 'Warehouse');

      const response = await client
        .patch(`${ADDRESSES}/${warehouse.id}`)
        .set(CSRF_HEADER, csrf)
        .send({ label: 'Mine now' })
        .expect(NOT_FOUND);

      expect(refusalOf(response).code).toBe('NOT_FOUND');
      expect((await rowNamed(B2B, 'Warehouse')).label).toBe('Warehouse');
    });

    /**
     * **The invariant the database does not enforce, from the direction nobody expects.**
     *
     * The index stops two defaults and says nothing about zero. Unticking *Use as my default address*
     * on the only default is a request the form makes freely, and honoured literally it leaves a book
     * with addresses and no default at all — no badge, and checkout with nothing to offer first. A
     * default can be moved, never removed.
     */
    it('never leaves the book with no default when the only one is unticked', async () => {
      const { client, csrf } = await signedIn();
      const home = await rowNamed(B2C, 'Home');

      const answered = expectSuccess<SavedAddress[]>(
        await client
          .patch(`${ADDRESSES}/${home.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ isDefault: false })
          .expect(OK),
      );

      expect(defaultOf(answered)).toBeDefined();
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /** Every field is optional on a patch, and `UPDATE … SET` with nothing to set is a syntax error. */
    it('accepts an empty patch without a 500', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      const answered = expectSuccess<SavedAddress[]>(
        await client.patch(`${ADDRESSES}/${office.id}`).set(CSRF_HEADER, csrf).send({}).expect(OK),
      );

      expect(labelsOf(answered)).toEqual(['Home', 'Office']);
    });
  });

  describe('deleting', () => {
    /**
     * **Soft, and the row survives** — `address.entity.ts`: *"Soft-deleted so a restore is possible"*.
     * Explicitly **not** to protect order history: orders hold an `addressSnapshot` and never reference
     * this table, so a hard delete could not blank out a past delivery address.
     */
    it('marks the address deleted rather than removing the row', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      const answered = expectSuccess<SavedAddress[]>(
        await client.delete(`${ADDRESSES}/${office.id}`).set(CSRF_HEADER, csrf).expect(OK),
      );

      expect(labelsOf(answered)).toEqual(['Home']);
      const row = await rowNamed(B2C, 'Office');
      expect(row.deletedAt).not.toBeNull();
      expect(row.isDefault).toBe(false);
    });

    it('leaves the deleted address out of every later read', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      await client.delete(`${ADDRESSES}/${office.id}`).set(CSRF_HEADER, csrf).expect(OK);

      expect(labelsOf(await book(client))).toEqual(['Home']);
    });

    /** Deleting the default promotes a survivor, or the book keeps two addresses and loses its badge. */
    it('promotes another address when the default is deleted', async () => {
      const { client, csrf } = await signedIn();
      const home = await rowNamed(B2C, 'Home');

      const answered = expectSuccess<SavedAddress[]>(
        await client.delete(`${ADDRESSES}/${home.id}`).set(CSRF_HEADER, csrf).expect(OK),
      );

      expect(defaultOf(answered)).toBe('Office');
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /**
     * **The oldest survivor, not the newest**, and it takes a third address to see it: with the two
     * seeded rows the survivor of a deletion is unique, so this suite could not tell the two rules
     * apart until one was added. Measured — the mutant that promoted `live[live.length - 1]` passed
     * all 32 cases here while the unit suite killed it.
     */
    it('promotes the oldest survivor rather than the newest', async () => {
      const { client, csrf } = await signedIn();
      await client.post(ADDRESSES).set(CSRF_HEADER, csrf).send(NEW_ADDRESS).expect(CREATED);
      const home = await rowNamed(B2C, 'Home');

      const answered = expectSuccess<SavedAddress[]>(
        await client.delete(`${ADDRESSES}/${home.id}`).set(CSRF_HEADER, csrf).expect(OK),
      );

      expect(labelsOf(answered)).toEqual(['Office', 'Studio']);
      expect(defaultOf(answered)).toBe('Office');
    });

    it('empties the book when the last address goes, without trying to promote one', async () => {
      const { client, csrf } = await signedIn();
      for (const row of await rowsOf(B2C)) {
        await client.delete(`${ADDRESSES}/${row.id}`).set(CSRF_HEADER, csrf).expect(OK);
      }

      expect(await book(client)).toEqual([]);
      expect(await liveDefaults(B2C)).toBe(0);
    });

    /**
     * **The index's predicate is partial, and this is the assertion that says so.**
     *
     * `WHERE isDefault = true AND deletedAt IS NULL` is what makes the soft delete safe rather than
     * something that quietly wedges the address book: a *deleted* default must not occupy the one slot
     * a live default needs. Arranged with SQL rather than through the API, because the service clears
     * the flag on its way out — which is the belt to this predicate's braces, and the reason a test
     * that went through `DELETE` would prove the service's tidying rather than the index's shape.
     * `schema-invariants.integration.spec.ts` pins the other half, that two *live* defaults are
     * refused.
     */
    it('lets a live default in beside a soft-deleted one', async () => {
      const { client, csrf } = await signedIn();
      const home = await rowNamed(B2C, 'Home');
      await integration.dataSource.query(
        'UPDATE addresses SET "deletedAt" = now(), "isDefault" = true WHERE id = $1',
        [home.id],
      );

      const answered = expectSuccess<SavedAddress[]>(
        await client
          .post(ADDRESSES)
          .set(CSRF_HEADER, csrf)
          .send({ ...NEW_ADDRESS, isDefault: true })
          .expect(CREATED),
      );

      expect(defaultOf(answered)).toBe('Studio');
      expect(labelsOf(answered)).toEqual(['Studio', 'Office']);
    });

    /**
     * **The restore the soft delete exists for, and the reason `isDefault` is cleared on the way out.**
     *
     * A deleted row that still says `isDefault` violates nothing while it is deleted — the index's
     * predicate excludes it — so the flag looks redundant right up to the moment someone restores the
     * row next to the address that was promoted in its place, at which point the restore itself is the
     * constraint violation. Raw SQL because there is no restore endpoint yet; the assertion is that the
     * row *can* come back, which is the entire stated purpose of the soft delete
     * (`address.entity.ts`: *"Soft-deleted so a restore is possible"*).
     */
    it('lets a deleted default be restored beside the address that replaced it', async () => {
      const { client, csrf } = await signedIn();
      const home = await rowNamed(B2C, 'Home');
      await client.delete(`${ADDRESSES}/${home.id}`).set(CSRF_HEADER, csrf).expect(OK);

      // Throws `uq_addresses_one_default_per_user` if the delete left the flag set.
      await integration.dataSource.query('UPDATE addresses SET "deletedAt" = NULL WHERE id = $1', [
        home.id,
      ]);

      expect(await liveDefaults(B2C)).toBe(1);
      expect(labelsOf(await book(client))).toEqual(['Office', 'Home']);
    });

    it('answers 404 for another customer’s address and deletes nothing', async () => {
      const { client, csrf } = await signedIn(B2C);
      const warehouse = await rowNamed(B2B, 'Warehouse');

      await client.delete(`${ADDRESSES}/${warehouse.id}`).set(CSRF_HEADER, csrf).expect(NOT_FOUND);

      expect((await rowNamed(B2B, 'Warehouse')).deletedAt).toBeNull();
    });

    it('answers 404 for an address it has already deleted, rather than deleting it twice', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      await client.delete(`${ADDRESSES}/${office.id}`).set(CSRF_HEADER, csrf).expect(OK);
      await client.delete(`${ADDRESSES}/${office.id}`).set(CSRF_HEADER, csrf).expect(NOT_FOUND);
    });
  });

  describe('promoting', () => {
    /** **200, not 201**: nothing is created, a flag moves between two existing rows. */
    it('moves the default and answers 200 with the promoted address first', async () => {
      const { client, csrf } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      const answered = expectSuccess<SavedAddress[]>(
        await client.post(`${ADDRESSES}/${office.id}/default`).set(CSRF_HEADER, csrf).expect(OK),
      );

      expect(labelsOf(answered)).toEqual(['Office', 'Home']);
      expect(defaultOf(answered)).toBe('Office');
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /** A double-clicked *Make default* must not be a constraint violation. Clear-then-set is why. */
    it('is idempotent for the address that is already the default', async () => {
      const { client, csrf } = await signedIn();
      const home = await rowNamed(B2C, 'Home');

      await client.post(`${ADDRESSES}/${home.id}/default`).set(CSRF_HEADER, csrf).expect(OK);
      await client.post(`${ADDRESSES}/${home.id}/default`).set(CSRF_HEADER, csrf).expect(OK);

      expect(await liveDefaults(B2C)).toBe(1);
      expect(defaultOf(await book(client))).toBe('Home');
    });

    it('answers 404 for another customer’s address and promotes nothing', async () => {
      const { client, csrf } = await signedIn(B2C);
      const warehouse = await rowNamed(B2B, 'Warehouse');

      await client
        .post(`${ADDRESSES}/${warehouse.id}/default`)
        .set(CSRF_HEADER, csrf)
        .expect(NOT_FOUND);

      // Rakesh's own default is where it was: the promotion this test made was refused, so the
      // assertion has to be about *his* book rather than about the caller's.
      expect((await rowNamed(B2B, 'Warehouse')).isDefault).toBe(true);
      expect(defaultOf(await book(client))).toBe('Home');
    });

    it('refuses a promotion whose CSRF token is missing', async () => {
      const { client } = await signedIn();
      const office = await rowNamed(B2C, 'Office');

      await client.post(`${ADDRESSES}/${office.id}/default`).expect(FORBIDDEN);
      expect(defaultOf(await book(client))).toBe('Home');
    });

    /** A guest holding a valid `nn_csrf` is still not an identity: the token is not a session. */
    it('refuses an anonymous promotion with 401 even when the CSRF pair is valid', async () => {
      const anonymous = agent(integration.app);
      const primer = await anonymous.get(CART).expect(OK);
      const csrf = cookieValue(primer, CSRF_COOKIE);
      const office = await rowNamed(B2C, 'Office');

      await anonymous
        .post(`${ADDRESSES}/${office.id}/default`)
        .set(CSRF_HEADER, csrf)
        .expect(UNAUTHORIZED);
    });
  });

  describe('one default per customer, under concurrency', () => {
    /**
     * **The proof that the per-user lock exists and is where the writes queue.**
     *
     * A transaction alone does not enforce "exactly one default": two concurrent creates on an empty
     * book each count zero addresses, each decide to promote themselves, and the second dies on
     * `uq_addresses_one_default_per_user` — a 500 on an ordinary double-click of *Add Address*. The way
     * out is a per-customer mutex, and `SELECT … FROM users … FOR NO KEY UPDATE` is it: it conflicts
     * with itself, so two address writes queue, and it does *not* conflict with the `FOR KEY SHARE`
     * that an order placement's foreign-key check takes, so a save never delays a checkout.
     *
     * Arranged with a rival transaction holding that exact lock rather than by racing two requests and
     * hoping they overlap. `waitForABlockedWriter` is what makes it deterministic — it returns the
     * blocked backend's statement, so this asserts **which** statement stopped rather than that
     * something did. With the lock deleted nothing ever blocks and the helper throws *"No connection
     * ever blocked on a lock; the race was not set up"*, which is the kill.
     */
    it('queues a write behind the owner-row lock, and only behind that', async () => {
      const { client, csrf } = await signedIn();
      const owner = await userId(B2C);
      const rival = integration.dataSource.createQueryRunner();
      let blockedOn: string[] = [];
      let status = 0;

      try {
        await rival.connect();
        await rival.startTransaction();
        await rival.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [owner]);

        // `.then` is what fires a supertest request: the builder is lazy, so assigning it would
        // arrange a race that never starts and `waitForABlockedWriter` would time out on an idle
        // database.
        const inFlight = Promise.resolve(
          client.post(ADDRESSES).set(CSRF_HEADER, csrf).send(NEW_ADDRESS),
        );

        const blocked = await waitForABlockedWriter(integration.dataSource);
        blockedOn = blocked.map((writer) => writer.query);

        await rival.commitTransaction();
        status = (await inFlight).status;
      } finally {
        if (rival.isTransactionActive) await rival.rollbackTransaction();
        await rival.release();
      }

      expect(blockedOn.some((query) => OWNER_LOCK.test(query))).toBe(true);
      expect(status).toBe(CREATED);
      expect(await liveDefaults(B2C)).toBe(1);
    });

    /**
     * **The double click, end to end.** Two creates in flight at once against an empty book, both
     * asking to be the default. Both must succeed and the customer must end with two addresses and
     * exactly one default — never a 500, and never two badges.
     *
     * Weaker evidence than the proof above on its own, because two requests are not guaranteed to
     * overlap; it is here because it is the shape a customer actually produces, and because it is the
     * one case that would notice a lock taken on the *wrong* row.
     */
    it('survives two concurrent creates that both ask to be the default', async () => {
      const { client, csrf } = await signedIn();
      await integration.dataSource.query('DELETE FROM addresses WHERE user_id = $1', [
        await userId(B2C),
      ]);

      const [first, second] = await Promise.all([
        Promise.resolve(
          client
            .post(ADDRESSES)
            .set(CSRF_HEADER, csrf)
            .send({ ...NEW_ADDRESS, label: 'Studio', isDefault: true }),
        ),
        Promise.resolve(
          client
            .post(ADDRESSES)
            .set(CSRF_HEADER, csrf)
            .send({ ...NEW_ADDRESS, label: 'Annexe', isDefault: true }),
        ),
      ]);

      expect([first.status, second.status]).toEqual([CREATED, CREATED]);
      expect((await rowsOf(B2C)).map((row) => row.label).sort()).toEqual(['Annexe', 'Studio']);
      expect(await liveDefaults(B2C)).toBe(1);
    });
  });
});
