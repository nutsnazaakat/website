import { NO_ORDER_TOTALS, orderTotalsByUser } from './customer-order-totals';

function dataSource(rows: unknown[]) {
  const calls: { sql: string; parameters: unknown[] }[] = [];
  return {
    calls,
    source: {
      query: (sql: string, parameters: unknown[]) => {
        calls.push({ sql, parameters });
        return Promise.resolve(rows);
      },
    } as never,
  };
}

describe('orderTotalsByUser', () => {
  it('costs no round trip for an empty id list', async () => {
    const db = dataSource([]);
    await expect(orderTotalsByUser(db.source, [])).resolves.toEqual(new Map());
    expect(db.calls).toEqual([]);
  });

  /**
   * The pair that has to disagree: revenue must match what Milestone 5's account totals already
   * tell the customer for the same orders, while the count must match `GET /admin/orders`, which
   * lists every status. Asserted against the statement, because the double answers whatever it is
   * told to whichever SQL is sent.
   */
  it('excludes cancelled and refunded from spend and from nothing else', async () => {
    const db = dataSource([]);
    await orderTotalsByUser(db.source, ['user-1']);

    const [call] = db.calls;
    expect(call?.sql).toContain('count(*)::int AS orders');
    expect(call?.sql).toContain('FILTER (WHERE o.status <> ALL($2))');
    expect(call?.sql).toContain('MAX(o."placedAt")');
    expect(call?.parameters[1]).toEqual(['cancelled', 'refunded']);
  });

  /**
   * **Never `orders.business_id`.** `CheckoutService.place` writes `businessId: null` into every
   * order it creates, whatever the channel, so a query scoped by that column answers zero for every
   * business that has ever bought anything — measured, and recorded in `BusinessStatsService`.
   */
  it('scopes by user_id and filters no channel', async () => {
    const db = dataSource([]);
    await orderTotalsByUser(db.source, ['user-1', 'user-2']);

    const [call] = db.calls;
    expect(call?.sql).toContain('o.user_id = ANY($1)');
    expect(call?.sql).not.toContain('business_id');
    expect(call?.sql).not.toContain('channel');
    expect(call?.parameters[0]).toEqual(['user-1', 'user-2']);
  });

  /**
   * `pg` answers a `SUM` over a `bigint` column as a **string**. Going through `BigInt` rather than
   * `Number(...) / 100` is what keeps this consistent with every other paise figure in the codebase.
   */
  it('reads the summed paise as a bigint, never as a float', async () => {
    const db = dataSource([
      {
        userId: 'user-1',
        orders: 3,
        spend: '90071992547409910',
        lastOrderAt: new Date('2026-08-19T11:30:00.000Z'),
      },
    ]);

    const totals = await orderTotalsByUser(db.source, ['user-1']);
    expect(totals.get('user-1')?.spendPaise).toBe(90071992547409910n);
    expect(totals.get('user-1')?.orders).toBe(3);
  });

  it('returns no entry for an account with no orders, which NO_ORDER_TOTALS stands in for', async () => {
    const db = dataSource([]);
    const totals = await orderTotalsByUser(db.source, ['user-1']);
    expect(totals.has('user-1')).toBe(false);
    expect(NO_ORDER_TOTALS).toEqual({ orders: 0, spendPaise: 0n, lastOrderAt: null });
  });
});
