import { In } from 'typeorm';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { BusinessStatsService, OPEN_RFQ_STATUSES } from './business-stats.service';

const RAKESH = 'f0000000-0000-4000-8000-00000000000a';

function harness(rows: { spend: string; orders: string }[] = [{ spend: '0', orders: '0' }]) {
  const count = jest.fn().mockResolvedValue(0);
  const rfqsRepo = { count };
  const query = jest.fn().mockResolvedValue(rows);
  const dataSource = {
    getRepository: (entity: unknown) => {
      if (entity === Rfq) return rfqsRepo;
      throw new Error('harness: no repository stubbed for this entity');
    },
    query,
  };
  const service = new BusinessStatsService(dataSource as never);
  return { service, count, query };
}

describe('OPEN_RFQ_STATUSES', () => {
  /**
   * Brief §34's four open states, exactly — `new`, `contacted`, `quote-sent`, `negotiation` —
   * not the single `'new'` the frontend counted before Task 7. Pinned as an exact array so an
   * eighth status added to `RFQ_STATUSES` without a matching entry in `IS_OPEN` is a *compile*
   * error (`Record<RfqStatus, boolean>` demands every key), and a status moved between the two
   * groups without updating this list is caught right here.
   */
  it('is exactly the four open statuses, never narrowed to one', () => {
    expect(OPEN_RFQ_STATUSES).toEqual(['new', 'contacted', 'quote-sent', 'negotiation']);
  });
});

describe('BusinessStatsService.forUser', () => {
  it('counts open RFQs across all four open statuses, scoped to the caller', async () => {
    const { service, count } = harness();

    await service.forUser(RAKESH);

    expect(count).toHaveBeenCalledWith({
      where: { userId: RAKESH, status: In(OPEN_RFQ_STATUSES) },
    });
  });

  it('sums only BULK orders for the caller, excluding cancelled and refunded', async () => {
    const { service, query } = harness();

    await service.forUser(RAKESH);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/o\.user_id = \$1/);
    expect(sql).toMatch(/o\.channel = \$2/);
    expect(sql).toMatch(/NOT IN \('cancelled', 'refunded'\)/);
    expect(params).toEqual([RAKESH, OrderChannelEnum.BULK]);
  });

  it('returns 0 and 0 for a business with no order history, not null', async () => {
    const { service } = harness([{ spend: '0', orders: '0' }]);

    const result = await service.forUser(RAKESH);

    expect(result.bulkSpend).toBe(0);
    expect(result.bulkOrders).toBe(0);
  });

  /**
   * `pg` answers `SUM` over a `bigint` column as a string, and a fractional rupee figure is
   * what proves this path goes through `BigInt` → `toRupees` rather than a `SUM(...)/100.0`
   * done inside the SQL itself, which would round differently.
   */
  it('converts a fractional total exactly', async () => {
    const { service } = harness([{ spend: '333301', orders: '3' }]);

    const result = await service.forUser(RAKESH);

    expect(result.bulkSpend).toBe(3333.01);
    expect(result.bulkOrders).toBe(3);
  });
});
