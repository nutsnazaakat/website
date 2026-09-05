import { HttpStatus } from '@nestjs/common';
import { toPaise } from '@nutwala/shared';
import {
  OrderChannelEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
  ShipmentStatus,
} from '../../entities/enums';
import type { Order } from '../../entities/commerce/order.entity';
import type { Payment } from '../../entities/commerce/payment.entity';
import type { Shipment } from '../../entities/commerce/shipment.entity';
import { AuditAction, AuditEntity, type AuditLogInput } from '../admin/audit-log.service';
import { AdminOrdersService } from './admin-orders.service';
import type { OrderStatusService } from './order-status.service';

const ORDER_NUMBER = 'NN-2026-100000';
const ADMIN = 'admin-1';

/** Enough of an order for `toAccountOrder` to map, which is what the reply goes through. */
function orderRow(): Order {
  return {
    id: 'ord-1',
    orderNumber: ORDER_NUMBER,
    userId: 'user-1',
    businessId: null,
    companyName: null,
    channel: OrderChannelEnum.RETAIL,
    status: 'packed',
    paymentMethod: PaymentMethodEnum.COD,
    paymentStatus: PaymentStatusEnum.PENDING,
    subtotalPaise: toPaise(1000),
    discountPaise: 0n,
    gstPaise: 0n,
    shippingPaise: 0n,
    totalPaise: toPaise(1000),
    couponCode: null,
    addressSnapshot: {
      fullName: 'Asha Rao',
      phone: '9876543210',
      email: 'asha@demo.in',
      line1: '12 Residency Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560025',
    },
    placedAt: new Date('2026-08-01T10:00:00.000Z'),
    estimatedDelivery: new Date('2026-08-04T10:00:00.000Z'),
    gstin: null,
    poNumber: null,
    items: [],
    events: [],
  } as unknown as Order;
}

/**
 * A query builder that records what was asked of it.
 *
 * The list's whole behaviour is the statement it builds — which predicates, which order, which
 * window — and none of that is visible in the rows a repository double hands back. Recording the
 * calls is what lets a dropped `addOrderBy` or a filter wired to the wrong column fail here rather
 * than only against Postgres.
 */
function queryBuilder(rows: Order[]) {
  const where: { clause: string; parameters: Record<string, unknown> }[] = [];
  const order: [string, string][] = [];
  const window: { skip?: number; take?: number } = {};
  const builder = {
    andWhere: (clause: string, parameters: Record<string, unknown>) => {
      where.push({ clause, parameters });
      return builder;
    },
    orderBy: (column: string, direction: string) => {
      order.push([column, direction]);
      return builder;
    },
    addOrderBy: (column: string, direction: string) => {
      order.push([column, direction]);
      return builder;
    },
    skip: (value: number) => {
      window.skip = value;
      return builder;
    },
    take: (value: number) => {
      window.take = value;
      return builder;
    },
    getManyAndCount: () => Promise.resolve<[Order[], number]>([rows, rows.length]),
  };
  return { builder, where, order, window };
}

function paymentRow(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1',
    orderId: 'ord-1',
    method: PaymentMethodEnum.COD,
    status: PaymentStatusEnum.PENDING,
    amountPaise: toPaise(1000),
    collectedAt: null,
    reference: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  } as unknown as Payment;
}

/**
 * The transaction's manager, recording what was written through it.
 *
 * `AuditLogService.record` takes the caller's open transaction and nothing else, so the assertion
 * that matters is not only *what* was recorded but *on which manager* — a mutation handing it the
 * `DataSource`'s own manager would still write a row and satisfy every assertion about its
 * contents. Only Postgres can prove the rollback; this proves the wiring.
 */
function transactionManager(order: Order | null, payment: Payment | null, affected = 1) {
  const updates: { entity: string; criteria: unknown; patch: unknown }[] = [];
  const saved: Record<string, unknown>[] = [];
  const manager = {
    getRepository: (entity: { name: string }) => ({
      findOne: () => Promise.resolve(entity.name === 'Payment' ? payment : order),
      update: (criteria: unknown, patch: unknown) => {
        updates.push({ entity: entity.name, criteria, patch });
        return Promise.resolve({ affected: entity.name === 'Payment' ? affected : 1 });
      },
      create: (row: Record<string, unknown>) => row,
      save: (row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ id: 'ship-1', ...row });
      },
    }),
  };
  return { manager, updates, saved };
}

function harness(
  found: Order | null = orderRow(),
  listed: Order[] = [],
  payment: Payment | null = paymentRow(),
  affected = 1,
  timezoneRow: { value: unknown } | null = { value: 'Asia/Kolkata' },
) {
  const built = queryBuilder(listed);
  /**
   * `list` reads `business.timezone` off the repository's own manager as of plan 9.4, so the mock
   * needs one. Added as **setup for a new precondition**, not as a change to what anything below
   * asserts: `businessTimezone` falls back to `Asia/Kolkata` for a null row, so passing `null` here
   * exercises a truncated `settings` table rather than a different timezone.
   */
  const settings = { findOne: jest.fn().mockResolvedValue(timezoneRow) };
  const orders = {
    findOne: jest.fn().mockResolvedValue(found),
    createQueryBuilder: jest.fn().mockReturnValue(built.builder),
    manager: { getRepository: jest.fn().mockReturnValue(settings) },
  };
  const payments = { findOne: jest.fn().mockResolvedValue(payment) };
  const shipments = { find: jest.fn().mockResolvedValue([] as Shipment[]) };
  const statuses = {
    transition: jest.fn().mockResolvedValue({ orderId: 'ord-1', from: 'packed', to: 'shipped' }),
  };
  const transaction = transactionManager(found, payment, affected);
  const dataSource = {
    transaction: <T>(run: (manager: unknown) => Promise<T>) => run(transaction.manager),
  };
  const audited: AuditLogInput[] = [];
  const audit = {
    record: (givenManager: unknown, input: AuditLogInput) => {
      audited.push(input);
      expect(givenManager).toBe(transaction.manager);
      return Promise.resolve();
    },
  };
  return {
    service: new AdminOrdersService(
      orders as never,
      payments as never,
      shipments as never,
      statuses as unknown as OrderStatusService,
      dataSource as never,
      audit,
    ),
    orders,
    payments,
    shipments,
    statuses,
    built,
    audited,
    updates: transaction.updates,
    saved: transaction.saved,
    manager: transaction.manager,
  };
}

describe('AdminOrdersService.setStatus', () => {
  /**
   * The three things this method contributes, and the assertion that it contributes nothing else:
   * the target, the actor and the audit request are handed to `transition`, which owns everything
   * about what a status change *does*.
   *
   * **`audit` is the load-bearing argument.** Without it `transition` writes no `audit_logs` row —
   * that is what keeps a customer's own cancellation out of the operator's trail — so an admin
   * route that forgot to ask would move the order silently, which spec §5 calls a defect in this
   * milestone. Nothing about the response would change.
   */
  it('asks for the transition, the actor and an audit row', async () => {
    const { service, statuses } = harness();

    await service.setStatus(ORDER_NUMBER, {
      status: 'shipped',
      note: 'Handed to the courier',
      actorUserId: ADMIN,
    });

    expect(statuses.transition).toHaveBeenCalledWith(ORDER_NUMBER, 'shipped', {
      actorUserId: ADMIN,
      note: 'Handed to the courier',
      restock: undefined,
      audit: { actorUserId: ADMIN },
    });
  });

  /**
   * Passed through untouched rather than defaulted. `TransitionOptions.restock` is deliberately
   * never inferred, and a service that filled in `?? false` here would make the DTO's `@ValidateIf`
   * pointless — the admin's stated decision and an omission would arrive identical again.
   */
  it('passes the restock decision through as the admin stated it', async () => {
    const kept = harness();
    await kept.service.setStatus(ORDER_NUMBER, {
      status: 'refunded',
      restock: false,
      actorUserId: ADMIN,
    });
    expect(kept.statuses.transition).toHaveBeenCalledWith(
      ORDER_NUMBER,
      'refunded',
      expect.objectContaining({ restock: false }),
    );

    const resold = harness();
    await resold.service.setStatus(ORDER_NUMBER, {
      status: 'refunded',
      restock: true,
      actorUserId: ADMIN,
    });
    expect(resold.statuses.transition).toHaveBeenCalledWith(
      ORDER_NUMBER,
      'refunded',
      expect.objectContaining({ restock: true }),
    );
  });

  /**
   * Read back after the transition, never patched in memory: `transition` writes through its own
   * transaction's manager and answers with a summary, so the timeline entry it just appended exists
   * only on a fresh read.
   */
  it('answers with the order as it now is, read back after the write', async () => {
    const { service, orders, statuses } = harness();

    const result = await service.setStatus(ORDER_NUMBER, { status: 'shipped', actorUserId: ADMIN });

    expect(statuses.transition).toHaveBeenCalled();
    expect(orders.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderNumber: ORDER_NUMBER } }),
    );
    expect(result.id).toBe(ORDER_NUMBER);
  });

  /**
   * **No owner clause, and that is the difference from `OrdersService`.** Its every read carries
   * `userId` in the `where` — spec §13's IDOR rule — and the console has no owner to scope to. The
   * assertion is that the admin read is by `orderNumber` *alone*, so a later edit that copied a
   * scoped read across would fail here rather than quietly return nothing for every order placed by
   * a guest.
   */
  it('reads by order number alone, with no owner clause', async () => {
    const { service, orders } = harness();

    await service.setStatus(ORDER_NUMBER, { status: 'shipped', actorUserId: ADMIN });

    const [options] = orders.findOne.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(Object.keys(options.where)).toEqual(['orderNumber']);
  });

  /**
   * The read-back's own refusal, which the detail route in Task 4 shares. Unreachable after a
   * committed transition — `transition` has already 404'd an order that does not exist — but the
   * helper is one function serving both, so the branch is exercised rather than left untested.
   */
  it('answers 404 in transition’s own words when the read-back finds nothing', async () => {
    const { service } = harness(null);

    await expect(
      service.setStatus(ORDER_NUMBER, { status: 'shipped', actorUserId: ADMIN }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  /** The refusals belong to `transition`; this method must not soften or re-wrap them. */
  it('lets the transition’s own refusal through unchanged', async () => {
    const { service, statuses } = harness();
    const refusal = Object.assign(new Error('illegal'), { code: 'ILLEGAL_STATUS_TRANSITION' });
    statuses.transition.mockRejectedValueOnce(refusal);

    await expect(
      service.setStatus(ORDER_NUMBER, { status: 'delivered', actorUserId: ADMIN }),
    ).rejects.toBe(refusal);
  });
});

describe('AdminOrdersService.list', () => {
  /**
   * Newest first, with a **total** tiebreak.
   *
   * `placedAt` is not unique: `orders.seed.ts` and every fixture write several orders in one
   * transaction, and Postgres's `now()` is transaction-start time, so a whole batch shares one
   * timestamp exactly. Without the second key a `LIMIT`/`OFFSET` window returns the same order on
   * two pages and loses another — and nothing about a single page would look wrong.
   */
  it('orders newest first and breaks ties on a unique column', async () => {
    const { service, built } = harness();

    await service.list({});

    expect(built.order).toEqual([
      ['o.placedAt', 'DESC'],
      ['o.orderNumber', 'DESC'],
    ]);
  });

  it('applies no predicate when nothing was asked for', async () => {
    const { service, built } = harness();

    await service.list({});

    expect(built.where).toEqual([]);
    expect(built.window).toEqual({ skip: 0, take: 24 });
  });

  /**
   * The channel goes through `orders.service.ts`'s shared `Record`, never `toUpperCase()`. That map
   * is checked in both directions against the wire union, so neither vocabulary can gain a member
   * alone — and a value that resolved to `undefined` would be *dropped* by TypeORM rather than
   * narrowing, answering with every channel instead of none.
   */
  it('filters by status, channel and both ends of the date range', async () => {
    const { service, built } = harness();

    await service.list({
      status: 'processing',
      channel: 'bulk',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });

    expect(built.where.map((entry) => entry.clause)).toEqual([
      'o.status = :status',
      'o.channel = :channel',
      'o.placedAt >= :from',
      'o.placedAt <= :to',
    ]);
    expect(built.where[1]?.parameters).toEqual({ channel: OrderChannelEnum.BULK });
    expect(built.where[2]?.parameters).toEqual({ from: new Date('2026-08-01T00:00:00.000Z') });
    expect(built.where[3]?.parameters).toEqual({ to: new Date('2026-08-31T23:59:59.999Z') });
  });

  /**
   * **A date-only bound is a day in the business's timezone; a full instant is not touched.** Spec
   * §5b, delivered by plan 9.4 in the same commit that moved `salesOverTime`.
   *
   * Asserted here at the clause level as well as end to end in
   * `business-timezone.integration.spec.ts`, because the two branches are easy to get half-right:
   * this pins that an instant still produces the plain `>= :from` comparison, so a console that
   * resolves its own ranges keeps getting exactly the bound it sent.
   *
   * The upper bound is a strict `<` on the following midnight rather than `<=` on 23:59:59.999 —
   * the same closed interval without a fencepost, since `placedAt` has microsecond resolution.
   */
  it('reads a date-only bound as a day in the business timezone', async () => {
    const { service, built } = harness();

    await service.list({ from: '2026-08-01', to: '2026-08-31' });

    expect(built.where.map((entry) => entry.clause)).toEqual([
      'o.placedAt >= (CAST(:from AS timestamp) AT TIME ZONE :fromZone)',
      "o.placedAt < ((CAST(:to AS timestamp) + INTERVAL '1 day') AT TIME ZONE :toZone)",
    ]);
    expect(built.where[0]?.parameters).toEqual({
      from: '2026-08-01',
      fromZone: 'Asia/Kolkata',
    });
    expect(built.where[1]?.parameters).toEqual({ to: '2026-08-31', toZone: 'Asia/Kolkata' });
  });

  /** One bound of each kind in one request: each is judged on its own shape. */
  it('mixes a date-only lower bound with an instant upper bound', async () => {
    const { service, built } = harness();

    await service.list({ from: '2026-08-01', to: '2026-08-31T18:29:59.999Z' });

    expect(built.where.map((entry) => entry.clause)).toEqual([
      'o.placedAt >= (CAST(:from AS timestamp) AT TIME ZONE :fromZone)',
      'o.placedAt <= :to',
    ]);
  });

  /**
   * A `settings` table with no `business.timezone` row groups days exactly as a seeded one does —
   * `businessTimezone`'s fallback, which is the same safety argument `SettingsService.FALLBACK`
   * makes about the payment flags.
   */
  it('falls back to Asia/Kolkata when the setting is missing', async () => {
    const { service, built } = harness(orderRow(), [], paymentRow(), 1, null);

    await service.list({ from: '2026-08-01' });

    expect(built.where[0]?.parameters).toEqual({ from: '2026-08-01', fromZone: 'Asia/Kolkata' });
  });

  /** A row holding something that is not a usable zone must not reach `AT TIME ZONE` at all. */
  it('falls back when the setting holds an unusable value', async () => {
    const { service, built } = harness(orderRow(), [], paymentRow(), 1, { value: 42 });

    await service.list({ from: '2026-08-01' });

    expect(built.where[0]?.parameters).toEqual({ from: '2026-08-01', fromZone: 'Asia/Kolkata' });
  });

  /** No date bound, no settings read: the timezone is only fetched when something needs it. */
  it('reads no setting when neither bound is given', async () => {
    const { service, orders } = harness();

    await service.list({ status: 'processing' });

    expect(orders.manager.getRepository).not.toHaveBeenCalled();
  });

  /** Clamped in the service as well as in the DTO, so a caller that bypasses the pipe cannot dump the table. */
  it('clamps the page window rather than trusting it', async () => {
    const { service, built } = harness();

    await service.list({ page: 3, limit: 500 });

    expect(built.window).toEqual({ skip: 120, take: 60 });
  });

  /**
   * The list loads no relations, so it must not go through `toAccountOrder` — which throws for an
   * order whose `items` and `events` are unloaded. A row with neither is exactly the row the query
   * returns, and mapping it is the assertion.
   */
  it('maps rows with no relations loaded, in brief §33’s columns', async () => {
    const row = orderRow();
    const { service } = harness(row, [row]);

    const page = await service.list({});

    expect(page).toEqual({
      items: [
        {
          id: ORDER_NUMBER,
          customer: {
            userId: 'user-1',
            name: 'Asha Rao',
            email: 'asha@demo.in',
            phone: '9876543210',
            businessId: null,
            companyName: null,
          },
          channel: 'retail',
          status: 'packed',
          total: 1000,
          paymentMethod: 'cod',
          paymentStatus: 'pending',
          placedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 24,
    });
  });
});

describe('AdminOrdersService.get', () => {
  it('answers the full order, customer included', async () => {
    const { service } = harness();

    const order = await service.get(ORDER_NUMBER);

    expect(order.id).toBe(ORDER_NUMBER);
    expect(order.customer).toMatchObject({ userId: 'user-1', name: 'Asha Rao' });
  });

  it('answers 404 for an order number nobody placed', async () => {
    const { service } = harness(null);

    await expect(service.get('NN-2026-999999')).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });
});

describe('AdminOrdersService.collectPayment', () => {
  it('moves the payment and the order’s denormalised copy in one transaction', async () => {
    const { service, updates } = harness();

    await service.collectPayment(ORDER_NUMBER, { reference: 'DLV-88213', actorUserId: ADMIN });

    expect(updates).toEqual([
      {
        entity: 'Payment',
        // Guarded on the status just read, so a concurrent collection reports 409 rather than
        // overwriting `collectedAt` and writing a second audit row.
        criteria: { id: 'pay-1', status: PaymentStatusEnum.PENDING },
        patch: {
          status: PaymentStatusEnum.COLLECTED,
          collectedAt: expect.any(Date) as unknown as Date,
          reference: 'DLV-88213',
        },
      },
      {
        entity: 'Order',
        criteria: { id: 'ord-1' },
        patch: { paymentStatus: PaymentStatusEnum.COLLECTED },
      },
    ]);
  });

  it('records the collection on the transaction’s own manager', async () => {
    const { service, audited } = harness();

    await service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN });

    expect(audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.PAYMENT_COLLECT,
        entityType: AuditEntity.PAYMENT,
        entityId: 'pay-1',
        before: { status: PaymentStatusEnum.PENDING },
        after: {
          status: PaymentStatusEnum.COLLECTED,
          orderNumber: ORDER_NUMBER,
          reference: null,
        },
      },
    ]);
  });

  /**
   * **The second call writes nothing at all — no update, no audit row.** Plan 9.1's rule, and it
   * matters more here than on an idempotent publish because this is a money fact: a second trail
   * entry saying cash was collected reads as a second collection, which is exactly the question the
   * trail exists to answer.
   */
  it('collects twice without double-counting and without a second audit row', async () => {
    const { service, updates, audited } = harness(
      orderRow(),
      [],
      paymentRow({ status: PaymentStatusEnum.COLLECTED }),
    );

    const result = await service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN });

    expect(updates).toEqual([]);
    expect(audited).toEqual([]);
    // Still the order, not an error: a double-clicked button must not need interpreting.
    expect(result.id).toBe(ORDER_NUMBER);
  });

  /**
   * A gateway payment moves to `COLLECTED` on a webhook. An admin button that could do it by hand
   * would be a way to mark an unpaid order paid — worth refusing now, while no `ONLINE` payment can
   * exist, rather than the day one can.
   */
  it('refuses to collect anything but COD by hand', async () => {
    const { service, updates } = harness(
      orderRow(),
      [],
      paymentRow({ method: PaymentMethodEnum.ONLINE }),
    );

    await expect(
      service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(updates).toEqual([]);
  });

  it('refuses to collect a payment that failed or was refunded', async () => {
    const { service } = harness(orderRow(), [], paymentRow({ status: PaymentStatusEnum.REFUNDED }));

    await expect(
      service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN }),
    ).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  /**
   * The gap between reading the status and writing it. Two operators collecting at once both read
   * `PENDING`; the second `UPDATE` re-checks its own `WHERE` against the committed row and matches
   * nothing. Without the guard it would overwrite `collectedAt` and write a second audit row — the
   * duplicate the idempotent return exists to prevent, arriving by another route.
   */
  it('reports a collection that raced another as 409, writing no audit row', async () => {
    const { service, audited } = harness(orderRow(), [], paymentRow(), 0);

    await expect(
      service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(audited).toEqual([]);
  });

  it('answers 404 for an order number nobody placed', async () => {
    const { service } = harness(null);

    await expect(
      service.collectPayment('NN-2026-999999', { actorUserId: ADMIN }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  /** Not a state placement can reach, but a fixture or a hand-run DELETE can. */
  it('answers 404 naming the order when it has no payment record', async () => {
    const { service } = harness(orderRow(), [], null);

    await expect(
      service.collectPayment(ORDER_NUMBER, { actorUserId: ADMIN }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });
});

describe('AdminOrdersService.createShipment', () => {
  /**
   * **The transition goes through `OrderStatusService` and shares the shipment's transaction.**
   * Both halves matter. A `status` write of its own would skip the `OrderEvent` the customer's
   * tracking page renders and the `order.shipped` notification brief §38 asks for, and neither
   * absence would fail any assertion about the response. A transition in a *separate* transaction
   * would leave an order marked shipped with nothing dispatched when the insert then failed.
   */
  it('moves the order to shipped through the status service, on its own transaction', async () => {
    const { service, statuses, manager } = harness();

    await service.createShipment(ORDER_NUMBER, {
      courier: 'Delhivery',
      trackingNumber: 'DL2894471104',
      actorUserId: ADMIN,
    });

    expect(statuses.transition).toHaveBeenCalledWith(ORDER_NUMBER, 'shipped', {
      manager,
      actorUserId: ADMIN,
      note: 'Dispatched via Delhivery (DL2894471104)',
      audit: { actorUserId: ADMIN },
    });
  });

  /**
   * `DISPATCHED`, not the column's `PENDING` default: the order says `shipped` in the same
   * transaction, and two records of one fact must not disagree.
   */
  it('records the dispatch against the order the transition resolved', async () => {
    const { service, saved } = harness();
    // `expect.any()` is typed `any`; an annotated `unknown` const keeps it usable inside `toEqual`.
    const aDate: unknown = expect.any(Date);

    await service.createShipment(ORDER_NUMBER, { courier: 'Delhivery', actorUserId: ADMIN });

    expect(saved).toEqual([
      {
        orderId: 'ord-1',
        courier: 'Delhivery',
        trackingNumber: null,
        status: ShipmentStatus.DISPATCHED,
        shippedAt: aDate,
        deliveredAt: null,
      },
    ]);
  });

  it('records the creation in the trail, on the transaction’s own manager', async () => {
    const { service, audited } = harness();

    await service.createShipment(ORDER_NUMBER, {
      courier: 'Delhivery',
      trackingNumber: 'DL2894471104',
      actorUserId: ADMIN,
    });

    expect(audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.SHIPMENT_CREATE,
        entityType: AuditEntity.SHIPMENT,
        entityId: 'ship-1',
        after: {
          orderNumber: ORDER_NUMBER,
          courier: 'Delhivery',
          trackingNumber: 'DL2894471104',
          status: ShipmentStatus.DISPATCHED,
        },
      },
    ]);
  });

  /**
   * The transition is attempted **first**, so an order that cannot legally reach `shipped` is
   * refused before anything is written. The reverse order would insert a shipment and roll it back,
   * which is the same outcome by luck rather than by design — and would put the refusal after a
   * write on the one path where the caller owns the transaction.
   */
  it('writes nothing when the order cannot legally ship', async () => {
    const { service, statuses, saved, audited } = harness();
    const refusal = Object.assign(new Error('illegal'), { code: 'ILLEGAL_STATUS_TRANSITION' });
    statuses.transition.mockRejectedValueOnce(refusal);

    await expect(
      service.createShipment(ORDER_NUMBER, { courier: 'Delhivery', actorUserId: ADMIN }),
    ).rejects.toBe(refusal);
    expect(saved).toEqual([]);
    expect(audited).toEqual([]);
  });
});
