import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AccountOrder, BusinessProfile, BusinessStats, SavedAddress } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedOrders } from '../../src/database/seeds/orders.seed';
import { seedRfqs } from '../../src/database/seeds/rfqs.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
} from './helpers';

/**
 * `GET`/`PUT /business/me` (Task 15), `GET /business/stats` (Task 16) and `GET /business/orders`
 * (Task 17) against real Postgres.
 *
 * `seedUsers` already seeds a `Business` row for `b2b@demo.in` with both address references
 * pointing at the same seeded `Warehouse` address (`users.seed.ts`'s `upsertBusiness`, written
 * before Task 15 existed) — this file's `me` fixture is that seed, not a bespoke one.
 *
 * **Why the address-ownership tests need a database and cannot be modelled in the unit suite
 * alone.** The unit suite (`businesses.service.spec.ts`) proves the *query shape* — `userId` in
 * the predicate, `deletedAt IS NULL` — against a hand-built double. What only Postgres can prove
 * is that a soft-deleted row created through the real `DELETE /account/addresses/:id` endpoint,
 * with its own default-promotion side effects, is the row this endpoint then treats as absent.
 *
 * **Why the stats tests need one too.** `business-stats.service.spec.ts` proves `forUser` sends
 * the right `where` and the right SQL text against mocked collaborators; it cannot prove the
 * *aggregate arithmetic* is right, because its `dataSource.query` mock answers whatever the test
 * tells it to. Only a real `SUM()` over the real seeded order — asked for independently, by a
 * raw query this file writes itself — can prove the two agree.
 */
const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'nn_csrf';

const ME = '/api/v1/business/me';
const STATS = '/api/v1/business/stats';
const ORDERS = '/api/v1/business/orders';
const ACCOUNT_ORDERS = '/api/v1/account/orders';
const REGISTER = '/api/v1/auth/register';
const ADDRESSES = '/api/v1/account/addresses';
const LOGIN = '/api/v1/auth/login';

const B2C = 'b2c@demo.in';
const B2B = 'b2b@demo.in';

const OK: number = HttpStatus.OK;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;

/** A `PUT /business/me` body every field of which is legal — the form's own shape. */
const VALID_UPDATE = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  gstin: '29ABCDE1234F1Z5',
  businessType: 'Sweet shop',
  billingAddressId: null as string | null,
  shippingAddressId: null as string | null,
};

describe('GET/PUT /business/me', () => {
  const integration = useIntegrationApp();

  /** Same reason `addresses.integration.spec.ts` clears it: `POST /auth/login` is capped at
   * five attempts per fifteen minutes per IP, and this file signs in well over five times. */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedUsers(integration.dataSource);
  });

  async function signedIn(email: string) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(OK);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  type Client = Awaited<ReturnType<typeof signedIn>>['client'];

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo — `cart.integration.
   * spec.ts`'s own `guest()` helper. A cold write can never succeed: `CsrfGuard` requires both the
   * cookie and a matching header, and a brand-new client has neither until one safe-method request
   * has run `CsrfBootstrapMiddleware`. Without this, "anonymous write" and "no CSRF token" would be
   * the same test wearing two names — the guard answers 403 for both, and 401 is unreachable for a
   * write until the token is primed first.
   */
  async function anonymous() {
    const client = agent(integration.app);
    const primer = await client.get(ME);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  /** A fresh, non-default address in the caller's own book — `POST /account/addresses`'s own
   * response is the whole book, so the newest entry is the one this fixture just created. */
  async function ownAddress(client: Client, csrf: string, label: string): Promise<SavedAddress> {
    const body = {
      label,
      fullName: 'Rakesh Anand',
      phone: '9845012345',
      email: 'purchase@anandsweets.example',
      line1: '4 New Estate Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560099',
      isDefault: false,
    };
    const response = await client.post(ADDRESSES).set(CSRF_HEADER, csrf).send(body).expect(201);
    const book = expectSuccess<SavedAddress[]>(response);
    const created = book.find((address) => address.label === label);
    if (created === undefined) throw new Error(`ownAddress: ${label} was not created`);
    return created;
  }

  describe('GET /business/me', () => {
    it('answers the seeded profile, with both addresses resolved to the same seeded row', async () => {
      const { client } = await signedIn(B2B);

      const profile = expectSuccess<BusinessProfile>(await client.get(ME).expect(OK));

      expect(profile).toMatchObject({
        companyName: 'Anand Sweets & Namkeen',
        contactPerson: 'Rakesh Anand',
        mobile: '9845012345',
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
      });
      expect(profile.billingAddress?.label).toBe('Warehouse');
      expect(profile.shippingAddress?.label).toBe('Warehouse');
    });

    it('publishes neither segment nor assignedSalespersonId', async () => {
      const { client } = await signedIn(B2B);

      const response = await client.get(ME).expect(OK);

      const text = JSON.stringify(response.body);
      expect(text).not.toContain('segment');
      expect(text).not.toContain('assignedSalesperson');
    });

    it('refuses an anonymous read with 401', async () => {
      const response = await request(integration.app).get(ME).expect(UNAUTHORIZED);
      expect(expectError(response).message).toBe('Unauthorized');
    });

    it('refuses a CUSTOMER-role caller with 403, not a business record that happens to be empty', async () => {
      const { client } = await signedIn(B2C);
      await client.get(ME).expect(FORBIDDEN);
    });
  });

  describe('PUT /business/me', () => {
    it('replaces the profile and answers with what was saved, addresses resolved', async () => {
      const { client, csrf } = await signedIn(B2B);
      const address = await ownAddress(client, csrf, 'Second warehouse');

      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, billingAddressId: address.id, shippingAddressId: address.id })
        .expect(OK);

      const profile = expectSuccess<BusinessProfile>(response);
      expect(profile.billingAddress?.id).toBe(address.id);
      expect(profile.shippingAddress?.id).toBe(address.id);

      const reread = expectSuccess<BusinessProfile>(await client.get(ME).expect(OK));
      expect(reread.billingAddress?.id).toBe(address.id);
    });

    it('refuses an empty mobile with 400', async () => {
      const { client, csrf } = await signedIn(B2B);
      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, mobile: '' })
        .expect(BAD_REQUEST);
      expect(expectError(response).details).toHaveProperty('mobile');
    });

    it('refuses a malformed mobile with 400', async () => {
      const { client, csrf } = await signedIn(B2B);
      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, mobile: '12345' })
        .expect(BAD_REQUEST);
      expect(expectError(response).details).toHaveProperty('mobile');
    });

    it("rejects another customer's address id rather than silently accepting it", async () => {
      const { client: b2c } = await signedIn(B2C);
      const homeRow = expectSuccess<SavedAddress[]>(await b2c.get(ADDRESSES).expect(OK)).find(
        (address) => address.label === 'Home',
      );
      if (homeRow === undefined) throw new Error('b2c has no Home address to borrow the id of');

      const { client, csrf } = await signedIn(B2B);
      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, billingAddressId: homeRow.id })
        .expect(NOT_FOUND);
      expect(expectError(response).message).toContain(homeRow.id);

      // Nothing was written — the seeded reference still resolves to the seeded address.
      const reread = expectSuccess<BusinessProfile>(await client.get(ME).expect(OK));
      expect(reread.billingAddress?.label).toBe('Warehouse');
    });

    it('rejects a soft-deleted address id', async () => {
      const { client, csrf } = await signedIn(B2B);
      const address = await ownAddress(client, csrf, 'Soon deleted');
      await client.delete(`${ADDRESSES}/${address.id}`).set(CSRF_HEADER, csrf).expect(OK);

      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, shippingAddressId: address.id })
        .expect(NOT_FOUND);
      expect(expectError(response).message).toContain(address.id);
    });

    it('refuses a non-uuid address id with 400, not a 500 from a malformed query', async () => {
      const { client, csrf } = await signedIn(B2B);
      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, billingAddressId: 'adr-b2c-home' })
        .expect(BAD_REQUEST);
      expect(expectError(response).details).toHaveProperty('billingAddressId');
    });

    it('cannot change segment or assignedSalespersonId — forbidNonWhitelisted refuses both', async () => {
      const { client, csrf } = await signedIn(B2B);

      const segmentAttempt = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, segment: 'retailer' })
        .expect(BAD_REQUEST);
      expect(expectError(segmentAttempt).details).toHaveProperty('segment');

      const salespersonAttempt = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send({ ...VALID_UPDATE, assignedSalespersonId: '123e4567-e89b-12d3-a456-426614174000' })
        .expect(BAD_REQUEST);
      expect(expectError(salespersonAttempt).details).toHaveProperty('assignedSalespersonId');
    });

    it('refuses an anonymous write with 401, once the CSRF check itself is satisfied', async () => {
      const { client, csrf } = await anonymous();
      const response = await client
        .put(ME)
        .set(CSRF_HEADER, csrf)
        .send(VALID_UPDATE)
        .expect(UNAUTHORIZED);
      expect(expectError(response).message).toBe('Unauthorized');
    });

    it('refuses a CUSTOMER-role caller with 403', async () => {
      const { client, csrf } = await signedIn(B2C);
      await client.put(ME).set(CSRF_HEADER, csrf).send(VALID_UPDATE).expect(FORBIDDEN);
    });

    it('refuses a write with no CSRF token with 403, before the DTO is even validated', async () => {
      const { client } = await signedIn(B2B);
      await client.put(ME).send(VALID_UPDATE).expect(FORBIDDEN);
    });
  });

  describe('GET /business/stats', () => {
    beforeEach(async () => {
      await seedSettings(integration.dataSource);
      await seedCatalog(integration.dataSource);
      await seedOrders(integration.dataSource);
      await seedRfqs(integration.dataSource);
    });

    /** Every order `orders.seed.ts` gives `b2b@demo.in` — `NN-2026-005042` (shipped) and
     * `NN-2026-004488` (delivered), both open under `B2B_ORDER_STATUSES` and both bulk. */
    const BULK_ORDER_NUMBERS = ['NN-2026-005042', 'NN-2026-004488'];

    const rawTotalPaise = async (orderNumber: string): Promise<bigint> => {
      const rows = await integration.dataSource.query<{ totalPaise: string }[]>(
        'SELECT "totalPaise" FROM orders WHERE "orderNumber" = $1',
        [orderNumber],
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`orders.seed did not create ${orderNumber}`);
      return BigInt(row.totalPaise);
    };

    it("answers the seeded business's real order count, open-RFQ count and spend", async () => {
      const { client } = await signedIn(B2B);

      const stats = expectSuccess<BusinessStats>(await client.get(STATS).expect(OK));

      expect(stats.bulkOrders).toBe(BULK_ORDER_NUMBERS.length);
      const totalPaise = (await Promise.all(BULK_ORDER_NUMBERS.map(rawTotalPaise))).reduce(
        (sum, paise) => sum + paise,
        0n,
      );
      expect(stats.bulkSpend).toBeCloseTo(Number(totalPaise) / 100, 6);
      // Anand Sweets & Namkeen's seeded enquiry — status 'new', one of the four open states.
      expect(stats.openRfqs).toBe(1);
    });

    it('answers zero for every figure on a fresh business with no history at all', async () => {
      const client = agent(integration.app);
      const registration = await client.post(REGISTER).send({
        name: 'Nasreen Qureshi',
        email: 'nasreen@freshbiz.example',
        phone: '9812345670',
        password: 'Password123!',
        isBusiness: true,
        company: {
          companyName: 'Fresh Biz Traders',
          contactPerson: 'Nasreen Qureshi',
          businessType: 'Distributor',
        },
      });
      expect(registration.status).toBe(201);

      const stats = expectSuccess<BusinessStats>(await client.get(STATS).expect(OK));
      expect(stats).toEqual({ openRfqs: 0, bulkSpend: 0, bulkOrders: 0 });
    });

    it("does not count another business's orders or enquiries", async () => {
      const client = agent(integration.app);
      await client.post(REGISTER).send({
        name: 'Nasreen Qureshi',
        email: 'nasreen2@freshbiz.example',
        phone: '9812345671',
        password: 'Password123!',
        isBusiness: true,
        company: {
          companyName: 'Fresh Biz Traders',
          contactPerson: 'Nasreen Qureshi',
          businessType: 'Distributor',
        },
      });

      const stats = expectSuccess<BusinessStats>(await client.get(STATS).expect(OK));
      expect(stats.bulkOrders).toBe(0);
      expect(stats.openRfqs).toBe(0);

      const { client: b2bClient } = await signedIn(B2B);
      const b2bStats = expectSuccess<BusinessStats>(await b2bClient.get(STATS).expect(OK));
      expect(b2bStats.bulkOrders).toBe(2);
      expect(b2bStats.openRfqs).toBe(1);
    });

    it('refuses an anonymous read with 401', async () => {
      await request(integration.app).get(STATS).expect(UNAUTHORIZED);
    });

    it('refuses a CUSTOMER-role caller with 403', async () => {
      const { client } = await signedIn(B2C);
      await client.get(STATS).expect(FORBIDDEN);
    });
  });

  describe('GET /business/orders', () => {
    beforeEach(async () => {
      await seedSettings(integration.dataSource);
      await seedCatalog(integration.dataSource);
      await seedOrders(integration.dataSource);
    });

    /**
     * The assertion that makes the delegation real, `orders.module.ts`'s own words for it: a
     * hand-written query here that differed from `OrdersService.list` in *any* respect — a
     * missing relation, a different order, a dropped filter — would answer something other than
     * what `GET /account/orders?channel=bulk` already answers for the identical caller, and
     * deep equality is what a figure-by-figure comparison could miss.
     */
    it('answers deep-equal to GET /account/orders?channel=bulk, for the same caller', async () => {
      const { client } = await signedIn(B2B);

      const viaBusiness = expectSuccess<AccountOrder[]>(await client.get(ORDERS).expect(OK));
      const viaAccount = expectSuccess<AccountOrder[]>(
        await client.get(`${ACCOUNT_ORDERS}?channel=bulk`).expect(OK),
      );

      expect(viaBusiness).toEqual(viaAccount);
      expect(viaBusiness.length).toBeGreaterThan(0);
    });

    /** `b2c@demo.in`'s four seeded orders are all `RETAIL` — the fixture that can actually
     * prove a channel filter is applied, rather than merely that nothing came back. */
    it('never returns a retail order', async () => {
      const { client } = await signedIn(B2B);

      const orders = expectSuccess<AccountOrder[]>(await client.get(ORDERS).expect(OK));

      expect(orders.every((order) => order.channel === 'bulk')).toBe(true);
    });

    it('answers an empty list for a business with no bulk orders', async () => {
      const client = agent(integration.app);
      await client.post(REGISTER).send({
        name: 'Nasreen Qureshi',
        email: 'nasreen3@freshbiz.example',
        phone: '9812345672',
        password: 'Password123!',
        isBusiness: true,
        company: {
          companyName: 'Fresh Biz Traders',
          contactPerson: 'Nasreen Qureshi',
          businessType: 'Distributor',
        },
      });

      const orders = expectSuccess<AccountOrder[]>(await client.get(ORDERS).expect(OK));
      expect(orders).toEqual([]);
    });

    it('refuses an anonymous read with 401', async () => {
      await request(integration.app).get(ORDERS).expect(UNAUTHORIZED);
    });

    it('refuses a CUSTOMER-role caller with 403', async () => {
      const { client } = await signedIn(B2C);
      await client.get(ORDERS).expect(FORBIDDEN);
    });
  });
});
