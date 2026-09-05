import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import { RFQ_NUMBER_PATTERN, type RfqDetail, type RfqSummary } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedRfqs } from '../../src/database/seeds/rfqs.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { TEST_PASSWORD } from '../factories/user.factory';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
} from './helpers';

/**
 * Milestone 7b, Task 11. `GET /rfqs` and `GET /rfqs/:rfqNumber` — own only, the same IDOR shape
 * `orders.integration.spec.ts` proves for `GET /account/orders`.
 *
 * The 401 test below is here for what it measured rather than what it was written to catch.
 * `@CurrentUser()` throws only when Nest's parameter-resolution actually runs, and on a route
 * that carries no `@Public()` it never gets the chance to: `JwtAuthGuard.canActivate` awaits
 * `super.canActivate` directly and returns its answer, so a missing or invalid session is
 * refused by the **guard**, before the handler — and its parameter decorator — is reached at
 * all. Swapping `@CurrentUser()` for `@OptionalUser()` on `list` was tried directly while writing
 * this file and left both `rfqs.controller.spec.ts` and this file's own 401 case fully green,
 * for that reason: on a non-`@Public()` route the two decorators are answering a question the
 * guard has already settled. The plan's mutation table names this swap as something that should
 * fail; measured, it does not, and the reason is the same defence-in-depth that makes it safe —
 * `@Public()` is the one decorator actually standing between this pair of decorators and an
 * anonymous 200. This file's 401 test is real and worth having regardless: it is the one place
 * that would fail if a future edit added `@Public()` here, which is the change that would
 * actually matter.
 */
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const RFQS = '/api/v1/rfqs';
const CATALOG_PRODUCTS = '/api/v1/catalog/products';
const LOGIN = '/api/v1/auth/login';
const REGISTER = '/api/v1/auth/register';

const BULK_BODY = {
  businessName: 'Crumb & Co Bakery',
  contactPerson: 'Priya Menon',
  mobile: '9820098200',
  email: 'priya@crumbandco.example',
  businessType: 'Bakery',
  pincode: '400050',
  lines: [{ productSlug: 'premium-california-almonds', kg: 60 }],
  packaging: 'Vacuum packs (5 kg)',
  frequency: 'Fortnightly',
};

const GIFTING_BODY = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  email: 'purchase@anandsweets.example',
  businessType: 'Corporate gifting',
  pincode: '560004',
  occasion: 'Diwali',
  giftBoxSlug: 'festive-gift-box',
  boxes: 50,
  budgetPerBox: 1500,
  brandingRequired: true,
  deliveryDate: '2026-10-15',
};

describe('rfqs', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  /** An anonymous client primed with `nn_csrf`, the bootstrap every integration spec uses. */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(CATALOG_PRODUCTS).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  async function signedIn(email: string, password = 'Password123!') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  async function registerBusiness(email: string) {
    const client = agent(integration.app);
    const response = await client
      .post(REGISTER)
      .send({
        name: 'Second Business Owner',
        email,
        phone: '9876500002',
        password: TEST_PASSWORD,
        isBusiness: true,
        company: {
          companyName: 'Second Business Pvt Ltd',
          contactPerson: 'Second Owner',
          businessType: 'Distributor',
        },
      })
      .expect(201);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(response).csrfToken };
  }

  describe('POST /rfqs and POST /rfqs/gifting', () => {
    it('lets a prospect with no account raise a bulk enquiry', async () => {
      const { client, csrf } = await guest();
      const rfq = expectSuccess<RfqDetail>(
        await client.post(RFQS).set(CSRF_HEADER, csrf).send(BULK_BODY).expect(201),
      );

      expect(rfq.id).toMatch(RFQ_NUMBER_PATTERN);
      expect(rfq.kind).toBe('bulk');
      expect(rfq.lines).toEqual([{ productSlug: 'premium-california-almonds', kg: 60 }]);
    });

    /**
     * `rfq.received` is the one notification in this milestone whose subject is nobody's account:
     * the sales team's, not the prospect's. `user_id` is therefore not asserted here — the
     * prospect is a guest and it is null, which `rfqs.service.spec.ts` pins at that layer. What
     * this adds is the `jsonb` round-trip: `kind` is stored as the enum's `'BULK'`, not the
     * wire's lowercase `'bulk'`, and only a real column can tell those apart.
     */
    it('queues rfq.received for a bulk enquiry', async () => {
      const { client, csrf } = await guest();
      const rfq = expectSuccess<RfqDetail>(
        await client.post(RFQS).set(CSRF_HEADER, csrf).send(BULK_BODY).expect(201),
      );

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'rfq.received' AND payload->>'rfqNumber' = $1`,
        [rfq.id],
      );
      expect(rows).toEqual([
        {
          payload: {
            rfqNumber: rfq.id,
            businessName: BULK_BODY.businessName,
            email: BULK_BODY.email,
            kind: 'BULK',
          },
        },
      ]);
    });

    it('lets a prospect raise a gifting enquiry, with no packaging or frequency on the wire', async () => {
      const { client, csrf } = await guest();
      const rfq = expectSuccess<RfqDetail>(
        await client.post(`${RFQS}/gifting`).set(CSRF_HEADER, csrf).send(GIFTING_BODY).expect(201),
      );

      expect(rfq.kind).toBe('gifting');
      expect(rfq.gifting).toMatchObject({ occasion: 'Diwali', boxes: 50, budgetPerBox: 1500 });
      expect(rfq).not.toHaveProperty('packaging');
      expect(rfq).not.toHaveProperty('frequency');
    });

    /**
     * Refusing is the tempting alternative and it is wrong here: a prospect naming a product
     * they saw in a brochure is a sales lead, and a 422 on the public form turns it away.
     * `RfqsService.create`'s own unit tests already prove this at that layer; this is the same
     * property over real HTTP and a real Postgres row.
     */
    it('stores an unknown product slug rather than refusing the enquiry', async () => {
      const { client, csrf } = await guest();
      const rfq = expectSuccess<RfqDetail>(
        await client
          .post(RFQS)
          .set(CSRF_HEADER, csrf)
          .send({ ...BULK_BODY, lines: [{ productSlug: 'no-such-product', kg: 10 }] })
          .expect(201),
      );

      expect(rfq.lines).toEqual([{ productSlug: 'no-such-product', kg: 10 }]);
      const rows = await integration.dataSource.query<{ product_id: string | null }[]>(
        'SELECT product_id FROM rfq_items WHERE rfq_id = (SELECT id FROM rfqs WHERE "rfqNumber" = $1)',
        [rfq.id],
      );
      expect(rows).toEqual([{ product_id: null }]);
    });

    /**
     * `nextRfqNumber` draws from a real Postgres sequence rather than counting existing rows,
     * and this is the case that distinguishes the two: a `count(*) + 1` scheme run twice inside
     * the same transactional window can compute the identical number for both requests, where
     * `nextval` is atomic by the database's own guarantee. `Promise.all` fires both requests
     * before either's response arrives, so the two `create` calls genuinely overlap.
     */
    it('draws two different numbers for two concurrent creates', async () => {
      const first = await guest();
      const second = await guest();

      const [a, b] = await Promise.all([
        first.client.post(RFQS).set(CSRF_HEADER, first.csrf).send(BULK_BODY).expect(201),
        second.client.post(RFQS).set(CSRF_HEADER, second.csrf).send(BULK_BODY).expect(201),
      ]);

      const rfqA = expectSuccess<RfqDetail>(a);
      const rfqB = expectSuccess<RfqDetail>(b);
      expect(rfqA.id).not.toBe(rfqB.id);
      expect(rfqA.id).toMatch(RFQ_NUMBER_PATTERN);
      expect(rfqB.id).toMatch(RFQ_NUMBER_PATTERN);
    });

    /**
     * Five per hour per IP. `useIntegrationApp` boots one application for the whole file, so
     * `ThrottlerGuard`'s in-memory storage is shared across every test in it — the `beforeEach`
     * reset above is what keeps this test's own five attempts the only ones the guard has seen,
     * the same arrangement `auth.integration.spec.ts`'s identical case uses for registration.
     */
    it('refuses a sixth enquiry from one IP within the hour', async () => {
      const { client, csrf } = await guest();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await client.post(RFQS).set(CSRF_HEADER, csrf).send(BULK_BODY);
        statuses.push(response.status);
      }

      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    });
  });

  describe('GET /rfqs and GET /rfqs/:rfqNumber', () => {
    /**
     * **401, and never a 200 with `[]`.** There is no such thing as a prospect's RFQ list, and a
     * route that answered an empty array to an anonymous caller would be hiding a missing guard
     * behind it. Not a 403: `GET` is a safe method and exempt from `CsrfGuard`, so the refusal is
     * authentication's.
     */
    it('refuses an anonymous caller with 401 on both read routes', async () => {
      await request(integration.app).get(RFQS).expect(401);
      await request(integration.app).get(`${RFQS}/RFQ-2026-100000`).expect(401);
    });

    it("lists exactly the caller's own RFQ, and reads it back with its lines", async () => {
      const owner = await signedIn('b2b@demo.in');
      const created = expectSuccess<RfqDetail>(
        await owner.client.post(RFQS).set(CSRF_HEADER, owner.csrf).send(BULK_BODY).expect(201),
      );

      // Exactly one, never "at least one" — b2b@demo.in owns none from the seed at this point in
      // the plan (Task 12 seeds fixtures later), so a leak here would not hide behind a fixture.
      const list = expectSuccess<RfqSummary[]>(await owner.client.get(RFQS).expect(200));
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(created.id);

      const detail = expectSuccess<RfqDetail>(
        await owner.client.get(`${RFQS}/${created.id}`).expect(200),
      );
      expect(detail).toEqual(created);
    });

    it("never lists another business's RFQ, and 404s its number by name", async () => {
      const owner = await signedIn('b2b@demo.in');
      const created = expectSuccess<RfqDetail>(
        await owner.client.post(RFQS).set(CSRF_HEADER, owner.csrf).send(BULK_BODY).expect(201),
      );

      const stranger = await registerBusiness('second-rfq-business@demo.in');

      const strangerList = expectSuccess<RfqSummary[]>(await stranger.client.get(RFQS).expect(200));
      expect(strangerList).toEqual([]);

      const response = await stranger.client.get(`${RFQS}/${created.id}`).expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    /**
     * The two misses — "not yours" and "does not exist" — answer with the same body, which is
     * what keeps `RFQ_NUMBER_PATTERN`'s sequential numbers from being walkable: a caller who got
     * two different answers could tell a real RFQ belonging to someone else from one that was
     * never issued at all.
     */
    it('answers a stranger’s RFQ and an RFQ that was never issued identically', async () => {
      const owner = await signedIn('b2b@demo.in');
      const created = expectSuccess<RfqDetail>(
        await owner.client.post(RFQS).set(CSRF_HEADER, owner.csrf).send(BULK_BODY).expect(201),
      );

      const stranger = await registerBusiness('third-rfq-business@demo.in');

      const neverIssuedNumber = 'RFQ-2026-900000';
      const strangersRfq = await stranger.client.get(`${RFQS}/${created.id}`).expect(404);
      const neverIssued = await stranger.client.get(`${RFQS}/${neverIssuedNumber}`).expect(404);

      // Each message echoes its own rfqNumber, so the two literal strings differ by that
      // substring alone — stripped out here, what remains is the same template, and the two
      // `code`s already being equal is checked separately.
      const template = (body: { message: string }, rfqNumber: string): string =>
        body.message.replace(rfqNumber, '<RFQ>');
      expect(template(expectError(strangersRfq), created.id)).toBe(
        template(expectError(neverIssued), neverIssuedNumber),
      );
      expect(expectError(strangersRfq).code).toBe(expectError(neverIssued).code);
    });

    /**
     * `RfqsService.create` never sets `assignedSalespersonId`/`expectedValuePaise`, and
     * `toRfqDetail` never reads `notesList` — so a test that only exercised the create path
     * would find all three fields empty and pass whether or not the guard actually works, the
     * exact vacuous-test shape Plan 3's Task 22 measured for `passwordHash`. Written directly
     * against the row instead: the sales desk's own words, planted by hand below the API this
     * controller exposes, then read back through it.
     */
    it('never serialises an internal note, salesperson or expected value onto the wire', async () => {
      const owner = await signedIn('b2b@demo.in');
      const created = expectSuccess<RfqDetail>(
        await owner.client.post(RFQS).set(CSRF_HEADER, owner.csrf).send(BULK_BODY).expect(201),
      );

      const [admin] = await integration.dataSource.query<{ id: string }[]>(
        `SELECT id FROM users WHERE email = 'admin@demo.in'`,
      );
      const adminId = admin?.id ?? '';
      expect(adminId).not.toBe('');

      await integration.dataSource.query(
        `UPDATE rfqs
            SET assigned_salesperson_id = $1, "expectedValuePaise" = $2
          WHERE "rfqNumber" = $3`,
        [adminId, '5000000', created.id],
      );
      await integration.dataSource.query(
        `INSERT INTO rfq_notes (rfq_id, author_user_id, body)
         SELECT id, $1, $2 FROM rfqs WHERE "rfqNumber" = $3`,
        [adminId, 'Haggling over the rate, do not quote below 900/kg.', created.id],
      );

      const response = await owner.client.get(`${RFQS}/${created.id}`).expect(200);
      expect(response.text).not.toContain('900/kg');
      expect(response.text).not.toContain(adminId);
      expect(response.text).not.toContain('assignedSalesperson');
      expect(response.text).not.toContain('expectedValue');
    });
  });

  /**
   * Milestone 7b, Task 12. Spec §16's Milestone 1 row promises "3 RFQs"; this is the seeder that
   * makes that true. Deliberately not in the shared `beforeEach` above — every ownership test in
   * this file asserts "exactly one" against `b2b@demo.in`'s own account, and a fixture RFQ
   * attached to that same business would turn every one of those into a false pass hiding behind
   * a coincidence.
   */
  describe('the RFQ seeder', () => {
    const countRfqs = async (): Promise<number> => {
      const rows = await integration.dataSource.query<{ count: string }[]>(
        'SELECT count(*)::int AS count FROM rfqs',
      );
      return Number(rows[0]?.count ?? 0);
    };

    it('writes exactly three RFQs, one attached to b2b@demo.in and two as prospects', async () => {
      await seedRfqs(integration.dataSource);
      expect(await countRfqs()).toBe(3);

      const owner = await signedIn('b2b@demo.in');
      const list = expectSuccess<RfqSummary[]>(await owner.client.get(RFQS).expect(200));
      expect(list).toHaveLength(1);
      expect(list[0]?.kind).toBe('bulk');
      expect(list[0]?.status).toBe('new');

      const prospects = await integration.dataSource.query<{ count: string }[]>(
        'SELECT count(*)::int AS count FROM rfqs WHERE user_id IS NULL',
      );
      expect(Number(prospects[0]?.count)).toBe(2);
    });

    it('covers both kinds, with the gifting row carrying its detail in paise', async () => {
      await seedRfqs(integration.dataSource);

      const rows = await integration.dataSource.query<
        { kind: string; occasion: string | null; budget: string | null }[]
      >(
        `SELECT r.kind, g.occasion, g."budgetPerBoxPaise"::text AS budget
           FROM rfqs r
           LEFT JOIN rfq_gifting_details g ON g.rfq_id = r.id
          WHERE r.kind = 'GIFTING'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.occasion).toBe('Client appreciation');
      expect(rows[0]?.budget).toBe('79900');
    });

    /**
     * The point of drawing numbers from `nextRfqNumber` rather than a literal, proven the way
     * the plan asks: idempotency is what makes `npm run seed -- rfqs` safe to run against a
     * database that already has these fixtures, and it is the property most likely to break
     * silently if a future edit upserts by anything *other* than the number a first run already
     * assigned.
     */
    it('is idempotent: a second run writes no additional rows and keeps the same numbers', async () => {
      await seedRfqs(integration.dataSource);
      const firstRun = await integration.dataSource.query<{ rfqNumber: string }[]>(
        'SELECT "rfqNumber" FROM rfqs ORDER BY "rfqNumber"',
      );

      await seedRfqs(integration.dataSource);
      const secondRun = await integration.dataSource.query<{ rfqNumber: string }[]>(
        'SELECT "rfqNumber" FROM rfqs ORDER BY "rfqNumber"',
      );

      expect(await countRfqs()).toBe(3);
      expect(secondRun.map((row) => row.rfqNumber)).toEqual(firstRun.map((row) => row.rfqNumber));
    });
  });
});
