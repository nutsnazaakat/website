import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type {
  AdminDashboard,
  AdminInventoryRow,
  AdminInventoryTransaction,
  Paginated,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/inventory';
const DASHBOARD = '/api/v1/admin/dashboard';
const CSRF_HEADER = 'X-CSRF-Token';
const NO_SUCH_VARIANT = '00000000-0000-4000-8000-000000000000';
/** Every seeded variant. `catalog.seed.ts`: retail packs open at 120, bulk at 40, threshold 10. */
const SEEDED_THRESHOLD = 10;

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string;
}

/**
 * The three stock surfaces plan 9.2 Tasks 1 and 2 add: `GET /admin/inventory`,
 * `GET /admin/inventory/:variantId/transactions`, and
 * `PATCH /admin/inventory/:variantId/threshold`.
 *
 * `inventory.integration.spec.ts` covers the adjustment beside them and is not duplicated here.
 * What this file exists for is the half only a real database can answer, and for these three routes
 * that is most of it:
 *
 * - every figure and every filter is computed by Postgres, so the predicates are only as correct as
 *   Postgres says they are — a double asked "is this row low?" would answer with whatever the double
 *   was told;
 * - **spec §12's inclusive `<=` and `checkLowStock`'s strict `<` disagree at exactly the threshold,
 *   deliberately.** Both ends are asserted here, through the real routes, so neither can be "fixed"
 *   to match the other without a failing test saying so;
 * - the low-stock **filter** and the `low` **flag** are the same SQL expression, and the
 *   out-of-stock filter mirrors `variantSoldOut`; agreement between them is asserted over whole
 *   pages rather than trusted;
 * - `?status=low`'s `total` and the dashboard's Low Stock card are the same figure, which is only
 *   true while neither of them filters on anything the other does not;
 * - a threshold change writes an audit row and **no** ledger row, in one transaction.
 */
describe('admin inventory surfaces', () => {
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
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);

  /** Seeded variants in SKU order, so a test can name "the first three" reproducibly. */
  const someVariants = async (
    count: number,
  ): Promise<{ variantId: string; sku: string; productName: string }[]> =>
    integration.dataSource.query<{ variantId: string; sku: string; productName: string }[]>(
      `SELECT i.variant_id AS "variantId", v.sku AS "sku", p.name AS "productName"
         FROM inventory i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
        ORDER BY v.sku
        LIMIT $1`,
      [count],
    );

  /**
   * Moves a variant's stock **without** going through the endpoint, writing the compensating ledger
   * row by hand.
   *
   * The ledger row is not optional bookkeeping: `SUM(inventory_transactions.delta) = inventory.onHand`
   * per variant is the invariant `schema-invariants.integration.spec.ts` asserts, so a fixture that
   * wrote only the column would make an unrelated suite fail on this file's leftovers if the cleaner
   * ever missed. `inventory.integration.spec.ts`'s `reserve` helper does the same.
   *
   * Used where the *starting state* is the point. Where the **crossing** is the point, the test goes
   * through `PATCH /admin/inventory/:variantId` instead, because the notification only exists on
   * that path.
   */
  const setStock = async (
    variantId: string,
    onHand: number,
    reserved = 0,
    lowStockThreshold = SEEDED_THRESHOLD,
  ): Promise<void> => {
    const [row] = await integration.dataSource.query<{ onHand: number }[]>(
      'SELECT "onHand" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    const opening = Number(row?.onHand);
    await integration.dataSource.query(
      'UPDATE inventory SET "onHand" = $2, reserved = $3, "lowStockThreshold" = $4 WHERE variant_id = $1',
      [variantId, onHand, reserved, lowStockThreshold],
    );
    if (onHand !== opening) {
      await integration.dataSource.query(
        `INSERT INTO inventory_transactions (variant_id, delta, type, reason, "balanceAfter")
         VALUES ($1, $2, 'ADJUSTMENT', 'Fixture: set up a stock position', $3)`,
        [variantId, onHand - opening, onHand],
      );
    }
  };

  const auditRows = async (): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", before, after, actor_user_id
         FROM audit_logs ORDER BY "createdAt", action`,
    );

  const lowStockNotifications = async (variantId: string): Promise<unknown[]> =>
    integration.dataSource.query(
      `SELECT payload FROM notifications
        WHERE template = 'stock.low' AND payload->>'variantId' = $1`,
      [variantId],
    );

  const ledgerCount = async (variantId: string): Promise<number> => {
    const [row] = await integration.dataSource.query<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM inventory_transactions WHERE variant_id = $1',
      [variantId],
    );
    return Number(row?.count);
  };

  /** Rows where the denormalised column and the append-only ledger disagree. Must always be empty. */
  const drift = async (): Promise<unknown[]> =>
    integration.dataSource.query(`
      SELECT i.variant_id
        FROM inventory i
        LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
       GROUP BY i.variant_id, i."onHand"
      HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
    `);

  describe('GET /admin/inventory', () => {
    it('answers brief §32 in full for every stock position', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      await setStock(variantId, 30, 4, 12);
      const { client } = await asAdmin();

      const response = await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200);
      const page = expectSuccess<Paginated<AdminInventoryRow>>(response);

      // `expect.any()` is typed `any`. Widening it to `unknown` through an annotated const keeps the
      // matcher usable inside `toEqual` with `no-unsafe-assignment` still on —
      // `health.integration.spec.ts` establishes this.
      const anyString: unknown = expect.any(String);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        variantId,
        sku: variant?.sku,
        size: anyString,
        isActive: true,
        productId: anyString,
        productName: variant?.productName,
        onHand: 30,
        reserved: 4,
        available: 26,
        lowStockThreshold: 12,
        low: false,
        outOfStock: false,
        updatedAt: anyString,
      });
    });

    it('counts every inventory row, and pages without repeating or losing one', async () => {
      const { client } = await asAdmin();
      const [row] = await integration.dataSource.query<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM inventory',
      );
      const expected = Number(row?.count);

      const first = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?limit=5&page=1`).expect(200),
      );
      const second = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?limit=5&page=2`).expect(200),
      );

      expect(first.total).toBe(expected);
      expect(second.total).toBe(expected);
      expect(first.items).toHaveLength(5);
      expect(second.items).toHaveLength(5);
      // Disjoint. An unstable tiebreak over LIMIT/OFFSET is how the same row lands on two pages.
      const ids = new Set([...first.items, ...second.items].map((item) => item.variantId));
      expect(ids.size).toBe(10);
    });

    /**
     * The worklist order this screen exists for: emptiest first, so the top of page 1 is the worst
     * of it. Every seeded variant sits at 40 or 120, so three deliberately lower positions must
     * sort ahead of all of them, in the order set here.
     */
    it('puts the emptiest stock first', async () => {
      const found = await someVariants(3);
      await setStock(String(found[0]?.variantId), 25);
      await setStock(String(found[1]?.variantId), 0);
      await setStock(String(found[2]?.variantId), 10);
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?limit=3`).expect(200),
      );

      expect(page.items.map((item) => item.available)).toEqual([0, 10, 25]);
      expect(page.items.map((item) => item.variantId)).toEqual([
        found[1]?.variantId,
        found[2]?.variantId,
        found[0]?.variantId,
      ]);
    });

    it('filters by SKU and by product name', async () => {
      const [variant] = await someVariants(1);
      const { client } = await asAdmin();

      const bySku = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200),
      );
      const byName = expectSuccess<Paginated<AdminInventoryRow>>(
        await client
          .get(`${BASE}?q=${encodeURIComponent(String(variant?.productName).slice(0, 10))}`)
          .expect(200),
      );

      expect(bySku.items.map((item) => item.sku)).toEqual([variant?.sku]);
      expect(byName.total).toBeGreaterThan(0);
      expect(byName.items.map((item) => item.variantId)).toContain(variant?.variantId);
    });

    /**
     * **Spec §12's `<=`, at exactly the threshold, driven through the real endpoints — and the
     * `stock.low` event's strict `<` alongside it.**
     *
     * The adjustment lands the variant exactly on its threshold. The list calls it low; the
     * notification does not fire. That disagreement is deliberate — a card is a standing question,
     * an event is a crossing — and it is asserted in one test so neither end can be changed to
     * match the other in silence. The second adjustment, one pack lower, is what does notify.
     */
    it('calls a variant at exactly its threshold low, while stock.low stays silent', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf } = await asAdmin();

      const [opening] = await integration.dataSource.query<{ onHand: number }[]>(
        'SELECT "onHand" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({
          delta: SEEDED_THRESHOLD - Number(opening?.onHand),
          reason: 'Stock count: down to the threshold exactly',
        })
        .expect(200);

      const atThreshold = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200),
      );
      expect(atThreshold.items[0]).toMatchObject({ available: SEEDED_THRESHOLD, low: true });
      expect(await lowStockNotifications(variantId)).toEqual([]);

      // One pack lower is the crossing, and the event fires exactly there.
      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'One more sold at the counter' })
        .expect(200);

      expect(await lowStockNotifications(variantId)).toHaveLength(1);
      expect(await drift()).toEqual([]);
    });

    it('narrows to low stock, out stock included, and to out alone', async () => {
      const found = await someVariants(3);
      await setStock(String(found[0]?.variantId), SEEDED_THRESHOLD);
      await setStock(String(found[1]?.variantId), 0);
      await setStock(String(found[2]?.variantId), SEEDED_THRESHOLD + 1);
      const { client } = await asAdmin();

      const low = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=low&limit=60`).expect(200),
      );
      const out = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=out&limit=60`).expect(200),
      );

      // `low` contains `out`: a threshold is never negative, so zero available satisfies both.
      expect(low.items.map((item) => item.variantId).sort()).toEqual(
        [found[0]?.variantId, found[1]?.variantId].sort(),
      );
      expect(out.items.map((item) => item.variantId)).toEqual([found[1]?.variantId]);
      // One above the threshold is not low. The boundary is asserted from both sides.
      expect(low.items.map((item) => item.variantId)).not.toContain(found[2]?.variantId);
    });

    /**
     * The filter and the flag are two implementations of one rule — `SQL_LOW_STOCK` /
     * `SQL_OUT_OF_STOCK` in the `WHERE` clause, `variantSoldOut` on the wire — so their agreement is
     * asserted over whole pages rather than assumed. This is the test that fails if one of them is
     * edited and the other is not.
     */
    it('agrees between the filters and the flags on every row', async () => {
      const found = await someVariants(3);
      await setStock(String(found[0]?.variantId), 0);
      await setStock(String(found[1]?.variantId), 5);
      const { client } = await asAdmin();

      const all = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?limit=60`).expect(200),
      );
      const low = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=low&limit=60`).expect(200),
      );
      const out = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=out&limit=60`).expect(200),
      );

      expect(low.items.every((item) => item.low)).toBe(true);
      expect(out.items.every((item) => item.outOfStock && item.low)).toBe(true);
      // And the other direction, over the unfiltered page: no row carries a flag the filter missed.
      const lowIds = new Set(low.items.map((item) => item.variantId));
      const outIds = new Set(out.items.map((item) => item.variantId));
      expect(all.items.filter((item) => item.low && !lowIds.has(item.variantId))).toEqual([]);
      expect(all.items.filter((item) => item.outOfStock && !outIds.has(item.variantId))).toEqual(
        [],
      );
    });

    /**
     * `low` is about `available`, not `onHand` — spec §10.1. A variant with plenty on the shelf and
     * all of it spoken for needs reordering, and the figure the storefront sells from is the one the
     * reorder list must use.
     */
    it('measures low against available, not on-hand', async () => {
      const [variant] = await someVariants(1);
      await setStock(String(variant?.variantId), 40, 32, SEEDED_THRESHOLD);
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200),
      );

      expect(page.items[0]).toMatchObject({ onHand: 40, reserved: 32, available: 8, low: true });
    });

    /**
     * The dashboard's Low Stock card and this list's `?status=low` total are **one figure**, computed
     * from one SQL predicate. They can only stay equal while neither endpoint filters on something
     * the other does not — which is why this list has no `isActive` or `isPublished` filter and does
     * not apply one by default. A card that disagrees with the screen it links to is worse than
     * either being absent.
     */
    it('reports the same low-stock figure as the dashboard card', async () => {
      const found = await someVariants(2);
      await setStock(String(found[0]?.variantId), SEEDED_THRESHOLD);
      await setStock(String(found[1]?.variantId), 0);
      const { client } = await asAdmin();

      const list = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=low&limit=60`).expect(200),
      );
      const dashboard = expectSuccess<AdminDashboard>(await client.get(DASHBOARD).expect(200));

      expect(list.total).toBe(2);
      expect(dashboard.cards.lowStock).toBe(list.total);
    });

    it('lists a deactivated variant, marked as such', async () => {
      const [variant] = await someVariants(1);
      await integration.dataSource.query(
        'UPDATE product_variants SET "isActive" = false WHERE id = $1',
        [variant?.variantId],
      );
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200),
      );

      expect(page.items[0]).toMatchObject({ variantId: variant?.variantId, isActive: false });
    });

    describe('validation', () => {
      it('rejects a status outside low and out', async () => {
        const { client } = await asAdmin();

        const response = await client.get(`${BASE}?status=plenty`).expect(400);

        expect(expectError(response).details).toHaveProperty('status');
      });

      it('rejects a limit above the cap rather than answering a different question', async () => {
        const { client } = await asAdmin();

        const response = await client.get(`${BASE}?limit=61`).expect(400);

        expect(expectError(response).details).toHaveProperty('limit');
      });

      /** `forbidNonWhitelisted`: an undeclared filter is a 400, not a silently unfiltered page. */
      it('rejects a filter it does not declare', async () => {
        const { client } = await asAdmin();

        await client.get(`${BASE}?channel=retail`).expect(400);
      });
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403', async () => {
        const { client } = await signIn(UserRole.CUSTOMER);

        await client.get(BASE).expect(403);
      });

      /** 401, not 403: a GET is not state-changing, so `CsrfGuard` does not run ahead of the token. */
      it('refuses an anonymous request with 401', async () => {
        await agent(integration.app).get(BASE).expect(401);
      });
    });
  });

  describe('GET /admin/inventory/:variantId/transactions', () => {
    it('answers brief §32 history newest first, naming the admin and the reason', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf, user } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -7, reason: 'Damaged in transit' })
        .expect(200);
      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: 20, reason: 'Restocked from the mill' })
        .expect(200);

      const page = expectSuccess<Paginated<AdminInventoryTransaction>>(
        await client.get(`${BASE}/${variantId}/transactions`).expect(200),
      );

      expect(page.total).toBe(3);
      // Newest first: the restock, then the write-off, then the seeder's opening receipt.
      expect(page.items.map((item) => item.reason)).toEqual([
        'Restocked from the mill',
        'Damaged in transit',
        'Opening stock (seed)',
      ]);
      const anyString: unknown = expect.any(String);
      expect(page.items[0]).toEqual({
        id: anyString,
        variantId,
        delta: 20,
        type: 'ADJUSTMENT',
        reason: 'Restocked from the mill',
        balanceAfter: 133,
        orderId: null,
        orderNumber: null,
        actorUserId: user.id,
        actorName: user.name,
        createdAt: anyString,
      });
      // A movement no admin made carries no attribution rather than a wrong one.
      expect(page.items[2]).toMatchObject({
        type: 'RECEIPT',
        actorUserId: null,
        actorName: null,
      });
    });

    /**
     * The soft link to the order, which is what makes a `SALE` row traceable to a basket. Written
     * directly rather than by placing an order: `order.factory.ts` explains why a fixture built out
     * of `POST /checkout/orders` drags five subsystems into a test about something else — and this
     * row is deliberately `delta: 0` so it cannot disturb `SUM(delta) = onHand`.
     */
    it('carries the order number on a movement a sale caused', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const order = await createTestOrder(integration.dataSource, {
        status: 'confirmed',
        totalRupees: 1499,
      });
      await integration.dataSource.query(
        `INSERT INTO inventory_transactions (variant_id, delta, type, reason, "balanceAfter", order_id)
         VALUES ($1, 0, 'SALE', 'Sold on ${order.orderNumber}', 120, $2)`,
        [variantId, order.id],
      );
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminInventoryTransaction>>(
        await client.get(`${BASE}/${variantId}/transactions`).expect(200),
      );

      expect(page.items[0]).toMatchObject({
        type: 'SALE',
        orderId: order.id,
        orderNumber: order.orderNumber,
      });
      expect(await drift()).toEqual([]);
    });

    it('paginates', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf } = await asAdmin();

      for (const delta of [-1, -2, -3]) {
        await client
          .patch(`${BASE}/${variantId}`)
          .set(CSRF_HEADER, csrf)
          .send({ delta, reason: 'Stock count correction' })
          .expect(200);
      }

      const first = expectSuccess<Paginated<AdminInventoryTransaction>>(
        await client.get(`${BASE}/${variantId}/transactions?limit=2&page=1`).expect(200),
      );
      const second = expectSuccess<Paginated<AdminInventoryTransaction>>(
        await client.get(`${BASE}/${variantId}/transactions?limit=2&page=2`).expect(200),
      );

      expect(first.total).toBe(4);
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(2);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    });

    /**
     * A 404, not an empty page. They look the same to a client and mean entirely different things:
     * "no history" sends the operator looking for a write that failed, when they mistyped a uuid.
     */
    it('answers 404 NOT_FOUND for a variant that does not exist', async () => {
      const { client } = await asAdmin();

      const response = await client.get(`${BASE}/${NO_SUCH_VARIANT}/transactions`).expect(404);

      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('rejects a variant id that is not a uuid', async () => {
      const { client } = await asAdmin();

      await client.get(`${BASE}/not-a-uuid/transactions`).expect(400);
    });

    it('refuses a signed-in customer with 403', async () => {
      const [variant] = await someVariants(1);
      const { client } = await signIn(UserRole.CUSTOMER);

      await client.get(`${BASE}/${String(variant?.variantId)}/transactions`).expect(403);
    });
  });

  describe('PATCH /admin/inventory/:variantId/threshold', () => {
    it('changes the threshold and answers with the resulting position', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 45 })
        .expect(200);

      expect(expectSuccess<AdminInventoryRow>(response)).toMatchObject({
        variantId,
        lowStockThreshold: 45,
        sku: variant?.sku,
      });
      const [row] = await integration.dataSource.query<{ lowStockThreshold: number }[]>(
        'SELECT "lowStockThreshold" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      expect(Number(row?.lowStockThreshold)).toBe(45);
    });

    it('records one audit row naming both thresholds and the admin who changed them', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf, user } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 30 })
        .expect(200);

      expect(await auditRows()).toEqual([
        {
          action: 'inventory.update',
          entity: 'inventory',
          entityId: variantId,
          before: { lowStockThreshold: SEEDED_THRESHOLD },
          after: { lowStockThreshold: 30 },
          actor_user_id: user.id,
        },
      ]);
    });

    /**
     * **No ledger row, because no stock moved.** The whole reason this is a route of its own: an
     * `inventory_transactions` row asserting a movement of zero would satisfy `SUM(delta) = onHand`
     * and corrupt the meaning of an append-only trail, which `InventoryService.adjust` already
     * refuses to do for an adjustment of zero.
     */
    it('writes no ledger row', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const before = await ledgerCount(variantId);
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 60 })
        .expect(200);

      expect(await ledgerCount(variantId)).toBe(before);
      expect(await drift()).toEqual([]);
    });

    /**
     * **The decision, end to end.** Raising the threshold past `available` makes the variant low and
     * queues nothing: `stock.low` is an event about stock moving, and no stock moved. The state is
     * not lost — the row appears under `?status=low` immediately, and on the dashboard card — which
     * is the answer to the only real objection to not notifying. `InventoryService.setThreshold`
     * carries the full reasoning.
     */
    it('queues no stock.low, and surfaces the new low state on the list instead', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf } = await asAdmin();

      const before = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?q=${String(variant?.sku)}`).expect(200),
      );
      expect(before.items[0]).toMatchObject({ low: false });

      const response = await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 500 })
        .expect(200);

      expect(expectSuccess<AdminInventoryRow>(response).low).toBe(true);
      expect(await lowStockNotifications(variantId)).toEqual([]);

      const after = expectSuccess<Paginated<AdminInventoryRow>>(
        await client.get(`${BASE}?status=low&limit=60`).expect(200),
      );
      expect(after.items.map((item) => item.variantId)).toEqual([variantId]);
    });

    /** Plan 9.1's rule: a write that changes nothing writes no audit row, idempotent calls included. */
    it('writes nothing on a second call carrying the same threshold', async () => {
      const [variant] = await someVariants(1);
      const variantId = String(variant?.variantId);
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 20 })
        .expect(200);
      const response = await client
        .patch(`${BASE}/${variantId}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 20 })
        .expect(200);

      expect(expectSuccess<AdminInventoryRow>(response).lowStockThreshold).toBe(20);
      expect(await auditRows()).toHaveLength(1);
    });

    it('answers 404 NOT_FOUND for a variant that does not exist, writing no audit row', async () => {
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${NO_SUCH_VARIANT}/threshold`)
        .set(CSRF_HEADER, csrf)
        .send({ lowStockThreshold: 5 })
        .expect(404);

      expect(expectError(response).code).toBe('NOT_FOUND');
      expect(await auditRows()).toEqual([]);
    });

    describe('validation', () => {
      const badBody = async (body: Record<string, unknown>): Promise<void> => {
        const [variant] = await someVariants(1);
        const { client, csrf } = await asAdmin();

        await client
          .patch(`${BASE}/${String(variant?.variantId)}/threshold`)
          .set(CSRF_HEADER, csrf)
          .send(body)
          .expect(400);
      };

      /** Required, not optional: with one field, an empty body is not a partial update. */
      it('rejects an empty body', async () => {
        await badBody({});
      });

      it('rejects a fractional threshold', async () => {
        await badBody({ lowStockThreshold: 2.5 });
      });

      it('rejects a negative threshold', async () => {
        await badBody({ lowStockThreshold: -1 });
      });

      /** `whitelist` plus `forbidNonWhitelisted` is spec §13's mass-assignment defence. */
      it('rejects a body trying to name its own actor', async () => {
        await badBody({ lowStockThreshold: 5, actorUserId: NO_SUCH_VARIANT });
      });

      /** Zero is legal: it means "warn me only once it is actually gone". */
      it('accepts zero', async () => {
        const [variant] = await someVariants(1);
        const { client, csrf } = await asAdmin();

        const response = await client
          .patch(`${BASE}/${String(variant?.variantId)}/threshold`)
          .set(CSRF_HEADER, csrf)
          .send({ lowStockThreshold: 0 })
          .expect(200);

        expect(expectSuccess<AdminInventoryRow>(response)).toMatchObject({
          lowStockThreshold: 0,
          low: false,
        });
      });
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403, changing nothing', async () => {
        const [variant] = await someVariants(1);
        const variantId = String(variant?.variantId);
        const { client, csrf } = await signIn(UserRole.CUSTOMER);

        await client
          .patch(`${BASE}/${variantId}/threshold`)
          .set(CSRF_HEADER, csrf)
          .send({ lowStockThreshold: 999 })
          .expect(403);

        const [row] = await integration.dataSource.query<{ lowStockThreshold: number }[]>(
          'SELECT "lowStockThreshold" FROM inventory WHERE variant_id = $1',
          [variantId],
        );
        expect(Number(row?.lowStockThreshold)).toBe(SEEDED_THRESHOLD);
        expect(await auditRows()).toEqual([]);
      });

      /** 403 rather than 401: `CsrfGuard` runs ahead of `JwtAuthGuard` on a state-changing request. */
      it('refuses an anonymous request', async () => {
        const [variant] = await someVariants(1);

        await agent(integration.app)
          .patch(`${BASE}/${String(variant?.variantId)}/threshold`)
          .send({ lowStockThreshold: 999 })
          .expect(403);
      });
    });
  });
});
