import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { OrderChannel, OrderFilters } from '@nutwala/shared';
import { Repository, type FindOptionsOrder, type FindOptionsWhere } from 'typeorm';
import { Order } from '../../entities/commerce/order.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { OrderStatusService } from './order-status.service';

/**
 * The wire's channel vocabulary as the column's, spelled out rather than upper-cased.
 *
 * `filters.channel.toUpperCase() as OrderChannelEnum` compiles and works today; a
 * `Record<OrderChannel, OrderChannelEnum>` requires a row per wire value and typechecks each
 * against the enum, so neither vocabulary can gain a member without the other. It is
 * `order.mapper.ts`'s `CHANNEL` read in the opposite direction, and the two sit at opposite ends of
 * the same request.
 *
 * **An unvalidated channel widens the filter rather than narrowing it.** A value outside the union
 * — reachable only from an untyped caller — resolves to `undefined` here, and TypeORM *drops*
 * `undefined` from a `where` (`SelectQueryBuilder.js:2496`), so the query answers with every channel
 * instead of none. That is a wrong answer confined to the caller's own orders, never a leak, because
 * `userId` is a separate clause. Task 17's query DTO is what makes it unreachable: the channel
 * parameter needs an `@IsIn` against the same two values, not a bare `@IsOptional() @IsString()`.
 *
 * **Exported, and `AdminOrdersService.list` is why.** `GET /admin/orders` filters by the same wire
 * channel and has to reach the same column enum; re-declaring the map there would be a fifth copy
 * of a two-value vocabulary whose whole point is that no copy can grow alone. Imported rather than
 * duplicated, the compile error the `satisfies`-style `Record` produces is still one error rather
 * than two files that quietly disagree.
 */
export const CHANNEL: Readonly<Record<OrderChannel, OrderChannelEnum>> = {
  retail: OrderChannelEnum.RETAIL,
  bulk: OrderChannelEnum.BULK,
};

/**
 * Both reads load both relations, because `toAccountOrder` refuses to map an order without them —
 * and the list endpoint answers `AccountOrder[]`, the same shape as the detail endpoint, so "the
 * list only needs the header fields" is not true of this contract.
 *
 * Two `OneToMany` joins in one query is a cartesian product: an order with 2 items and 8 events
 * comes back as 16 rows, which TypeORM folds into one entity. Bounded here — the basket is capped
 * at 50 lines and a timeline is one row per status change — so the join stays cheaper than the
 * per-order round trips `relationLoadStrategy: 'query'` would make.
 */
const RELATIONS = { items: true, events: true } as const;

/**
 * `order_items` has no natural order, so the query imposes one.
 *
 * There is no `position` or `lineNumber` column, and `createdAt` is *identical* across every line
 * of an order: both the seeder and `CheckoutService.place` write an order's lines in a single
 * multi-row insert, so they share one `now()`. Without an explicit `ORDER BY` two reads of the same
 * order can return its invoice lines in different sequences, and the only symptom a customer sees is
 * their receipt rearranging itself between visits — which reads as a rendering glitch, not as a
 * missing clause.
 *
 * `id` is the only stable candidate and it is a v4 uuid, so the sequence is **arbitrary but fixed**:
 * this buys stability, not the order the customer built the basket in. Nothing in the schema can buy
 * the second, and a `position` column is the migration that would.
 *
 * **Exported, and `CheckoutController.reload` is why.** Placement answers with the order it just
 * created, and `GET /account/orders/:orderNumber` answers with the same order later; both go through
 * `toAccountOrder`, so "one mapper" is meant to make the two bodies identical. A reload that imposed
 * no order left the placement response in `order_items`' physical sequence and this read in `id`
 * sequence — which differ whenever the second line's uuid sorts below the first, i.e. about half the
 * time — so the same order's invoice lines came back rearranged between the confirmation screen and
 * the account page. Measured by `orders.integration.spec.ts`'s round-trip case, which is the only
 * test that reads one order down both paths. One constant, imported, rather than the same literal
 * written twice.
 *
 * `events` are deliberately *not* ordered here. `toAccountOrder` sorts them by `createdAt` itself
 * because `CheckoutService.place` builds an order's first event in memory and never reloads it, so
 * "the read was ordered" is not a property that mapping can borrow. Items have no such second
 * source and no key the mapper could sort on — hence the split.
 */
export const ITEMS_IN_ORDER = { items: { id: 'ASC' } } as const satisfies FindOptionsOrder<Order>;

/**
 * A customer's own order history, and nobody else's.
 *
 * Spec §13's IDOR rule is the whole of this service: the owner comes from the session and is a
 * clause in the query, never a check applied to a row that has already been fetched. The difference
 * is not behavioural today — both answer nothing for a stranger's order — and that is exactly why
 * the query is the safer of the two: `findOne({ where: { orderNumber } })` followed by
 * `if (order.userId !== userId) throw` leaves a working lookup behind after someone refactors the
 * `throw` away, while a `where` that loses `userId` returns the wrong customer's order immediately
 * and loudly.
 *
 * Nothing here answers with a status code. Both reads report a miss as `null` and neither can tell
 * "no such order" from "not yours" — a distinction only the controller could turn into a 403, and
 * spec §13 rules that out: order numbers are sequential, so an endpoint that confirmed existence
 * would be an oracle an attacker walks. The customer sees one 404 for both, which is all a customer
 * needs.
 */
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly statuses: OrderStatusService,
  ) {}

  /**
   * The caller's orders, newest first, optionally narrowed to one channel.
   *
   * `placedAt DESC` is served by `idx_orders_user_placed_at` — `(userId, placedAt)`, whose leading
   * column is this query's only mandatory predicate. Do not add another index for it.
   */
  async list(userId: string | null, filters: OrderFilters = {}): Promise<Order[]> {
    /**
     * A guest has no history, and this is a hard return rather than something expressed in the
     * `where`. There are three ways to put it in the `where` instead and all three are wrong.
     *
     * `where: { userId: null }` does not compile, and that is worth knowing before trying it:
     * `FindOptionsWhere<Entity>` maps each property through `NonNullable`, so the nullable column's
     * criterion is `string | FindOperator<string> | undefined` and `null` is rejected. Measured, not
     * assumed — this exact edit was made and `tsc` refused it.
     *
     * `where: { userId: userId ?? undefined }` compiles, and is the dangerous one. TypeORM **drops**
     * an `undefined` from a find-options `where` (`SelectQueryBuilder.js:2496-2504`, default
     * `invalidWhereValuesBehavior.undefined: 'ignore'`), so the clause vanishes, `where` becomes
     * `{}`, and this method answers with **every order in the table**. It is
     * `cart-read.service.ts`'s `find({ where: [] })` hazard wearing different clothes. Note the same
     * default exists for `null` — so if the column's criterion ever did admit one, it would be
     * silently dropped rather than compiled to `IS NULL`.
     *
     * `where: { userId: IsNull() }` compiles and does mean `user_id IS NULL`, and is still wrong:
     * that predicate is shared by every guest order ever placed, so a guest is not an identity and
     * one guest would read another's. A guest sees their order exactly once, in the response to
     * `POST /checkout/orders` — which is why `PlaceOrderResult` *is* the order rather than a receipt
     * to re-fetch.
     */
    if (userId === null) return [];

    const where: FindOptionsWhere<Order> = { userId };
    if (filters.channel !== undefined) where.channel = CHANNEL[filters.channel];

    return this.orders.find({
      where,
      relations: RELATIONS,
      order: { placedAt: 'DESC', ...ITEMS_IN_ORDER },
    });
  }

  /**
   * One order of the caller's, by the number they can read down a phone line.
   *
   * `orderNumber`, not `id`: it is §6.3's route parameter, it carries `uq_orders_order_number`, and
   * the wire has no field for the uuid at all (`AccountOrder.id` *is* the number). A uuid in the URL
   * would be a second identifier for one thing.
   */
  async findOne(userId: string | null, orderNumber: string): Promise<Order | null> {
    // Same guard as `list`, for the three reasons spelled out there. The stakes are higher on this
    // route: a widened `where` here hands any guest any order by its number.
    if (userId === null) return null;

    return this.orders.findOne({
      // Both clauses, in the query. `orderNumber` is unique, so `userId` narrows nothing on the
      // happy path — its whole job is to make a stranger's order unreachable rather than merely
      // unreturned.
      where: { userId, orderNumber },
      relations: RELATIONS,
      order: ITEMS_IN_ORDER,
    });
  }

  /**
   * The customer cancelling their own order — spec §6.3's one write on this controller.
   *
   * Everything about *what* a cancellation does belongs to `OrderStatusService.transition`: the
   * legality check against `@nutwala/shared`'s transition map, the guarded `UPDATE`, the
   * `OrderEvent`, and putting the stock back with its compensating `CANCELLATION` ledger row, all in
   * one transaction. This method adds exactly two things, and they are the two an admin endpoint
   * would not have.
   *
   * **The target status is hardcoded and is never read from the request.** `RETAIL_TRANSITIONS`
   * allows `delivered -> refunded` and `canTransition` would happily approve it, so a
   * `POST .../cancel` that took a status from its caller would be an admin endpoint with a
   * misleading name — a customer able to refund themselves. There is no `to` parameter here for the
   * same reason there is no `userId` one.
   *
   * **The owner is established before anything is written, and it is established by the read
   * above.** `transition()` looks an order up by `orderNumber` alone, which is correct for the admin
   * console and wrong for a customer, so `findOne` is what turns a stranger's order number into a
   * `null` the controller answers **404** to — never a 403, and never a 422 saying the transition was
   * illegal, which would confirm the order exists and what state it is in. A guest is covered by the
   * same call: `findOne(null, …)` returns `null` without querying, so no cancellation can be
   * attempted without a session and `actorUserId` below is always a real customer.
   *
   * The order is read a second time afterwards rather than the first read being patched in memory:
   * `transition` writes through its own transaction's `EntityManager` and returns a summary, not an
   * entity, so the `items`/`events` relations `toAccountOrder` needs — including the cancellation
   * event just appended — only exist on a fresh read. A `null` from that second read is a server
   * fault and deliberately not a 404: the order was cancelled a moment ago, so telling the customer
   * it does not exist would be a lie about a write that succeeded.
   *
   * **No lock, and adding one would be a downgrade.** `transition` writes with
   * `update({ id, status: from }, patch)` — the status it read is inside the `WHERE` — so two
   * concurrent cancellations block under `READ COMMITTED`, the second re-checks against the committed
   * row, matches nothing, reports `affected !== 1` and raises **409 before** the stock consequence
   * runs. A double cancellation therefore cannot restock twice, and a `SELECT … FOR UPDATE` here
   * would only add a second serialisation point in front of one that already works.
   */
  async cancel(userId: string | null, orderNumber: string): Promise<Order | null> {
    const owned = await this.findOne(userId, orderNumber);
    if (owned === null) return null;

    await this.statuses.transition(owned.orderNumber, 'cancelled', {
      // The customer *is* the actor. Placement's first event is system-generated and carries `null`
      // here, but a cancellation was performed by someone and the timeline the admin reads has to
      // say who — `owned.userId` rather than the parameter, so it is the column's own value.
      actorUserId: owned.userId,
    });

    const cancelled = await this.findOne(userId, owned.orderNumber);
    if (cancelled === null) {
      throw new Error(`Order ${owned.orderNumber} was cancelled but could not be read back`);
    }
    return cancelled;
  }
}
