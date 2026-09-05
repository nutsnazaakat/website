import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { AdminOrder, AdminOrderSummary, Paginated } from '@nutwala/shared';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Order } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { Shipment } from '../../entities/commerce/shipment.entity';
import { PaymentMethodEnum, PaymentStatusEnum, ShipmentStatus } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { businessTimezone, DATE_ONLY_PATTERN } from '../settings/business-timezone';
import type { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import type { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import type { CollectPaymentDto } from './dto/collect-payment.dto';
import type { CreateShipmentDto } from './dto/create-shipment.dto';
import { toAdminOrder, toAdminOrderSummary } from './mappers/admin-order.mapper';
import { OrderStatusService } from './order-status.service';
import { CHANNEL, ITEMS_IN_ORDER } from './orders.service';

/** Both relations, because `toAccountOrder` refuses to map an order without them. */
const RELATIONS = { items: true, events: true } as const;

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The same refusal from every route on this controller, in `OrderStatusService.transition`'s own
 * words — so a mistyped reference reads identically whether it was caught by the read or by the
 * transition, and no route becomes an oracle for which of the two happened.
 */
function noSuchOrder(orderNumber: string): DomainError {
  return new DomainError(ErrorCodes.NOT_FOUND, `No order ${orderNumber}.`, HttpStatus.NOT_FOUND, {
    orderNumber,
  });
}

/**
 * The operator's half of orders — spec §6.4's `/admin/orders` block, brief §33.
 *
 * **A second service beside `OrdersService`, not extra methods on it**, and the difference is the
 * one thing that must not blur: every read in `OrdersService` carries `userId` in its `where`
 * clause, and its docblock calls that spec §13's IDOR rule *"the whole of this service"*. An admin
 * read has no owner to scope to — the console lists the shop's orders — so an `Order` fetched here
 * is fetched by `orderNumber` alone. Putting an unscoped read next to the scoped ones would leave a
 * method one careless reuse away from serving a customer somebody else's order, and the two would
 * be told apart only by their names.
 *
 * The write half is thinner still, because none of it lives here: `OrderStatusService.transition`
 * owns which moves are legal, the timeline row, the stock consequence, the notification hook and —
 * as of plan 9.2 — the `audit_logs` row, all in one transaction. What this service adds is the
 * admin's identity and the reply.
 */
@Injectable()
export class AdminOrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Shipment) private readonly shipments: Repository<Shipment>,
    private readonly statuses: OrderStatusService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `POST /admin/orders/:orderNumber/status` — spec §6.4's *"validated transition + timeline
   * event"*, and the route `OrderStatusService` was built for.
   *
   * **Everything that decides what happens is `transition`'s**, deliberately. The legality check
   * against `@nutwala/shared`'s per-channel maps, the guarded `UPDATE`, the `OrderEvent`, the
   * `CANCELLATION`/`RETURN` ledger rows, the `order.shipped`/`order.delivered` notification and the
   * audit row are one transaction there, and re-implementing any of them here would be the second
   * copy that drifts. This method contributes three things and no more: the actor, the audit
   * request, and re-reading the order so the console can render the committed result.
   *
   * **The refusals all come from below and are not softened here.** An unknown or mistyped order
   * number is a **404** — never a 422 claiming the transition was illegal, which would send an
   * operator hunting for a rule when they had fat-fingered a reference. An illegal move is a **422
   * `ILLEGAL_STATUS_TRANSITION`** carrying `allowed`, which is also the answer for a status from the
   * other channel's vocabulary and for a no-op click on the status the order already holds. A
   * transition racing another admin's is a **409**. None of that is re-implemented; the integration
   * suite asserts each still holds through this route.
   *
   * The order is re-read rather than patched in memory, exactly as `OrdersService.cancel` does and
   * for the same reason: `transition` writes through its own transaction's `EntityManager` and
   * answers with a summary, not an entity, so the relations `toAdminOrder` needs — the event it just
   * appended included — exist only on a fresh read. The read-back cannot miss on this path:
   * `transition` has already answered 404 for an order that does not exist, and its transaction has
   * committed by the time this runs.
   */
  async setStatus(
    orderNumber: string,
    input: ChangeOrderStatusDto & { actorUserId: string },
  ): Promise<AdminOrder> {
    await this.statuses.transition(orderNumber, input.status, {
      actorUserId: input.actorUserId,
      note: input.note ?? null,
      restock: input.restock,
      // Recorded inside `transition`'s transaction — spec §5, and the only place the row can be
      // atomic with the change. See `TransitionOptions.audit`.
      audit: { actorUserId: input.actorUserId },
    });

    return this.reload(orderNumber);
  }

  /**
   * `GET /admin/orders` — brief §33's list, whose seven columns are normative: Order ID, Customer,
   * B2C/B2B, Amount, Payment, Status, Date.
   *
   * **No relations, and that is what makes this shape different from the detail's.** Every one of
   * brief §33's columns lives on `orders` itself — the customer's name, email and phone come from
   * the order's own `address_snapshot`, which is a column too — so a page costs one statement and
   * no join. Loading `items` and `events` to reuse `AccountOrder` would fan 24 orders out into 24
   * baskets and 24 timelines, which is why `AdminOrderSummary` exists at all.
   *
   * **Ordered `placedAt DESC`, then `orderNumber DESC`**, served by `idx_orders_status_placed_at`
   * when a status is named and by `idx_orders_placed_at` when it is not. The tiebreak is not
   * decoration: `placedAt` is not unique — `orders.seed.ts` and every fixture write several orders
   * inside one transaction, and Postgres's `now()` is transaction-start time, so a whole batch
   * shares one timestamp exactly. An unstable tiebreak over `LIMIT`/`OFFSET` returns the same order
   * on two pages and loses another entirely. `orderNumber` carries `uq_orders_order_number`, so it
   * is arbitrary but *total*, which is the property paging actually needs.
   *
   * The date bounds are **inclusive at both ends**, compared against `placedAt`, and as of plan 9.4
   * a **date-only** bound is a day in the business's timezone rather than a UTC day. The block that
   * builds them carries the full reasoning; `AdminOrderQueryDto.from` carries the history.
   *
   * `getManyAndCount` issues the count as a second statement over the same `where`, so page 9 of a
   * 43-row result still reports 43 — where a `count(*) OVER ()` window would answer zero of zero
   * for a page past the end. `InventoryService.list` avoids the same trap the same way.
   */
  async list(query: AdminOrderQueryDto): Promise<Paginated<AdminOrderSummary>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.orders.createQueryBuilder('o');

    if (query.status !== undefined) {
      builder.andWhere('o.status = :status', { status: query.status });
    }
    // Through the shared `Record`, never `toUpperCase()`: `@IsIn` has already refused anything
    // outside the union, and this is the map that cannot grow on one side alone.
    if (query.channel !== undefined) {
      builder.andWhere('o.channel = :channel', { channel: CHANNEL[query.channel] });
    }
    /**
     * **A date-only bound is a day in the business's timezone; a full instant is left exactly as
     * sent.** Spec §5b, delivered by plan 9.4 in the same commit as `salesOverTime`.
     *
     * `?from=2026-08-27` used to mean midnight **UTC**, so an IST operator asking for the 27th lost
     * the first five and a half hours of it — a 04:00 IST order fell outside a filter that named
     * its own day. `AdminOrderQueryDto.from` records that this filter is one of the figures that
     * had to move, and it moves through the same `businessTimezone(manager)` the dashboard reads,
     * so there is one definition of "what day is it" across the admin surface.
     *
     * A full instant (`2026-08-27T00:00:00.000Z`) is **not** reinterpreted: the caller has already
     * resolved it, and shifting a bound a client computed would break any console that builds its
     * own ranges. `DATE_ONLY_PATTERN` is what tells the two apart.
     *
     * The upper bound flips from `<=` to a **strict `<` on the following midnight** for the
     * date-only case, which is the same closed interval expressed without a fencepost: "through the
     * end of the 27th" as `<= 23:59:59.999` would silently drop an order placed in the last
     * millisecond of the day, and `placedAt` is a `timestamptz` with microsecond resolution. An
     * instant bound keeps `<=`, because that is the inclusive bound the caller asked for.
     *
     * `CAST(… AS timestamp)` rather than `::timestamp`: TypeORM substitutes named parameters by
     * scanning for `:name`, and a `::` cast immediately after one is exactly the shape that has
     * historically confused that scanner. The zone and the date are both bound parameters, never
     * interpolated.
     */
    if (query.from !== undefined || query.to !== undefined) {
      const timezone = await businessTimezone(this.orders.manager);

      if (query.from !== undefined) {
        if (DATE_ONLY_PATTERN.test(query.from)) {
          builder.andWhere('o.placedAt >= (CAST(:from AS timestamp) AT TIME ZONE :fromZone)', {
            from: query.from,
            fromZone: timezone,
          });
        } else {
          builder.andWhere('o.placedAt >= :from', { from: new Date(query.from) });
        }
      }

      if (query.to !== undefined) {
        if (DATE_ONLY_PATTERN.test(query.to)) {
          builder.andWhere(
            `o.placedAt < ((CAST(:to AS timestamp) + INTERVAL '1 day') AT TIME ZONE :toZone)`,
            { to: query.to, toZone: timezone },
          );
        } else {
          builder.andWhere('o.placedAt <= :to', { to: new Date(query.to) });
        }
      }
    }

    const [rows, total] = await builder
      .orderBy('o.placedAt', 'DESC')
      .addOrderBy('o.orderNumber', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map((order) => toAdminOrderSummary(order)), total, page, limit };
  }

  /**
   * `GET /admin/orders/:orderNumber` — everything `/account/orders/:orderNumber` answers, plus the
   * customer identity a customer's own view has no use for.
   *
   * The same helper every write's reply goes through, so the detail an operator opens and the
   * detail they get back from a status change cannot be different shapes.
   */
  async get(orderNumber: string): Promise<AdminOrder> {
    return this.reload(orderNumber);
  }

  /**
   * `POST /admin/orders/:orderNumber/payment/collect` — spec §10.4's *"`POST
   * /admin/orders/:id/payment/collect` moves it to COLLECTED on delivery"*.
   *
   * **Idempotent, and the second call writes nothing at all — not even an audit row.** Plan 9.1's
   * rule is that a write which changes nothing leaves no trace, and it matters more here than on an
   * idempotent publish: this is a money fact. A second row in the trail saying cash was collected
   * would read as a second collection, which is precisely the question the trail exists to answer.
   * The response is the same either way, so a double-clicked button, a retried request and a second
   * operator all see the collected order rather than an error they have to interpret.
   *
   * **Two rows move, in one transaction, because the schema holds the fact twice.**
   * `payments.status` is the authoritative record — it carries `collectedAt` and `reference` — while
   * `orders.paymentStatus` is the denormalised copy `toAccountOrder` renders on the customer's own
   * page. Updating one without the other is how the customer's receipt and the operator's ledger
   * start disagreeing, so the guard reads `payments` and the write covers both.
   *
   * **The `UPDATE` is guarded on the status just read**, the same shape `OrderStatusService`
   * uses: two operators collecting at once both read `PENDING`, and under `READ COMMITTED` the
   * second re-checks its own `WHERE` against the committed row, matches nothing, and reports 409
   * rather than overwriting `collectedAt` with a later timestamp and writing a second audit row.
   * The early idempotent return above cannot cover that — it reads in a different statement.
   *
   * **Only a COD payment can be collected by hand.** Spec §10.4 is what this endpoint implements
   * and `POST /checkout/orders` refuses `online` outright, so no `ONLINE` payment exists today; the
   * refusal is here for the day one does, because a gateway payment moves to `COLLECTED` on a
   * webhook and an admin button that could do it by hand would be a way to mark an unpaid order
   * paid. `PAYMENT_METHOD_UNAVAILABLE` is the registry's existing member for "not with this
   * method".
   *
   * **No coupling to the order's status.** §10.4 says "on delivery", and this deliberately does not
   * check that the order *is* delivered: a courier reports cash collected before an operator gets
   * round to flipping the status, and the bulk ladder collects payment *before* dispatch —
   * `awaiting-payment -> approved` is the whole point of that step. A status check here would make
   * B2B collection impossible.
   */
  async collectPayment(
    orderNumber: string,
    input: CollectPaymentDto & { actorUserId: string },
  ): Promise<AdminOrder> {
    await this.dataSource.transaction(async (manager) => {
      const order = await manager.getRepository(Order).findOne({ where: { orderNumber } });
      if (order === null) throw noSuchOrder(orderNumber);

      const payment = await this.paymentFor(manager, order.id, orderNumber);

      if (payment.method !== PaymentMethodEnum.COD) {
        throw new DomainError(
          ErrorCodes.PAYMENT_METHOD_UNAVAILABLE,
          'Only a cash-on-delivery payment can be collected by hand.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { orderNumber, method: payment.method },
        );
      }

      // Already collected: nothing changes, so nothing is written. See the docblock.
      if (payment.status === PaymentStatusEnum.COLLECTED) return;

      if (payment.status !== PaymentStatusEnum.PENDING) {
        throw new DomainError(
          ErrorCodes.ILLEGAL_STATUS_TRANSITION,
          `A payment that is "${payment.status}" cannot be collected.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { orderNumber, from: payment.status, to: PaymentStatusEnum.COLLECTED },
        );
      }

      const reference = input.reference ?? null;
      const collected = await manager
        .getRepository(Payment)
        .update(
          { id: payment.id, status: PaymentStatusEnum.PENDING },
          { status: PaymentStatusEnum.COLLECTED, collectedAt: new Date(), reference },
        );

      if (collected.affected !== 1) {
        throw new DomainError(
          ErrorCodes.ILLEGAL_STATUS_TRANSITION,
          `Payment for ${orderNumber} is no longer pending. Reload it and try again.`,
          HttpStatus.CONFLICT,
          { orderNumber },
        );
      }

      // The denormalised copy, moved in the same transaction — see the docblock.
      await manager
        .getRepository(Order)
        .update({ id: order.id }, { paymentStatus: PaymentStatusEnum.COLLECTED });

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.PAYMENT_COLLECT,
        entityType: AuditEntity.PAYMENT,
        entityId: payment.id,
        before: { status: PaymentStatusEnum.PENDING },
        after: { status: PaymentStatusEnum.COLLECTED, orderNumber, reference },
      });
    });

    return this.reload(orderNumber);
  }

  /**
   * `POST /admin/orders/:orderNumber/shipment` — spec §6.4's last order row.
   *
   * **Creating a shipment also moves the order to `shipped`, and the two are one transaction.**
   * The plan leaves this open and both answers are defensible; this is the case for coupling them.
   * They are one event in the warehouse — the parcel left the building — and splitting them into two
   * clicks makes the second one forgettable. What is forgotten is not cosmetic: `transition` is
   * where the `OrderEvent` the customer's tracking page renders is appended (spec §10.3, *"admin
   * action and customer-visible tracking are the same data"*) and where the `order.shipped`
   * notification brief §38 asks for is queued. An order left at `packed` with a tracking number
   * against it is a customer who was never told their parcel is on its way, and a shop whose own
   * screens disagree about whether it shipped.
   *
   * **It goes through `OrderStatusService`, never a `status` write of its own**, which is what makes
   * the timeline and the notification hook unavoidable rather than remembered — and what keeps the
   * legality check in one place. `TransitionOptions.manager` is the new option that lets the
   * `shipments` row and the transition share one transaction; without it a failure between them
   * leaves an order marked shipped with nothing dispatched, or a dispatch nobody can see.
   *
   * **The transition is attempted first, so a refusal costs no write.** An order that cannot legally
   * reach `shipped` — one still `pending`, one already `delivered`, one cancelled — is refused with
   * the same `422 ILLEGAL_STATUS_TRANSITION` carrying `allowed` that the status route answers, and
   * no `shipments` row is created. That is the deliberate consequence of coupling: **this route
   * cannot be used to record a second dispatch against an order, or to attach an airway bill that
   * arrived after the fact**, because `shipped -> shipped` is a no-op and `canTransition` refuses
   * one. Spec §6.4 has no route that updates a shipment, so that case has nowhere to go today;
   * `CreateShipmentDto` records it as the gap it is.
   *
   * The shipment is `DISPATCHED` as of now rather than the column's `PENDING` default, because the
   * order it belongs to says `shipped` a line later and two records of one fact must not disagree.
   * `deliveredAt` stays null throughout this plan: nothing writes it, since `delivered` is a status
   * the operator sets on the order and no route updates a shipment.
   */
  async createShipment(
    orderNumber: string,
    input: CreateShipmentDto & { actorUserId: string },
  ): Promise<AdminOrder> {
    await this.dataSource.transaction(async (manager) => {
      /**
       * Before the insert, so an illegal move refuses without writing — and `moved.orderId` is how
       * the shipment finds its order, rather than a second lookup by `orderNumber`. A 404 for an
       * order nobody placed comes from here too, in the same words every other route uses.
       */
      const moved = await this.statuses.transition(orderNumber, 'shipped', {
        manager,
        actorUserId: input.actorUserId,
        note: input.trackingNumber
          ? `Dispatched via ${input.courier} (${input.trackingNumber})`
          : `Dispatched via ${input.courier}`,
        audit: { actorUserId: input.actorUserId },
      });

      const shipment = await manager.getRepository(Shipment).save(
        manager.getRepository(Shipment).create({
          orderId: moved.orderId,
          courier: input.courier,
          trackingNumber: input.trackingNumber ?? null,
          status: ShipmentStatus.DISPATCHED,
          shippedAt: new Date(),
          deliveredAt: null,
        }),
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.SHIPMENT_CREATE,
        entityType: AuditEntity.SHIPMENT,
        entityId: shipment.id,
        // A create has no `before` — `AuditLogInput` says so, and the column stores null.
        after: {
          orderNumber,
          courier: shipment.courier,
          trackingNumber: shipment.trackingNumber,
          status: ShipmentStatus.DISPATCHED,
        },
      });
    });

    return this.reload(orderNumber);
  }

  /**
   * The order's payment row, newest first.
   *
   * `payments` has no unique index on `order_id` and `CheckoutService.place` writes exactly one, so
   * "newest" is a tiebreak that never breaks a tie today — and is the right one the day a retry or a
   * second attempt writes another, since the live payment is the last one opened.
   *
   * A missing row is a **404 naming the order**, not a 500. It is not a state placement can reach,
   * but a fixture, an import or a hand-run `DELETE` can, and "this order has no payment record" sends
   * an operator somewhere useful where a constraint error would not.
   */
  private async paymentFor(
    manager: EntityManager,
    orderId: string,
    orderNumber: string,
  ): Promise<Payment> {
    const payment = await manager
      .getRepository(Payment)
      .findOne({ where: { orderId }, order: { createdAt: 'DESC' } });

    if (payment === null) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        `Order ${orderNumber} has no payment record.`,
        HttpStatus.NOT_FOUND,
        { orderNumber },
      );
    }

    return payment;
  }

  /**
   * The read behind the detail route and every write's reply, so no two of them can answer
   * different shapes.
   *
   * A miss is a 404 in the same words `transition` uses, which is the honest answer on the read
   * route; after a committed write it is unreachable.
   */
  private async reload(orderNumber: string): Promise<AdminOrder> {
    const order = await this.orders.findOne({
      where: { orderNumber },
      relations: RELATIONS,
      order: ITEMS_IN_ORDER,
    });

    if (order === null) throw noSuchOrder(orderNumber);

    /**
     * The payment and the shipments are read separately rather than through relations, because
     * `Order` declares neither — and adding them would put loadable arrays on every read in the
     * codebase to serve three fields on one admin shape. A missing payment is tolerated rather than
     * thrown over: see `toAdminOrder`. Issued concurrently, so it is one round trip's latency.
     */
    const [payment, shipments] = await Promise.all([
      this.payments.findOne({ where: { orderId: order.id }, order: { createdAt: 'DESC' } }),
      // Oldest first, so a replacement dispatch reads after the one it replaced.
      this.shipments.find({ where: { orderId: order.id }, order: { createdAt: 'ASC' } }),
    ]);

    return toAdminOrder(order, payment, shipments);
  }
}
