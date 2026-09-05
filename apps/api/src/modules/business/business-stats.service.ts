import { Injectable } from '@nestjs/common';
import { RFQ_STATUSES, toRupees, type BusinessStats, type RfqStatus } from '@nutwala/shared';
import { DataSource, In } from 'typeorm';
import { OrderChannelEnum } from '../../entities/enums';
import { Rfq } from '../../entities/b2b/rfq.entity';

/**
 * Whether each of `RFQ_STATUSES`' seven values counts as *open* for the dashboard — a full
 * `Record`, not a filtered list built by naming the three closed ones, for the reason
 * `RfqStatusBadge`'s `label`/`variant` Records and `businesses.service.ts`'s `_segmentsMap` both
 * exist: an eighth status added to `RFQ_STATUSES` becomes a compile error here rather than a
 * silently-uncounted enquiry. `contacted` and `negotiation` are open for the identical reason
 * `RfqStatusBadge` gives them the identical customer-facing label — the desk is still working
 * the enquiry either way.
 */
export const IS_OPEN: Record<RfqStatus, boolean> = {
  new: true,
  contacted: true,
  'quote-sent': true,
  negotiation: true,
  approved: false,
  rejected: false,
  converted: false,
};

export const OPEN_RFQ_STATUSES: RfqStatus[] = RFQ_STATUSES.filter((status) => IS_OPEN[status]);

interface SpendRow {
  spend: string;
  orders: string;
}

/**
 * `GET /business/stats` — the four figures `routes/business/index.tsx` used to derive
 * client-side from a whole order and RFQ list it had already fetched for other reasons.
 *
 * **Scoped by `userId`, not by `businessId` — measured, not assumed.** `orders.business_id`
 * exists as a column and `Order` even carries a `business` relation, so it looks like the
 * obvious thing to scope by. `CheckoutService.place` (`checkout.service.ts:244`) writes
 * `businessId: null` into every order it creates, always, regardless of channel — so a query
 * scoped by `businessId` would answer zero spend and zero orders for every business that has
 * ever placed one. `userId` is what is actually populated, and a business is 1:1 with a user, so
 * scoping by it is correct today. It would need revisiting the day a business gains a second
 * login, which `businessId`'s presence on the column suggests was anticipated but never wired.
 */
@Injectable()
export class BusinessStatsService {
  constructor(private readonly dataSource: DataSource) {}

  async forUser(userId: string): Promise<BusinessStats> {
    const openRfqs = await this.dataSource
      .getRepository(Rfq)
      .count({ where: { userId, status: In(OPEN_RFQ_STATUSES) } });

    /**
     * `COALESCE(SUM(...), 0)` is what makes a business with no bulk orders answer `0`, not
     * `null` — `SUM` over zero rows is `NULL`, and `Number(null)` is `0` while `BigInt(null)`
     * throws, so without the `COALESCE` this line would 500 on the exact "no history" case the
     * plan's own proof list names.
     *
     * `'cancelled'` and `'refunded'` are `B2C_ORDER_STATUSES` values that do not appear in
     * `B2B_ORDER_STATUSES` at all — measured against `BULK_TRANSITIONS`, a bulk order can never
     * legally reach either through `OrderStatusService`. The exclusion is kept anyway, as
     * defence in depth against `status` — a plain `varchar(24)`, not a Postgres enum — ever
     * holding one through a path this service does not control, exactly the caution
     * `order.mapper.ts`'s `toOrderStatus` states for the identical column on the read side.
     */
    const rows = await this.dataSource.query<SpendRow[]>(
      `SELECT COALESCE(SUM(o."totalPaise"), 0) AS spend, count(*) AS orders
         FROM orders o
        WHERE o.user_id = $1 AND o.channel = $2 AND o.status NOT IN ('cancelled', 'refunded')`,
      [userId, OrderChannelEnum.BULK],
    );
    const row = rows[0] ?? { spend: '0', orders: '0' };

    return {
      openRfqs,
      // `BigInt(row.spend)` first, `toRupees` second — never `Number(row.spend) / 100` directly.
      // `pg` answers a `SUM` over a `bigint` column as a **string**, and going through `BigInt`
      // is what keeps this line consistent with every other paise figure in the codebase, which
      // never treats a raw driver value as though it were already a JS number.
      bulkSpend: toRupees(BigInt(row.spend)),
      bulkOrders: Number(row.orders),
    };
  }
}
