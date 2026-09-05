import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminPricingTier, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { PricingTier } from '../../src/entities/catalog/pricing-tier.entity';
import { CustomerSegment, UserRole } from '../../src/entities/enums';
import { Business } from '../../src/entities/identity/business.entity';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectStatus, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/pricing-tiers';
const CSRF_HEADER = 'X-CSRF-Token';

const OK: number = HttpStatus.OK;
const CREATED: number = HttpStatus.CREATED;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;
const CONFLICT: number = HttpStatus.CONFLICT;

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string;
}

/**
 * `GET`, `POST` and `PATCH /admin/pricing-tiers` — plan 9.3 Task 5, brief §31.
 *
 * What only a real database can answer:
 *
 * - **the overlap predicate is evaluated in `numeric`**, over columns that are `numeric(8,2)`,
 *   rather than in JavaScript floats against strings a fixture invented. Every boundary case below
 *   — touching ranges, an open-ended top slab, a rung entirely inside another — is decided by
 *   Postgres;
 * - **the scope predicate really is `resolveTiers`' grouping**: a business's `DEFAULT` and
 *   `RETAILER` rungs collide, and two unscoped rungs in different bands do not. A double could be
 *   told either answer;
 * - **the audit row and the write are one transaction**, and a refused write leaves neither.
 */
describe('admin pricing tier surfaces', () => {
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

  /**
   * **`seedCatalog` ships real ladders** — `catalog.seed.ts` writes brief §16's 1–4 / 5–9 / 10–24 /
   * 25–49 / 50+ rungs for every bulk product — and every case below is about which rungs exist.
   * Clearing them is what makes this file's fixtures the whole population, so a `total` or an
   * overlap refusal measures what the test set up rather than what the seeder happened to leave.
   *
   * Called from each block's own `beforeEach` rather than the file's, so the block above it can ask
   * the one question that needs the seeded data intact.
   */
  const clearSeededLadders = async (): Promise<void> => {
    await integration.dataSource.query('DELETE FROM pricing_tiers');
  };

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

  /** A seeded product, so a tier has a real `product_id` to hang off and the `FOR UPDATE` lock has
   * a real row to take. */
  const seededProduct = async (): Promise<{ id: string; slug: string; name: string }> => {
    const [row] = await integration.dataSource.query<{ id: string; slug: string; name: string }[]>(
      'SELECT id, slug, name FROM products ORDER BY slug LIMIT 1',
    );
    if (row === undefined) throw new Error('seedCatalog produced no product');
    return row;
  };

  const secondProduct = async (): Promise<{ id: string; slug: string }> => {
    const [row] = await integration.dataSource.query<{ id: string; slug: string }[]>(
      'SELECT id, slug FROM products ORDER BY slug OFFSET 1 LIMIT 1',
    );
    if (row === undefined) throw new Error('seedCatalog produced only one product');
    return row;
  };

  const seedBusiness = async (): Promise<Business> => {
    const user = await createTestUser(integration.dataSource, { role: UserRole.BUSINESS });
    const businesses = integration.dataSource.getRepository(Business);
    return businesses.save(
      businesses.create({
        userId: user.id,
        companyName: 'Anand Sweets',
        contactPerson: 'Ravi Kumar',
        mobile: '9812345670',
        gstin: null,
        businessType: 'Sweet shop',
        segment: CustomerSegment.RETAILER,
      }),
    );
  };

  /** Written directly, so the fixtures this file's overlap cases stand on do not depend on the
   * endpoint under test. */
  const seedTier = async (input: {
    productId: string;
    minKg: string;
    maxKg: string | null;
    pricePerKgPaise?: bigint | null;
    segment?: CustomerSegment;
    businessId?: string | null;
  }): Promise<PricingTier> => {
    const tiers = integration.dataSource.getRepository(PricingTier);
    return tiers.save(
      tiers.create({
        productId: input.productId,
        minKg: input.minKg,
        maxKg: input.maxKg,
        pricePerKgPaise: input.pricePerKgPaise ?? 62_000n,
        segment: input.segment ?? CustomerSegment.DEFAULT,
        businessId: input.businessId ?? null,
      }),
    );
  };

  const auditRows = async (): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", before, after, actor_user_id
         FROM audit_logs ORDER BY "createdAt", action`,
    );

  const tierCount = async (): Promise<number> => {
    const [row] = await integration.dataSource.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM pricing_tiers',
    );
    return row?.count ?? 0;
  };

  /**
   * **The rule this milestone introduces has to be true of the data that already exists**, or it is
   * a rule the operator cannot satisfy: every seeded ladder would be un-editable, because a `PATCH`
   * re-checks the merged rung and would find the row beside it. Asserted directly against the
   * seeder's own output rather than by reading `catalog.seed.ts`, so a later change to those bands
   * fails here rather than in production.
   */
  describe('the ladders that already exist', () => {
    it('has no overlapping rungs to begin with', async () => {
      const clashes = await integration.dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count
           FROM pricing_tiers a
           JOIN pricing_tiers b
             ON b.id <> a.id
            AND b.product_id = a.product_id
            AND (
                  (a.business_id IS NOT NULL AND b.business_id = a.business_id)
               OR (a.business_id IS NULL AND b.business_id IS NULL AND b.segment = a.segment)
                )
            AND (a."maxKg" IS NULL OR b."minKg" <= a."maxKg")
            AND (b."maxKg" IS NULL OR a."minKg" <= b."maxKg")`,
      );
      expect(clashes[0]?.count).toBe(0);
    });

    /** And the corollary: a seeded rung can be edited without being refused by its own neighbours. */
    it('lets a seeded rung change its price', async () => {
      const { client, csrf } = await asAdmin();
      const [row] = await integration.dataSource.query<{ id: string }[]>(
        'SELECT id FROM pricing_tiers ORDER BY "minKg" LIMIT 1',
      );
      if (row === undefined) throw new Error('seedCatalog produced no pricing tier');

      await client
        .patch(`${BASE}/${row.id}`)
        .set(CSRF_HEADER, csrf)
        .send({ pricePerKg: 501 })
        .expect(OK);
    });
  });

  describe('GET /admin/pricing-tiers', () => {
    beforeEach(clearSeededLadders);

    it('refuses an anonymous caller with 401 and a signed-in customer with 403', async () => {
      await agent(integration.app).get(BASE).expect(UNAUTHORIZED);
      const { client } = await signIn(UserRole.CUSTOMER);
      await client.get(BASE).expect(FORBIDDEN);
    });

    it('answers a ladder, product and business named on every rung', async () => {
      const { client } = await asAdmin();
      const product = await seededProduct();
      const business = await seedBusiness();
      await seedTier({ productId: product.id, minKg: '1.00', maxKg: '4.00' });
      await seedTier({
        productId: product.id,
        minKg: '5.00',
        maxKg: null,
        businessId: business.id,
        segment: CustomerSegment.RETAILER,
      });

      const page = expectSuccess<Paginated<AdminPricingTier>>(
        await client.get(`${BASE}?productId=${product.id}`).expect(OK),
      );

      expect(page.total).toBe(2);
      expect(page.items[0]).toMatchObject({
        productId: product.id,
        productSlug: product.slug,
        productName: product.name,
        minKg: 1,
        maxKg: 4,
        pricePerKg: 620,
        segment: 'default',
        businessId: null,
        companyName: null,
      });
      expect(page.items[1]).toMatchObject({
        minKg: 5,
        maxKg: null,
        segment: 'retailer',
        businessId: business.id,
        companyName: 'Anand Sweets',
      });
    });

    it('filters by band and by business, with "none" for the unscoped rungs', async () => {
      const { client } = await asAdmin();
      const product = await seededProduct();
      const business = await seedBusiness();
      const listed = await seedTier({ productId: product.id, minKg: '1.00', maxKg: '4.00' });
      const banded = await seedTier({
        productId: product.id,
        minKg: '1.00',
        maxKg: '4.00',
        segment: CustomerSegment.HORECA,
      });
      const negotiated = await seedTier({
        productId: product.id,
        minKg: '1.00',
        maxKg: '4.00',
        businessId: business.id,
      });

      const horeca = expectSuccess<Paginated<AdminPricingTier>>(
        await client.get(`${BASE}?segment=horeca`).expect(OK),
      );
      expect(horeca.items.map((item) => item.id)).toEqual([banded.id]);

      const mine = expectSuccess<Paginated<AdminPricingTier>>(
        await client.get(`${BASE}?businessId=${business.id}`).expect(OK),
      );
      expect(mine.items.map((item) => item.id)).toEqual([negotiated.id]);

      const unscoped = expectSuccess<Paginated<AdminPricingTier>>(
        await client.get(`${BASE}?businessId=none`).expect(OK),
      );
      expect(unscoped.items.map((item) => item.id).sort()).toEqual([listed.id, banded.id].sort());
    });

    it('refuses an undeclared filter rather than ignoring it', async () => {
      const { client } = await asAdmin();
      await client.get(`${BASE}?minKg=10`).expect(BAD_REQUEST);
    });

    /** Unlike every other admin list, the natural ordering key here can legitimately repeat — two
     * rungs on different products can share a `minKg` — so `id` is what makes the order total. */
    it('pages without repeating or losing a rung', async () => {
      const { client } = await asAdmin();
      const product = await seededProduct();
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const from = index * 10;
        created.push(
          (
            await seedTier({
              productId: product.id,
              minKg: `${String(from)}.00`,
              maxKg: `${String(from + 9)}.00`,
            })
          ).id,
        );
      }

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const answered = expectSuccess<Paginated<AdminPricingTier>>(
          await client.get(`${BASE}?page=${String(page)}&limit=2`).expect(OK),
        );
        seen.push(...answered.items.map((item) => item.id));
      }

      expect(new Set(seen).size).toBe(5);
      expect(seen.sort()).toEqual([...created].sort());
    });
  });

  describe('POST /admin/pricing-tiers', () => {
    beforeEach(clearSeededLadders);

    it('creates a rung, answers 201 with it, and audits the create', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const product = await seededProduct();

      const created = expectSuccess<AdminPricingTier>(
        expectStatus(
          await client
            .post(BASE)
            .set(CSRF_HEADER, csrf)
            .send({ productId: product.id, minKg: 10, maxKg: 24, pricePerKg: 620 }),
          CREATED,
        ),
      );

      expect(created).toMatchObject({
        productId: product.id,
        minKg: 10,
        maxKg: 24,
        pricePerKg: 620,
        segment: 'default',
        businessId: null,
      });

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'pricing-tier.create',
        entity: 'pricing-tier',
        entityId: created.id,
        before: null,
        actor_user_id: admin.id,
      });
      expect(rows[0]?.after).toMatchObject({ pricePerKgPaise: '62000', minKg: 10, maxKg: 24 });
    });

    /**
     * **The overlap refusal, and every boundary Postgres has to get right.**
     *
     * `bulkTierFor` takes the *first* rung whose range contains the weight, over a ladder sorted by
     * `minKg` — so any of these pairs would make a price depend on row order, and
     * `CheckoutService.place` snapshots the resolved rate onto the invoice.
     */
    it.each([
      ['a rung starting inside another', 20, 30],
      ['a rung ending inside another', 5, 12],
      ['a rung entirely inside another', 12, 20],
      ['a rung entirely containing another', 1, 100],
      ['a rung touching at the lower bound', 1, 10],
      ['a rung touching at the upper bound', 24, 40],
      ['an identical rung', 10, 24],
    ])('refuses %s', async (_case, minKg, maxKg) => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const existing = await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      const refusal = expectError(
        await client
          .post(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ productId: product.id, minKg, maxKg, pricePerKg: 500 })
          .expect(CONFLICT),
      );

      expect(refusal.code).toBe('PRICING_TIER_OVERLAP');
      expect(refusal.details).toMatchObject({ conflictingTierId: existing.id });
      expect(await tierCount()).toBe(1);
      expect(await auditRows()).toEqual([]);
    });

    it('accepts a rung that abuts another without overlapping it', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      await seedTier({ productId: product.id, minKg: '1.00', maxKg: '9.99' });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: product.id, minKg: 10, maxKg: 24, pricePerKg: 620 })
        .expect(CREATED);

      expect(await tierCount()).toBe(2);
    });

    /** An open-ended slab has no end, so anything above its `minKg` meets it. */
    it('refuses a rung above an open-ended top slab, and one below it', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      await seedTier({ productId: product.id, minKg: '50.00', maxKg: null });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: product.id, minKg: 100, maxKg: 200, pricePerKg: 500 })
        .expect(CONFLICT);

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: product.id, minKg: 1, maxKg: null, pricePerKg: 500 })
        .expect(CONFLICT);

      expect(await tierCount()).toBe(1);
    });

    /**
     * **The grouping that a naive `(product, segment, business)` uniqueness check would get
     * wrong.** `resolveTiers`' first rung filters on `businessId` **alone** and never looks at the
     * band, so both of these rows are in the same resolved ladder for that business.
     */
    it('refuses two overlapping rungs for one business even in different bands', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const business = await seedBusiness();
      await seedTier({
        productId: product.id,
        minKg: '10.00',
        maxKg: '24.00',
        businessId: business.id,
        segment: CustomerSegment.DEFAULT,
      });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({
          productId: product.id,
          minKg: 12,
          maxKg: 20,
          pricePerKg: 500,
          segment: 'retailer',
          businessId: business.id,
        })
        .expect(CONFLICT);

      expect(await tierCount()).toBe(1);
    });

    /** Unscoped rungs are resolved by band, so two bands are two ladders and cannot collide. */
    it('accepts overlapping rungs in two different bands when neither is business-scoped', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: product.id, minKg: 10, maxKg: 24, pricePerKg: 590, segment: 'horeca' })
        .expect(CREATED);

      expect(await tierCount()).toBe(2);
    });

    /** A business's negotiated ladder is a different ladder from the shop's list pricing. */
    it('accepts a business rung overlapping an unscoped one', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const business = await seedBusiness();
      await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({
          productId: product.id,
          minKg: 10,
          maxKg: 24,
          pricePerKg: 560,
          businessId: business.id,
        })
        .expect(CREATED);

      expect(await tierCount()).toBe(2);
    });

    /** Different products are always different ladders. */
    it('accepts an identical rung on another product', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const other = await secondProduct();
      await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: other.id, minKg: 10, maxKg: 24, pricePerKg: 620 })
        .expect(CREATED);

      expect(await tierCount()).toBe(2);
    });

    /** Brief §47: a null price is a quote-required slab. */
    it('stores a quote-required slab and reads it back as null', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();

      const created = expectSuccess<AdminPricingTier>(
        expectStatus(
          await client
            .post(BASE)
            .set(CSRF_HEADER, csrf)
            .send({ productId: product.id, minKg: 50, maxKg: null, pricePerKg: null }),
          CREATED,
        ),
      );

      expect(created.pricePerKg).toBeNull();
      expect(created.maxKg).toBeNull();
    });

    it('refuses a range whose maximum is below its minimum', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ productId: product.id, minKg: 24, maxKg: 10, pricePerKg: 620 })
        .expect(BAD_REQUEST);

      expect(await tierCount()).toBe(0);
    });

    it('answers 404 for a product or a business that does not exist', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({
          productId: 'c1000000-0000-4000-8000-0000000000ff',
          minKg: 10,
          maxKg: 24,
          pricePerKg: 620,
        })
        .expect(NOT_FOUND);

      await client
        .post(BASE)
        .set(CSRF_HEADER, csrf)
        .send({
          productId: product.id,
          minKg: 10,
          maxKg: 24,
          pricePerKg: 620,
          businessId: 'b1000000-0000-4000-8000-0000000000ff',
        })
        .expect(NOT_FOUND);

      expect(await tierCount()).toBe(0);
    });

    it('is refused without the CSRF header', async () => {
      const { client } = await asAdmin();
      const product = await seededProduct();

      await client
        .post(BASE)
        .send({ productId: product.id, minKg: 10, maxKg: 24, pricePerKg: 620 })
        .expect(FORBIDDEN);

      expect(await tierCount()).toBe(0);
    });
  });

  describe('PATCH /admin/pricing-tiers/:id', () => {
    beforeEach(clearSeededLadders);

    it('changes a price and audits only what changed', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const product = await seededProduct();
      const existing = await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      const updated = expectSuccess<AdminPricingTier>(
        await client
          .patch(`${BASE}/${existing.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ pricePerKg: 590 })
          .expect(OK),
      );

      expect(updated.pricePerKg).toBe(590);
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'pricing-tier.update',
        entity: 'pricing-tier',
        entityId: existing.id,
        before: { pricePerKgPaise: '62000' },
        after: { pricePerKgPaise: '59000' },
        actor_user_id: admin.id,
      });
    });

    /** Plan 9.1's rule: a write that changes nothing leaves no trace — and `10` arriving against a
     * stored `'10.00'` must not read as a change. */
    it('writes no audit row when nothing changes, including the numeric round trip', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const existing = await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client.patch(`${BASE}/${existing.id}`).set(CSRF_HEADER, csrf).send({}).expect(OK);
      await client
        .patch(`${BASE}/${existing.id}`)
        .set(CSRF_HEADER, csrf)
        .send({ minKg: 10, maxKg: 24, pricePerKg: 620 })
        .expect(OK);

      expect(await auditRows()).toEqual([]);
    });

    it('refuses to widen a rung into its neighbour, and writes nothing', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const lower = await seedTier({ productId: product.id, minKg: '1.00', maxKg: '9.00' });
      await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      const refusal = expectError(
        await client
          .patch(`${BASE}/${lower.id}`)
          .set(CSRF_HEADER, csrf)
          .send({ maxKg: 15 })
          .expect(CONFLICT),
      );

      expect(refusal.code).toBe('PRICING_TIER_OVERLAP');
      const [row] = await integration.dataSource.query<{ maxKg: string }[]>(
        'SELECT "maxKg" FROM pricing_tiers WHERE id = $1',
        [lower.id],
      );
      expect(Number(row?.maxKg)).toBe(9);
      expect(await auditRows()).toEqual([]);
    });

    /** The rung being edited must not be compared against itself, or no rung could ever be changed
     * without being moved out of its own range first. */
    it('lets a rung change its own price without colliding with itself', async () => {
      const { client, csrf } = await asAdmin();
      const product = await seededProduct();
      const existing = await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client
        .patch(`${BASE}/${existing.id}`)
        .set(CSRF_HEADER, csrf)
        .send({ minKg: 8, maxKg: 26, pricePerKg: 600 })
        .expect(OK);
    });

    it('answers 404 for an unknown uuid and 400 for a non-uuid', async () => {
      const { client, csrf } = await asAdmin();
      // A real uuid that names no row — `p1000000-…` is not one, since `p` is not a hex digit, and
      // `ParseUUIDPipe` would answer 400 for it rather than letting the read report the miss.
      await client
        .patch(`${BASE}/d1000000-0000-4000-8000-0000000000ff`)
        .set(CSRF_HEADER, csrf)
        .send({ pricePerKg: 500 })
        .expect(NOT_FOUND);
      await client
        .patch(`${BASE}/not-a-uuid`)
        .set(CSRF_HEADER, csrf)
        .send({ pricePerKg: 500 })
        .expect(BAD_REQUEST);
    });

    it('is refused without the CSRF header', async () => {
      const { client } = await asAdmin();
      const product = await seededProduct();
      const existing = await seedTier({ productId: product.id, minKg: '10.00', maxKg: '24.00' });

      await client.patch(`${BASE}/${existing.id}`).send({ pricePerKg: 1 }).expect(FORBIDDEN);
      expect(await auditRows()).toEqual([]);
    });
  });
});
