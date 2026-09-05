import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminProduct, AdminVariant, Product } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, cookieValue, expectError, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_PRODUCTS = '/api/v1/admin/products';
const ADMIN_VARIANTS = '/api/v1/admin/variants';
const ADMIN_INVENTORY = '/api/v1/admin/inventory';
const CATALOG_PRODUCTS = '/api/v1/catalog/products';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'nn_csrf';
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

interface InventoryRow {
  onHand: number;
  reserved: number;
  lowStockThreshold: number;
}

interface AuditRow {
  action: string;
  entity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/variants` and `POST /admin/products/:id/variants` — spec §6.4, brief §30. Plan 9.1 Task 7.
 *
 * The load-bearing claim in this file is the `Inventory` row.
 *
 * A variant created without one is not visibly broken: `availableFor` maps a missing relation to
 * `0`, so the storefront simply calls the pack sold out. What breaks is *stocking* it —
 * `InventoryService.adjust`'s conditional `UPDATE` matches no row and answers **"No such product
 * variant"** for a variant the operator is looking at — and there is no route in the whole admin
 * surface that can create the row afterwards, so the pack is permanently unsellable. So the test
 * that matters is not "the row exists" but "an adjustment against the new variant succeeds", which
 * is what a mutation removing the insert has to break.
 */
describe('admin variants', () => {
  const integration = useIntegrationApp();

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
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);
  type Admin = Awaited<ReturnType<typeof asAdmin>>;

  const productId = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM products WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug}`);
    return id;
  };

  const inventoryOf = async (variantId: string): Promise<InventoryRow | undefined> => {
    const rows = await integration.dataSource.query<InventoryRow[]>(
      'SELECT "onHand", reserved, "lowStockThreshold" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    return rows[0];
  };

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  const VARIANT_BODY = {
    sku: 'PCA-750G',
    size: '750g',
    grams: 750,
    channel: 'retail' as const,
    price: 675,
    mrp: 790,
  };

  const addVariant = async (
    admin: Admin,
    slug = 'premium-california-almonds',
    overrides: Record<string, unknown> = {},
  ): Promise<AdminVariant> =>
    expectSuccess<AdminVariant>(
      await admin.client
        .post(`${ADMIN_PRODUCTS}/${await productId(slug)}/variants`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ ...VARIANT_BODY, ...overrides })
        .expect(201),
    );

  /**
   * A SKU the seeder really wrote, read back rather than spelled out.
   *
   * `catalog.seed.ts` derives it as `slugToSku(slug)-SIZE` — three letters per hyphenated word,
   * uppercased — so `PRECALALM-1KG`. Hardcoding that here would pin this test to a private function
   * in the seeder, and it has already been rewritten once.
   */
  const seededSku = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ sku: string }[]>(
      `SELECT v.sku FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE p.slug = $1 ORDER BY v.grams LIMIT 1`,
      [slug],
    );
    const sku = rows[0]?.sku;
    if (sku === undefined) throw new Error(`seedCatalog wrote no variants for ${slug}`);
    return sku;
  };

  const adjust = (admin: Admin, variantId: string, delta: number) =>
    admin.client
      .patch(`${ADMIN_INVENTORY}/${variantId}`)
      .set(CSRF_HEADER, admin.csrf)
      .send({ delta, reason: 'Fixture stock movement for the variant delete rules' });

  describe('POST /admin/products/:id/variants', () => {
    it('creates the variant and converts rupees to paise once', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      expect(variant).toMatchObject({
        sku: 'PCA-750G',
        size: '750g',
        grams: 750,
        channel: 'retail',
        price: 675,
        mrp: 790,
        // Defaults, not sent by the body.
        moq: 1,
        isActive: true,
        available: 0,
        soldOut: true,
      });

      const stored = await integration.dataSource.query<{ pricePaise: string }[]>(
        'SELECT "pricePaise"::text FROM product_variants WHERE id = $1',
        [variant.id],
      );
      expect(stored[0]?.pricePaise).toBe('67500');
    });

    /**
     * **The requirement this task exists for.** The row itself, and then the consequence — because
     * the row's absence is invisible from the outside and only the adjustment path notices.
     */
    it('creates the inventory row in the same transaction, at zero', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      expect(await inventoryOf(variant.id)).toEqual({
        onHand: 0,
        reserved: 0,
        lowStockThreshold: 10,
      });
    });

    /**
     * The behavioural half. Without the `Inventory` row this answers **404 "No such product
     * variant"** — `InventoryService.adjust`'s own message for an id that matches nothing — so the
     * operator would be told a variant they are looking at does not exist, with no way to stock it
     * ever.
     */
    it('lets the new variant be stocked, which a missing inventory row would make impossible', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      const response = await adjust(admin, variant.id, 24).expect(200);
      expect(expectSuccess<{ onHand: number }>(response).onHand).toBe(24);

      // And the ledger and the column agree, which is the invariant the seeded state also holds.
      const drift = await integration.dataSource.query<{ variant_id: string }[]>(`
        SELECT i.variant_id
          FROM inventory i
          LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
         GROUP BY i.variant_id, i."onHand"
        HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
      `);
      expect(drift).toEqual([]);
    });

    /**
     * A brand-new variant is sold out, not infinitely in stock — `variantSoldOut` over an
     * `available` of zero. It also drags the whole product to sold out only if every *other* active
     * variant is at zero too, which the seeded almonds are not.
     */
    it('reads as sold out on the storefront until it is stocked', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      const publicView = expectSuccess<Product>(
        await agent(integration.app)
          .get(`${CATALOG_PRODUCTS}/premium-california-almonds`)
          .expect(200),
      );
      const pack = publicView.variants.find((candidate) => candidate.sku === variant.sku);

      expect(pack).toMatchObject({ available: 0, soldOut: true });
      expect(publicView.soldOut).toBe(false);
    });

    it('honours an explicit low-stock threshold, the only place §6.4 can set one', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin, 'premium-california-almonds', {
        lowStockThreshold: 3,
      });

      expect((await inventoryOf(variant.id))?.lowStockThreshold).toBe(3);
    });

    it('records who created it, with the inventory threshold in the trail', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      const rows = await auditRows(variant.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'variant.create', entity: 'variant', before: null });
      // Money in rupees, not paise: `pricePaise` is a `bigint`, which `JSON.stringify` refuses, so
      // the polyfill would have written a *string* into the jsonb column.
      expect(rows[0]?.after).toMatchObject({
        sku: 'PCA-750G',
        price: 675,
        mrp: 790,
        lowStockThreshold: 10,
      });
    });

    it('refuses a SKU another variant already uses, anywhere in the table', async () => {
      const admin = await asAdmin();
      // A seeded *almond* SKU, sent against a *cashew* product: `uq_product_variants_sku` is
      // table-wide, not per product, which is why the message does not say "this product already
      // has".
      const taken = await seededSku('premium-california-almonds');

      const response = await admin.client
        .post(`${ADMIN_PRODUCTS}/${await productId('w320-cashews')}/variants`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ ...VARIANT_BODY, sku: taken })
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('IDENTIFIER_IN_USE');
      expect(error.details).toEqual({ field: 'sku', value: taken });
    });

    it('answers 404 for a product that does not exist', async () => {
      const admin = await asAdmin();

      await admin.client
        .post(`${ADMIN_PRODUCTS}/${NO_SUCH_ID}/variants`)
        .set(CSRF_HEADER, admin.csrf)
        .send(VARIANT_BODY)
        .expect(404);
    });
  });

  describe('PATCH /admin/variants/:id', () => {
    it('changes only what was sent and audits only what changed, money in rupees', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      const updated = expectSuccess<AdminVariant>(
        await admin.client
          .patch(`${ADMIN_VARIANTS}/${variant.id}`)
          .set(CSRF_HEADER, admin.csrf)
          .send({ price: 699, moq: 2 })
          .expect(200),
      );

      expect(updated).toMatchObject({ price: 699, moq: 2, sku: 'PCA-750G', mrp: 790 });

      const rows = await auditRows(variant.id);
      expect(rows.map((row) => row.action)).toEqual(['variant.create', 'variant.update']);
      expect(rows[1]?.before).toEqual({ price: 675, moq: 1 });
      expect(rows[1]?.after).toEqual({ price: 699, moq: 2 });
    });

    it('writes no audit row for a patch that changes nothing', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      await admin.client
        .patch(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ price: 675, size: '750g' })
        .expect(200);

      expect((await auditRows(variant.id)).map((row) => row.action)).toEqual(['variant.create']);
    });

    /**
     * Deactivating is the withdrawal that keeps the stock ledger — `inventory-transaction.entity.ts`
     * names it as the alternative to a delete. The pack leaves the storefront and stays on the admin
     * screen, which `admin-products.integration.spec.ts` asserts from the other side.
     */
    it('withdraws a pack from the storefront when isActive goes false', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      await admin.client
        .patch(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ isActive: false })
        .expect(200);

      const publicView = expectSuccess<Product>(
        await agent(integration.app)
          .get(`${CATALOG_PRODUCTS}/premium-california-almonds`)
          .expect(200),
      );
      expect(publicView.variants.map((candidate) => candidate.sku)).not.toContain('PCA-750G');
    });

    it('switches channel through the one wire-to-column map', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      const updated = expectSuccess<AdminVariant>(
        await admin.client
          .patch(`${ADMIN_VARIANTS}/${variant.id}`)
          .set(CSRF_HEADER, admin.csrf)
          .send({ channel: 'bulk' })
          .expect(200),
      );

      expect(updated.channel).toBe('bulk');
      const stored = await integration.dataSource.query<{ channel: string }[]>(
        'SELECT channel::text AS channel FROM product_variants WHERE id = $1',
        [variant.id],
      );
      expect(stored[0]?.channel).toBe('BULK');
    });

    it('refuses a SKU another variant already uses', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      await admin.client
        .patch(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ sku: await seededSku('premium-california-almonds') })
        .expect(409);
    });

    it('answers 404 for a variant that does not exist', async () => {
      const admin = await asAdmin();

      await admin.client
        .patch(`${ADMIN_VARIANTS}/${NO_SUCH_ID}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ moq: 4 })
        .expect(404);
    });
  });

  describe('DELETE /admin/variants/:id', () => {
    /**
     * **Decision 3, resolved identically to a product's delete** — a hard delete, refused with the
     * same `ENTITY_IN_USE` code when history references the row, so an operator learns one rule
     * rather than two.
     *
     * Three refusals, in the order the service checks them, because each sends an operator somewhere
     * different: stock they can clear themselves, an order they cannot, and a ledger that must
     * outlive the row by design.
     */
    it('refuses a variant that still holds stock, naming how much', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);
      await adjust(admin, variant.id, 12).expect(200);

      const response = await admin.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('ENTITY_IN_USE');
      expect(error.details).toEqual({ variantId: variant.id, onHand: 12 });
      expect(error.message).toContain('Adjust it to zero');
    });

    /**
     * Stock back to zero, ledger not empty. `inventory_transactions.variant_id` is
     * `ON DELETE RESTRICT` and the ledger is append-only, so the row must outlive the variant —
     * `inventory-transaction.entity.ts` states the intended alternative in as many words:
     * "admin deactivates it instead".
     */
    it('refuses a variant with stock movement history even at zero on hand', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);
      await adjust(admin, variant.id, 12).expect(200);
      await adjust(admin, variant.id, -12).expect(200);

      expect((await inventoryOf(variant.id))?.onHand).toBe(0);

      const response = await admin.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('ENTITY_IN_USE');
      expect(error.details).toEqual({ variantId: variant.id, inventoryTransactions: 2 });
      expect(error.message).toContain('Deactivate it instead');
    });

    it('refuses a variant that has been ordered', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 675,
        items: [
          {
            productSlug: 'premium-california-almonds',
            name: 'Premium California Almonds',
            qty: 1,
            unitRupees: 675,
            variantId: variant.id,
            detail: '750g',
          },
        ],
      });

      const response = await admin.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      expect(expectError(response).details).toEqual({ variantId: variant.id, orderItems: 1 });
    });

    /** Every seeded variant carries an opening `RECEIPT` and 120 or 40 on hand, so none can go. */
    it('refuses every seeded variant, which is the state the catalogue ships in', async () => {
      const admin = await asAdmin();
      const detail = expectSuccess<AdminProduct>(
        await admin.client
          .get(`${ADMIN_PRODUCTS}/${await productId('premium-california-almonds')}`)
          .expect(200),
      );
      const seeded = detail.variants[0];
      if (!seeded) throw new Error('seedCatalog wrote no variants');

      await admin.client
        .delete(`${ADMIN_VARIANTS}/${seeded.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);
    });

    /**
     * The case a delete is for: a pack added by mistake, never stocked and never sold. The
     * `Inventory` row created with it goes too — `inventory.variant_id` is CASCADE because the row
     * "is genuinely 1:1 with the variant and part of its lifecycle".
     */
    it('deletes a variant that has never been stocked or sold, and audits it', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);

      await admin.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(204);

      expect(await inventoryOf(variant.id)).toBeUndefined();

      const rows = await auditRows(variant.id);
      expect(rows.map((row) => row.action)).toEqual(['variant.create', 'variant.delete']);
      expect(rows[1]?.after).toBeNull();
      expect(rows[1]?.before).toMatchObject({ sku: 'PCA-750G', price: 675 });
    });

    it('leaves no audit row behind when the delete is refused', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);
      await adjust(admin, variant.id, 5).expect(200);

      await admin.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      expect((await auditRows(variant.id)).map((row) => row.action)).toEqual(['variant.create']);
    });

    it('answers 404 for a variant that does not exist', async () => {
      const admin = await asAdmin();

      await admin.client
        .delete(`${ADMIN_VARIANTS}/${NO_SUCH_ID}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(404);
    });
  });

  describe('authorisation', () => {
    it('refuses a signed-in customer with 403, and an anonymous caller with 401', async () => {
      const admin = await asAdmin();
      const variant = await addVariant(admin);
      const customer = await signIn(UserRole.CUSTOMER);

      await customer.client
        .patch(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, customer.csrf)
        .send({ price: 1 })
        .expect(403);
      await customer.client
        .delete(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, customer.csrf)
        .expect(403);

      // Primed with a `GET` first: `CsrfBootstrapMiddleware` sets the cookie on the **response**, so
      // a brand-new client's very first write can never satisfy the global `CsrfGuard` — and a 403
      // there would hide the 401 this case is about.
      const anonymous = agent(integration.app);
      const primer = await anonymous.get('/api/v1/cart').expect(200);
      await anonymous
        .patch(`${ADMIN_VARIANTS}/${variant.id}`)
        .set(CSRF_HEADER, cookieValue(primer, CSRF_COOKIE))
        .send({ price: 1 })
        .expect(401);
    });
  });
});
