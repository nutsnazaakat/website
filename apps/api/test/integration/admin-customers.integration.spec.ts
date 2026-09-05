import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminCustomer, AdminCustomerSummary, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { CustomerSegment, OrderChannelEnum, UserRole } from '../../src/entities/enums';
import { Address } from '../../src/entities/identity/address.entity';
import { Business } from '../../src/entities/identity/business.entity';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/customers';

const OK: number = HttpStatus.OK;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;

/**
 * `GET /admin/customers` and `GET /admin/customers/:id` — plan 9.3 Task 1, brief §35.
 *
 * What only a real database can answer:
 *
 * - **the password hash never reaches the wire.** `admin-customer.mapper.spec.ts` proves the mapper
 *   omits it from a row that carries it; only a real request proves that the whole stack — the
 *   repository's `select: false`, the mapper, the serialiser — agrees, because the hash is a real
 *   column with a real bcrypt value in it here;
 * - **the aggregates are the aggregates.** The unit suite's `dataSource.query` double answers
 *   whatever the test tells it to. Only a real `SUM` over real orders can prove that `totalSpend`
 *   excludes `cancelled` and `refunded` while `orders` counts them;
 * - **paging is stable across a batch written in one transaction**, where `@CreateDateColumn`
 *   stamps one timestamp on every row and the tiebreak is the only thing separating them.
 */
describe('admin customer surfaces', () => {
  const integration = useIntegrationApp();

  /** See `inventory.integration.spec.ts` — one app per file, so the throttler is shared. */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  const signIn = async (role: UserRole) => {
    const user = await createTestUser(integration.dataSource, { role });
    const client = agent(integration.app);
    const login = await client
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(OK);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);

  const b2bAccount = async (
    overrides: { companyName?: string; segment?: CustomerSegment } = {},
  ) => {
    const user = await createTestUser(integration.dataSource, {
      role: UserRole.BUSINESS,
      name: 'Ravi Kumar',
    });
    const businesses = integration.dataSource.getRepository(Business);
    const business = await businesses.save(
      businesses.create({
        userId: user.id,
        companyName: overrides.companyName ?? 'Sweet Centre',
        contactPerson: 'Ravi Kumar',
        mobile: '9812345670',
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
        segment: overrides.segment ?? CustomerSegment.RETAILER,
      }),
    );
    return { user, business };
  };

  describe('GET /admin/customers', () => {
    it('refuses an anonymous caller with 401 and a signed-in customer with 403', async () => {
      await agent(integration.app).get(BASE).expect(UNAUTHORIZED);

      const { client } = await signIn(UserRole.CUSTOMER);
      await client.get(BASE).expect(FORBIDDEN);
    });

    /**
     * The filter that keeps this list agreeing with `GET /admin/dashboard`'s `customers` card,
     * which counts `role <> 'ADMIN'`. The signed-in admin is itself the row that must not appear.
     */
    it('lists customers and businesses but never an admin', async () => {
      const { client, user: admin } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const { user: businessUser } = await b2bAccount();

      const page = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(BASE).expect(OK),
      );

      const ids = page.items.map((item) => item.id);
      expect(ids).toContain(customer.id);
      expect(ids).toContain(businessUser.id);
      expect(ids).not.toContain(admin.id);
      expect(page.total).toBe(2);
    });

    /**
     * **The disclosure case.** `users.passwordHash` holds a real bcrypt hash here, and the response
     * is searched as raw JSON rather than by key so a hash nested under any field — a business
     * record, an address — would fail this too.
     */
    it('publishes no password hash anywhere in the body', async () => {
      const { client } = await asAdmin();
      await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });

      const response = await client.get(BASE).expect(OK);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('$2b$');
    });

    it('filters by role', async () => {
      const { client } = await asAdmin();
      await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const { user: businessUser } = await b2bAccount();

      const b2b = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?role=b2b`).expect(OK),
      );
      expect(b2b.items.map((item) => item.id)).toEqual([businessUser.id]);

      const b2c = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?role=b2c`).expect(OK),
      );
      expect(b2c.items.map((item) => item.id)).not.toContain(businessUser.id);
    });

    it('searches name, email and phone', async () => {
      const { client } = await asAdmin();
      const target = await createTestUser(integration.dataSource, {
        name: 'Meenakshi Iyer',
        email: 'meenakshi@demo.in',
        phone: '9000011111',
      });
      await createTestUser(integration.dataSource, { name: 'Someone Else' });

      for (const q of ['meenak', 'MEENAKSHI@DEMO.IN', '900001']) {
        const page = expectSuccess<Paginated<AdminCustomerSummary>>(
          await client.get(`${BASE}?q=${encodeURIComponent(q)}`).expect(OK),
        );
        expect(page.items.map((item) => item.id)).toEqual([target.id]);
      }
    });

    it('refuses ?role=admin rather than enumerating operator accounts', async () => {
      const { client } = await asAdmin();
      const refusal = expectError(await client.get(`${BASE}?role=admin`).expect(BAD_REQUEST));
      expect(refusal.details).toHaveProperty('role');
    });

    it('refuses an undeclared filter rather than ignoring it', async () => {
      const { client } = await asAdmin();
      await client.get(`${BASE}?segment=retailer`).expect(BAD_REQUEST);
    });

    /**
     * Every account here is written inside one transaction per statement but within milliseconds,
     * and `users.createdAt` carries no unique constraint — so `id DESC` is the only thing making
     * two pages disjoint. Without it a row appears twice and another disappears.
     */
    it('pages without repeating or losing a customer', async () => {
      const { client } = await asAdmin();
      const created = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER }));
      }

      const first = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?page=1&limit=2`).expect(OK),
      );
      const second = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?page=2&limit=2`).expect(OK),
      );
      const third = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?page=3&limit=2`).expect(OK),
      );

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(5);
      expect(seen.sort()).toEqual(created.map((user) => user.id).sort());
      expect(first.total).toBe(5);
    });

    /**
     * Brief §35's list columns, and the pair that pull in opposite directions on purpose: revenue
     * must agree with what the customer's own account page already tells them for the same orders,
     * while the count must agree with `GET /admin/orders`, which lists every status.
     */
    it('counts every order but excludes cancelled and refunded from spend', async () => {
      const { client } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });

      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 1200,
        userId: customer.id,
        placedAt: new Date('2026-08-01T10:00:00.000Z'),
      });
      await createTestOrder(integration.dataSource, {
        status: 'cancelled',
        totalRupees: 900,
        userId: customer.id,
        placedAt: new Date('2026-08-05T10:00:00.000Z'),
      });
      await createTestOrder(integration.dataSource, {
        status: 'refunded',
        totalRupees: 700,
        userId: customer.id,
        placedAt: new Date('2026-08-09T10:00:00.000Z'),
      });

      const page = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?q=${encodeURIComponent(customer.email)}`).expect(OK),
      );

      expect(page.items[0]).toMatchObject({
        orders: 3,
        totalSpend: 1200,
        // The *latest* order, whatever its status — an operator asking "when did we last hear from
        // them" is not asking about revenue.
        lastOrderAt: '2026-08-09T10:00:00.000Z',
      });
    });

    it('answers zero and null for a customer who has never ordered', async () => {
      const { client } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });

      const page = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?q=${encodeURIComponent(customer.email)}`).expect(OK),
      );
      expect(page.items[0]).toMatchObject({ orders: 0, totalSpend: 0, lastOrderAt: null });
    });
  });

  describe('GET /admin/customers/:id', () => {
    it('answers the customer, their live addresses and no password hash', async () => {
      const { client } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const addresses = integration.dataSource.getRepository(Address);
      await addresses.save(
        addresses.create({
          userId: customer.id,
          label: 'Home',
          fullName: 'Asha Rao',
          phone: '9876543210',
          email: customer.email,
          line1: '12 Residency Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560025',
          isDefault: true,
        }),
      );
      const deleted = await addresses.save(
        addresses.create({
          userId: customer.id,
          label: 'Old flat',
          fullName: 'Asha Rao',
          phone: '9876543210',
          email: customer.email,
          line1: '4 Church Street',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
          isDefault: false,
          deletedAt: new Date(),
        }),
      );

      const response = await client.get(`${BASE}/${customer.id}`).expect(OK);
      const detail = expectSuccess<AdminCustomer>(response);

      expect(detail.id).toBe(customer.id);
      expect(detail.role).toBe('b2c');
      expect(detail.business).toBeNull();
      expect(detail.addresses.map((address) => address.label)).toEqual(['Home']);
      expect(detail.addresses.map((address) => address.id)).not.toContain(deleted.id);
      expect(JSON.stringify(response.body)).not.toContain('$2b$');

      /**
       * **The key list, not only the hash**, and the difference was measured: `users.passwordHash`
       * is `select: false`, so a mapper written as `{ ...user }` leaks *nothing* through this route
       * today and the `$2b$` assertion above passes under exactly the mutation it is meant to
       * catch. What a spread does leak here is `updatedAt` — and the day any query in that module
       * reaches for `addSelect('user.passwordHash')` it would leak the hash too, silently. So the
       * shape is asserted whole, which fails on the spread rather than on the consequence of it.
       * `admin-customer.mapper.spec.ts` catches the same mutation from the other side, with a
       * fixture that does carry the hash.
       */
      expect(Object.keys(detail).sort()).toEqual([
        'addresses',
        'business',
        'createdAt',
        'email',
        'id',
        'isActive',
        'lastLoginAt',
        'lastOrderAt',
        'name',
        'orders',
        'phone',
        'role',
        'totalSpend',
      ]);
    });

    it('carries the business record and its segment for a b2b account', async () => {
      const { client } = await asAdmin();
      const { user, business } = await b2bAccount({ segment: CustomerSegment.DISTRIBUTOR });

      const detail = expectSuccess<AdminCustomer>(
        await client.get(`${BASE}/${user.id}`).expect(OK),
      );

      expect(detail.role).toBe('b2b');
      expect(detail.business).toEqual({
        id: business.id,
        companyName: 'Sweet Centre',
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
        segment: 'distributor',
      });
    });

    it('reports the same figures the list row does for the same account', async () => {
      const { client } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 2500,
        userId: customer.id,
        channel: OrderChannelEnum.BULK,
      });

      const page = expectSuccess<Paginated<AdminCustomerSummary>>(
        await client.get(`${BASE}?q=${encodeURIComponent(customer.email)}`).expect(OK),
      );
      const detail = expectSuccess<AdminCustomer>(
        await client.get(`${BASE}/${customer.id}`).expect(OK),
      );

      expect(detail.orders).toBe(page.items[0]?.orders);
      expect(detail.totalSpend).toBe(page.items[0]?.totalSpend);
      expect(detail.lastOrderAt).toBe(page.items[0]?.lastOrderAt);
    });

    it('answers 404 for an unknown uuid', async () => {
      const { client } = await asAdmin();
      const refusal = expectError(
        await client.get(`${BASE}/f0000000-0000-4000-8000-0000000000ff`).expect(NOT_FOUND),
      );
      expect(refusal.code).toBe('NOT_FOUND');
    });

    /**
     * An operator account is not a customer, and the refusal must be indistinguishable from the one
     * an unknown uuid gets — otherwise this endpoint is an oracle for which uuids are admins.
     */
    it('answers an identical 404 for an admin account', async () => {
      const { client, user: admin } = await asAdmin();

      const unknown = expectError(
        await client.get(`${BASE}/f0000000-0000-4000-8000-0000000000ff`).expect(NOT_FOUND),
      );
      const operator = expectError(await client.get(`${BASE}/${admin.id}`).expect(NOT_FOUND));

      expect(operator.code).toBe(unknown.code);
      expect(operator.message).toBe(unknown.message);
    });

    it('answers 400 for a reference that is not a uuid', async () => {
      const { client } = await asAdmin();
      await client.get(`${BASE}/not-a-uuid`).expect(BAD_REQUEST);
    });
  });
});
