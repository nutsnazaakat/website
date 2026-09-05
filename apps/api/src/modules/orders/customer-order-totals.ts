import type { DataSource } from 'typeorm';

/**
 * One account's order history, as every admin people-surface reports it.
 *
 * `spendPaise` is paise, because a `SUM` over a `bigint` column is; the mapper at each boundary is
 * what converts it to rupees, per spec §8. **`orders` and `lastOrderAt` cover every status while
 * `spendPaise` excludes `cancelled` and `refunded`** — see `orderTotalsByUser`.
 */
export interface CustomerOrderTotals {
  orders: number;
  spendPaise: bigint;
  lastOrderAt: Date | null;
}

/** No history at all — what an account that has never ordered gets, since the aggregate returns it
 * no row rather than a row of zeroes. */
export const NO_ORDER_TOTALS: CustomerOrderTotals = {
  orders: 0,
  spendPaise: 0n,
  lastOrderAt: null,
};

/**
 * Excluded from spend and from nothing else.
 *
 * `DashboardService`'s `NON_REVENUE_STATUSES` is the same pair for the same reason, and
 * `BusinessStatsService` excludes the same two from `bulkSpend`. Passed as a parameter rather than
 * interpolated: `orders.status` is a plain `varchar` with a check constraint, so this is the one
 * vocabulary the database itself will not police.
 */
const NON_REVENUE_STATUSES = ['cancelled', 'refunded'];

/** What the aggregate answers, in the driver's own types: `count(*)` is cast to `int`, and a `SUM`
 * over a `bigint` column comes back as a **string** whatever is done to it. */
interface TotalsRow {
  userId: string;
  orders: number;
  spend: string;
  lastOrderAt: Date | null;
}

/**
 * Order count, spend and last order date for a set of accounts, in one statement.
 *
 * **A plain function rather than a service, and shared rather than copied.**
 * `GET /admin/customers` and `GET /admin/businesses` report these three figures for the *same*
 * accounts — a business is 1:1 with a user — and the one thing an operator must never see is two
 * admin screens disagreeing about what the same person has spent. A second copy of this SQL is
 * exactly how that happens, and it would happen silently: both would compile, both would return
 * plausible numbers. It needs no provider for the same reason `resolveTiers` and `toAccountOrder`
 * do not: it holds no state and takes the connection it is to use.
 *
 * **`orders` and `lastOrderAt` count every status; `spend` excludes `cancelled` and `refunded`.**
 * The pair pull in opposite directions on purpose, as `AdminDashboardCards` already documents:
 * revenue must agree with what Milestone 5's account totals tell the customer for the same orders,
 * and a count that silently dropped cancellations would disagree with `GET /admin/orders`, which
 * lists them.
 *
 * **Every channel, retail and bulk.** Brief §46 puts both on one account, so a bulk-only figure
 * would make `GET /admin/businesses/:id` and `GET /admin/customers/:id` disagree about the same
 * person. `GET /business/stats`'s `bulkOrders`/`bulkSpend` are a different question under different
 * names and do not contradict these.
 *
 * **Scoped by `user_id`, never by `orders.business_id`** — `BusinessStatsService`'s docblock records
 * the measurement: `CheckoutService.place` writes `businessId: null` into every order it creates,
 * whatever the channel, so a query scoped by that column answers zero for every business that has
 * ever bought anything.
 *
 * `COALESCE(SUM(...), 0)` is what makes an account with only cancelled orders answer `0` rather
 * than `null` — `SUM` over zero rows is `NULL`, and `BigInt(null)` throws where `Number(null)`
 * quietly answers zero.
 *
 * An empty id list short-circuits: `= ANY('{}')` is valid SQL and would cost a round trip to learn
 * nothing.
 */
export async function orderTotalsByUser(
  dataSource: DataSource,
  userIds: readonly string[],
): Promise<Map<string, CustomerOrderTotals>> {
  if (userIds.length === 0) return new Map();

  const rows = await dataSource.query<TotalsRow[]>(
    `SELECT o.user_id AS "userId",
            count(*)::int AS orders,
            COALESCE(SUM(o."totalPaise") FILTER (WHERE o.status <> ALL($2)), 0) AS spend,
            MAX(o."placedAt") AS "lastOrderAt"
       FROM orders o
      WHERE o.user_id = ANY($1)
      GROUP BY o.user_id`,
    [[...userIds], NON_REVENUE_STATUSES],
  );

  return new Map(
    rows.map((row) => [
      row.userId,
      // `BigInt(row.spend)` first, never `Number(row.spend) / 100`: `pg` answers a `SUM` over a
      // `bigint` column as a string, and treating a raw driver value as though it were already a JS
      // number is the one thing this codebase never does with money.
      { orders: row.orders, spendPaise: BigInt(row.spend), lastOrderAt: row.lastOrderAt },
    ]),
  );
}
