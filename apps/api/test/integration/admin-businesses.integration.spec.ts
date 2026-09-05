import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type {
  AdminBusiness,
  AdminBusinessSummary,
  AdminCustomer,
  Paginated,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { Rfq } from '../../src/entities/b2b/rfq.entity';
import { CustomerSegment, OrderChannelEnum, RfqKind, UserRole } from '../../src/entities/enums';
import { Address } from '../../src/entities/identity/address.entity';
import { Business } from '../../src/entities/identity/business.entity';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/businesses';
const CUSTOMERS = '/api/v1/admin/customers';

const OK: number = HttpStatus.OK;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;

let rfqSequence = 0;

/**
 * `GET /admin/businesses` and `GET /admin/businesses/:id` — plan 9.3 Task 2, brief §35's B2B
 * profile.
 *
 * What only a real database can answer:
 *
 * - **the aggregates agree with `GET /admin/customers/:id` for the same account.** Both go through
 *   `orderTotalsByUser`, and the assertion below fetches both screens and compares them — the one
 *   failure this surface exists to prevent is two admin screens disagreeing about what one customer
 *   has spent;
 * - **a soft-deleted address reference reads back as absent**, through the same
 *   `BusinessesService.getProfile` the business's own profile page uses, with the row actually
 *   soft-deleted in Postgres;
 * - **the RFQ counts are counts**, over real rows, with `OPEN_RFQ_STATUSES` applied by the database
 *   rather than by a double that answers whatever it is told.
 */
describe('admin business surfaces', () => {
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

  const seedBusiness = async (
    overrides: {
      companyName?: string;
      segment?: CustomerSegment;
      gstin?: string | null;
      contactPerson?: string;
      assignedSalespersonId?: string | null;
    } = {},
  ) => {
    const user = await createTestUser(integration.dataSource, { role: UserRole.BUSINESS });
    const businesses = integration.dataSource.getRepository(Business);
    const business = await businesses.save(
      businesses.create({
        userId: user.id,
        companyName: overrides.companyName ?? 'Anand Sweets',
        contactPerson: overrides.contactPerson ?? 'Ravi Kumar',
        mobile: '9812345670',
        gstin: overrides.gstin === undefined ? '29ABCDE1234F1Z5' : overrides.gstin,
        businessType: 'Sweet shop',
        segment: overrides.segment ?? CustomerSegment.DEFAULT,
        assignedSalespersonId: overrides.assignedSalespersonId ?? null,
      }),
    );
    return { user, business };
  };

  const seedRfq = async (userId: string, status: string): Promise<Rfq> => {
    rfqSequence += 1;
    const rfqs = integration.dataSource.getRepository(Rfq);
    return rfqs.save(
      rfqs.create({
        rfqNumber: `RFQ-2026-8${String(rfqSequence).padStart(5, '0')}`,
        userId,
        kind: RfqKind.BULK,
        businessName: 'Anand Sweets',
        contactPerson: 'Ravi Kumar',
        mobile: '9812345670',
        email: 'ravi@anandsweets.in',
        gstin: null,
        businessType: 'Sweet shop',
        pincode: '560058',
        packaging: 'Vacuum pack',
        frequency: 'Monthly',
        notes: null,
        status,
        assignedSalespersonId: null,
        expectedValuePaise: null,
      }),
    );
  };

  describe('GET /admin/businesses', () => {
    it('refuses an anonymous caller with 401 and a signed-in business with 403', async () => {
      await agent(integration.app).get(BASE).expect(UNAUTHORIZED);
      const { client } = await signIn(UserRole.BUSINESS);
      await client.get(BASE).expect(FORBIDDEN);
    });

    it('lists brief §35’s B2B profile, with no password hash anywhere in the body', async () => {
      const { client } = await asAdmin();
      const { user, business } = await seedBusiness({ segment: CustomerSegment.RETAILER });

      const response = await client.get(BASE).expect(OK);
      const page = expectSuccess<Paginated<AdminBusinessSummary>>(response);

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: business.id,
        userId: user.id,
        companyName: 'Anand Sweets',
        contactPerson: 'Ravi Kumar',
        email: user.email,
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
        segment: 'retailer',
        assignedSalesperson: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('$2b$');
    });

    it('filters by segment and searches company, contact and GSTIN', async () => {
      const { client } = await asAdmin();
      const { business: horeca } = await seedBusiness({
        companyName: 'Blue Tokai Roasters',
        contactPerson: 'Meena Nair',
        gstin: '27ZZZZZ9999Z9Z9',
        segment: CustomerSegment.HORECA,
      });
      await seedBusiness({ companyName: 'Anand Sweets' });

      const banded = expectSuccess<Paginated<AdminBusinessSummary>>(
        await client.get(`${BASE}?segment=horeca`).expect(OK),
      );
      expect(banded.items.map((item) => item.id)).toEqual([horeca.id]);

      for (const q of ['tokai', 'meena', '27ZZZ']) {
        const found = expectSuccess<Paginated<AdminBusinessSummary>>(
          await client.get(`${BASE}?q=${encodeURIComponent(q)}`).expect(OK),
        );
        expect(found.items.map((item) => item.id)).toEqual([horeca.id]);
      }
    });

    it('refuses an undeclared filter rather than ignoring it', async () => {
      const { client } = await asAdmin();
      await client.get(`${BASE}?role=b2b`).expect(BAD_REQUEST);
    });

    it('pages without repeating or losing a business', async () => {
      const { client } = await asAdmin();
      const created = [];
      for (let index = 0; index < 5; index += 1) {
        created.push((await seedBusiness({ companyName: `Firm ${String(index)}` })).business);
      }

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const answered = expectSuccess<Paginated<AdminBusinessSummary>>(
          await client.get(`${BASE}?page=${String(page)}&limit=2`).expect(OK),
        );
        seen.push(...answered.items.map((item) => item.id));
      }

      expect(new Set(seen).size).toBe(5);
      expect(seen.sort()).toEqual(created.map((business) => business.id).sort());
    });

    /**
     * Brief §35's "RFQs" column and the live subset beside it. `approved`, `rejected` and
     * `converted` are the three closed states, so four of the seven are open.
     */
    it('counts every enquiry and the open subset', async () => {
      const { client } = await asAdmin();
      const { user } = await seedBusiness();

      await seedRfq(user.id, 'new');
      await seedRfq(user.id, 'negotiation');
      await seedRfq(user.id, 'converted');
      await seedRfq(user.id, 'rejected');

      const page = expectSuccess<Paginated<AdminBusinessSummary>>(
        await client.get(BASE).expect(OK),
      );
      expect(page.items[0]).toMatchObject({ rfqs: 4, openRfqs: 2 });
    });

    /**
     * **Every channel, and the same rule `GET /admin/customers` applies.** A bulk-only total would
     * make the two screens disagree about the same person, which brief §46's one-account rule makes
     * a routine situation rather than an edge case.
     */
    it('counts orders across both channels and excludes cancelled and refunded from spend', async () => {
      const { client } = await asAdmin();
      const { user } = await seedBusiness();

      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 5000,
        userId: user.id,
        channel: OrderChannelEnum.BULK,
        placedAt: new Date('2026-08-02T10:00:00.000Z'),
      });
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 800,
        userId: user.id,
        channel: OrderChannelEnum.RETAIL,
        placedAt: new Date('2026-08-04T10:00:00.000Z'),
      });
      await createTestOrder(integration.dataSource, {
        status: 'cancelled',
        totalRupees: 1500,
        userId: user.id,
        channel: OrderChannelEnum.BULK,
        placedAt: new Date('2026-08-06T10:00:00.000Z'),
      });

      const page = expectSuccess<Paginated<AdminBusinessSummary>>(
        await client.get(BASE).expect(OK),
      );
      expect(page.items[0]).toMatchObject({
        orders: 3,
        totalSpend: 5800,
        lastOrderAt: '2026-08-06T10:00:00.000Z',
      });
    });

    /** The assertion this whole arrangement exists for: one account, two admin screens, one answer. */
    it('reports the same order figures GET /admin/customers/:id does for the same account', async () => {
      const { client } = await asAdmin();
      const { user } = await seedBusiness();
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 3300,
        userId: user.id,
        channel: OrderChannelEnum.BULK,
      });

      const businesses = expectSuccess<Paginated<AdminBusinessSummary>>(
        await client.get(BASE).expect(OK),
      );
      const customer = expectSuccess<AdminCustomer>(
        await client.get(`${CUSTOMERS}/${user.id}`).expect(OK),
      );

      expect(businesses.items[0]?.orders).toBe(customer.orders);
      expect(businesses.items[0]?.totalSpend).toBe(customer.totalSpend);
      expect(businesses.items[0]?.lastOrderAt).toBe(customer.lastOrderAt);
    });

    /**
     * Brief §35's last column, and the plan's Task 4 says no column exists for it. It does:
     * `businesses.assigned_salesperson_id` and `rfqs.assigned_salesperson_id` have been in the
     * initial schema since 2026-08-19, both `uuid REFERENCES users(id) ON DELETE SET NULL`.
     */
    it('resolves the assigned salesperson from the column that already exists', async () => {
      const { client, user: admin } = await asAdmin();
      await seedBusiness({ assignedSalespersonId: admin.id });

      const page = expectSuccess<Paginated<AdminBusinessSummary>>(
        await client.get(BASE).expect(OK),
      );
      expect(page.items[0]?.assignedSalesperson).toEqual({
        id: admin.id,
        name: admin.name,
        email: admin.email,
      });
    });
  });

  describe('GET /admin/businesses/:id', () => {
    it('resolves both addresses and treats a soft-deleted reference as absent', async () => {
      const { client } = await asAdmin();
      const { user, business } = await seedBusiness();
      const addresses = integration.dataSource.getRepository(Address);

      const billing = await addresses.save(
        addresses.create({
          userId: user.id,
          label: 'Warehouse',
          fullName: 'Ravi Kumar',
          phone: '9812345670',
          email: user.email,
          line1: '9 Industrial Estate',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560058',
          isDefault: true,
        }),
      );
      const shipping = await addresses.save(
        addresses.create({
          userId: user.id,
          label: 'Old depot',
          fullName: 'Ravi Kumar',
          phone: '9812345670',
          email: user.email,
          line1: '4 Church Street',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
          isDefault: false,
          deletedAt: new Date(),
        }),
      );

      await integration.dataSource
        .getRepository(Business)
        .update(
          { id: business.id },
          { billingAddressId: billing.id, shippingAddressId: shipping.id },
        );

      const detail = expectSuccess<AdminBusiness>(
        await client.get(`${BASE}/${business.id}`).expect(OK),
      );

      expect(detail.billingAddress).toMatchObject({ label: 'Warehouse', pincode: '560058' });
      // The reference is still on the row; the address is soft-deleted, so it reads back as absent.
      expect(detail.shippingAddress).toBeNull();
    });

    it('answers 404 for an unknown uuid and 400 for a non-uuid', async () => {
      const { client } = await asAdmin();
      const refusal = expectError(
        await client.get(`${BASE}/b0000000-0000-4000-8000-0000000000ff`).expect(NOT_FOUND),
      );
      expect(refusal.code).toBe('NOT_FOUND');
      await client.get(`${BASE}/not-a-uuid`).expect(BAD_REQUEST);
    });

    /** The account's uuid addresses `GET /admin/customers/:id`; this resource is keyed by the
     * business's own. One uuid reaching two resources would answer the wrong screen. */
    it('is not addressable by the account’s uuid', async () => {
      const { client } = await asAdmin();
      const { user } = await seedBusiness();
      await client.get(`${BASE}/${user.id}`).expect(NOT_FOUND);
    });
  });
});
