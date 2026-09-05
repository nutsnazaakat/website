import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminOrder, AdminOrderSummary, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import {
  OrderChannelEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
  ShipmentStatus,
  UserRole,
} from '../../src/entities/enums';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectStatus, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/orders';
const CSRF_HEADER = 'X-CSRF-Token';

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string;
}

interface SeededVariant {
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  onHand: number;
}

/**
 * The admin order surfaces — plan 9.2 Tasks 3 to 6.
 *
 * What only a real database can answer, and for these routes that is the whole point of the task:
 *
 * - **the `audit_logs` row and the change it describes are one transaction.** `AuditLogService`'s
 *   contract is that an audit row must never outlive a write that rolled back, and a unit double
 *   cannot show that — it has no transaction to roll back. The refund-against-broken-stock case
 *   below drives `transition` down a path that genuinely fails *after* the audit write and asserts
 *   the trail is empty and the order unmoved;
 * - **the per-channel vocabularies are enforced from the row's own channel**, so a bulk status on a
 *   retail order is refused with the real `allowed` list rather than accepted into a `varchar`;
 * - **stock follows status** — a cancellation restores `onHand` and writes the compensating
 *   `CANCELLATION` ledger rows, a refund does so only when the admin says the goods are resellable,
 *   and `SUM(inventory_transactions.delta) = inventory.onHand` survives both.
 */
describe('admin order surfaces', () => {
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

  /** A seeded retail variant with a real `inventory` row, so a restock has somewhere to land. */
  const seededVariant = async (): Promise<SeededVariant> => {
    const [row] = await integration.dataSource.query<SeededVariant[]>(
      `SELECT v.id AS "variantId", p.id AS "productId", p.slug AS "slug", p.name AS "name",
              i."onHand" AS "onHand"
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         JOIN inventory i ON i.variant_id = v.id
        ORDER BY v.sku
        LIMIT 1`,
    );
    if (row === undefined) throw new Error('seedCatalog produced no stocked variant');
    return row;
  };

  const auditRows = async (): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", before, after, actor_user_id
         FROM audit_logs ORDER BY "createdAt", action`,
    );

  const statusOf = async (orderNumber: string): Promise<string> => {
    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM orders WHERE "orderNumber" = $1',
      [orderNumber],
    );
    return String(row?.status);
  };

  interface PaymentRow {
    status: string;
    collectedAt: Date | null;
    reference: string | null;
  }

  const paymentsFor = async (orderId: string): Promise<PaymentRow[]> =>
    integration.dataSource.query<PaymentRow[]>(
      'SELECT status, "collectedAt", reference FROM payments WHERE order_id = $1',
      [orderId],
    );

  const paymentStatusOn = async (orderNumber: string): Promise<string> => {
    const [row] = await integration.dataSource.query<{ paymentStatus: string }[]>(
      'SELECT "paymentStatus" FROM orders WHERE "orderNumber" = $1',
      [orderNumber],
    );
    return String(row?.paymentStatus);
  };

  interface ShipmentRow {
    id: string;
    courier: string | null;
    trackingNumber: string | null;
    status: string;
    shippedAt: Date | null;
  }

  const shipmentsFor = async (orderId: string): Promise<ShipmentRow[]> =>
    integration.dataSource.query<ShipmentRow[]>(
      `SELECT id, courier, "trackingNumber", status, "shippedAt"
         FROM shipments WHERE order_id = $1 ORDER BY "createdAt"`,
      [orderId],
    );

  const onHandOf = async (variantId: string): Promise<number> => {
    const [row] = await integration.dataSource.query<{ onHand: number }[]>(
      'SELECT "onHand" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    return Number(row?.onHand);
  };

  const ledgerFor = async (variantId: string): Promise<{ delta: number; type: string }[]> =>
    integration.dataSource.query<{ delta: number; type: string }[]>(
      'SELECT delta, type FROM inventory_transactions WHERE variant_id = $1 ORDER BY "createdAt"',
      [variantId],
    );

  /** Rows where the denormalised column and the append-only ledger disagree. Must always be empty. */
  const drift = async (): Promise<unknown[]> =>
    integration.dataSource.query(`
      SELECT i.variant_id
        FROM inventory i
        LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
       GROUP BY i.variant_id, i."onHand"
      HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
    `);

  describe('GET /admin/orders', () => {
    /** Brief §33's columns are normative, so the row is asserted whole rather than field by field. */
    it('answers brief §33’s columns for every order in the shop', async () => {
      const customer = await createTestUser(integration.dataSource);
      const order = await createTestOrder(integration.dataSource, {
        status: 'processing',
        totalRupees: 2450,
        userId: customer.id,
        placedAt: new Date('2026-08-10T09:00:00.000Z'),
      });
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminOrderSummary>>(await client.get(BASE).expect(200));

      expect(page).toMatchObject({ total: 1, page: 1, limit: 24 });
      expect(page.items[0]).toEqual({
        id: order.orderNumber,
        customer: {
          userId: customer.id,
          name: 'Asha Rao',
          email: 'fixture@demo.in',
          phone: '9876543210',
          businessId: null,
          companyName: null,
        },
        channel: 'retail',
        status: 'processing',
        total: 2450,
        paymentMethod: 'cod',
        paymentStatus: 'pending',
        placedAt: '2026-08-10T09:00:00.000Z',
      });
    });

    /**
     * A guest order has no account, and `userId: null` is the only field that says so — the name and
     * the email on the row are the delivery contact, which a guest order has like any other. Without
     * the null an operator cannot tell a guest from an account-holder called Asha Rao.
     */
    it('reports a guest order as one, without losing its delivery contact', async () => {
      await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 300,
        userId: null,
      });
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminOrderSummary>>(await client.get(BASE).expect(200));

      expect(page.items[0]?.customer).toMatchObject({ userId: null, email: 'fixture@demo.in' });
    });

    it('lists both channels and narrows to one on request', async () => {
      await createTestOrder(integration.dataSource, { status: 'pending', totalRupees: 500 });
      await createTestOrder(integration.dataSource, {
        status: 'quote-requested',
        totalRupees: 60_000,
        channel: OrderChannelEnum.BULK,
      });
      const { client } = await asAdmin();

      const all = expectSuccess<Paginated<AdminOrderSummary>>(await client.get(BASE).expect(200));
      expect(all.total).toBe(2);

      const bulk = expectSuccess<Paginated<AdminOrderSummary>>(
        await client.get(`${BASE}?channel=bulk`).expect(200),
      );
      expect(bulk.total).toBe(1);
      expect(bulk.items[0]).toMatchObject({ channel: 'bulk', status: 'quote-requested' });
    });

    it('narrows by status', async () => {
      await createTestOrder(integration.dataSource, { status: 'pending', totalRupees: 500 });
      await createTestOrder(integration.dataSource, { status: 'delivered', totalRupees: 700 });
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminOrderSummary>>(
        await client.get(`${BASE}?status=delivered`).expect(200),
      );

      expect(page.total).toBe(1);
      expect(page.items[0]?.status).toBe('delivered');
    });

    /** Both bounds inclusive, which is only visible when an order sits exactly on one of them. */
    it('filters by an inclusive date range', async () => {
      const early = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 100,
        placedAt: new Date('2026-07-31T23:59:59.000Z'),
      });
      const onTheBoundary = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 200,
        placedAt: new Date('2026-08-01T00:00:00.000Z'),
      });
      const late = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 300,
        placedAt: new Date('2026-08-31T23:59:59.999Z'),
      });
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 400,
        placedAt: new Date('2026-09-01T00:00:01.000Z'),
      });
      const { client } = await asAdmin();

      const page = expectSuccess<Paginated<AdminOrderSummary>>(
        await client
          .get(`${BASE}?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z`)
          .expect(200),
      );

      expect(page.items.map((row) => row.id)).toEqual([
        late.orderNumber,
        onTheBoundary.orderNumber,
      ]);
      expect(page.items.map((row) => row.id)).not.toContain(early.orderNumber);
    });

    /**
     * Paging over orders that share a `placedAt` to the microsecond — which is what every fixture
     * and the seeder produce, since Postgres's `now()` is transaction-start time. Without the
     * `orderNumber` tiebreak the two pages overlap and an order is lost, and neither page looks
     * wrong on its own.
     */
    it('pages without repeating or losing an order when timestamps collide', async () => {
      const at = new Date('2026-08-15T12:00:00.000Z');
      for (let index = 0; index < 5; index += 1) {
        await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 100 + index,
          placedAt: at,
        });
      }
      const { client } = await asAdmin();

      const first = expectSuccess<Paginated<AdminOrderSummary>>(
        await client.get(`${BASE}?limit=2&page=1`).expect(200),
      );
      const second = expectSuccess<Paginated<AdminOrderSummary>>(
        await client.get(`${BASE}?limit=2&page=2`).expect(200),
      );
      const third = expectSuccess<Paginated<AdminOrderSummary>>(
        await client.get(`${BASE}?limit=2&page=3`).expect(200),
      );

      const seen = [...first.items, ...second.items, ...third.items].map((row) => row.id);
      expect(first.total).toBe(5);
      expect(new Set(seen).size).toBe(5);
    });

    describe('validation', () => {
      it('rejects a status that is not one of brief §33’s', async () => {
        const { client } = await asAdmin();

        const response = await client.get(`${BASE}?status=dispatched`).expect(400);

        expect(expectError(response).details).toHaveProperty('status');
      });

      it('rejects a channel outside the union rather than widening the query', async () => {
        const { client } = await asAdmin();

        const response = await client.get(`${BASE}?channel=gold`).expect(400);

        expect(expectError(response).details).toHaveProperty('channel');
      });

      it('rejects a date that is not a date', async () => {
        const { client } = await asAdmin();

        await client.get(`${BASE}?from=last-tuesday`).expect(400);
      });

      /** `forbidNonWhitelisted`: an undeclared filter is a 400, not a silently unfiltered page. */
      it('rejects a filter it does not declare', async () => {
        const { client } = await asAdmin();

        await client.get(`${BASE}?q=almond`).expect(400);
      });

      it('rejects a limit above the cap rather than answering a different question', async () => {
        const { client } = await asAdmin();

        await client.get(`${BASE}?limit=61`).expect(400);
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

  describe('GET /admin/orders/:orderNumber', () => {
    /**
     * Everything `/account/orders/:orderNumber` answers, plus the customer — and it is the same
     * mapper, so the two cannot disagree about one order. The timeline is the `order_events` rows
     * the customer's own tracking page renders, oldest first.
     */
    it('answers the full order: items, totals, address, timeline and payment state', async () => {
      const customer = await createTestUser(integration.dataSource);
      const order = await createTestOrder(integration.dataSource, {
        status: 'processing',
        totalRupees: 1500,
        userId: customer.id,
        items: [
          {
            productSlug: 'premium-california-almonds',
            name: 'Premium California Almonds',
            qty: 2,
            unitRupees: 750,
          },
        ],
        events: [
          { status: 'pending' },
          { status: 'confirmed', note: 'Payment verified' },
          { status: 'processing' },
        ],
      });
      const { client } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client.get(`${BASE}/${order.orderNumber}`).expect(200),
      );

      expect(body.id).toBe(order.orderNumber);
      expect(body.status).toBe('processing');
      expect(body.total).toBe(1500);
      expect(body.address).toMatchObject({ fullName: 'Asha Rao', pincode: '560025' });
      expect(body.items).toEqual([
        expect.objectContaining({ name: 'Premium California Almonds', qty: 2, total: 1500 }),
      ]);
      // Oldest first — `OrderTimeline` treats the last entry as the current step.
      expect(body.timeline.map((entry) => entry.status)).toEqual([
        'pending',
        'confirmed',
        'processing',
      ]);
      expect(body.paymentMethod).toBe('cod');
      expect(body.paymentStatus).toBe('pending');
      expect(body.customer).toMatchObject({ userId: customer.id, email: 'fixture@demo.in' });
    });

    /**
     * The admin read is by `orderNumber` alone — no owner clause, unlike every read in
     * `OrdersService`. An order placed by a guest, or by another customer, is the operator's to see.
     */
    it('reads an order with no account behind it', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 400,
        userId: null,
        events: [{ status: 'pending' }],
      });
      const { client } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client.get(`${BASE}/${order.orderNumber}`).expect(200),
      );

      expect(body.customer.userId).toBeNull();
    });

    it('answers 404 for an order number nobody placed', async () => {
      const { client } = await asAdmin();

      const response = await client.get(`${BASE}/NN-2026-999999`).expect(404);

      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403, even for their own order', async () => {
        const { client, user } = await signIn(UserRole.CUSTOMER);
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
          userId: user.id,
        });

        await client.get(`${BASE}/${order.orderNumber}`).expect(403);
      });

      it('refuses an anonymous request with 401', async () => {
        await agent(integration.app).get(`${BASE}/NN-2026-100000`).expect(401);
      });
    });
  });

  describe('POST /admin/orders/:orderNumber/status', () => {
    it('moves the order, appends the timeline event and answers with the committed order', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 1200,
      });
      const { client, csrf, user } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'confirmed', note: 'Payment verified over the phone' })
        .expect(200);

      const body = expectSuccess<AdminOrder>(response);
      expect(body.id).toBe(order.orderNumber);
      expect(body.status).toBe('confirmed');
      // The timeline the customer's tracking page renders is the same rows — spec §10.3.
      expect(body.timeline).toEqual([
        expect.objectContaining({ status: 'confirmed', note: 'Payment verified over the phone' }),
      ]);
      expect(await statusOf(order.orderNumber)).toBe('confirmed');

      const [event] = await integration.dataSource.query<{ actor_user_id: string }[]>(
        'SELECT actor_user_id FROM order_events WHERE order_id = $1',
        [order.id],
      );
      expect(event?.actor_user_id).toBe(user.id);
    });

    /**
     * The row spec §5 requires — *"a status change that leaves no trace is a defect in this
     * milestone"* — carrying the actor from the signed token, the order's uuid, and both ends of the
     * change.
     */
    it('records exactly one audit row, attributed to the token’s admin', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'confirmed',
        totalRupees: 900,
      });
      const { client, csrf, user } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'processing' })
        .expect(200);

      expect(await auditRows()).toEqual([
        {
          action: 'order.status-change',
          entity: 'order',
          entityId: order.id,
          before: { status: 'confirmed' },
          after: { status: 'processing', orderNumber: order.orderNumber, note: null },
          actor_user_id: user.id,
        },
      ]);
    });

    /**
     * **The transaction property, and the only case that can measure it.**
     *
     * `putStockBack` answers 404 when a line's `inventory` row is missing — deliberately, *"rather
     * than write a CANCELLATION row for stock that never moved"* — which is a real failure *after*
     * the audit row is written. So an audit row written outside `transition`'s transaction survives
     * here, claiming a refund that never happened, while the order is still `delivered`.
     *
     * Moving `this.audit.record(manager, …)` to any other manager makes this fail and nothing else
     * in the repository notice.
     */
    it('rolls the audit row back with the transition when the stock consequence fails', async () => {
      const variant = await seededVariant();
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 500,
        items: [
          {
            productId: variant.productId,
            variantId: variant.variantId,
            productSlug: variant.slug,
            name: variant.name,
            qty: 2,
            unitRupees: 250,
          },
        ],
      });
      // The stock row a restock would credit, removed. Its ledger rows go with it, so the
      // `SUM(delta) = onHand` invariant is not left broken for the rest of the file.
      await integration.dataSource.query(
        'DELETE FROM inventory_transactions WHERE variant_id = $1',
        [variant.variantId],
      );
      await integration.dataSource.query('DELETE FROM inventory WHERE variant_id = $1', [
        variant.variantId,
      ]);
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'refunded', restock: true })
        .expect(404);

      expect(await auditRows()).toEqual([]);
      expect(await statusOf(order.orderNumber)).toBe('delivered');
      const [event] = await integration.dataSource.query<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM order_events WHERE order_id = $1',
        [order.id],
      );
      expect(Number(event?.count)).toBe(0);
    });

    it('refuses an illegal transition with 422 and the statuses that were available', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'shipped',
        totalRupees: 700,
      });
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'pending' })
        .expect(422);

      const error = expectError(response);
      expect(error.code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(error.details).toMatchObject({
        from: 'shipped',
        to: 'pending',
        allowed: ['out-for-delivery'],
      });
      expect(await auditRows()).toEqual([]);
      expect(await statusOf(order.orderNumber)).toBe('shipped');
    });

    /**
     * **The per-channel vocabularies, from both sides.** `transition` reads the channel off the row
     * and never from the caller, which is what stops a retail order being judged against the bulk
     * ladder — where `processing -> shipped` would slip past `packed`. Brief §33's two lists are
     * `shared/`'s and neither may be extended here.
     */
    it('refuses a B2B status on a retail order and a retail-only status on a B2B order', async () => {
      const retail = await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 400,
        channel: OrderChannelEnum.RETAIL,
      });
      const bulk = await createTestOrder(integration.dataSource, {
        status: 'processing',
        totalRupees: 40_000,
        channel: OrderChannelEnum.BULK,
      });
      const { client, csrf } = await asAdmin();

      const onRetail = await client
        .post(`${BASE}/${retail.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'quote-sent' })
        .expect(422);
      expect(expectError(onRetail).details).toMatchObject({ allowed: ['confirmed', 'cancelled'] });

      // `packed` exists only for retail; the bulk ladder goes `processing -> shipped`.
      const onBulk = await client
        .post(`${BASE}/${bulk.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'packed' })
        .expect(422);
      expect(expectError(onBulk).details).toMatchObject({ allowed: ['shipped'] });

      expect(await auditRows()).toEqual([]);
      expect(await statusOf(retail.orderNumber)).toBe('pending');
      expect(await statusOf(bulk.orderNumber)).toBe('processing');
    });

    /** A duplicate click. `canTransition` refuses a no-op, so no second identical event is appended. */
    it('refuses a move to the status the order already holds', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'packed',
        totalRupees: 600,
      });
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'packed' })
        .expect(422);

      expect(await auditRows()).toEqual([]);
    });

    /** A mistyped reference is a 404, never a 422 about a rule the operator did not break. */
    it('answers 404 for an order number nobody placed', async () => {
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/NN-2026-999999/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'confirmed' })
        .expect(404);

      expect(expectError(response).code).toBe('NOT_FOUND');
      expect(await auditRows()).toEqual([]);
    });

    it('restores stock and writes the CANCELLATION ledger row when an order is cancelled', async () => {
      const variant = await seededVariant();
      const opening = await onHandOf(variant.variantId);
      const order = await createTestOrder(integration.dataSource, {
        status: 'processing',
        totalRupees: 500,
        items: [
          {
            productId: variant.productId,
            variantId: variant.variantId,
            productSlug: variant.slug,
            name: variant.name,
            qty: 3,
            unitRupees: 166,
          },
        ],
      });
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'cancelled', note: 'Customer changed their mind' })
        .expect(200);

      expect(await onHandOf(variant.variantId)).toBe(opening + 3);
      expect(await ledgerFor(variant.variantId)).toEqual(
        expect.arrayContaining([{ delta: 3, type: 'CANCELLATION' }]),
      );
      expect(await drift()).toEqual([]);

      const [row] = await auditRows();
      expect(row?.after).toEqual({
        status: 'cancelled',
        orderNumber: order.orderNumber,
        note: 'Customer changed their mind',
      });
    });

    /**
     * Spec §10.3 makes restocking a judgement about the goods rather than a property of the status,
     * so the flag is read and nothing else. Both answers are recorded in the trail, because "the
     * admin decided not to restock" is a fact that exists nowhere else — there is no ledger row for
     * a decision not to move stock.
     */
    it('refunds without restocking unless told to, and records which was chosen', async () => {
      const variant = await seededVariant();
      const opening = await onHandOf(variant.variantId);
      const line = {
        productId: variant.productId,
        variantId: variant.variantId,
        productSlug: variant.slug,
        name: variant.name,
        qty: 2,
        unitRupees: 250,
      };
      const kept = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 500,
        items: [line],
      });
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${kept.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'refunded', restock: false })
        .expect(200);

      expect(await onHandOf(variant.variantId)).toBe(opening);
      expect((await auditRows())[0]?.after).toMatchObject({ restock: false });

      const resold = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 500,
        items: [line],
      });
      await client
        .post(`${BASE}/${resold.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'refunded', restock: true })
        .expect(200);

      expect(await onHandOf(variant.variantId)).toBe(opening + 2);
      expect(await ledgerFor(variant.variantId)).toEqual(
        expect.arrayContaining([{ delta: 2, type: 'RETURN' }]),
      );
      expect(await drift()).toEqual([]);
      expect((await auditRows())[1]?.after).toMatchObject({ restock: true });
    });

    /**
     * Brief §38 names "order shipped" and "order delivered" among its triggers, and `transition` is
     * where they are queued — so a route that wrote `status` directly would take the customer's
     * email with it. Asserted through the real route for exactly that reason.
     */
    it('queues the shipped notification through the route', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'packed',
        totalRupees: 800,
      });
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/status`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'shipped' })
        .expect(200);

      const queued = await integration.dataSource.query<{ template: string }[]>(
        "SELECT template FROM notifications WHERE payload->>'orderNumber' = $1",
        [order.orderNumber],
      );
      expect(queued.map((row) => row.template)).toEqual(['order.shipped']);
    });

    describe('validation', () => {
      it('refuses a refund that does not state the restock decision', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'delivered',
          totalRupees: 500,
        });
        const { client, csrf } = await asAdmin();

        const response = await client
          .post(`${BASE}/${order.orderNumber}/status`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'refunded' })
          .expect(400);

        expect(expectError(response).details).toHaveProperty('restock');
        expect(await statusOf(order.orderNumber)).toBe('delivered');
      });

      it('refuses a status that is not one at all', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
        });
        const { client, csrf } = await asAdmin();

        const response = await client
          .post(`${BASE}/${order.orderNumber}/status`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'dispatched' })
          .expect(400);

        expect(expectError(response).details).toHaveProperty('status');
      });

      /** `forbidNonWhitelisted`: a forged actor is a 400, not a field quietly stripped. */
      it('refuses a body carrying an actor of its own', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
        });
        const { client, csrf } = await asAdmin();

        await client
          .post(`${BASE}/${order.orderNumber}/status`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'confirmed', actorUserId: 'someone-else' })
          .expect(400);
      });
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403 and writes nothing', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
        });
        const { client, csrf } = await signIn(UserRole.CUSTOMER);

        await client
          .post(`${BASE}/${order.orderNumber}/status`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'confirmed' })
          .expect(403);

        expect(await statusOf(order.orderNumber)).toBe('pending');
        expect(await auditRows()).toEqual([]);
      });

      /** 403 from `CsrfGuard`, which runs ahead of the token on an unsafe method. */
      it('refuses an anonymous request', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
        });

        const response = await agent(integration.app)
          .post(`${BASE}/${order.orderNumber}/status`)
          .send({ status: 'confirmed' });

        expect([401, 403]).toContain(response.status);
        expect(await statusOf(order.orderNumber)).toBe('pending');
        expect(await auditRows()).toEqual([]);
      });

      /** The token is the only source of the actor; a matching CSRF pair does not substitute. */
      it('refuses an unsafe request with no CSRF header even from an admin', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'pending',
          totalRupees: 300,
        });
        const { client } = await asAdmin();

        expectStatus(
          await client.post(`${BASE}/${order.orderNumber}/status`).send({ status: 'confirmed' }),
          403,
        );
        expect(await statusOf(order.orderNumber)).toBe('pending');
      });
    });
  });
  describe('POST /admin/orders/:orderNumber/payment/collect', () => {
    it('records COD as collected on the payment and on the order, and answers with both', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'out-for-delivery',
        totalRupees: 1250,
        payment: {},
        events: [{ status: 'pending' }],
      });
      const { client, csrf, user } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({ reference: 'DLV-88213' })
          .expect(200),
      );

      expect(body.paymentStatus).toBe('collected');
      expect(body.paymentReference).toBe('DLV-88213');
      expect(body.paymentCollectedAt).not.toBeNull();

      const [payment] = await paymentsFor(order.id);
      expect(payment?.status).toBe(PaymentStatusEnum.COLLECTED);
      expect(payment?.reference).toBe('DLV-88213');
      expect(payment?.collectedAt).not.toBeNull();
      // The denormalised copy the customer's own page renders, moved in the same transaction.
      expect(await paymentStatusOn(order.orderNumber)).toBe(PaymentStatusEnum.COLLECTED);

      // `expect.any()` is typed `any`; an annotated `unknown` const keeps it usable inside `toEqual`
      // with `no-unsafe-assignment` still on — `health.integration.spec.ts` establishes this.
      const anyString: unknown = expect.any(String);

      expect(await auditRows()).toEqual([
        {
          action: 'payment.collect',
          entity: 'payment',
          entityId: anyString,
          before: { status: 'PENDING' },
          after: {
            status: 'COLLECTED',
            orderNumber: order.orderNumber,
            reference: 'DLV-88213',
          },
          actor_user_id: user.id,
        },
      ]);
    });

    /**
     * **Idempotent, and the second call writes nothing at all.** Double-counting would show up two
     * ways — a second `payments` row, or `collectedAt` rewritten to a later moment — and neither
     * happens. The audit trail keeps exactly one entry, per plan 9.1's rule: a second row saying
     * cash was collected reads as a second collection, which is the question the trail exists to
     * answer.
     */
    it('collects twice without double-counting and without a second audit row', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 900,
        payment: {},
      });
      const { client, csrf } = await asAdmin();

      const first = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({ reference: 'DLV-1' })
          .expect(200),
      );

      const second = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({ reference: 'DLV-2' })
          .expect(200),
      );

      const rows = await paymentsFor(order.id);
      expect(rows).toHaveLength(1);
      // Neither the moment nor the reference is rewritten: the first collection is the collection.
      expect(rows[0]?.reference).toBe('DLV-1');
      expect(second.paymentCollectedAt).toBe(first.paymentCollectedAt);
      expect(second.paymentReference).toBe('DLV-1');
      expect(await auditRows()).toHaveLength(1);
    });

    /** Cash handed over with no receipt number is a real thing to record — the column is nullable. */
    it('collects with no reference at all', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 400,
        payment: {},
      });
      const { client, csrf } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({})
          .expect(200),
      );

      expect(body.paymentStatus).toBe('collected');
      expect(body.paymentReference).toBeNull();
    });

    /**
     * **No coupling to the order's status**, and the bulk ladder is why it must not be: B2B collects
     * payment *before* dispatch — `awaiting-payment -> approved` is the whole point of that step —
     * so a check that the order was `delivered` would make B2B collection impossible.
     */
    it('collects on a B2B order that has not shipped', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'awaiting-payment',
        totalRupees: 80_000,
        channel: OrderChannelEnum.BULK,
        payment: {},
      });
      const { client, csrf } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({})
          .expect(200),
      );

      expect(body.status).toBe('awaiting-payment');
      expect(body.paymentStatus).toBe('collected');
    });

    it('refuses to collect anything but COD by hand', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 600,
        payment: { method: PaymentMethodEnum.ONLINE },
      });
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/payment/collect`)
        .set(CSRF_HEADER, csrf)
        .send({})
        .expect(422);

      expect(expectError(response).code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect(await paymentStatusOn(order.orderNumber)).toBe(PaymentStatusEnum.PENDING);
      expect(await auditRows()).toEqual([]);
    });

    it('refuses to collect a refunded payment', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 600,
        payment: { status: PaymentStatusEnum.REFUNDED },
      });
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/payment/collect`)
        .set(CSRF_HEADER, csrf)
        .send({})
        .expect(422);

      expect(expectError(response).code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(await auditRows()).toEqual([]);
    });

    /** Not a state placement can reach, but a fixture or an import can — and 404 says where to look. */
    it('answers 404 when the order has no payment record', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 600,
      });
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/payment/collect`)
        .set(CSRF_HEADER, csrf)
        .send({})
        .expect(404);

      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('answers 404 for an order number nobody placed', async () => {
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/NN-2026-999999/payment/collect`)
        .set(CSRF_HEADER, csrf)
        .send({})
        .expect(404);

      expect(await auditRows()).toEqual([]);
    });

    describe('validation', () => {
      it('refuses a reference wider than the column it goes in', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'delivered',
          totalRupees: 600,
          payment: {},
        });
        const { client, csrf } = await asAdmin();

        const response = await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({ reference: 'x'.repeat(121) })
          .expect(400);

        expect(expectError(response).details).toHaveProperty('reference');
        expect(await paymentStatusOn(order.orderNumber)).toBe(PaymentStatusEnum.PENDING);
      });

      /** `forbidNonWhitelisted`: an amount is not a field this endpoint has — spec §13. */
      it('refuses an amount of its own', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'delivered',
          totalRupees: 600,
          payment: {},
        });
        const { client, csrf } = await asAdmin();

        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({ amount: 1 })
          .expect(400);
      });
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403 and collects nothing', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'delivered',
          totalRupees: 600,
          payment: {},
        });
        const { client, csrf } = await signIn(UserRole.CUSTOMER);

        await client
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .set(CSRF_HEADER, csrf)
          .send({})
          .expect(403);

        expect(await paymentStatusOn(order.orderNumber)).toBe(PaymentStatusEnum.PENDING);
        expect(await auditRows()).toEqual([]);
      });

      it('refuses an anonymous request', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'delivered',
          totalRupees: 600,
          payment: {},
        });

        const response = await agent(integration.app)
          .post(`${BASE}/${order.orderNumber}/payment/collect`)
          .send({});

        expect([401, 403]).toContain(response.status);
        expect(await paymentStatusOn(order.orderNumber)).toBe(PaymentStatusEnum.PENDING);
      });
    });
  });
  describe('POST /admin/orders/:orderNumber/shipment', () => {
    /**
     * **One act: the shipment row and the move to `shipped`, in one transaction.** The transition
     * goes through `OrderStatusService`, so the `OrderEvent` the customer's tracking page renders
     * and the `order.shipped` notification brief §38 asks for both happen — asserted here because a
     * `status` write of its own would produce an identical response with neither.
     */
    it('records the dispatch, ships the order, appends the timeline event and notifies', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'packed',
        totalRupees: 1800,
        payment: {},
        // Placed an hour ago, so the fixture's own events precede the one the route appends —
        // `createTestOrder` derives their timestamps from `placedAt`, which defaults to now.
        placedAt: new Date(Date.now() - 60 * 60 * 1000),
        events: [{ status: 'pending' }, { status: 'packed' }],
      });
      const { client, csrf, user } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Delhivery', trackingNumber: 'DL2894471104' })
          .expect(200),
      );

      expect(body.status).toBe('shipped');
      // `expect.any()` is typed `any`; an annotated `unknown` const keeps it usable inside `toEqual`
      // with `no-unsafe-assignment` still on — `health.integration.spec.ts` establishes this.
      const anIsoString: unknown = expect.any(String);

      expect(body.shipments).toEqual([
        {
          id: anIsoString,
          courier: 'Delhivery',
          trackingNumber: 'DL2894471104',
          status: 'dispatched',
          shippedAt: anIsoString,
          deliveredAt: null,
          createdAt: anIsoString,
        },
      ]);
      // Through `OrderStatusService`, so the customer's timeline says so too.
      expect(body.timeline.map((entry) => entry.status)).toEqual(['pending', 'packed', 'shipped']);
      expect(await statusOf(order.orderNumber)).toBe('shipped');

      const rows = await shipmentsFor(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: ShipmentStatus.DISPATCHED, courier: 'Delhivery' });
      expect(rows[0]?.shippedAt).not.toBeNull();

      const queued = await integration.dataSource.query<{ template: string }[]>(
        "SELECT template FROM notifications WHERE payload->>'orderNumber' = $1",
        [order.orderNumber],
      );
      expect(queued.map((row) => row.template)).toEqual(['order.shipped']);

      // Two rows, two facts, one transaction: a parcel went to a named courier, and the order moved.
      const trail = await auditRows();
      expect(trail.map((row) => row.action).sort()).toEqual([
        'order.status-change',
        'shipment.create',
      ]);
      expect(trail.every((row) => row.actor_user_id === user.id)).toBe(true);
    });

    it('records a dispatch with no tracking number yet', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'packed',
        totalRupees: 700,
      });
      const { client, csrf } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Blue Dart' })
          .expect(200),
      );

      expect(body.shipments[0]).toMatchObject({ courier: 'Blue Dart', trackingNumber: null });
      expect(body.status).toBe('shipped');
    });

    it('ships a B2B order, which reaches shipped from processing', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'processing',
        totalRupees: 90_000,
        channel: OrderChannelEnum.BULK,
      });
      const { client, csrf } = await asAdmin();

      const body = expectSuccess<AdminOrder>(
        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Gati' })
          .expect(200),
      );

      expect(body.status).toBe('shipped');
      expect(body.shipments).toHaveLength(1);
    });

    /**
     * **The whole point of the coupling, measured.** An order that cannot legally reach `shipped` is
     * refused with the same 422 the status route answers, and **no shipment row is written** — the
     * two really are one act rather than two that usually happen together. Both rollback halves are
     * asserted, because a shipment written and then rolled back and a shipment never written look
     * identical from outside and only one of them is what the code does.
     */
    it('refuses to dispatch an order that cannot legally ship, writing nothing', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 500,
      });
      const { client, csrf } = await asAdmin();

      const response = await client
        .post(`${BASE}/${order.orderNumber}/shipment`)
        .set(CSRF_HEADER, csrf)
        .send({ courier: 'Delhivery' })
        .expect(422);

      expect(expectError(response).code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(expectError(response).details).toMatchObject({ allowed: ['confirmed', 'cancelled'] });
      expect(await shipmentsFor(order.id)).toEqual([]);
      expect(await statusOf(order.orderNumber)).toBe('pending');
      expect(await auditRows()).toEqual([]);
    });

    /**
     * The deliberate consequence of coupling: `shipped -> shipped` is a no-op and `canTransition`
     * refuses one, so this route cannot record a second dispatch or attach an airway bill that
     * arrived after the fact. Spec §6.4 has no route that *updates* a shipment;
     * `CreateShipmentDto` records that as the gap it is.
     */
    it('refuses a second dispatch on an order that has already shipped', async () => {
      const order = await createTestOrder(integration.dataSource, {
        status: 'packed',
        totalRupees: 500,
      });
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/${order.orderNumber}/shipment`)
        .set(CSRF_HEADER, csrf)
        .send({ courier: 'Delhivery' })
        .expect(200);

      await client
        .post(`${BASE}/${order.orderNumber}/shipment`)
        .set(CSRF_HEADER, csrf)
        .send({ courier: 'Delhivery', trackingNumber: 'DL-late-awb' })
        .expect(422);

      expect(await shipmentsFor(order.id)).toHaveLength(1);
    });

    it('answers 404 for an order number nobody placed', async () => {
      const { client, csrf } = await asAdmin();

      await client
        .post(`${BASE}/NN-2026-999999/shipment`)
        .set(CSRF_HEADER, csrf)
        .send({ courier: 'Delhivery' })
        .expect(404);

      expect(await auditRows()).toEqual([]);
    });

    describe('validation', () => {
      it('refuses a dispatch with no courier', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });
        const { client, csrf } = await asAdmin();

        const response = await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ trackingNumber: 'DL2894471104' })
          .expect(400);

        expect(expectError(response).details).toHaveProperty('courier');
        expect(await statusOf(order.orderNumber)).toBe('packed');
      });

      it('refuses an empty courier as well as a missing one', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });
        const { client, csrf } = await asAdmin();

        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: '' })
          .expect(400);
      });

      it('refuses a courier or tracking number wider than its column', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });
        const { client, csrf } = await asAdmin();

        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'c'.repeat(81) })
          .expect(400);

        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Delhivery', trackingNumber: 't'.repeat(121) })
          .expect(400);
      });

      /** `forbidNonWhitelisted`: the status is decided by the act, not by the caller. */
      it('refuses a status of its own', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });
        const { client, csrf } = await asAdmin();

        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Delhivery', status: 'DELIVERED' })
          .expect(400);
      });
    });

    describe('authorization', () => {
      it('refuses a signed-in customer with 403 and dispatches nothing', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });
        const { client, csrf } = await signIn(UserRole.CUSTOMER);

        await client
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .set(CSRF_HEADER, csrf)
          .send({ courier: 'Delhivery' })
          .expect(403);

        expect(await shipmentsFor(order.id)).toEqual([]);
        expect(await statusOf(order.orderNumber)).toBe('packed');
      });

      it('refuses an anonymous request', async () => {
        const order = await createTestOrder(integration.dataSource, {
          status: 'packed',
          totalRupees: 500,
        });

        const response = await agent(integration.app)
          .post(`${BASE}/${order.orderNumber}/shipment`)
          .send({ courier: 'Delhivery' });

        expect([401, 403]).toContain(response.status);
        expect(await shipmentsFor(order.id)).toEqual([]);
      });
    });
  });
});
