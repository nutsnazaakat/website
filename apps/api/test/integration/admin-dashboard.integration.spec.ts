import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminDashboard } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { Rfq } from '../../src/entities/b2b/rfq.entity';
import { Inventory } from '../../src/entities/catalog/inventory.entity';
import { OrderChannelEnum, RfqKind, UserRole } from '../../src/entities/enums';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectSuccess, useIntegrationApp } from './helpers';

const DASHBOARD = '/api/v1/admin/dashboard';
const LOGIN = '/api/v1/auth/login';

const DAY = 24 * 60 * 60 * 1000;

/**
 * `GET /admin/dashboard` — brief §29's nine cards and four charts.
 *
 * This is an integration spec and has no unit twin, deliberately. Every figure the endpoint
 * returns *is* a SQL aggregate: there is no branch to double, and a unit test would have to mock
 * `DataSource.query` and assert the service returns what the mock was told to return — a test of
 * the arithmetic in the mock. Spec §12 is explicit that "each aggregate is an integration test
 * against seeded fixtures with known totals, because a dashboard that quietly reports the wrong
 * revenue is worse than one that fails", and the two claims only Postgres can answer are the ones
 * worth having: that `FILTER (WHERE status <> ALL(...))` really excludes what it says it does, and
 * that an empty table answers zeroes rather than `null` or `NaN`.
 *
 * The fixture is written by `createTestOrder` rather than by `seedOrders`, so every card has a
 * hand-checkable total instead of one derived by re-summing the same rows the endpoint summed.
 */
describe('admin dashboard', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests. `useIntegrationApp` boots one application per file, so
   * `ThrottlerGuard`'s in-memory storage is shared across it and `POST /auth/login` is capped at
   * five attempts per fifteen minutes per IP — every supertest request arriving from 127.0.0.1.
   * `inventory.integration.spec.ts` records the full reasoning.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  /** A signed-in admin. Cookie-persisting, because the read below is authenticated. */
  const asAdmin = async () => {
    const user = await createTestUser(integration.dataSource, { role: UserRole.ADMIN });
    const client = agent(integration.app);
    await client.post(LOGIN).send({ email: user.email, password: TEST_PASSWORD }).expect(200);
    return client;
  };

  const read = async (): Promise<AdminDashboard> => {
    const client = await asAdmin();
    return expectSuccess<AdminDashboard>(await client.get(DASHBOARD).expect(200));
  };

  describe('an empty database', () => {
    /**
     * The case that would 500 rather than answer wrong. `SUM` over zero rows is `NULL`, and
     * `BigInt(null)` throws — so without the `COALESCE`s in `DashboardService` a brand-new
     * deployment's very first dashboard request would be an internal error. `Number(null)` being
     * `0` is why the same mistake in a JS reduction would have gone unnoticed instead.
     *
     * The admin doing the reading is the only row in `users`, and `customers` counts non-admin
     * accounts, so zero is the right answer there too rather than one.
     */
    it('answers zeroes, not nulls or NaN', async () => {
      const dashboard = await read();

      expect(dashboard.cards).toEqual({
        totalSales: 0,
        b2cSales: 0,
        b2bSales: 0,
        orders: 0,
        pendingOrders: 0,
        pendingRfqs: 0,
        customers: 0,
        b2bCustomers: 0,
        lowStock: 0,
      });
      for (const value of Object.values(dashboard.cards)) {
        expect(Number.isNaN(value)).toBe(false);
      }
    });

    it('answers empty series, with both arms of the channel split still present', async () => {
      const { charts } = await read();

      expect(charts.salesOverTime).toEqual([]);
      expect(charts.topProducts).toEqual([]);
      expect(charts.topCategories).toEqual([]);
      // Not `[]`: a `GROUP BY channel` would return no row for a channel that has never sold, and
      // brief §29's "B2C vs B2B" chart has two arms whether or not both have traded.
      expect(charts.channelSplit).toEqual([
        { channel: 'retail', sales: 0, orders: 0 },
        { channel: 'bulk', sales: 0, orders: 0 },
      ]);
    });
  });

  describe('against a known fixture', () => {
    /**
     * Six orders, four of which earn revenue.
     *
     * `cancelled` (₹700) and `refunded` (₹300) are the two statuses Milestone 5's account totals
     * already exclude, so they are here to be excluded: `totalSales` must come out at
     * 1000 + 500 + 20000 + 5000 = ₹26,500 and never ₹27,500. `orders` must still be **6**, because
     * an order count that dropped cancellations would disagree with `GET /admin/orders`, which
     * lists them all.
     *
     * The ₹5,000 bulk order is placed 45 days ago, which puts it inside every revenue card and
     * outside the 30-day `salesOverTime` window — the one fixture that separates the two.
     */
    beforeEach(async () => {
      await seedCatalog(integration.dataSource);

      const b2c = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      await createTestUser(integration.dataSource, { role: UserRole.BUSINESS });

      const now = new Date();
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 1000,
        userId: b2c.id,
        placedAt: now,
        items: [
          {
            productSlug: 'premium-california-almonds',
            name: 'Premium California Almonds',
            qty: 3,
            unitRupees: 200,
          },
          { productSlug: 'w320-cashews', name: 'W320 Cashews', qty: 1, unitRupees: 400 },
        ],
      });
      await createTestOrder(integration.dataSource, {
        status: 'pending',
        totalRupees: 500,
        placedAt: now,
        items: [
          {
            productSlug: 'premium-california-almonds',
            name: 'Premium California Almonds',
            qty: 2,
            unitRupees: 250,
          },
        ],
      });
      await createTestOrder(integration.dataSource, {
        status: 'cancelled',
        totalRupees: 700,
        placedAt: now,
      });
      await createTestOrder(integration.dataSource, {
        status: 'refunded',
        totalRupees: 300,
        placedAt: now,
      });
      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 20000,
        channel: OrderChannelEnum.BULK,
        placedAt: now,
      });
      await createTestOrder(integration.dataSource, {
        status: 'shipped',
        totalRupees: 5000,
        channel: OrderChannelEnum.BULK,
        placedAt: new Date(now.getTime() - 45 * DAY),
      });

      const rfqs = integration.dataSource.getRepository(Rfq);
      await rfqs.save(
        (['new', 'negotiation', 'approved'] as const).map((status, index) =>
          rfqs.create({
            rfqNumber: `RFQ-2026-90000${String(index)}`,
            userId: null,
            kind: RfqKind.BULK,
            businessName: 'Fixture Foods',
            contactPerson: 'Rakesh Anand',
            mobile: '9845012345',
            email: 'fixture@demo.in',
            gstin: null,
            businessType: 'Retailer',
            pincode: '560058',
            packaging: 'Vacuum packed',
            frequency: 'Monthly',
            notes: null,
            status,
            assignedSalespersonId: null,
            expectedValuePaise: null,
          }),
        ),
      );
    });

    it('reports brief §29’s nine cards, excluding cancelled and refunded from revenue', async () => {
      const { cards } = await read();

      expect(cards).toEqual({
        // 1000 + 500 + 20000 + 5000. The ₹700 cancellation and the ₹300 refund are excluded.
        totalSales: 26500,
        b2cSales: 1500,
        b2bSales: 25000,
        // Every order, whatever its status — see `AdminDashboardCards`' docblock.
        orders: 6,
        pendingOrders: 1,
        // `new` and `negotiation` are open; `approved` is closed. `OPEN_RFQ_STATUSES` decides,
        // shared with `GET /business/stats` so the two dashboards cannot disagree.
        pendingRfqs: 2,
        // The admin doing the reading is excluded; the two customers and the business are not.
        customers: 3,
        b2bCustomers: 1,
        // `seedCatalog` opens every variant at 120 or 40 against a threshold of 10.
        lowStock: 0,
      });
      // b2cSales + b2bSales === totalSales, always: `channel` is a two-value enum.
      expect(cards.b2cSales + cards.b2bSales).toBe(cards.totalSales);
    });

    /**
     * Spec §12 defines low stock as `available <= lowStockThreshold`, and the boundary is the
     * interesting half: a variant sitting *exactly* on its threshold counts. `checkLowStock`'s
     * notification crossing is the strict `<`, so the two deliberately disagree at that one point —
     * asserted here so the difference is a decision on the record rather than a surprise.
     */
    it('counts a variant at or below its low-stock threshold', async () => {
      const inventory = integration.dataSource.getRepository(Inventory);
      const rows = await inventory.find({ order: { variantId: 'ASC' }, take: 3 });
      const [below, exactly, above] = rows;
      if (!below || !exactly || !above) throw new Error('seedCatalog wrote too few inventory rows');

      await inventory.update({ variantId: below.variantId }, { onHand: 5, lowStockThreshold: 10 });
      await inventory.update(
        { variantId: exactly.variantId },
        { onHand: 10, lowStockThreshold: 10 },
      );
      await inventory.update({ variantId: above.variantId }, { onHand: 11, lowStockThreshold: 10 });

      expect((await read()).cards.lowStock).toBe(2);
    });

    /**
     * `reserved` is part of the definition, not decoration: `available` is `onHand - reserved`, and
     * `Inventory` stores no third column precisely so the two cannot disagree. A card computed from
     * `onHand` alone would call a fully-reserved variant well stocked.
     */
    it('measures low stock against available, not on-hand', async () => {
      const inventory = integration.dataSource.getRepository(Inventory);
      const row = await inventory.findOneOrFail({ where: {}, order: { variantId: 'ASC' } });
      await inventory.update(
        { variantId: row.variantId },
        { onHand: 20, reserved: 15, lowStockThreshold: 10 },
      );

      expect((await read()).cards.lowStock).toBe(1);
    });

    it('splits sales by channel in agreement with the cards', async () => {
      const { cards, charts } = await read();

      expect(charts.channelSplit).toEqual([
        { channel: 'retail', sales: 1500, orders: 2 },
        { channel: 'bulk', sales: 25000, orders: 2 },
      ]);
      // The chart is built from the same row the cards came from, so this can never drift.
      expect(charts.channelSplit[0]?.sales).toBe(cards.b2cSales);
      expect(charts.channelSplit[1]?.sales).toBe(cards.b2bSales);
    });

    /**
     * Today's bar carries the four revenue orders inside the window — 1000 + 500 + 20000 — and the
     * 45-day-old ₹5,000 bulk order is absent, while still counting towards `b2bSales` above. The
     * cancellation and the refund are absent from both.
     */
    it('reports sales over time for the last 30 days only', async () => {
      const { charts } = await read();
      /**
       * **Today in the business's timezone**, which is what the bars are grouped by as of plan 9.4
       * (spec §5b). This suite seeds no settings at all, so it reaches `Asia/Kolkata` through
       * `businessTimezone`'s **fallback** rather than through the seeded row — which is the right
       * thing for it to exercise, since a truncated `settings` table must group days the same way a
       * populated one does.
       *
       * This was `new Date().toISOString().slice(0, 10)`, the **UTC** date, which was correct while
       * `salesOverTime` grouped by UTC day. It is a change to the test's *setup* — how "today" is
       * derived — and not to what it asserts: the claim is still that the four in-window revenue
       * orders all land on today's single bar at ₹21,500 across 3 orders, with the 45-day-old order,
       * the cancellation and the refund absent. Left as it was, this test would fail for 5½ hours
       * out of every 24 and pass for the rest, which is the flake the timezone work exists to remove.
       */
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'short',
      }).format(new Date());

      expect(charts.salesOverTime).toEqual([{ date: today, sales: 21500, orders: 3 }]);
    });

    /**
     * Ordered by units moved, from the `order_items` snapshot. Almonds sold 3 + 2 = 5 units across
     * two orders and cashews 1, so almonds lead — and the ₹200 and ₹250 unit prices are summed as
     * line totals (₹600 + ₹500) rather than averaged into a single price.
     */
    it('ranks top products by units sold, from the order-item snapshot', async () => {
      const { charts } = await read();

      expect(charts.topProducts).toEqual([
        {
          slug: 'premium-california-almonds',
          name: 'Premium California Almonds',
          unitsSold: 5,
          sales: 1100,
        },
        { slug: 'w320-cashews', name: 'W320 Cashews', unitsSold: 1, sales: 400 },
      ]);
    });

    /**
     * Categories resolve through `products.category_id`, which the fixture's lines do not carry —
     * `createTestOrder` leaves `productId` null unless a test binds it, exactly as a line whose
     * product has since been deleted would. So this chart is legitimately empty while
     * `topProducts` is not, which is the asymmetry `AdminTopSeller`'s docblock states.
     */
    it('reports no category for a line whose product no longer resolves', async () => {
      expect((await read()).charts.topCategories).toEqual([]);
    });

    it('ranks top categories for lines that do resolve to a product', async () => {
      const rows = await integration.dataSource.query<{ id: string }[]>(
        `SELECT id FROM products WHERE slug = 'premium-california-almonds'`,
      );
      const productId = rows[0]?.id;
      if (productId === undefined) throw new Error('seedCatalog wrote no almonds');

      await createTestOrder(integration.dataSource, {
        status: 'delivered',
        totalRupees: 900,
        items: [
          {
            productSlug: 'premium-california-almonds',
            name: 'Premium California Almonds',
            qty: 4,
            unitRupees: 225,
            productId,
          },
        ],
      });

      expect((await read()).charts.topCategories).toEqual([
        { slug: 'almonds', name: 'Almonds', unitsSold: 4, sales: 900 },
      ]);
    });
  });

  describe('authorisation', () => {
    it('refuses an anonymous caller with 401', async () => {
      await agent(integration.app).get(DASHBOARD).expect(401);
    });

    /**
     * The half `admin-routes-guarded.integration.spec.ts` cannot prove. That spec asserts the
     * metadata is present; this asserts the guard reading it actually refuses — the two together
     * are what make `@Roles(UserRole.ADMIN)` more than a decorator.
     */
    it('refuses a signed-in customer with 403', async () => {
      const user = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const client = agent(integration.app);
      await client.post(LOGIN).send({ email: user.email, password: TEST_PASSWORD }).expect(200);

      await client.get(DASHBOARD).expect(403);
    });
  });
});
