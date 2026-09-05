import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type {
  AdminProduct,
  AdminVariant,
  CartValidationResult,
  Paginated,
  Product,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectStatus, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_PRODUCTS = '/api/v1/admin/products';
const CATALOG_PRODUCTS = '/api/v1/catalog/products';
const CART = '/api/v1/cart';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

interface AuditRow {
  action: string;
  entity: string;
  entityId: string | null;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/products` — spec §6.4's product block, brief §30. Plan 9.1's Tasks 4, 5 and 6.
 *
 * Three claims run through this file and none of them can be made by a unit test:
 *
 * 1. **The admin list includes unpublished products and the public catalogue does not.** That is
 *    the entire reason the endpoint exists beside `GET /catalog/products`, and the only way to check
 *    it is to ask both and compare.
 * 2. **Every write leaves an `audit_logs` row in the same transaction, and a write that changed
 *    nothing leaves none.** Both halves are read back from the table.
 * 3. **A delete is refused when history references the product**, against a real order and against
 *    the real append-only stock ledger — the FK graph is what decides this, so a double cannot.
 */
describe('admin products', () => {
  const integration = useIntegrationApp();

  /** See `inventory.integration.spec.ts`: one app per file means one shared throttler store. */
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

  const categoryId = async (slug = 'almonds'): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM categories WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug} category`);
    return id;
  };

  const productId = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM products WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug}`);
    return id;
  };

  const auditRows = async (entityId?: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after
         FROM audit_logs
        ${entityId === undefined ? '' : 'WHERE "entityId" = $1'}
        ORDER BY "createdAt", action`,
      entityId === undefined ? [] : [entityId],
    );

  /** A body that satisfies every required column, for a category the seeder wrote. */
  const productBody = async (overrides: Record<string, unknown> = {}) => ({
    name: 'Hand-Sorted Anjeer',
    slug: 'hand-sorted-anjeer',
    categoryId: await categoryId('anjeer'),
    subtitle: 'Soft, seedy figs for slow afternoons.',
    description: 'Hand-sorted dried figs, unsulphured.',
    origin: 'Afghanistan',
    grade: 'Premium',
    processing: 'Hand sorted and sun dried',
    shelfLife: '9 months from packing',
    storage: 'Store in a cool, dry place. Refrigerate after opening.',
    ingredients: 'Dried figs',
    hsn: '0804',
    gstRate: 5,
    ...overrides,
  });

  const create = async (admin: Admin, overrides: Record<string, unknown> = {}) =>
    expectSuccess<AdminProduct>(
      expectStatus(
        await admin.client
          .post(ADMIN_PRODUCTS)
          .set(CSRF_HEADER, admin.csrf)
          .send(await productBody(overrides)),
        201,
      ),
    );

  describe('GET /admin/products — the unpublished view', () => {
    /**
     * **The case the whole endpoint exists for.** `CatalogService.baseQuery` pins
     * `product.isPublished = true`, so a draft is invisible to every storefront route; if this list
     * inherited that filter there would be no way to reach a product you had just created.
     */
    it('lists a product the public catalogue cannot see', async () => {
      const admin = await asAdmin();
      const draft = await create(admin);

      expect(draft.isPublished).toBe(false);

      const adminList = expectSuccess<Paginated<AdminProduct>>(
        await admin.client.get(`${ADMIN_PRODUCTS}?q=anjeer`).expect(200),
      );
      expect(adminList.items.map((item) => item.slug)).toContain('hand-sorted-anjeer');

      const publicList = expectSuccess<Paginated<Product>>(
        await agent(integration.app).get(`${CATALOG_PRODUCTS}?q=anjeer`).expect(200),
      );
      expect(publicList.items.map((item) => item.slug)).not.toContain('hand-sorted-anjeer');

      // And the draft's own storefront page 404s, so nothing about it is reachable publicly.
      await agent(integration.app).get(`${CATALOG_PRODUCTS}/hand-sorted-anjeer`).expect(404);
    });

    it('filters on published, which is tri-state: omitted means both', async () => {
      const admin = await asAdmin();
      await create(admin);

      const both = expectSuccess<Paginated<AdminProduct>>(
        await admin.client.get(`${ADMIN_PRODUCTS}?limit=60`).expect(200),
      );
      const drafts = expectSuccess<Paginated<AdminProduct>>(
        await admin.client.get(`${ADMIN_PRODUCTS}?published=false&limit=60`).expect(200),
      );
      const live = expectSuccess<Paginated<AdminProduct>>(
        await admin.client.get(`${ADMIN_PRODUCTS}?published=true&limit=60`).expect(200),
      );

      // 27 seeded products, all published, plus the one draft.
      expect(both.total).toBe(28);
      expect(drafts.items.map((item) => item.slug)).toEqual(['hand-sorted-anjeer']);
      expect(live.total).toBe(27);
    });

    it('filters by category slug and paginates', async () => {
      const admin = await asAdmin();

      const page = expectSuccess<Paginated<AdminProduct>>(
        await admin.client.get(`${ADMIN_PRODUCTS}?category=almonds&page=1&limit=2`).expect(200),
      );

      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(2);
      expect(page.page).toBe(1);
      expect(page.limit).toBe(2);
      expect(page.items.every((item) => item.category === 'almonds')).toBe(true);
    });

    /** `forbidNonWhitelisted` — an undeclared filter is a 400, not a silently unfiltered page. */
    it('refuses an undeclared query parameter', async () => {
      const admin = await asAdmin();

      const response = await admin.client.get(`${ADMIN_PRODUCTS}?inStockOnly=true`).expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /admin/products/:id', () => {
    /**
     * The read counterpart of the list's whole point: `toWireProduct` filters to active variants, so
     * a pack an operator has just deactivated would vanish from the screen they deactivated it on.
     */
    it('includes a deactivated variant, which the public product page omits', async () => {
      const admin = await asAdmin();
      const id = await productId('premium-california-almonds');
      const before = expectSuccess<AdminProduct>(
        await admin.client.get(`${ADMIN_PRODUCTS}/${id}`).expect(200),
      );
      const target = before.variants.find((variant) => variant.size === '250g');
      if (!target) throw new Error('seedCatalog wrote no 250g almond pack');

      await admin.client
        .patch(`/api/v1/admin/variants/${target.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ isActive: false })
        .expect(200);

      const after = expectSuccess<AdminProduct>(
        await admin.client.get(`${ADMIN_PRODUCTS}/${id}`).expect(200),
      );
      expect(after.variants.map((variant) => variant.size)).toContain('250g');
      expect(after.variants.find((variant) => variant.size === '250g')?.isActive).toBe(false);

      const publicView = expectSuccess<Product>(
        await agent(integration.app)
          .get(`${CATALOG_PRODUCTS}/premium-california-almonds`)
          .expect(200),
      );
      expect(publicView.variants.map((variant) => variant.size)).not.toContain('250g');
    });

    it('answers 404 for an unknown id and 400 for one that is not a uuid', async () => {
      const admin = await asAdmin();

      expect(
        expectError(await admin.client.get(`${ADMIN_PRODUCTS}/${NO_SUCH_ID}`).expect(404)).code,
      ).toBe('NOT_FOUND');
      await admin.client.get(`${ADMIN_PRODUCTS}/not-a-uuid`).expect(400);
    });
  });

  describe('POST /admin/products', () => {
    it('creates an unpublished product and records who created it', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      expect(created).toMatchObject({
        slug: 'hand-sorted-anjeer',
        name: 'Hand-Sorted Anjeer',
        isPublished: false,
        publishedAt: null,
        gstRate: 5,
        variants: [],
        // Inherited from `toWireProduct`: with no active variants, `productSoldOut` is true.
        soldOut: true,
      });

      const rows = await auditRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'product.create',
        entity: 'product',
        // From the signed token, never a body field — the controllers assign `actorUserId` after
        // the DTO spread and `forbidNonWhitelisted` refuses one in the body outright.
        actor_user_id: admin.user.id,
        before: null,
      });
      expect(rows[0]?.after).toMatchObject({ slug: 'hand-sorted-anjeer', isPublished: false });
    });

    it('refuses a slug another product already uses', async () => {
      const admin = await asAdmin();

      const response = await admin.client
        .post(ADMIN_PRODUCTS)
        .set(CSRF_HEADER, admin.csrf)
        .send(await productBody({ slug: 'premium-california-almonds' }))
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('IDENTIFIER_IN_USE');
      expect(error.details).toEqual({ field: 'slug', value: 'premium-california-almonds' });
    });

    /**
     * `products.category_id` is a real FK with `ON DELETE RESTRICT`, so an unknown id would be
     * refused by Postgres anyway — as an opaque driver error surfacing as a 500. The `exists` check
     * turns that into a 422 naming the field.
     */
    it('refuses an unknown category with a named 422, not a driver error', async () => {
      const admin = await asAdmin();

      const response = await admin.client
        .post(ADMIN_PRODUCTS)
        .set(CSRF_HEADER, admin.csrf)
        .send(await productBody({ categoryId: NO_SUCH_ID }))
        .expect(422);

      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });

    /**
     * The transaction contract, reached through HTTP.
     *
     * `AdminProductsService.remove` refuses a product with stock history, so the whole transaction —
     * audit row included — must roll back. Asserting that no `product.delete` row was written is
     * asserting that the audit write really is inside the caller's transaction rather than committed
     * beside it: a separately-committed row would claim a deletion that never happened, which
     * `AuditLogService`'s docblock names as worse than having no trail at all.
     */
    it('leaves no audit row behind when the write it describes is refused', async () => {
      const admin = await asAdmin();
      const id = await productId('roasted-makhana');

      await admin.client.delete(`${ADMIN_PRODUCTS}/${id}`).set(CSRF_HEADER, admin.csrf).expect(409);

      expect(await auditRows(id)).toEqual([]);
    });
  });

  describe('PATCH /admin/products/:id', () => {
    it('changes only what was sent and audits only what changed', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      const updated = expectSuccess<AdminProduct>(
        await admin.client
          .patch(`${ADMIN_PRODUCTS}/${created.id}`)
          .set(CSRF_HEADER, admin.csrf)
          .send({ name: 'Hand-Sorted Anjeer (Jumbo)', gstRate: 12 })
          .expect(200),
      );

      expect(updated.name).toBe('Hand-Sorted Anjeer (Jumbo)');
      expect(updated.gstRate).toBe(12);
      // Untouched.
      expect(updated.slug).toBe('hand-sorted-anjeer');
      expect(updated.origin).toBe('Afghanistan');

      const rows = await auditRows(created.id);
      expect(rows.map((row) => row.action)).toEqual(['product.create', 'product.update']);
      const update = rows[1];
      // Numbers, not `'5.00'` and `'12'`: `gstRate` and `moqKg` are `numeric`, so the snapshot
      // normalises them — see `ProductSnapshot`. Otherwise a PATCH resending the stored rate would
      // read as a change and write an audit row saying 5 became 5.
      expect(update?.before).toEqual({ name: 'Hand-Sorted Anjeer', gstRate: 5 });
      expect(update?.after).toEqual({ name: 'Hand-Sorted Anjeer (Jumbo)', gstRate: 12 });
    });

    /**
     * `InventoryService.adjust` records the measurement that makes this a rule: a zero adjustment
     * once produced a 200 and a ledger row "asserting a movement of zero", and "an audit trail reads
     * as authoritative, so a row recording a change that never happened is worse than no row".
     */
    it('writes no audit row for a patch that changes nothing', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      await admin.client
        .patch(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ name: 'Hand-Sorted Anjeer' })
        .expect(200);

      expect((await auditRows(created.id)).map((row) => row.action)).toEqual(['product.create']);
    });

    /**
     * The `numeric`-column trap, closed. Postgres stores `gstRate: 5` and reads it back as `'5.00'`,
     * so a snapshot that kept the raw string would call `PATCH { gstRate: 5 }` a change — a
     * pointless `UPDATE` and an audit row asserting the rate moved from 5 to 5. This is the case a
     * `name`-only no-op test cannot see.
     */
    it('treats a resent numeric value as unchanged, despite Postgres reading it back as 5.00', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      await admin.client
        .patch(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ gstRate: 5, moqKg: 0 })
        .expect(200);

      expect((await auditRows(created.id)).map((row) => row.action)).toEqual(['product.create']);
    });

    it('refuses a slug another product already uses, but accepts the product’s own', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      await admin.client
        .patch(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ slug: 'w320-cashews' })
        .expect(409);

      // Resending its own slug is not a collision with itself, and changes nothing.
      await admin.client
        .patch(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ slug: 'hand-sorted-anjeer' })
        .expect(200);

      expect((await auditRows(created.id)).map((row) => row.action)).toEqual(['product.create']);
    });
  });

  describe('DELETE /admin/products/:id', () => {
    /**
     * **Decision 1, tested against a real order.** A hard delete refused with a named 409 when
     * history references the product — see `AdminProductsService.remove` for the four reasons.
     *
     * The order is written directly rather than placed through checkout, so the product carries an
     * `order_items` row and *no* stock-ledger row: that isolates the order check from the ledger
     * check, which is the point of having both.
     */
    it('refuses to delete a product that has been ordered, naming what referenced it', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 450,
        items: [
          {
            productSlug: created.slug,
            name: created.name,
            qty: 2,
            unitRupees: 225,
            productId: created.id,
          },
        ],
      });

      const response = await admin.client
        .delete(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('ENTITY_IN_USE');
      expect(error.details).toEqual({ productId: created.id, orderItems: 1 });
      expect(error.message).toContain('Unpublish it instead');

      // Still there, and no `product.delete` row claiming otherwise.
      await admin.client.get(`${ADMIN_PRODUCTS}/${created.id}`).expect(200);
      expect((await auditRows(created.id)).map((row) => row.action)).toEqual(['product.create']);
    });

    /**
     * The other half of the refusal, and the one that would otherwise be a 500.
     * `inventory_transactions.variant_id` is `ON DELETE RESTRICT` and `seedCatalog` writes one
     * opening `RECEIPT` per variant, so **no seeded product can be deleted** — `wishlist-item.
     * entity.ts` records the exact Postgres error. Checking first is what turns a constraint name
     * into an instruction.
     */
    it('refuses to delete a product with stock movement history', async () => {
      const admin = await asAdmin();
      const id = await productId('roasted-makhana');

      const response = await admin.client
        .delete(`${ADMIN_PRODUCTS}/${id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('ENTITY_IN_USE');
      // Eight variants, one opening receipt each.
      expect(error.details).toEqual({ productId: id, inventoryTransactions: 8 });
      expect(error.message).toContain('append-only');
    });

    /**
     * The case delete is actually for: a product created by mistake, never stocked and never sold.
     * Its variant carries an `Inventory` row (created with it, in the same transaction) and no
     * ledger row, so the cascade takes the inventory row with it.
     */
    it('deletes a product that has never been stocked or sold, and audits it', async () => {
      const admin = await asAdmin();
      const created = await create(admin);
      const variant = expectSuccess<AdminVariant>(
        await admin.client
          .post(`${ADMIN_PRODUCTS}/${created.id}/variants`)
          .set(CSRF_HEADER, admin.csrf)
          .send({
            sku: 'HSA-500G',
            size: '500g',
            grams: 500,
            channel: 'retail',
            price: 449,
            mrp: 520,
          })
          .expect(201),
      );

      await admin.client
        .delete(`${ADMIN_PRODUCTS}/${created.id}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(204);

      await admin.client.get(`${ADMIN_PRODUCTS}/${created.id}`).expect(404);

      const inventory = await integration.dataSource.query<{ count: string }[]>(
        'SELECT count(*) FROM inventory WHERE variant_id = $1',
        [variant.id],
      );
      expect(Number(inventory[0]?.count)).toBe(0);

      const rows = await auditRows(created.id);
      expect(rows.map((row) => row.action)).toEqual(['product.create', 'product.delete']);
      // A delete has a `before` and no `after`: nothing else will ever hold this row.
      expect(rows[1]?.after).toBeNull();
      expect(rows[1]?.before).toMatchObject({ slug: 'hand-sorted-anjeer' });
    });

    it('answers 404 for a product that does not exist', async () => {
      const admin = await asAdmin();

      await admin.client
        .delete(`${ADMIN_PRODUCTS}/${NO_SUCH_ID}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(404);
    });
  });

  describe('publish and unpublish', () => {
    it('publishes a draft onto the storefront and stamps publishedAt', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      const published = expectSuccess<AdminProduct>(
        await admin.client
          .post(`${ADMIN_PRODUCTS}/${created.id}/publish`)
          .set(CSRF_HEADER, admin.csrf)
          .expect(200),
      );

      expect(published.isPublished).toBe(true);
      expect(published.publishedAt).not.toBeNull();

      const publicView = expectSuccess<Product>(
        await agent(integration.app).get(`${CATALOG_PRODUCTS}/hand-sorted-anjeer`).expect(200),
      );
      expect(publicView.slug).toBe('hand-sorted-anjeer');

      const rows = await auditRows(created.id);
      expect(rows.map((row) => row.action)).toEqual(['product.create', 'product.publish']);
      expect(rows[1]?.before).toMatchObject({ isPublished: false });
      expect(rows[1]?.after).toMatchObject({ isPublished: true });
    });

    /**
     * Idempotent, and honest about it: no write, no audit row. A second `product.publish` row would
     * claim a change nobody made.
     */
    it('is idempotent, and records nothing for a publish that changed nothing', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      const first = expectSuccess<AdminProduct>(
        await admin.client
          .post(`${ADMIN_PRODUCTS}/${created.id}/publish`)
          .set(CSRF_HEADER, admin.csrf)
          .expect(200),
      );
      const second = expectSuccess<AdminProduct>(
        await admin.client
          .post(`${ADMIN_PRODUCTS}/${created.id}/publish`)
          .set(CSRF_HEADER, admin.csrf)
          .expect(200),
      );

      expect(second.publishedAt).toBe(first.publishedAt);
      expect((await auditRows(created.id)).map((row) => row.action)).toEqual([
        'product.create',
        'product.publish',
      ]);
    });

    /**
     * `publishedAt` records when the listing **first** went live, so a product pulled for a week
     * while a photo is redone does not come back looking newly launched.
     */
    it('keeps the original publishedAt across an unpublish and republish', async () => {
      const admin = await asAdmin();
      const created = await create(admin);
      const publish = () =>
        admin.client
          .post(`${ADMIN_PRODUCTS}/${created.id}/publish`)
          .set(CSRF_HEADER, admin.csrf)
          .expect(200);

      const first = expectSuccess<AdminProduct>(await publish());
      await admin.client
        .post(`${ADMIN_PRODUCTS}/${created.id}/unpublish`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(200);
      const again = expectSuccess<AdminProduct>(await publish());

      expect(again.publishedAt).toBe(first.publishedAt);
      expect((await auditRows(created.id)).map((row) => row.action).sort()).toEqual([
        'product.create',
        'product.publish',
        'product.publish',
        'product.unpublish',
      ]);
    });

    /**
     * **Decision 2, asserted rather than invented.** Unpublishing a product that sits in live carts
     * writes nothing to those carts, and `CartReadService.toValidatable`'s existing sold-out
     * handling (spec §10.1) is what reports it: the product's rules map to `null`, `verdictFor`
     * answers `NOT_FOUND` for the line, the row **stays** in `GET /cart` with no price, the money
     * leaves it out, and `ok` is false so checkout is blocked. The customer keeps a line they can
     * remove.
     *
     * The alternative — deleting the cart rows — was already rejected there, in writing: "an admin
     * who withdraws a product for a week would have emptied every basket holding it". This test is
     * what stops a later edit reopening that.
     */
    it('leaves a cart holding the product intact, reporting the line unavailable', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      expectStatus(
        await customer.client
          .put(CART)
          .set(CSRF_HEADER, customer.csrf)
          .send({
            lines: [
              { slug: 'premium-california-almonds', mode: 'retail', size: '1kg', qty: 2 },
              { slug: 'w320-cashews', mode: 'retail', size: '250g', qty: 1 },
            ],
          }),
        200,
      );

      const admin = await asAdmin();
      await admin.client
        .post(`${ADMIN_PRODUCTS}/${await productId('premium-california-almonds')}/unpublish`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(200);

      // The row is still there — not silently deleted from the basket.
      const cart = expectSuccess<{
        lines: { slug: string }[];
        totals: { subtotal: number; hasUnpriceableLines: boolean };
      }>(await customer.client.get(CART).expect(200));
      expect(cart.lines.map((line) => line.slug)).toEqual([
        'premium-california-almonds',
        'w320-cashews',
      ]);

      const validation = expectSuccess<CartValidationResult>(
        await customer.client.post(`${CART}/validate`).set(CSRF_HEADER, customer.csrf).send({}),
      );

      expect(validation.ok).toBe(false);
      const withdrawn = validation.lines.find((line) => line.slug === 'premium-california-almonds');
      expect(withdrawn).toMatchObject({ unavailable: true, code: 'NOT_FOUND', lineTotal: null });
      // The other line is untouched and still priced.
      const kept = validation.lines.find((line) => line.slug === 'w320-cashews');
      expect(kept?.unavailable).toBe(false);
      expect(kept?.code).toBeUndefined();
      expect(kept?.lineTotal).toBeGreaterThan(0);
      // The withdrawn line contributes nothing to the money, and the honesty flag is raised.
      expect(validation.totals.hasUnpriceableLines).toBe(true);

      // And the storefront can no longer see it at all.
      await agent(integration.app)
        .get(`${CATALOG_PRODUCTS}/premium-california-almonds`)
        .expect(404);
    });
  });

  describe('authorisation', () => {
    it('refuses an anonymous caller with 401', async () => {
      await agent(integration.app).get(ADMIN_PRODUCTS).expect(401);
    });

    it('refuses a signed-in customer with 403 on every verb', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      const id = await productId('premium-california-almonds');

      await customer.client.get(ADMIN_PRODUCTS).expect(403);
      await customer.client.get(`${ADMIN_PRODUCTS}/${id}`).expect(403);
      await customer.client
        .post(ADMIN_PRODUCTS)
        .set(CSRF_HEADER, customer.csrf)
        .send(await productBody())
        .expect(403);
      await customer.client
        .patch(`${ADMIN_PRODUCTS}/${id}`)
        .set(CSRF_HEADER, customer.csrf)
        .send({ name: 'Mine now' })
        .expect(403);
      await customer.client
        .delete(`${ADMIN_PRODUCTS}/${id}`)
        .set(CSRF_HEADER, customer.csrf)
        .expect(403);
      await customer.client
        .post(`${ADMIN_PRODUCTS}/${id}/unpublish`)
        .set(CSRF_HEADER, customer.csrf)
        .expect(403);
      await customer.client.get('/api/v1/admin/categories').expect(403);
    });

    /** `CsrfGuard` is global and precedes the JWT guard, so a write with no token is a 403. */
    it('refuses a state-changing request with no CSRF token', async () => {
      const admin = await asAdmin();

      await admin.client
        .post(ADMIN_PRODUCTS)
        .send(await productBody())
        .expect(403);
    });
  });
});
