// backend/src/modules/admin/dashboard.service.ts
import { Injectable } from '@nestjs/common';
import {
  toRupees,
  type AdminChannelSplitPoint,
  type AdminDashboard,
  type AdminDashboardCards,
  type AdminSalesPoint,
  type AdminTopSeller,
  type OrderStatus,
} from '@nutwala/shared';
import { DataSource } from 'typeorm';
import { OrderChannelEnum, UserRole } from '../../entities/enums';
import { OPEN_RFQ_STATUSES } from '../business/business-stats.service';
import { SQL_LOW_STOCK } from '../inventory/stock-sql';
import { businessTimezone } from '../settings/business-timezone';

/**
 * The statuses that earn no revenue.
 *
 * `satisfies readonly OrderStatus[]` is the control: both spellings are real brief §33 statuses,
 * and a typo here would silently stop excluding a cancellation — the dashboard would then report
 * more revenue than the customer's own order history does for the same orders, which is the exact
 * divergence Milestone 5's account totals already chose against. `AccountOrder`'s totals and
 * `BusinessStatsService.forUser` both exclude the same two.
 *
 * Passed as a parameter and compared with `<> ALL($n)`, not interpolated: `orders.status` is a
 * plain `varchar(24)` with a check constraint, so this is the one vocabulary the database itself
 * will not police.
 */
const NON_REVENUE_STATUSES = ['cancelled', 'refunded'] as const satisfies readonly OrderStatus[];

/** How far back `salesOverTime` reaches. Brief §29 asks for the trend, not for all history. */
const SALES_SERIES_DAYS = 30;

/** How many bars `topProducts` and `topCategories` carry. */
const TOP_SELLER_LIMIT = 5;

/**
 * `count(*)` comes back from `pg` as a string unless it is cast, and `SUM` over a `bigint` column
 * comes back as a string regardless. Every count below is therefore cast with `::int` in SQL and
 * typed `number` here, and every money figure is left a string and converted through
 * `BigInt(...)` → `toRupees` — never `Number(row.sales) / 100`, which is what
 * `BusinessStatsService` records the reasoning for: a raw driver value is not already a JS number.
 */
interface CardsRow {
  totalSales: string;
  b2cSales: string;
  b2bSales: string;
  orders: number;
  b2cOrders: number;
  b2bOrders: number;
  pendingOrders: number;
}

interface PeopleRow {
  customers: number;
  b2bCustomers: number;
}

interface CountRow {
  count: number;
}

interface SalesPointRow {
  day: string;
  sales: string;
  orders: number;
}

interface TopSellerRow {
  slug: string;
  name: string;
  unitsSold: number;
  sales: string;
}

/**
 * `GET /admin/dashboard` — brief §29's nine cards and four charts.
 *
 * **Every figure is computed by Postgres.** Spec §12 is explicit that the cards "come from
 * aggregate queries, not table scans in application code", and `GET /business/stats` (Milestone 7)
 * is the precedent this follows: one statement per question, `COALESCE` on every `SUM` so an empty
 * table answers `0` rather than `null`, and the paise → rupee conversion applied once at the
 * boundary. Loading orders and reducing in JS would also be wrong for a reason beyond speed — the
 * revenue exclusion below would then live in application code at one more site, and spec §12's
 * own warning is that "a dashboard that quietly reports the wrong revenue is worse than one that
 * fails".
 *
 * `SUM` over zero rows is `NULL`, and `BigInt(null)` throws while `Number(null)` is `0`. So the
 * `COALESCE`s are not cosmetic: without them an empty database would 500 on the exact "no history
 * yet" case a brand-new deployment is in.
 *
 * **Six statements, not one.** They could be folded into a single query with CTEs, and that was
 * rejected: the six answer questions about five different tables with no join between them, so a
 * combined statement would be a cross join or a stack of scalar subqueries — harder to read, no
 * faster, and impossible to test one card at a time. They are also issued concurrently, so the
 * round trips overlap.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly dataSource: DataSource) {}

  async summary(): Promise<AdminDashboard> {
    const [cards, people, lowStock, pendingRfqs, salesOverTime, topProducts, topCategories] =
      await Promise.all([
        this.orderCards(),
        this.people(),
        this.lowStock(),
        this.pendingRfqs(),
        this.salesOverTime(),
        this.topProducts(),
        this.topCategories(),
      ]);

    const cardFigures: AdminDashboardCards = {
      totalSales: toRupees(BigInt(cards.totalSales)),
      b2cSales: toRupees(BigInt(cards.b2cSales)),
      b2bSales: toRupees(BigInt(cards.b2bSales)),
      orders: cards.orders,
      pendingOrders: cards.pendingOrders,
      pendingRfqs,
      customers: people.customers,
      b2bCustomers: people.b2bCustomers,
      lowStock,
    };

    /**
     * Brief §29's "B2C vs B2B" chart is built from the same row the cards came from rather than
     * from a seventh query of its own.
     *
     * Two things fall out of that and both are the point: the chart cannot disagree with the cards
     * above it — a `GROUP BY channel` would be a second derivation of the same figure, and the
     * first time the exclusion list changed only one of them would follow — and both arms are
     * always present, at zero if need be, where a grouped query returns no row for a channel that
     * has never sold anything and the chart would render one bar.
     */
    const channelSplit: AdminChannelSplitPoint[] = [
      { channel: 'retail', sales: cardFigures.b2cSales, orders: cards.b2cOrders },
      { channel: 'bulk', sales: cardFigures.b2bSales, orders: cards.b2bOrders },
    ];

    return {
      cards: cardFigures,
      charts: { salesOverTime, channelSplit, topProducts, topCategories },
    };
  }

  /**
   * The four money cards, the order count and the pending count, in one pass over `orders`.
   *
   * `FILTER (WHERE …)` rather than six correlated subqueries or six statements: one sequential
   * scan answers all of them, and every figure is then guaranteed to describe the same snapshot of
   * the table.
   *
   * **`orders` deliberately has no status filter while the three money figures do.** An operator
   * clicking the Orders card lands on `GET /admin/orders`, which lists every order whatever its
   * status, and a card that disagreed with the list beside it would read as a bug. `b2cOrders` and
   * `b2bOrders` *do* carry the filter, because they are the denominators of `b2cSales`/`b2bSales`
   * in the channel-split chart and an average order value computed across them has to be honest.
   * `AdminDashboardCards`' docblock states both halves on the wire, so the difference is part of
   * the contract rather than a surprise.
   *
   * The `channel` comparisons bind `OrderChannelEnum` values as parameters against a Postgres enum
   * column; the driver sends them untyped and Postgres coerces, which is what
   * `BusinessStatsService` already relies on.
   */
  private async orderCards(): Promise<CardsRow> {
    const rows = await this.dataSource.query<CardsRow[]>(
      `SELECT
         COALESCE(SUM(o."totalPaise") FILTER (WHERE o.status <> ALL($1::text[])), 0)::text AS "totalSales",
         COALESCE(SUM(o."totalPaise") FILTER (WHERE o.status <> ALL($1::text[]) AND o.channel = $2), 0)::text AS "b2cSales",
         COALESCE(SUM(o."totalPaise") FILTER (WHERE o.status <> ALL($1::text[]) AND o.channel = $3), 0)::text AS "b2bSales",
         count(*)::int AS orders,
         count(*) FILTER (WHERE o.status <> ALL($1::text[]) AND o.channel = $2)::int AS "b2cOrders",
         count(*) FILTER (WHERE o.status <> ALL($1::text[]) AND o.channel = $3)::int AS "b2bOrders",
         count(*) FILTER (WHERE o.status = $4)::int AS "pendingOrders"
       FROM orders o`,
      [
        [...NON_REVENUE_STATUSES],
        OrderChannelEnum.RETAIL,
        OrderChannelEnum.BULK,
        // The first state of brief §33's retail pipeline, and the only one that means "nobody has
        // looked at this yet". `PENDING_ORDER_STATUS` is spelled inline rather than imported from
        // `shared` because `B2C_ORDER_STATUSES[0]` would pin the card to array order.
        'pending' satisfies OrderStatus,
      ],
    );

    // An aggregate with no `GROUP BY` always returns exactly one row, even over an empty table, so
    // this fallback is unreachable. It exists because `noUncheckedIndexedAccess` is on and the
    // honest alternative — a non-null assertion — would be a claim about the driver rather than
    // about SQL.
    return (
      rows[0] ?? {
        totalSales: '0',
        b2cSales: '0',
        b2bSales: '0',
        orders: 0,
        b2cOrders: 0,
        b2bOrders: 0,
        pendingOrders: 0,
      }
    );
  }

  /**
   * Brief §29's Customers and B2B Customers.
   *
   * `role <> 'ADMIN'` rather than `role = 'CUSTOMER'`: brief §46 requires one account to switch
   * between retail and bulk shopping, and `POST /auth/upgrade-to-business` moves the row's `role`
   * from `CUSTOMER` to `BUSINESS`. Counting only `CUSTOMER` would therefore make the Customers
   * card *fall* every time a shopper upgraded — the business would appear to be losing customers
   * by acquiring wholesale ones. `b2bCustomers` is the `BUSINESS` subset of the same figure, not a
   * disjoint bucket.
   *
   * `isActive` is deliberately not filtered. It is set false by nothing in this codebase today, so
   * a filter would be an untested branch, and "customers" on an operator dashboard means accounts
   * that exist. Worth revisiting the day account deactivation ships.
   */
  private async people(): Promise<PeopleRow> {
    const rows = await this.dataSource.query<PeopleRow[]>(
      `SELECT count(*) FILTER (WHERE u.role <> $1)::int AS customers,
              count(*) FILTER (WHERE u.role = $2)::int AS "b2bCustomers"
         FROM users u`,
      [UserRole.ADMIN, UserRole.BUSINESS],
    );
    return rows[0] ?? { customers: 0, b2bCustomers: 0 };
  }

  /**
   * Brief §29's Low Stock, defined by spec §12 as `available <= lowStockThreshold`.
   *
   * `available` is `onHand - reserved` and is computed here rather than read, because `Inventory`
   * deliberately stores no third column (see its docblock).
   *
   * **This is `<=`, while `checkLowStock`'s notification crossing is `<`.** Not an oversight and
   * not reconcilable by picking one: spec §12 defines the card and `check-low-stock.ts`'s docblock
   * is explicit that landing exactly *on* the threshold is not low enough to notify about. So a
   * variant sitting at exactly its threshold is counted by this card and has raised no
   * `stock.low` notification, which is the intended reading of both documents — the card is a
   * standing count, the notification is an event. Recorded because the discrepancy looks like a
   * bug to anyone who finds one without the other.
   *
   * Every inventory row is counted, including one belonging to a deactivated variant or an
   * unpublished product. That follows spec §12 literally; narrowing it to sellable variants is a
   * defensible alternative and would need to be the same narrowing `GET /admin/inventory` (plan
   * 9.2) applies, or the card and the screen it links to would disagree.
   */
  /**
   * Brief §29's "Low Stock" card.
   *
   * The predicate comes from `SQL_LOW_STOCK` rather than being spelled here, because
   * `GET /admin/inventory?status=low` asks the identical question and this card links to that list.
   * Spelled out twice, the first edit to either would make the card disagree with the screen it
   * sends the operator to — and `stock-sql.ts` is also where the deliberate difference from
   * `checkLowStock`'s strict `<` is recorded, which a bare string here would hide.
   */
  private async lowStock(): Promise<number> {
    const rows = await this.dataSource.query<CountRow[]>(
      `SELECT count(*)::int AS count
         FROM inventory i
        WHERE ${SQL_LOW_STOCK}`,
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Brief §29's Pending RFQs.
   *
   * `OPEN_RFQ_STATUSES` is imported from `BusinessStatsService` rather than re-derived, and that is
   * the whole reason it is exported there: it is built from a `Record<RfqStatus, boolean>` so an
   * eighth status added to `RFQ_STATUSES` is a compile error rather than a silently uncounted
   * enquiry. A second list here would be the drift that `Record` exists to prevent — and the two
   * would disagree about `negotiation` first, which is precisely the status a business owner would
   * expect their own dashboard and the admin's to agree on.
   *
   * A plain exported const, so nothing is injected and no module import is needed;
   * `CatalogService` imports `bulkTierFor` from the cart module on the same footing.
   */
  private async pendingRfqs(): Promise<number> {
    const rows = await this.dataSource.query<CountRow[]>(
      `SELECT count(*)::int AS count FROM rfqs r WHERE r.status = ANY($1::text[])`,
      [OPEN_RFQ_STATUSES],
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Brief §29's sales-over-time chart: one point per day for the last 30 days, revenue orders only.
   *
   * **Days are days in the business's own timezone**, read from `settings` — spec §5b, delivered by
   * plan 9.4. This query used to group by UTC day, and the docblock here said so at length: an
   * order placed at 10am IST on the 3rd landed in the 3rd, but one placed at 4am IST landed in the
   * 2nd, so every early-morning order appeared on the previous day's bar. `placedAt` is
   * `timestamptz`, so grouping it *requires* naming a zone; there was no business timezone anywhere
   * in the brief, the spec or this codebase, and UTC was the honest placeholder until there was.
   *
   * **It moved together with `GET /admin/orders`'s `?from`/`?to` filter, in one commit**, which is
   * the part spec §5b is emphatic about: "a per-endpoint fix is how two figures start disagreeing".
   * Plan 9.2 left that filter on UTC deliberately so the two could be moved as a pair, and
   * `AdminOrdersService.list` reads the same setting through the same
   * `businessTimezone(manager)`. There is exactly one definition of "what day is it" on the admin
   * surface.
   *
   * The 30-day window is still an **instant** comparison — `now() - interval '30 days'` — not a
   * day boundary in the business zone. So the earliest bar can be a partial day, by up to the
   * zone's offset. That is unchanged by this work and deliberately left: the window is "how far
   * back does the trend reach", the grouping is "which day did this order happen on", and only the
   * second is what an operator reads off a bar.
   *
   * Only days that have orders appear. A gap-free series would need
   * `generate_series`, and which days to fill is a presentation decision — the chart knows its own
   * x-axis and the API does not.
   */
  private async salesOverTime(): Promise<AdminSalesPoint[]> {
    // The caller's own manager, so the zone is read from the same snapshot the grouping runs
    // against. The value reaches SQL as a bound parameter and is never interpolated.
    const timezone = await businessTimezone(this.dataSource.manager);

    const rows = await this.dataSource.query<SalesPointRow[]>(
      `SELECT to_char(date_trunc('day', o."placedAt" AT TIME ZONE $3), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(o."totalPaise"), 0)::text AS sales,
              count(*)::int AS orders
         FROM orders o
        WHERE o.status <> ALL($1::text[])
          AND o."placedAt" >= now() - $2::interval
        GROUP BY 1
        ORDER BY 1`,
      [[...NON_REVENUE_STATUSES], `${String(SALES_SERIES_DAYS)} days`, timezone],
    );

    return rows.map((row) => ({
      date: row.day,
      sales: toRupees(BigInt(row.sales)),
      orders: row.orders,
    }));
  }

  /**
   * Brief §29's top-products chart, from the `order_items` **snapshot** rather than from `products`.
   *
   * `OrderItem` carries `productSlug` and `name` as copies precisely so a deleted or renamed
   * product leaves the line unchanged (its docblock says so), and grouping on the snapshot is what
   * makes this chart keep reporting sales a product really made under the name it was sold as. A
   * join to `products` would drop those lines entirely — `order_items.product_id` is
   * `ON DELETE SET NULL` — so the chart would understate history the moment anything was deleted.
   *
   * `lineTotalPaise` is nullable: a line fulfilled against a negotiated quote carries no total.
   * `COALESCE` inside the `SUM` counts such a line's units without inventing money for it.
   *
   * `min(oi.name)` picks one name deterministically where the same slug was sold under two names
   * over time. Arbitrary but stable, which is what a chart label needs; `max` would be equally
   * defensible and a "most recent" pick would need a window function for no visible gain.
   *
   * Ordered by units first — "top products" in a catalogue business means volume moved, and
   * ordering by revenue would put the 50kg consignments at the top of every bar chart forever.
   * `slug` is the final tiebreak so the answer is stable across calls.
   */
  private async topProducts(): Promise<AdminTopSeller[]> {
    const rows = await this.dataSource.query<TopSellerRow[]>(
      `SELECT oi."productSlug" AS slug,
              min(oi.name) AS name,
              SUM(oi.qty)::int AS "unitsSold",
              SUM(COALESCE(oi."lineTotalPaise", 0))::text AS sales
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.status <> ALL($1::text[])
        GROUP BY oi."productSlug"
        ORDER BY "unitsSold" DESC, sales DESC, slug ASC
        LIMIT $2`,
      [[...NON_REVENUE_STATUSES], TOP_SELLER_LIMIT],
    );
    return rows.map(toTopSeller);
  }

  /**
   * Brief §29's top-categories chart.
   *
   * Unlike `topProducts` this **must** join `products`, because `order_items` snapshots no
   * category. The consequence is stated on the wire type: a line whose product has since been
   * deleted has `product_id IS NULL` and contributes to no category, so this chart can legitimately
   * total less than `topProducts` does. An inner join says that plainly; a left join would produce
   * a nameless bar.
   */
  private async topCategories(): Promise<AdminTopSeller[]> {
    const rows = await this.dataSource.query<TopSellerRow[]>(
      `SELECT c.slug AS slug,
              c.name AS name,
              SUM(oi.qty)::int AS "unitsSold",
              SUM(COALESCE(oi."lineTotalPaise", 0))::text AS sales
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         JOIN categories c ON c.id = p.category_id
        WHERE o.status <> ALL($1::text[])
        GROUP BY c.slug, c.name
        ORDER BY "unitsSold" DESC, sales DESC, slug ASC
        LIMIT $2`,
      [[...NON_REVENUE_STATUSES], TOP_SELLER_LIMIT],
    );
    return rows.map(toTopSeller);
  }
}

function toTopSeller(row: TopSellerRow): AdminTopSeller {
  return {
    slug: row.slug,
    name: row.name,
    unitsSold: row.unitsSold,
    sales: toRupees(BigInt(row.sales)),
  };
}
