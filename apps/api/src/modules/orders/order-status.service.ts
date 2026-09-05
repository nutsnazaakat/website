import { HttpStatus, Injectable } from '@nestjs/common';
import { canTransition, nextStatuses, type OrderChannel, type OrderStatus } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { OrderEvent } from '../../entities/commerce/order-event.entity';
import { Order } from '../../entities/commerce/order.entity';
import {
  InventoryTransactionType,
  NotificationChannel,
  OrderChannelEnum,
} from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { checkLowStock } from '../inventory/check-low-stock';
import { NotificationsService } from '../notifications/notifications.service';

/** `orders.cancel_reason` is `varchar(200)`; `order_events.note` is `varchar(300)`. */
const CANCEL_REASON_MAX = 200;

/** What a transition can be told, beyond the status it is moving to. */
export interface TransitionOptions {
  /** The admin who acted, or `null` for a system or customer-driven change. */
  actorUserId?: string | null;
  /** Free text for the timeline. Also becomes `cancelReason` when cancelling, truncated. */
  note?: string | null;
  /**
   * Whether refunded goods go back on sale. Read **only** on the `refunded` path.
   *
   * Spec §10.3 makes this a judgement about the goods rather than a property of the status —
   * returned food may not be resellable — so it is never inferred and never defaulted to `true`.
   * Omitting it restocks nothing, which is the recoverable direction of the two: an admin can add
   * stock back with an `ADJUSTMENT`, and cannot un-sell a spoiled pack that went back on the shelf.
   * Every call site that refunds should still pass it explicitly, because "no flag" and "the admin
   * decided not to restock" are different facts that arrive here looking identical.
   */
  restock?: boolean;
  /**
   * Present for an **admin-initiated** transition: the row `audit_logs` gets, written inside this
   * transition's own transaction.
   *
   * Spec §5 requires every admin status change to leave a trace, and `AuditLogService.record`
   * requires the caller's open transaction — *"an audit row committed separately from the change it
   * describes … can outlive a write that rolled back, claiming a change that never happened"*.
   * `transition` opens that transaction and nobody else holds it, so the write belongs here: an
   * audit call wrapped **around** `transition` in a controller or a service commits separately by
   * construction, whatever care is taken. Passing this option is a request to record; the atomicity
   * is not the caller's to get right.
   *
   * **Absent for a customer's own cancellation**, which is why this is an option rather than
   * unconditional. `audit_logs` is the *admin* trail — spec §5 says "every destructive **admin**
   * action" — and `POST /account/orders/:orderNumber/cancel` is a customer acting on their own
   * order. That act is already recorded where it belongs: an `OrderEvent` carrying the customer as
   * `actorUserId`, which is the timeline they and the operator both read.
   *
   * **It carries its own `actorUserId` rather than reusing the one above**, and the duplication is
   * deliberate. `TransitionOptions.actorUserId` is nullable, because a system-driven transition has
   * no actor; `AuditLogInput.actorUserId` is not, because an unattributable admin mutation is one
   * this service is unwilling to have made. Requiring it here makes "audit this, by nobody"
   * impossible to express instead of something to check for at runtime.
   */
  audit?: { actorUserId: string };
  /**
   * A transaction to join instead of opening one.
   *
   * `transition` owns its own transaction by default and that is the right default: the status
   * write, the `OrderEvent`, the audit row and the stock consequence are one act, and no caller
   * should have to assemble that correctly. This exists for the caller whose act is *larger* than
   * the transition — `AdminOrdersService.createShipment`, where the `shipments` row and the move to
   * `shipped` are one thing that must commit or roll back together. Without it that route would
   * write the shipment in one transaction and transition in another, and a failure between them
   * leaves an order marked shipped with nothing dispatched, or a dispatch nobody can see.
   *
   * **A caller that passes this owns the transaction and therefore owns the rollback.** Everything
   * `transition` writes lands in it, `options.audit` included, so atomicity with the caller's own
   * writes is automatic — but a caller that swallows an exception thrown from here and commits
   * anyway would commit a half-applied transition. There is exactly one such caller and it does
   * not catch.
   */
  manager?: EntityManager;
}

/** What the transition did, for the caller that has to report it. */
export interface TransitionResult {
  orderId: string;
  orderNumber: string;
  from: OrderStatus;
  to: OrderStatus;
  /** The lines whose stock went back, ascending by `variantId`. Empty when none did. */
  restored: readonly { variantId: string; qty: number }[];
}

/**
 * The one server-side owner of "which status changes are legal, and what each does to stock".
 *
 * The rule itself lives in `@nutwala/shared`'s `RETAIL_TRANSITIONS` / `BULK_TRANSITIONS`, mirrored as
 * the `ck_orders_status` check constraint. This service is a consumer of it, deliberately: a second
 * transition table here would be the third copy of brief §33's vocabulary, and the third copy is the
 * one that drifts. Nothing in this file decides what may follow what.
 *
 * Note what is **not** here: the initial `pending` event of a new order. Nothing transitions *to*
 * `pending` — it is the state an order is born in, and `nextStatuses(channel, x)` never returns it —
 * so placement writes that first event itself rather than through `transition()`.
 */
@Injectable()
export class OrderStatusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Moves an order to `to`, appends the `OrderEvent` the timeline renders, and applies the stock
   * consequence — all in one transaction, so a restore that succeeds while its ledger row fails
   * cannot happen. `SUM(inventory_transactions.delta) == inventory.onHand` is asserted by
   * `schema-invariants.integration.spec.ts`, and the column and the ledger move together or not at
   * all.
   *
   * An illegal transition is a 422 and writes nothing — spec §10.3's "not a silent write". An
   * unknown order number is a 404, because an admin who mistyped a reference must not be told the
   * transition was illegal.
   *
   * `options.audit` puts the `audit_logs` row **in this same transaction**, which is the only place
   * it can go: see that option's docblock.
   */
  async transition(
    orderNumber: string,
    to: OrderStatus,
    options: TransitionOptions = {},
  ): Promise<TransitionResult> {
    const joined = options.manager;
    return joined === undefined
      ? this.dataSource.transaction((own) => this.apply(own, orderNumber, to, options))
      : this.apply(joined, orderNumber, to, options);
  }

  /**
   * The transition itself, against whichever transaction is in force.
   *
   * Split out from `transition` only so `options.manager` can be honoured; every line below was
   * previously the body of `this.dataSource.transaction(...)` and none of it changed. Private,
   * because "run this outside a transaction" is not a thing any caller may ask for — the guarantee
   * this service exists to give is that the status, the event, the audit row and the stock all move
   * together.
   */
  private async apply(
    manager: EntityManager,
    orderNumber: string,
    to: OrderStatus,
    options: TransitionOptions,
  ): Promise<TransitionResult> {
    const order = await manager.getRepository(Order).findOne({
      where: { orderNumber },
      relations: { items: true },
    });

    if (!order) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        `No order ${orderNumber}.`,
        HttpStatus.NOT_FOUND,
        { orderNumber },
      );
    }

    /**
     * The channel comes from the row, never from the caller.
     *
     * A caller-supplied channel is how a retail order gets judged against the bulk ladder, which
     * would let `processing -> shipped` slip past `packed`.
     */
    const channel: OrderChannel = order.channel === OrderChannelEnum.BULK ? 'bulk' : 'retail';

    /**
     * `ck_orders_status` guarantees the column holds one of the 14 values, so the cast is a claim
     * the database already enforces. A value outside the channel's own tuple — a bulk status on a
     * retail order — still lands safely: `nextStatuses` degrades to `[]`, so every transition from
     * it is refused rather than crashing.
     */
    const from = order.status as OrderStatus;

    if (!canTransition(channel, from, to)) {
      throw new DomainError(
        ErrorCodes.ILLEGAL_STATUS_TRANSITION,
        `An order that is "${from}" cannot become "${to}".`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        // What *is* allowed, so a client renders the real choices instead of guessing. Empty for a
        // terminal order, which is itself the answer.
        { orderNumber, from, to, allowed: nextStatuses(channel, from) },
      );
    }

    const patch =
      to === 'cancelled'
        ? {
            status: to,
            cancelledAt: new Date(),
            // Truncated because the two columns disagree by 100 characters; the full text is on
            // the event, which is the row the timeline actually renders.
            cancelReason: options.note?.slice(0, CANCEL_REASON_MAX) ?? null,
          }
        : { status: to };

    /**
     * Guarded on the status we just read, and the guard is the point.
     *
     * Reading the status and writing it are two statements, so two admins clicking at once both
     * read `pending`, both pass `canTransition`, and both append an event — the duplicate the
     * no-op refusal exists to prevent, arriving by another route. Under `READ COMMITTED` the
     * second `UPDATE` blocks on the first, then re-checks its `WHERE` against the committed row
     * and matches nothing, so it reports zero rows instead of overwriting.
     *
     * 409 rather than 422: the request was legal when it was made, and retrying it against the
     * order's new status is a sensible thing for the caller to do.
     */
    const moved = await manager.getRepository(Order).update({ id: order.id, status: from }, patch);

    if (moved.affected !== 1) {
      throw new DomainError(
        ErrorCodes.ILLEGAL_STATUS_TRANSITION,
        `Order ${orderNumber} is no longer "${from}". Reload it and try again.`,
        HttpStatus.CONFLICT,
        { orderNumber, from, to },
      );
    }

    await manager.getRepository(OrderEvent).insert({
      orderId: order.id,
      status: to,
      note: options.note ?? null,
      actorUserId: options.actorUserId ?? null,
    });

    /**
     * The audit row, on this transaction's manager — **before** the stock consequence, not after.
     *
     * Position is load-bearing rather than aesthetic. `applyStockConsequence` can fail for a real
     * reason: `putStockBack` answers 404 when a line's `inventory` row is missing, deliberately,
     * *"rather than write a CANCELLATION row for stock that never moved"*. So there is a reachable
     * path on which everything above this line rolls back — and an audit row written outside this
     * transaction would survive it, claiming a status change that never happened. Written here, it
     * dies with the rest. That is the property `test/integration/admin-orders.integration.spec.ts`
     * measures by breaking the stock row and asserting the trail stays empty.
     *
     * `restock` is recorded on the `refunded` path only, where it is a decision the admin made
     * about the goods; on every other path nothing consulted it. What *happened* to stock is the
     * `inventory_transactions` row, which is the ledger and the only append-only record of it —
     * this row records what was asked for.
     */
    if (options.audit !== undefined) {
      await this.audit.record(manager, {
        actorUserId: options.audit.actorUserId,
        action: AuditAction.ORDER_STATUS_CHANGE,
        entityType: AuditEntity.ORDER,
        entityId: order.id,
        before: { status: from },
        after: {
          status: to,
          orderNumber: order.orderNumber,
          note: options.note ?? null,
          ...(to === 'refunded' ? { restock: options.restock === true } : {}),
        },
      });
    }

    const restored = await this.applyStockConsequence(manager, order, to, options);

    /**
     * The one addition `transition` gains this milestone, and the only two `to` values it
     * fires for. Brief §38 names "order shipped" and "order delivered" as two of its eight
     * triggers; every other forward step (`confirmed`, `processing`, `packed`,
     * `out-for-delivery`) is an operational state change with nothing a customer is waiting to
     * hear, so this does not fire unconditionally the way `RfqStatusService.transition` does —
     * an RFQ's every step *is* the point of the pipeline, an order's is not.
     */
    if (to === 'shipped' || to === 'delivered') {
      await this.notifications.queue(manager, {
        userId: order.userId,
        channel: NotificationChannel.EMAIL,
        template: to === 'shipped' ? 'order.shipped' : 'order.delivered',
        payload: { orderNumber: order.orderNumber, status: to },
      });
    }

    return { orderId: order.id, orderNumber: order.orderNumber, from, to, restored };
  }

  /**
   * The stock consequence of arriving at `to`, per spec §10.3.
   *
   * `cancelled` always restores, and needs no "before dispatch" test: `RETAIL_TRANSITIONS` only
   * offers `cancelled` from `pending`, `confirmed`, `processing` and `packed`, so an order that has
   * shipped cannot reach it at all. After dispatch the goods are with a courier and the correct
   * action is a return, not a cancellation.
   *
   * `refunded` restores only when the admin says the goods are resellable. Everything else — every
   * ordinary forward step — touches inventory not at all, which is why this returns early rather
   * than looping over the lines with a zero delta.
   */
  private async applyStockConsequence(
    manager: EntityManager,
    order: Order,
    to: OrderStatus,
    options: TransitionOptions,
  ): Promise<readonly { variantId: string; qty: number }[]> {
    const type =
      to === 'cancelled'
        ? InventoryTransactionType.CANCELLATION
        : to === 'refunded' && options.restock === true
          ? InventoryTransactionType.RETURN
          : null;

    if (type === null) return [];

    const reason =
      type === InventoryTransactionType.CANCELLATION
        ? `Order ${order.orderNumber} cancelled`
        : `Order ${order.orderNumber} refunded, goods restocked`;

    const restored: { variantId: string; qty: number }[] = [];

    /**
     * Ascending `variantId`, which is the order placement decrements in.
     *
     * Two transactions touching the same two variants in opposite orders is the textbook deadlock,
     * and a cancellation racing a placement is exactly that pair. Sorting both sides means whichever
     * gets `var-1` first also gets `var-2` first, so one waits instead of both dying.
     *
     * `variantId` is nullable `SET NULL`, so a line can outlive its variant: those are skipped
     * rather than refused, because there is no stock row left to credit and blocking a cancellation
     * over a variant deleted months ago would be worse than an uncredited line.
     */
    const lines = order.items
      .filter((item): item is typeof item & { variantId: string } => item.variantId !== null)
      .sort((a, b) => a.variantId.localeCompare(b.variantId));

    for (const line of lines) {
      await this.putStockBack(manager, {
        orderId: order.id,
        variantId: line.variantId,
        qty: line.qty,
        type,
        reason,
        actorUserId: options.actorUserId ?? null,
      });
      restored.push({ variantId: line.variantId, qty: line.qty });
    }

    return restored;
  }

  /**
   * One line's stock back on the shelf, plus the ledger row that explains it.
   *
   * The same conditional-`UPDATE`-and-`RETURNING` shape as the decrement: the new `onHand` comes
   * back from the writing statement, so `balanceAfter` is the value the storefront will read rather
   * than a second derivation of it, and no read-then-write gap exists for a concurrent operation to
   * land in. `updatedAt` is set by hand because raw SQL bypasses `@UpdateDateColumn`.
   *
   * `onHand + delta >= reserved` cannot fail for a positive delta while `ck_inventory_non_negative`
   * holds, so zero rows here means the `inventory` row itself is missing — and the honest answer is
   * to fail the whole transition rather than write a CANCELLATION row for stock that never moved,
   * which is precisely how `SUM(delta) == onHand` drifts.
   *
   * **The data-modifying CTE is load-bearing — see the long note on `CheckoutService.sell`, which
   * carries the identical shape and had the identical defect.** TypeORM's Postgres driver answers
   * `[rows, rowCount]` for a bare `UPDATE`, so `rows[0]?.onHand` was `undefined` on every successful
   * restock and every cancellation threw `NOT_FOUND`. Found while proving the decrement against a
   * real database in Task 7; the unit doubles here answer `[{ onHand }]`, the shape a `SELECT`
   * returns, so nothing single-threaded could show it. Still one statement, predicate still inside
   * the write.
   */
  private async putStockBack(
    manager: EntityManager,
    input: {
      orderId: string;
      variantId: string;
      qty: number;
      type: InventoryTransactionType;
      reason: string;
      actorUserId: string | null;
    },
  ): Promise<void> {
    const rows = await manager.query<{ onHand: number; lowStockThreshold: number }[]>(
      `WITH restored AS (
         UPDATE "inventory"
            SET "onHand" = "onHand" + $1, "updatedAt" = now()
          WHERE "variant_id" = $2
            AND "onHand" + $1 >= "reserved"
        RETURNING "onHand", "lowStockThreshold"
       )
       SELECT "onHand", "lowStockThreshold" FROM restored`,
      [input.qty, input.variantId],
    );

    const onHand = rows[0]?.onHand;
    const lowStockThreshold = rows[0]?.lowStockThreshold;

    if (onHand === undefined) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'No stock record for a line on this order, so it could not be restocked.',
        HttpStatus.NOT_FOUND,
        { variantId: input.variantId },
      );
    }

    await manager.getRepository(InventoryTransaction).insert({
      variantId: input.variantId,
      delta: input.qty,
      type: input.type,
      reason: input.reason,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      balanceAfter: Number(onHand),
    });

    await checkLowStock(manager, this.notifications, {
      variantId: input.variantId,
      delta: input.qty,
      onHand: Number(onHand),
      lowStockThreshold: Number(lowStockThreshold),
    });
  }
}
