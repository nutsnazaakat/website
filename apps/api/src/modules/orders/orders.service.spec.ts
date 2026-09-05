import { HttpStatus } from '@nestjs/common';
import { canTransition, nextStatuses, type OrderChannel, type OrderStatus } from '@nutwala/shared';
import type { Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import type { OrderEvent } from '../../entities/commerce/order-event.entity';
import type { OrderItem } from '../../entities/commerce/order-item.entity';
import type { AddressSnapshot, Order } from '../../entities/commerce/order.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../entities/enums';
import { toAccountOrder } from './mappers/order.mapper';
import type { OrderStatusService, TransitionOptions } from './order-status.service';
import { OrdersService } from './orders.service';

/**
 * Two customers and a guest, because every assertion in this file is about which of the three a row
 * belongs to.
 *
 * The uuids are distinct from the order numbers throughout, so a lookup keyed on the wrong column
 * misses rather than coincidentally matching — `orderNumber` and `id` are both `string` and the
 * compiler cannot tell them apart.
 */
const ASHA = 'f0000000-0000-4000-8000-00000000000a';
const RAKESH = 'f0000000-0000-4000-8000-00000000000b';

const RETAIL_SNAPSHOT: AddressSnapshot = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '12 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

/**
 * Two lines per order, stored **descending** by `id`.
 *
 * The stored sequence is deliberately the reverse of the wanted one: a query that forgets its
 * `ORDER BY` on the items relation returns exactly what the harness holds, so the assertion on line
 * order fails rather than passing on the arrangement the fixture happened to have. `order_items` has
 * no natural order in Postgres either, which is the whole reason the clause exists.
 */
const items = (orderNumber: string, orderId: string): OrderItem[] =>
  [
    {
      id: `${orderId}-item-2`,
      orderId,
      productSlug: 'w320-cashews',
      name: 'W320 Cashews',
      detail: '500g',
      size: '500g',
      grams: 500,
      kg: null,
      qty: 2,
      unitPricePaise: 59900n,
      lineTotalPaise: 119800n,
      gstRate: '5.00',
      gstAmountPaise: 5990n,
    },
    {
      id: `${orderId}-item-1`,
      orderId,
      productSlug: 'premium-california-almonds',
      name: `Premium California Almonds (${orderNumber})`,
      detail: '1kg',
      size: '1kg',
      grams: 1000,
      kg: null,
      qty: 1,
      unitPricePaise: 99900n,
      lineTotalPaise: 99900n,
      gstRate: '5.00',
      gstAmountPaise: 4995n,
    },
  ] as unknown as OrderItem[];

const events = (orderId: string, placedAt: string): OrderEvent[] =>
  [
    {
      id: `${orderId}-evt-2`,
      orderId,
      status: 'confirmed',
      note: 'Payment received.',
      actorUserId: null,
      createdAt: new Date(new Date(placedAt).getTime() + 120_000),
    },
    {
      id: `${orderId}-evt-1`,
      orderId,
      status: 'pending',
      note: null,
      actorUserId: null,
      createdAt: new Date(placedAt),
    },
  ] as unknown as OrderEvent[];

interface OrderSeed {
  orderNumber: string;
  userId: string | null;
  channel: OrderChannelEnum;
  placedAt: string;
  /**
   * Defaults to `confirmed`, which is what every read case above wants and what `cancel`'s happy
   * path needs — `RETAIL_TRANSITIONS` offers `cancelled` from `pending`, `confirmed`, `processing`
   * and `packed`. Overridden only by the cancel cases, which need an order the customer is *not*
   * allowed to cancel and cannot get one from a fixture where every row is cancellable.
   */
  status?: string;
}

const row = (seed: OrderSeed): Order => {
  const id = `ord-${seed.orderNumber}`;
  return {
    id,
    orderNumber: seed.orderNumber,
    userId: seed.userId,
    businessId: null,
    channel: seed.channel,
    status: seed.status ?? 'confirmed',
    paymentMethod: PaymentMethodEnum.COD,
    paymentStatus: PaymentStatusEnum.PENDING,
    subtotalPaise: 219700n,
    discountPaise: 0n,
    gstPaise: 10985n,
    shippingPaise: 0n,
    totalPaise: 230685n,
    couponCode: null,
    addressSnapshot: RETAIL_SNAPSHOT,
    billingSnapshot: null,
    companyName: null,
    gstin: null,
    poNumber: null,
    specialInstructions: null,
    placedAt: new Date(seed.placedAt),
    estimatedDelivery: new Date('2026-08-20T12:00:00.000Z'),
    cancelledAt: null,
    cancelReason: null,
    items: items(seed.orderNumber, id),
    events: events(id, seed.placedAt),
  } as unknown as Order;
};

/**
 * The seeded fixture's own shape: `b2c@demo.in` owns four retail orders, `b2b@demo.in` two bulk
 * ones — plus a **guest** order, which the seed does not have and this file needs.
 *
 * Stored in **ascending** `placedAt` and with the owners interleaved, both on purpose. Ascending
 * means a query with no `ORDER BY`, and a query ordered `ASC`, each return a sequence the newest-first
 * assertion rejects; interleaved means a query that lost its `userId` returns a list whose *order* is
 * plausible and whose *membership* is not, so the failure names the real problem.
 */
const ORDERS: readonly Order[] = [
  {
    orderNumber: 'NN-2026-004488',
    userId: RAKESH,
    channel: OrderChannelEnum.BULK,
    placedAt: '2026-06-24T05:10:00.000Z',
  },
  {
    orderNumber: 'NN-2026-004509',
    userId: null,
    channel: OrderChannelEnum.RETAIL,
    placedAt: '2026-07-01T09:15:00.000Z',
  },
  {
    orderNumber: 'NN-2026-004650',
    userId: ASHA,
    channel: OrderChannelEnum.RETAIL,
    placedAt: '2026-07-09T08:00:00.000Z',
  },
  {
    orderNumber: 'NN-2026-004821',
    userId: ASHA,
    channel: OrderChannelEnum.RETAIL,
    placedAt: '2026-07-28T10:02:00.000Z',
  },
  {
    orderNumber: 'NN-2026-004977',
    userId: ASHA,
    channel: OrderChannelEnum.RETAIL,
    placedAt: '2026-08-05T14:10:00.000Z',
  },
  {
    orderNumber: 'NN-2026-005042',
    userId: RAKESH,
    channel: OrderChannelEnum.BULK,
    placedAt: '2026-08-08T04:30:00.000Z',
  },
  {
    orderNumber: 'NN-2026-005107',
    userId: ASHA,
    channel: OrderChannelEnum.RETAIL,
    placedAt: '2026-08-12T05:20:00.000Z',
  },
].map(row);

const ASHA_NEWEST_FIRST = ['NN-2026-005107', 'NN-2026-004977', 'NN-2026-004821', 'NN-2026-004650'];
const RAKESH_NEWEST_FIRST = ['NN-2026-005042', 'NN-2026-004488'];
const EVERY_ORDER_NEWEST_FIRST = [
  'NN-2026-005107',
  'NN-2026-005042',
  'NN-2026-004977',
  'NN-2026-004821',
  'NN-2026-004650',
  'NN-2026-004509',
  'NN-2026-004488',
];

/**
 * One order in a named status, for the cancel cases only.
 *
 * Every row in `ORDERS` is `confirmed` and therefore cancellable, which is right for the reads and
 * useless for proving a refusal: an order that has shipped, an order already cancelled and an order
 * that has been delivered are the three the customer must be turned away from, and the seeded
 * fixture has none of them. Same builder, so these rows differ from the ones above in exactly one
 * column.
 */
const inStatus = (
  orderNumber: string,
  userId: string,
  channel: OrderChannelEnum,
  status: string,
): readonly Order[] => [
  row({ orderNumber, userId, channel, placedAt: '2026-08-12T05:20:00.000Z', status }),
];

type Direction = 'ASC' | 'DESC';
type FindOptions = {
  where?: Record<string, unknown>;
  relations?: Record<string, boolean>;
  order?: Record<string, unknown>;
};

const isDirection = (value: unknown): value is Direction => value === 'ASC' || value === 'DESC';

/**
 * `Array.isArray` on an `unknown` narrows to `any[]`, which throws away every check downstream.
 * Named here so the loaded relation arrives typed, per the convention `eslint.config.mjs` sets out.
 */
const isRowArray = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value);

/**
 * A repository double that actually applies the `where`, the `order` and the `relations` it is sent.
 *
 * `find: jest.fn().mockResolvedValue(ORDERS)` would make every assertion in this file vacuous: the
 * cross-customer case would pass while returning the whole table, and deleting `userId` from the
 * query would change nothing observable. This is the shape `pincode.service.spec.ts` and
 * `cart-read.service.spec.ts` both take, for the same reason.
 *
 * Three behaviours are modelled from TypeORM rather than invented, because the mutants this file has
 * to kill depend on them:
 *
 * - **`undefined` in a `where` is dropped, not compiled to anything.** Verified in
 *   `node_modules/typeorm/query-builder/SelectQueryBuilder.js:2496-2504`: the default
 *   `invalidWhereValuesBehavior.undefined` is `'ignore'` and this project configures no other, so the
 *   key disappears from the predicate. `null` has the same default two lines further down. That is
 *   what makes a guest guard written as `userId ?? undefined` return **everything** here, exactly as
 *   it would against Postgres — and it is why an absent channel filter is simply no clause.
 * - **An unloaded relation is `undefined`, not `[]`.** `Order.items` and `Order.events` are declared
 *   as non-optional arrays and TypeORM leaves them unset when `relations` does not ask for them, so
 *   projecting them away is what lets `toAccountOrder` be used below as the oracle for "the query
 *   loaded what the wire needs".
 * - **A `FindOperator` is refused rather than interpreted.** `IsNull()`, `In([...])` and friends are
 *   objects, and comparing one with `===` would quietly match nothing — a guest guard rewritten as
 *   `IsNull()` would then *look* correct here while returning every guest's orders against Postgres.
 *   The harness throws instead, so a query rewritten into a shape this file cannot interpret fails
 *   loudly. Same reason `pincode.service.spec.ts` refuses anything but the `In` it expects.
 */
function harness(rows: readonly Order[] = ORDERS) {
  /**
   * A per-test copy of the fixture, because `cancel` **writes**.
   *
   * `ORDERS` is a module-level constant, so a `transition` double that moved `status` on the shared
   * objects would leave the next test reading a cancelled order — and the leak would land on whichever
   * case happened to run second. Shallow is enough: nothing here mutates a line, and `project`
   * already hands the service a copy of the row it selects, which is why the double has to write to
   * *this* array for a re-read to see it at all.
   */
  const table: Order[] = rows.map((candidate) => ({ ...candidate }));

  const matches = (candidate: Order, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      // TypeORM drops both, so the harness drops both. See the note above.
      if (expected === undefined || expected === null) return true;
      if (typeof expected === 'object') {
        throw new Error(`harness: cannot interpret a FindOperator on "${key}"`);
      }
      if (!(key in candidate)) throw new Error(`harness: unsupported criterion "${key}"`);
      return (candidate as unknown as Record<string, unknown>)[key] === expected;
    });

  const compare = (left: unknown, right: unknown, direction: Direction): number => {
    const sign = direction === 'ASC' ? 1 : -1;
    if (left instanceof Date && right instanceof Date) {
      return sign * (left.getTime() - right.getTime());
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return sign * left.localeCompare(right);
    }
    throw new Error(`harness: cannot order values of type ${typeof left}`);
  };

  /** `relations` decides what is present; `order.items` decides the sequence within it. */
  const project = (candidate: Order, options: FindOptions): Order => {
    const projected = { ...candidate } as unknown as Record<string, unknown>;
    for (const relation of ['items', 'events'] as const) {
      if (options.relations?.[relation] !== true) delete projected[relation];
    }

    const itemOrder = options.order?.items;
    if (itemOrder !== undefined) {
      const loaded = projected.items;
      if (!isRowArray(loaded)) {
        throw new Error('harness: asked to order items that the query did not load');
      }
      const [first] = Object.entries(itemOrder as Record<string, unknown>);
      if (first === undefined) throw new Error('harness: an empty order on the items relation');
      const [key, direction] = first;
      if (!isDirection(direction)) {
        throw new Error(`harness: bad item direction "${String(direction)}"`);
      }
      projected.items = [...loaded].sort((left, right) =>
        compare(left[key], right[key], direction),
      );
    }

    return projected as unknown as Order;
  };

  const select = (options: FindOptions): Order[] => {
    const found = table.filter((candidate) => matches(candidate, options.where ?? {}));
    for (const [key, direction] of Object.entries(options.order ?? {})) {
      if (key === 'items' || key === 'events') continue;
      if (!isDirection(direction)) throw new Error(`harness: unsupported order on "${key}"`);
      found.sort((left, right) =>
        compare(
          (left as unknown as Record<string, unknown>)[key],
          (right as unknown as Record<string, unknown>)[key],
          direction,
        ),
      );
    }
    return found.map((candidate) => project(candidate, options));
  };

  const find = jest.fn((options: FindOptions) => Promise.resolve(select(options)));
  const findOne = jest.fn((options: FindOptions) => Promise.resolve(select(options)[0] ?? null));

  /**
   * `OrderStatusService.transition`, doubled as the thing it is rather than as a resolved promise.
   *
   * A `jest.fn().mockResolvedValue(...)` would make every cancel assertion below vacuous: the
   * returned order's status would still be `confirmed`, so a `cancel` that skipped its re-read and
   * handed back the row it had already loaded would pass, and a `cancel` that cheerfully cancelled a
   * `shipped` order would too. So this double does the three things the real service does that
   * `OrdersService` depends on — refuse an illegal move with the same `DomainError` shape, move the
   * status, and append the event — and it decides legality by calling `@nutwala/shared`'s
   * `canTransition`, which is the real rule rather than a second copy of it. Everything else about
   * `transition` (the guarded `UPDATE`, the stock consequence, the ledger row, the one transaction) is
   * `order-status.service.spec.ts`'s and the integration suite's to prove; this file is about what
   * `OrdersService` asks for and what it does with the answer.
   */
  const transition = jest.fn(
    (orderNumber: string, to: OrderStatus, options: TransitionOptions = {}) => {
      const found = table.find((candidate) => candidate.orderNumber === orderNumber);
      if (found === undefined) {
        return Promise.reject(
          new DomainError(ErrorCodes.NOT_FOUND, `No order ${orderNumber}.`, HttpStatus.NOT_FOUND, {
            orderNumber,
          }),
        );
      }

      const channel: OrderChannel = found.channel === OrderChannelEnum.BULK ? 'bulk' : 'retail';
      const from = found.status as OrderStatus;
      if (!canTransition(channel, from, to)) {
        return Promise.reject(
          new DomainError(
            ErrorCodes.ILLEGAL_STATUS_TRANSITION,
            `An order that is "${from}" cannot become "${to}".`,
            HttpStatus.UNPROCESSABLE_ENTITY,
            { orderNumber, from, to, allowed: nextStatuses(channel, from) },
          ),
        );
      }

      found.status = to;
      found.events = [
        ...found.events,
        {
          id: `${found.id}-evt-${String(found.events.length + 1)}`,
          orderId: found.id,
          status: to,
          note: options.note ?? null,
          actorUserId: options.actorUserId ?? null,
          createdAt: new Date('2026-08-21T00:00:00.000Z'),
        } as unknown as OrderEvent,
      ];
      return Promise.resolve({ orderId: found.id, orderNumber, from, to, restored: [] });
    },
  );

  return {
    service: new OrdersService(
      { find, findOne } as unknown as Repository<Order>,
      { transition } as unknown as OrderStatusService,
    ),
    find,
    findOne,
    transition,
    /** The row as the harness now holds it, so a test can see what the write left behind. */
    stored: (orderNumber: string): Order | undefined =>
      table.find((candidate) => candidate.orderNumber === orderNumber),
    /**
     * The same selection path with whatever `where` the caller names, so a test can show what the
     * mutant would answer instead of asserting that it would. `unscoped({})` is literally "give
     * `list` an empty `where`", which is the mutation the task asks to be proved load-bearing.
     */
    unscoped: (options: FindOptions) => select(options),
  };
}

const numbers = (found: readonly Order[]): string[] => found.map((order) => order.orderNumber);

/**
 * Narrows away the `undefined` that `noUncheckedIndexedAccess` insists on, and fails with a sentence
 * rather than with a `TypeError` on the following line.
 *
 * Plan 2 found a scoping test that failed on `this.items.find is not a function` — a green light for
 * the wrong reason, because the next reader cannot tell a scoping bug from a fixture that forgot a
 * relation. A named message is the difference.
 */
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

describe('OrdersService.list', () => {
  /**
   * The scoping assertion, and the reason this service exists. Spec §13: history is scoped by
   * `userId` from the session and by nothing else.
   *
   * Compared against the *whole* expected list rather than a length or a `some`, and against the
   * table's full contents on the third line: a query that dropped `userId` returns seven orders in a
   * perfectly plausible newest-first sequence, and only a whole-list comparison says which of the two
   * things went wrong.
   */
  it('returns only the caller’s own orders, newest first', async () => {
    const { service } = harness();

    expect(numbers(await service.list(ASHA))).toEqual(ASHA_NEWEST_FIRST);
    expect(numbers(await service.list(RAKESH))).toEqual(RAKESH_NEWEST_FIRST);
  });

  /**
   * What the missing clause answers, stated rather than left to imagination.
   *
   * Deleting `userId` from the `where` does not make `list` throw or return nothing — it returns all
   * seven orders in a flawless newest-first sequence, one customer's history interleaved with
   * another's and with a guest's. This asserts the harness really is capable of producing that, which
   * is what makes the test above a measurement of the query rather than of the fixture: without it,
   * "asha has four orders" is equally consistent with a table that only holds four.
   */
  it('would answer with the whole table if the owner clause went missing', () => {
    const { unscoped } = harness();

    expect(numbers(unscoped({ where: {}, order: { placedAt: 'DESC' } }))).toEqual(
      EVERY_ORDER_NEWEST_FIRST,
    );
    expect(EVERY_ORDER_NEWEST_FIRST).not.toEqual(ASHA_NEWEST_FIRST);
  });

  /**
   * Both directions of the channel filter, because one of them is unfalsifiable on its own.
   *
   * Every one of a customer's seeded orders is the same channel — `b2c@demo.in`'s four are all
   * `RETAIL`, `b2b@demo.in`'s two all `BULK` — so `list(asha, { channel: 'retail' })` returns four
   * *with the filter deleted*. Asserting the empty direction is what makes the clause observable, and
   * asserting both is what catches a `Record` written the wrong way round: an inverted
   * wire-to-enum map swaps the two answers and passes neither.
   */
  it('filters by channel in both directions, so the clause is observable', async () => {
    const { service } = harness();

    expect(numbers(await service.list(ASHA, { channel: 'retail' }))).toEqual(ASHA_NEWEST_FIRST);
    expect(numbers(await service.list(ASHA, { channel: 'bulk' }))).toEqual([]);
    expect(numbers(await service.list(RAKESH, { channel: 'bulk' }))).toEqual(RAKESH_NEWEST_FIRST);
    expect(numbers(await service.list(RAKESH, { channel: 'retail' }))).toEqual([]);
  });

  /**
   * A guest has no history, and the guard is a return rather than a clause.
   *
   * The second assertion is the load-bearing half, because `[]` is reachable by two wrong routes as
   * well as by the right one. `where: { userId: userId ?? undefined }` compiles and answers with the
   * **whole table** — TypeORM drops an `undefined` criterion — which `toEqual([])` alone would catch;
   * `where: { userId: IsNull() }` compiles too and answers with every guest order ever placed, which
   * `toEqual([])` would *not* catch against Postgres. Asserting that the repository was never asked
   * is what pins the early return against both. (`where: { userId: null }`, the spelling a reader
   * reaches for first, does not compile at all — `FindOptionsWhere` runs the column through
   * `NonNullable`.)
   */
  it('answers nothing for a guest, without querying at all', async () => {
    const { service, find } = harness();

    // Compared as order numbers, so the mutant's failure is a readable list of the seven rows it
    // leaked rather than 590 lines of entity.
    expect(numbers(await service.list(null))).toEqual([]);
    expect(find).not.toHaveBeenCalled();
    // And the table is not empty of guest orders, so "nothing" is a decision rather than a vacuum.
    expect(ORDERS.filter((order) => order.userId === null)).toHaveLength(1);
  });

  /**
   * `GET /account/orders` answers `AccountOrder[]` — the same shape as the detail route, because the
   * account list renders items and a status. `toAccountOrder` **throws** on an order whose `items` or
   * `events` are unloaded, so it is used here as the oracle rather than asserting on `relations`
   * directly: this fails if the list query stops loading either relation, and it fails in the mapper's
   * own words.
   */
  it('loads the relations the wire shape needs', async () => {
    const { service } = harness();

    const newest = present((await service.list(ASHA))[0], 'the newest order');

    const mapped = toAccountOrder(newest);
    expect(mapped.id).toBe('NN-2026-005107');
    expect(mapped.items).toHaveLength(2);
    expect(mapped.timeline.map((entry) => entry.status)).toEqual(['pending', 'confirmed']);
  });

  /** The list's lines are ordered too — `order_items` has no natural sequence on either route. */
  it('orders every order’s lines, not just the detail route’s', async () => {
    const { service } = harness();

    const found = await service.list(ASHA);

    for (const order of found) {
      expect(order.items.map((item) => item.id)).toEqual([
        `${order.id}-item-1`,
        `${order.id}-item-2`,
      ]);
    }
  });
});

describe('OrdersService.findOne', () => {
  /** The happy path, with the lines in a sequence the fixture stores backwards. */
  it('returns the caller’s order with its lines in a stable order', async () => {
    const { service } = harness();

    const found = present(await service.findOne(ASHA, 'NN-2026-004821'), 'order NN-2026-004821');

    expect(found.orderNumber).toBe('NN-2026-004821');
    expect(found.items.map((item) => item.id)).toEqual([
      'ord-NN-2026-004821-item-1',
      'ord-NN-2026-004821-item-2',
    ]);
    // Through the mapper as well, because that is the sequence the invoice prints.
    expect(toAccountOrder(found).items.map((line) => line.name)).toEqual([
      'Premium California Almonds (NN-2026-004821)',
      'W320 Cashews',
    ]);
  });

  /**
   * Spec §13's IDOR row. Another customer's order number is indistinguishable from an order number
   * that does not exist, and that is asserted as an *equality between the two answers* rather than as
   * two separate nulls — because the property is "the endpoint is not an oracle", not "this lookup
   * missed".
   *
   * A 403 for the first and a 404 for the second would confirm the order exists, and order numbers
   * are sequential, so a walk of the range would enumerate the shop's volume and every reference in
   * it. The customer cannot act on the difference and does not get it.
   */
  it('cannot tell a stranger’s order from one that does not exist', async () => {
    const { service } = harness();

    const stranger = await service.findOne(RAKESH, 'NN-2026-004821');
    const absent = await service.findOne(RAKESH, 'NN-2026-999999');

    expect(stranger).toBeNull();
    expect(stranger).toEqual(absent);
    // The positive control: the order is really there, and its owner really can read it.
    expect(await service.findOne(ASHA, 'NN-2026-004821')).not.toBeNull();
  });

  /**
   * The owner is a clause in the query, not a test applied afterwards.
   *
   * This is the one structural assertion in the file, and it is here because the two implementations
   * are **behaviourally identical**: `findOne({ where: { orderNumber } })` followed by
   * `if (order.userId !== userId) return null` answers exactly as the test above expects. What
   * separates them is what a later refactor leaves behind — deleting the post-hoc `if` leaves a
   * working lookup that returns other people's orders, while a `where` that lost `userId` returns the
   * wrong row on the next test run. No black-box assertion can see that difference, so this one looks
   * at the query.
   */
  it('puts the owner inside the query rather than checking it afterwards', async () => {
    const { service, findOne } = harness();

    await service.findOne(ASHA, 'NN-2026-004821');

    expect(findOne).toHaveBeenCalledTimes(1);
    const [options] = present(findOne.mock.calls[0], 'the recorded findOne call');
    expect(options.where).toEqual({ userId: ASHA, orderNumber: 'NN-2026-004821' });
  });

  /**
   * `orderNumber`, not `id`. §6.3's route is `/account/orders/:orderNumber`, the column carries
   * `uq_orders_order_number`, and `AccountOrder` has no field for the uuid at all — so a lookup on the
   * primary key would be a second identifier for one thing, and the fixture keeps the two values
   * distinct so the mistake cannot pass by coincidence.
   */
  it('looks the order up by its number and not by its primary key', async () => {
    const { service } = harness();

    expect(await service.findOne(ASHA, 'ord-NN-2026-004821')).toBeNull();
  });

  /** Same guard as `list`, and it has to be: a dropped `null` would hand any guest any order. */
  it('answers nothing for a guest, without querying at all', async () => {
    const { service, findOne } = harness();

    expect(await service.findOne(null, 'NN-2026-004509')).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  /** The detail route's own relation load, proved by the mapper that refuses to work without it. */
  it('loads items and events, which the mapper refuses to do without', async () => {
    const { service } = harness();

    const found = present(await service.findOne(ASHA, 'NN-2026-005107'), 'order NN-2026-005107');

    expect(() => toAccountOrder(found)).not.toThrow();
    expect(toAccountOrder(found).timeline).toHaveLength(2);
  });
});

/**
 * `cancel` is this service's only write, and everything it does to stock, to the ledger and to the
 * `orders` row itself belongs to `OrderStatusService.transition`. So the cases below are about the
 * two things `OrdersService` adds and nothing else: **whose order it is**, and **which transition a
 * customer is allowed to ask for**.
 *
 * The stock consequence — `onHand` back up and a compensating `CANCELLATION` ledger row — is
 * deliberately not asserted here and cannot be: `putStockBack` is a raw data-modifying CTE whose
 * whole defect class only exists against a real driver. It shipped broken through 458 passing unit
 * tests, because the doubles answered `[{ onHand }]` while TypeORM's Postgres driver answers
 * `[rows, rowCount]` for a bare `UPDATE`. `orders.integration.spec.ts` is where that is pinned.
 */
describe('OrdersService.cancel', () => {
  /**
   * The happy path, and the assertion that separates a real re-read from the row the method already
   * had in its hand.
   *
   * `cancel` loads the order once to establish ownership, transitions it, and loads it **again**. A
   * version that returned the first read instead — the obvious simplification, one line shorter —
   * answers a `status` of `confirmed` and a timeline with no cancellation in it, so the customer's
   * page re-renders showing the order they just cancelled as still live. Mapped through
   * `toAccountOrder` as well, because that is the body the route sends and the mapper *throws* on an
   * order whose relations were not loaded — so this doubles as the proof that the second read asks
   * for them.
   */
  it('cancels the caller’s own order and answers with the order as it now stands', async () => {
    const { service } = harness();

    const cancelled = present(
      await service.cancel(ASHA, 'NN-2026-004821'),
      'the cancelled order NN-2026-004821',
    );

    expect(cancelled.status).toBe('cancelled');
    const mapped = toAccountOrder(cancelled);
    expect(mapped.id).toBe('NN-2026-004821');
    expect(mapped.status).toBe('cancelled');
    // Oldest first, with the cancellation last — `OrderTimeline.tsx` renders the final entry as the
    // current step, so an order whose history ends anywhere else shows the wrong step confidently.
    expect(mapped.timeline.map((entry) => entry.status)).toEqual([
      'pending',
      'confirmed',
      'cancelled',
    ]);
  });

  /**
   * **`'cancelled'`, hardcoded, and nothing else in the call.**
   *
   * `RETAIL_TRANSITIONS` allows `delivered -> refunded` and `canTransition` would approve it, so a
   * target status taken from the request would make `POST .../cancel` an admin endpoint with a
   * misleading name — a customer refunding themselves. There is no parameter for it to arrive
   * through, and this is the assertion that says so: the whole argument list is compared, so a third
   * argument that grew a `to`, or a `note` inventing a reason on the customer's behalf, fails here.
   */
  it('asks for the cancelled transition and passes the customer as the actor', async () => {
    const { service, transition } = harness();

    await service.cancel(ASHA, 'NN-2026-004821');

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith('NN-2026-004821', 'cancelled', { actorUserId: ASHA });
  });

  /**
   * The `OrderEvent`'s `actorUserId` is the customer, and the two earlier events are the control.
   *
   * Unlike placement's first event — system-generated, `actorUserId: null` — a cancellation *was*
   * performed by someone, and the timeline an admin reads has to say who. `actorUserId: null` here
   * typechecks perfectly and loses the only record of it.
   */
  it('writes the cancellation event against the customer who asked for it', async () => {
    const { service, stored } = harness();

    await service.cancel(ASHA, 'NN-2026-004821');

    const events = present(stored('NN-2026-004821'), 'the stored order').events;
    expect(events.at(-1)?.status).toBe('cancelled');
    expect(events.at(-1)?.actorUserId).toBe(ASHA);
    // The events that were already there carry no actor, so "the customer" is a value this write
    // supplied rather than something the fixture had lying around.
    expect(events.slice(0, -1).map((event) => event.actorUserId)).toEqual([null, null]);
  });

  /**
   * Spec §13, on the write. **Another customer's order number cancels nothing and is not even
   * attempted.**
   *
   * `transition()` looks an order up by `orderNumber` alone — correct for the admin console, wrong
   * for a customer — so the owner clause in `findOne` is the only thing standing between a walked
   * order number and someone else's order being destroyed. `toHaveBeenCalledTimes(0)` is the
   * load-bearing half: an implementation that transitioned first and checked ownership afterwards
   * would answer `null` here too, having already cancelled the order and put its stock back.
   */
  it('refuses another customer’s order without attempting the transition', async () => {
    const { service, transition, stored } = harness();

    expect(await service.cancel(RAKESH, 'NN-2026-004821')).toBeNull();

    expect(transition).not.toHaveBeenCalled();
    expect(present(stored('NN-2026-004821'), 'the stored order').status).toBe('confirmed');
    // The positive control: the order is really there and its owner really can cancel it, so the
    // refusal above is about ownership and not about a lookup that misses for everyone.
    expect(await service.cancel(ASHA, 'NN-2026-004821')).not.toBeNull();
  });

  /**
   * The same `null` for a stranger's order and for one that never existed, asserted as an equality
   * between the two answers rather than as two separate nulls — the property is "this route is not an
   * existence oracle", and order numbers are sequential enough to walk.
   */
  it('cannot tell a stranger’s order from one that does not exist', async () => {
    const { service } = harness();

    const strangers = await service.cancel(RAKESH, 'NN-2026-004821');
    const absent = await service.cancel(RAKESH, 'NN-2026-999999');

    expect(strangers).toBeNull();
    expect(strangers).toEqual(absent);
  });

  /**
   * A guest cancels nothing, and the guard is `findOne`'s own early return rather than a second copy
   * of it here.
   *
   * Both halves matter. The first is that no query is issued at all — `where: { userId: undefined }`
   * would be *dropped* by TypeORM and match the order by number alone, handing any anonymous caller
   * any order to cancel, which is the same hazard as the reads with a write on the end of it. The
   * second is that a signed-in customer cannot cancel a *guest's* order either: `user_id IS NULL` is
   * a predicate every guest order shares, so it belongs to nobody who can act on it.
   */
  it('answers nothing for a guest, and never reaches the status service', async () => {
    const { service, findOne, transition } = harness();

    expect(await service.cancel(null, 'NN-2026-004509')).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();

    expect(await service.cancel(ASHA, 'NN-2026-004509')).toBeNull();
    expect(transition).not.toHaveBeenCalled();
    // And that order is genuinely in the table, so "nothing" is a decision rather than a vacuum.
    expect(ORDERS.filter((order) => order.userId === null)).toHaveLength(1);
  });

  /**
   * **A shipped order cannot be cancelled, and the 422 names what is possible instead.**
   *
   * After dispatch the goods are with a courier and the correct action is a return, so
   * `RETAIL_TRANSITIONS` offers `cancelled` only from `pending`, `confirmed`, `processing` and
   * `packed`. The refusal carries `allowed` — `nextStatuses(channel, from)` — because a UI that can
   * say "this one is out for delivery next" is useful and one that can only say "no" is not.
   *
   * The row is asserted untouched afterwards: §10.3's "not a silent write" means the 422 costs the
   * order nothing, not even an event.
   */
  it('refuses to cancel a shipped order with a 422 that names what is allowed', async () => {
    const { service, stored } = harness(
      inStatus('NN-2026-005107', ASHA, OrderChannelEnum.RETAIL, 'shipped'),
    );

    const failure = await service.cancel(ASHA, 'NN-2026-005107').catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((failure as DomainError).code).toBe('ILLEGAL_STATUS_TRANSITION');
    expect((failure as DomainError).details).toEqual({
      orderNumber: 'NN-2026-005107',
      from: 'shipped',
      to: 'cancelled',
      allowed: ['out-for-delivery'],
    });
    const order = present(stored('NN-2026-005107'), 'the stored order');
    expect(order.status).toBe('shipped');
    expect(order.events).toHaveLength(2);
  });

  /**
   * **A customer may cancel; a customer may not refund** — the rule stated as behaviour rather than
   * as a call signature.
   *
   * `delivered` is the one retail status with a forward move that a customer must not be able to
   * make: `RETAIL_TRANSITIONS.delivered` is `['refunded']`, so a route that read its target from the
   * request, or reached for `nextStatuses(...)[0]` to be helpful, would refund a delivered order on a
   * request called *cancel* — a money movement the customer authorised nothing about. The refusal
   * names `refunded` as the thing that *is* available, which is exactly the information an admin
   * needs and a customer cannot act on themselves.
   */
  it('will not refund a delivered order through the cancel path', async () => {
    const { service, stored } = harness(
      inStatus('NN-2026-004821', ASHA, OrderChannelEnum.RETAIL, 'delivered'),
    );

    const failure = await service.cancel(ASHA, 'NN-2026-004821').catch((thrown: unknown) => thrown);

    // `toBeInstanceOf` first, so a mutant that *succeeds* here — the whole point of the case — fails
    // on "expected a DomainError, received an Order" rather than on `getStatus is not a function`,
    // which reads like a broken assertion instead of a refunded order.
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((failure as DomainError).details).toMatchObject({
      from: 'delivered',
      to: 'cancelled',
      allowed: ['refunded'],
    });
    expect(present(stored('NN-2026-004821'), 'the stored order').status).toBe('delivered');
  });

  /**
   * **Cancelling twice is a 422, not a second event** — and it falls out of `canTransition` refusing
   * a no-op rather than out of anything written here.
   *
   * The point of the case is the mutant it kills: an early return like
   * `if (owned.status === 'cancelled') return owned;` reads like a courtesy, answers **200** to the
   * second click, and quietly makes the endpoint idempotent-looking while `transition`'s guarded
   * `UPDATE` — the thing that stops a double cancellation restocking twice — never runs. The event
   * count is asserted for the same reason: three, not four.
   */
  it('refuses a second cancellation with a 422 and appends no second event', async () => {
    const { service, stored } = harness();

    await service.cancel(ASHA, 'NN-2026-004821');
    const failure = await service.cancel(ASHA, 'NN-2026-004821').catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((failure as DomainError).details).toMatchObject({
      from: 'cancelled',
      to: 'cancelled',
      // Terminal, so there is nothing left to offer — which is itself the answer.
      allowed: [],
    });
    expect(present(stored('NN-2026-004821'), 'the stored order').events).toHaveLength(3);
  });

  /**
   * **A bulk order can never be cancelled by its customer, and that is `BULK_TRANSITIONS` speaking,
   * not a rule this service invents.**
   *
   * §33's B2B ladder has no `cancelled` in it at all — a quoted, approved consignment is unwound by
   * agreement, not by a button — so the refusal here is the same 422 with `processing` named as the
   * only available move. Worth its own case because the channel comes from the *row* inside
   * `transition`: a caller-supplied channel would let a bulk order be judged against the retail
   * ladder, and this is the assertion that a business customer cannot reach that.
   */
  it('refuses a bulk order, because the bulk ladder has no cancelled state', async () => {
    const { service } = harness(
      inStatus('NN-2026-005042', RAKESH, OrderChannelEnum.BULK, 'approved'),
    );

    const failure = await service
      .cancel(RAKESH, 'NN-2026-005042')
      .catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((failure as DomainError).details).toMatchObject({
      from: 'approved',
      to: 'cancelled',
      allowed: ['processing'],
    });
  });
});
