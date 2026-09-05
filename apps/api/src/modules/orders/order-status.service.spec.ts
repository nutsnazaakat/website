import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';
import { InventoryTransactionType, OrderChannelEnum } from '../../entities/enums';
import { AuditAction, AuditEntity, type AuditLogInput } from '../admin/audit-log.service';
import { OrderStatusService } from './order-status.service';

/** The only order number the harness knows about. Anything else is a genuine lookup miss. */
const ORDER_NUMBER = 'NN-2026-100000';

/** The shape of the patch the service sends to `UPDATE orders`. */
interface OrderPatch {
  status?: string;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
}

interface Recorded {
  events: { orderId: string; status: string; note: string | null; actorUserId: string | null }[];
  ledger: { variantId: string; delta: number; type: InventoryTransactionType }[];
  stockUpdates: { variantId: string; delta: number }[];
  orderStatus: string | null;
  orderPatch: OrderPatch | null;
  queued: unknown[];
  /** Every `AuditLogService.record` call, in order. Empty is the assertion on the customer path. */
  audited: AuditLogInput[];
}

function harness(order: {
  channel: OrderChannelEnum;
  status: string;
  items?: { variantId: string | null; qty: number }[];
  /** What the guarded `UPDATE orders` reports. `0` models the row moving under us. */
  updateAffected?: number;
}) {
  const recorded: Recorded = {
    events: [],
    ledger: [],
    stockUpdates: [],
    orderStatus: null,
    orderPatch: null,
    queued: [],
    audited: [],
  };

  const manager = {
    getRepository: (entity: { name: string }) => ({
      /**
       * Answers `null` for any number but the fixture's own.
       *
       * A `findOne` that always resolves a row would leave the 404 case asserting nothing — the
       * service would be judged against a lookup that cannot miss.
       */
      findOne: (options: { where?: { orderNumber?: string } }) =>
        Promise.resolve(
          options.where?.orderNumber === ORDER_NUMBER
            ? {
                id: 'ord-1',
                orderNumber: ORDER_NUMBER,
                channel: order.channel,
                status: order.status,
                items: order.items ?? [{ variantId: 'var-1', qty: 2 }],
              }
            : null,
        ),
      insert: (row: Record<string, unknown>) => {
        if (entity.name === 'OrderEvent') recorded.events.push(row as never);
        if (entity.name === 'InventoryTransaction') recorded.ledger.push(row as never);
        return Promise.resolve({ identifiers: [] });
      },
      update: (_criteria: unknown, patch: OrderPatch) => {
        recorded.orderPatch = patch;
        if (patch.status) recorded.orderStatus = patch.status;
        return Promise.resolve({ affected: order.updateAffected ?? 1 });
      },
    }),
    // The conditional UPDATE. Returns a row so the happy path proceeds; the zero-rows branch is
    // only reachable against real Postgres and is Task 7's to prove.
    query: (sql: string, parameters: unknown[]) => {
      if (/inventory/i.test(sql)) {
        recorded.stockUpdates.push({
          variantId: String(parameters[1]),
          delta: Number(parameters[0]),
        });
      }
      return Promise.resolve([{ onHand: 120, lowStockThreshold: 10 }]);
    },
  };

  const openedOwnTransaction = jest.fn();
  const dataSource = {
    transaction: <T>(run: (m: unknown) => Promise<T>) => {
      openedOwnTransaction();
      return run(manager);
    },
  };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };
  /**
   * The audit fake records **which manager it was handed** alongside the row.
   *
   * `AuditLogService.record`'s whole contract is that it writes through the caller's open
   * transaction, and a mutation that passed some other manager — `this.dataSource.manager`, say —
   * would still produce a row and satisfy every assertion about its contents. Capturing the manager
   * is what makes "in the same transaction" a thing this file can measure at all; only Postgres can
   * prove the rollback itself, which `admin-orders.integration.spec.ts` does.
   */
  const audit = {
    record: (givenManager: unknown, input: AuditLogInput) => {
      recorded.audited.push(input);
      expect(givenManager).toBe(manager);
      return Promise.resolve();
    },
  };
  return {
    service: new OrderStatusService(dataSource as never, notifications as never, audit),
    recorded,
    manager,
    openedOwnTransaction,
  };
}

describe('OrderStatusService.transition', () => {
  it('appends an event and moves the order when the transition is legal', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });

    await service.transition(ORDER_NUMBER, 'confirmed', {
      actorUserId: 'admin-1',
      note: 'Verified',
    });

    expect(recorded.orderStatus).toBe('confirmed');
    expect(recorded.events).toEqual([
      { orderId: 'ord-1', status: 'confirmed', note: 'Verified', actorUserId: 'admin-1' },
    ]);
  });

  /**
   * §10.3: an illegal transition is a 422, not a silent write. `shipped` cannot go back to `pending`,
   * and the order must be left exactly as it was — no event, no status change.
   */
  it('refuses an illegal transition with 422 and writes nothing', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'shipped' });

    await expect(service.transition(ORDER_NUMBER, 'pending', {})).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.events).toEqual([]);
    expect(recorded.orderStatus).toBeNull();
  });

  /** The refusal carries what *is* allowed, so a client renders the choices rather than guessing. */
  it('names the statuses that were available instead', async () => {
    const { service } = harness({ channel: OrderChannelEnum.RETAIL, status: 'shipped' });

    const error = await service
      .transition(ORDER_NUMBER, 'pending', {})
      .catch((thrown: unknown) => thrown);

    expect((error as DomainError).details).toEqual({
      orderNumber: ORDER_NUMBER,
      from: 'shipped',
      to: 'pending',
      allowed: ['out-for-delivery'],
    });
  });

  /**
   * A duplicate admin click. `canTransition` already refuses a no-op — `order-status.test.ts` pins it
   * — and this asserts the service does not work around that with an `if (from === to) return`.
   */
  it('refuses a transition to the status the order already holds', async () => {
    const { service } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });
    await expect(service.transition(ORDER_NUMBER, 'packed', {})).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  /**
   * A bulk order follows the bulk ladder. `processing → packed` is legal for retail and does not
   * exist for bulk, so passing the channel through is what stops the two vocabularies mixing.
   */
  it('judges a bulk order against the bulk ladder', async () => {
    const { service } = harness({ channel: OrderChannelEnum.BULK, status: 'processing' });
    await expect(service.transition(ORDER_NUMBER, 'packed', {})).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    const bulk = harness({ channel: OrderChannelEnum.BULK, status: 'processing' });
    await expect(bulk.service.transition(ORDER_NUMBER, 'shipped', {})).resolves.toBeDefined();
  });

  it('restores stock and writes a CANCELLATION row when an order is cancelled', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'processing',
      items: [
        { variantId: 'var-1', qty: 2 },
        { variantId: 'var-2', qty: 1 },
      ],
    });

    await service.transition(ORDER_NUMBER, 'cancelled', { note: 'Customer changed their mind' });

    expect(recorded.stockUpdates).toEqual([
      { variantId: 'var-1', delta: 2 },
      { variantId: 'var-2', delta: 1 },
    ]);
    expect(recorded.ledger.map((r) => r.type)).toEqual([
      InventoryTransactionType.CANCELLATION,
      InventoryTransactionType.CANCELLATION,
    ]);
  });

  /**
   * Step 3 of the task also asks for `cancelledAt` and `cancelReason`, which nothing above checks:
   * every assertion so far would hold for an implementation that recorded a cancellation with no
   * date and no reason, which is the pair the admin list and the customer's timeline both read.
   */
  it('records when a cancelled order was cancelled, and why', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'confirmed',
    });

    await service.transition(ORDER_NUMBER, 'cancelled', { note: 'Ordered the wrong size' });

    expect(recorded.orderPatch?.cancelReason).toBe('Ordered the wrong size');
    expect(recorded.orderPatch?.cancelledAt).toBeInstanceOf(Date);
  });

  /**
   * `order_events.note` is `varchar(300)` and `orders.cancel_reason` is `varchar(200)`, so the same
   * string cannot be written to both unchanged. Untruncated, a 300-character reason is a Postgres
   * `22001` — the cancellation fails at the database with a 500 after passing every rule above.
   */
  it('trims a long cancellation reason to the width of the column it goes in', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'confirmed',
    });
    const note = 'w'.repeat(300);

    await service.transition(ORDER_NUMBER, 'cancelled', { note });

    expect(recorded.orderPatch?.cancelReason).toHaveLength(200);
    // The full text survives on the event, which is the row the timeline renders.
    expect(recorded.events[0]?.note).toBe(note);
  });

  /**
   * §10.3 makes restocking a **judgement about the goods**, not a property of the status: returned
   * food may not be resellable. So `refunded` reads the flag and nothing else. Defaulting it to
   * `true` would put possibly-spoiled food back on sale, which is why the omitted case restocks
   * nothing.
   */
  it('refunds without restocking unless told to restock', async () => {
    const plain = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await plain.service.transition(ORDER_NUMBER, 'refunded', {});
    expect(plain.recorded.ledger).toEqual([]);
    expect(plain.recorded.stockUpdates).toEqual([]);

    const restocked = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await restocked.service.transition(ORDER_NUMBER, 'refunded', { restock: true });
    expect(restocked.recorded.ledger.map((r) => r.type)).toEqual([InventoryTransactionType.RETURN]);
  });

  /**
   * A status change with no stock consequence must not touch inventory at all. Without this, a
   * "restore on every transition" implementation passes the cancellation test and quietly inflates
   * stock on every step of a normal order's life.
   */
  it('leaves stock alone on an ordinary forward step', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'confirmed',
    });
    await service.transition(ORDER_NUMBER, 'processing', {});
    expect(recorded.stockUpdates).toEqual([]);
    expect(recorded.ledger).toEqual([]);
  });

  /**
   * Ascending `variantId`, which is the order the placement decrements in.
   *
   * The task expected this to be unprovable without concurrency. The *deadlock* is — but the
   * ordering is not: the lines arrive here descending, so an implementation that walks
   * `order.items` as it found them restores `var-2` first and fails this.
   */
  it('restores lines in ascending variantId whatever order they arrive in', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'packed',
      items: [
        { variantId: 'var-2', qty: 1 },
        { variantId: 'var-1', qty: 2 },
      ],
    });

    await service.transition(ORDER_NUMBER, 'cancelled', {});

    expect(recorded.stockUpdates).toEqual([
      { variantId: 'var-1', delta: 2 },
      { variantId: 'var-2', delta: 1 },
    ]);
  });

  /**
   * `OrderItem.variantId` is nullable `SET NULL`, so a line can outlive its variant. There is no
   * stock row left to credit, and the alternative — a raw `UPDATE ... WHERE variant_id = NULL`
   * matching nothing — would refuse the whole cancellation for a variant admin deleted months ago.
   */
  it('cancels an order whose variant has since been deleted, restoring what it can', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'processing',
      items: [
        { variantId: null, qty: 3 },
        { variantId: 'var-2', qty: 1 },
      ],
    });

    await service.transition(ORDER_NUMBER, 'cancelled', {});

    expect(recorded.orderStatus).toBe('cancelled');
    expect(recorded.stockUpdates).toEqual([{ variantId: 'var-2', delta: 1 }]);
    expect(recorded.ledger).toHaveLength(1);
  });

  /**
   * The gap between reading the status and writing it. Two admins clicking at once both read
   * `pending`, both pass `canTransition`, and without a guarded `UPDATE` both append an event — the
   * duplicate the no-op refusal exists to prevent, arriving by a different route.
   */
  it('refuses to write when the order moved under it', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'pending',
      updateAffected: 0,
    });

    await expect(service.transition(ORDER_NUMBER, 'confirmed', {})).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
    });
    expect(recorded.events).toEqual([]);
    expect(recorded.ledger).toEqual([]);
  });

  it('reports an unknown order number as 404, not as an illegal transition', async () => {
    // Two different failures need two different answers: an admin who mistyped a reference must not
    // be told the transition was illegal. Same shape as the inventory adjustment's 404-versus-409.
    const { service } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });
    await expect(service.transition('NN-2026-999999', 'confirmed', {})).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });
});

describe('OrderStatusService.transition — notifications', () => {
  it('queues order.shipped when a packed order ships', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });

    await service.transition(ORDER_NUMBER, 'shipped', {});

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        channel: 'EMAIL',
        template: 'order.shipped',
        payload: { orderNumber: ORDER_NUMBER, status: 'shipped' },
      }),
    ]);
  });

  it('queues order.delivered when an out-for-delivery order is delivered', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'out-for-delivery',
    });

    await service.transition(ORDER_NUMBER, 'delivered', {});

    expect(recorded.queued).toEqual([expect.objectContaining({ template: 'order.delivered' })]);
  });

  it('queues nothing for a step that is neither shipped nor delivered', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });

    await service.transition(ORDER_NUMBER, 'confirmed', {});

    expect(recorded.queued).toEqual([]);
  });
});

/**
 * The `audit_logs` row plan 9.2 puts **inside** `transition`'s own transaction.
 *
 * Spec §5 requires every admin status change to leave a trace and `AuditLogService.record` requires
 * the caller's open transaction, so the write cannot sit around `transition` in a controller — it
 * would commit separately from the change it describes. These cases pin the contents and the
 * absence; the rollback itself needs Postgres and is asserted in
 * `test/integration/admin-orders.integration.spec.ts`.
 */
describe('OrderStatusService.transition — the audit row', () => {
  const ADMIN = 'admin-1';

  it('records the status change on the transaction’s own manager when asked to', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });

    await service.transition(ORDER_NUMBER, 'shipped', {
      actorUserId: ADMIN,
      note: 'Handed to the courier',
      audit: { actorUserId: ADMIN },
    });

    expect(recorded.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.ORDER_STATUS_CHANGE,
        entityType: AuditEntity.ORDER,
        entityId: 'ord-1',
        before: { status: 'packed' },
        after: {
          status: 'shipped',
          orderNumber: ORDER_NUMBER,
          note: 'Handed to the courier',
        },
      },
    ]);
  });

  /**
   * `POST /account/orders/:orderNumber/cancel` is a customer acting on their own order, and
   * `audit_logs` is the *admin* trail — spec §5's "every destructive **admin** action". The act is
   * already recorded as an `OrderEvent` carrying the customer as the actor, which is the timeline
   * they and the operator both read. An unconditional audit write here would fill the operator's
   * trail with customer activity and, worse, would need an actor where `TransitionOptions`
   * legitimately has none.
   */
  it('writes no audit row for a transition that did not ask for one', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });

    await service.transition(ORDER_NUMBER, 'cancelled', { actorUserId: 'customer-1' });

    expect(recorded.audited).toEqual([]);
    expect(recorded.orderStatus).toBe('cancelled');
  });

  /**
   * The refund flag is the one part of a transition that is a **decision** rather than a
   * consequence — spec §10.3 makes restocking a judgement about the goods — so the trail has to
   * carry it, including when the answer was no. What actually moved is the `RETURN` ledger row;
   * this records what was asked for, which is the only record that an admin chose *not* to restock.
   */
  it('records the restock decision on the refunded path, both ways', async () => {
    const kept = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await kept.service.transition(ORDER_NUMBER, 'refunded', {
      restock: false,
      audit: { actorUserId: ADMIN },
    });
    expect(kept.recorded.audited[0]?.after).toMatchObject({ status: 'refunded', restock: false });

    const resold = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await resold.service.transition(ORDER_NUMBER, 'refunded', {
      restock: true,
      audit: { actorUserId: ADMIN },
    });
    expect(resold.recorded.audited[0]?.after).toMatchObject({ status: 'refunded', restock: true });
  });

  /**
   * `restock` is read only on the `refunded` path, so reporting it elsewhere would be a claim about
   * a flag nothing consulted — and `cancelled` restores stock unconditionally, so a `restock: false`
   * beside a cancellation would read as the opposite of what happened.
   */
  it('leaves restock off the row for a status that never consults it', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });

    await service.transition(ORDER_NUMBER, 'cancelled', { audit: { actorUserId: ADMIN } });

    expect(recorded.audited[0]?.after).toEqual({
      status: 'cancelled',
      orderNumber: ORDER_NUMBER,
      note: null,
    });
  });

  /** A refused transition changed nothing, and plan 9.1's rule is that nothing changed writes no row. */
  it('writes no audit row when the transition is refused', async () => {
    const illegal = harness({ channel: OrderChannelEnum.RETAIL, status: 'shipped' });
    await expect(
      illegal.service.transition(ORDER_NUMBER, 'pending', { audit: { actorUserId: ADMIN } }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(illegal.recorded.audited).toEqual([]);

    const raced = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'pending',
      updateAffected: 0,
    });
    await expect(
      raced.service.transition(ORDER_NUMBER, 'confirmed', { audit: { actorUserId: ADMIN } }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(raced.recorded.audited).toEqual([]);

    const missing = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });
    await expect(
      missing.service.transition('NN-2026-999999', 'confirmed', { audit: { actorUserId: ADMIN } }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(missing.recorded.audited).toEqual([]);
  });
});

/**
 * `TransitionOptions.manager` — plan 9.2's second addition, for the caller whose act is larger than
 * the transition.
 *
 * `AdminOrdersService.createShipment` writes a `shipments` row and moves the order to `shipped`, and
 * those must commit or roll back together: a failure between two transactions leaves an order marked
 * shipped with nothing dispatched, or a dispatch nobody can see. Owning its own transaction stays the
 * default, because the status write, the event, the audit row and the stock consequence are one act
 * no caller should have to assemble.
 */
describe('OrderStatusService.transition — joining a caller’s transaction', () => {
  it('opens its own transaction when none is given', async () => {
    const { service, openedOwnTransaction } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'packed',
    });

    await service.transition(ORDER_NUMBER, 'shipped', {});

    expect(openedOwnTransaction).toHaveBeenCalledTimes(1);
  });

  /**
   * Not merely "it still works": the assertion is that `dataSource.transaction` is **not** called,
   * because a nested `transaction()` on the same DataSource would take a second connection from the
   * pool and commit independently of the caller's — which is the failure this option exists to
   * avoid, wearing the disguise of working code.
   */
  it('joins the manager it is given, opening no transaction of its own', async () => {
    const { service, manager, recorded, openedOwnTransaction } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'packed',
    });

    await service.transition(ORDER_NUMBER, 'shipped', {
      manager: manager as never,
      audit: { actorUserId: 'admin-1' },
    });

    expect(openedOwnTransaction).not.toHaveBeenCalled();
    expect(recorded.orderStatus).toBe('shipped');
    // The audit row lands in the caller's transaction too — the fake asserts the manager identity.
    expect(recorded.audited).toHaveLength(1);
  });
});
