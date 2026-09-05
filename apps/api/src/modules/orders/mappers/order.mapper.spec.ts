import { B2B_ORDER_STATUSES, B2C_ORDER_STATUSES } from '@nutwala/shared';
import type { OrderEvent } from '../../../entities/commerce/order-event.entity';
import type { OrderItem } from '../../../entities/commerce/order-item.entity';
import type { AddressSnapshot, Order } from '../../../entities/commerce/order.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../../entities/enums';
import { toAccountOrder } from './order.mapper';

/**
 * The uuid primary key, kept distinct from the order number in every fixture on purpose. Mapping
 * `order.id` instead of `order.orderNumber` typechecks — both are `string` — so the only thing that
 * can tell the two apart is a fixture where they differ.
 */
const ORDER_UUID = '3f1a9b7c-0000-4000-8000-000000000001';
const ORDER_NUMBER = 'NN-2026-005107';

const RETAIL_SNAPSHOT: AddressSnapshot = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

const event = (status: string, at: string, note: string | null = null): OrderEvent =>
  ({
    id: `evt-${status}`,
    orderId: ORDER_UUID,
    status,
    note,
    actorUserId: null,
    createdAt: new Date(at),
  }) as unknown as OrderEvent;

const item = (overrides: Partial<OrderItem> = {}): OrderItem =>
  ({
    id: '9a2c1d44-0000-4000-8000-000000000001',
    orderId: ORDER_UUID,
    productSlug: 'roasted-makhana',
    name: 'Roasted Makhana',
    detail: '250g',
    size: '250g',
    grams: 250,
    kg: null,
    qty: 3,
    unitPricePaise: 29900n,
    lineTotalPaise: 89700n,
    gstRate: '5.00',
    gstAmountPaise: 4485n,
    ...overrides,
  }) as unknown as OrderItem;

/**
 * A stored order. Every money figure is a **distinct** paise value, so a field mapped from its
 * neighbour — gst from shipping, subtotal from total — is a failed assertion rather than a
 * coincidence, and none of them is a whole number of rupees by accident.
 */
const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: ORDER_UUID,
    orderNumber: ORDER_NUMBER,
    userId: 'f0000000-0000-4000-8000-000000000001',
    businessId: null,
    channel: OrderChannelEnum.RETAIL,
    status: 'out-for-delivery',
    paymentMethod: PaymentMethodEnum.COD,
    paymentStatus: PaymentStatusEnum.PENDING,
    subtotalPaise: 123456n,
    discountPaise: 10000n,
    gstPaise: 6173n,
    shippingPaise: 7900n,
    totalPaise: 127529n,
    couponCode: null,
    addressSnapshot: RETAIL_SNAPSHOT,
    billingSnapshot: null,
    companyName: null,
    gstin: null,
    poNumber: null,
    specialInstructions: null,
    placedAt: new Date('2026-08-12T05:20:00.000Z'),
    estimatedDelivery: new Date('2026-08-15T12:00:00.000Z'),
    cancelledAt: null,
    cancelReason: null,
    items: [item()],
    events: [event('pending', '2026-08-12T05:20:00.000Z')],
    ...overrides,
  }) as unknown as Order;

describe('toAccountOrder', () => {
  /**
   * `AccountOrder.id` is documented as `` `NN-{year}-{6 digits}` `` and `Order` carries both keys, so
   * this is the assertion that stops the uuid being sent instead. The second half matters as much as
   * the first: `AccountOrder` has **no** field for the uuid, deliberately, because every
   * customer-facing route — the order-success URL, `GET /account/orders/:orderNumber`, Task 20's
   * cancel — is keyed by the human-readable number. Asserted over the serialised response rather
   * than field by field, because "the uuid is nowhere" is a claim about the whole object.
   */
  it('names the order by its number, and never leaks the primary key', () => {
    const mapped = toAccountOrder(order());

    expect(mapped.id).toBe(ORDER_NUMBER);
    expect(JSON.stringify(mapped)).not.toContain(ORDER_UUID);
  });

  /**
   * `orders` has no email column and `user_id` is nullable, because guest checkout is supported — so
   * the snapshot is the only source that answers for a guest, which is the customer who most needs
   * the order to be readable. The fixture gives the order a `userId` as well, so an implementation
   * reaching for `order.user.email` would have somewhere plausible to reach.
   */
  it('takes the email from the address snapshot, which is the only place it lives', () => {
    expect(toAccountOrder(order()).email).toBe('b2c@demo.in');
    expect(
      toAccountOrder(
        order({
          userId: null,
          addressSnapshot: { ...RETAIL_SNAPSHOT, email: 'guest@example.com' },
        }),
      ).email,
    ).toBe('guest@example.com');
  });

  /**
   * Paise to rupees, in that direction, for all five figures independently.
   *
   * A wrong direction is not a rounding difference: 123456 paise is ₹1,234.56, and multiplying
   * instead would bill ₹12,34,56,00. The figures are all distinct and none is a round rupee, so a
   * transposed pair and a hand-rolled `* 100` both fail here rather than agreeing by luck.
   */
  it('converts every money field from paise to rupees', () => {
    expect(toAccountOrder(order())).toMatchObject({
      subtotal: 1234.56,
      discount: 100,
      gst: 61.73,
      shipping: 79,
      total: 1275.29,
    });
  });

  /** A sub-rupee figure, where a division and a multiplication cannot possibly be confused. */
  it('keeps a figure smaller than a rupee smaller than a rupee', () => {
    expect(toAccountOrder(order({ gstPaise: 1n })).gst).toBe(0.01);
  });

  it('converts a line total to rupees and carries the slug that makes the name a link', () => {
    expect(toAccountOrder(order()).items).toEqual([
      {
        slug: 'roasted-makhana',
        name: 'Roasted Makhana',
        detail: '250g',
        qty: 3,
        total: 897,
      },
    ]);
  });

  /**
   * A quote line has no price to bill, and `null` is what the page renders as *Quote Required*.
   * `toRupees(null)` is `Number(null) / 100` — a confident ₹0 against goods that were quoted.
   */
  it('leaves a quoted line without a total rather than pricing it at zero', () => {
    expect(toAccountOrder(order({ items: [item({ lineTotalPaise: null })] })).items[0]?.total).toBe(
      null,
    );
  });

  /**
   * The asymmetry the whole file exists for. `channel` and `paymentMethod`/`paymentStatus` are
   * `UPPERCASE` Postgres enums that must be lowered; `status` is a `varchar(24)` already holding the
   * wire value and must be passed through untouched. Getting either backwards ships a value that
   * every `Record<OrderStatus, …>` lookup in `features/account/status.ts` misses, which renders an
   * empty badge rather than an error.
   */
  it('lowers the enum vocabularies and leaves the status vocabulary alone', () => {
    expect(toAccountOrder(order())).toMatchObject({
      channel: 'retail',
      status: 'out-for-delivery',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
    });

    expect(
      toAccountOrder(
        order({
          channel: OrderChannelEnum.BULK,
          status: 'quote-requested',
          paymentMethod: PaymentMethodEnum.ONLINE,
          paymentStatus: PaymentStatusEnum.REFUNDED,
        }),
      ),
    ).toMatchObject({
      channel: 'bulk',
      status: 'quote-requested',
      paymentMethod: 'online',
      paymentStatus: 'refunded',
    });
  });

  /** The two payment statuses the six seeded orders do not reach, so the lookup is complete. */
  it('lowers the payment statuses no seeded order is in', () => {
    expect(
      toAccountOrder(order({ paymentStatus: PaymentStatusEnum.COLLECTED })).paymentStatus,
    ).toBe('collected');
    expect(toAccountOrder(order({ paymentStatus: PaymentStatusEnum.FAILED })).paymentStatus).toBe(
      'failed',
    );
  });

  /**
   * `orders.status` is a varchar, so nothing but this function stands between a bad row and a
   * `Record<OrderStatus, string>` lookup that answers `undefined`. An uppercase channel arriving in
   * the status field is exactly the mix-up this file's docblock warns about, and it must be loud.
   */
  it('refuses a status that is not in the vocabulary, rather than rendering a blank badge', () => {
    expect(() => toAccountOrder(order({ status: 'RETAIL' }))).toThrow(/not an order status/);
    expect(() => toAccountOrder(order({ status: 'OUT-FOR-DELIVERY' }))).toThrow(
      /not an order status/,
    );
    expect(() =>
      toAccountOrder(order({ events: [event('Delivered', '2026-08-12T05:20:00.000Z')] })),
    ).toThrow(/not an order status/);
  });

  it('renders dates as ISO strings, which is what the wire declares and the page parses', () => {
    expect(toAccountOrder(order())).toMatchObject({
      placedAt: '2026-08-12T05:20:00.000Z',
      estimatedDelivery: '2026-08-15T12:00:00.000Z',
    });
  });

  /**
   * Every optional field is absent rather than null. `AccountOrder` declares them optional and the
   * detail page renders each behind a `&&`, so a null would typecheck nowhere and read as present
   * anywhere that counted keys. Asserted on the exact key set, because the promise is about what is
   * *missing*.
   */
  it('omits the optional fields it has nothing to say about', () => {
    const mapped = toAccountOrder(order());

    expect(Object.keys(mapped).sort()).toEqual([
      'address',
      'channel',
      'discount',
      'email',
      'estimatedDelivery',
      'gst',
      'id',
      'items',
      'paymentMethod',
      'paymentStatus',
      'placedAt',
      'shipping',
      'status',
      'subtotal',
      'timeline',
      'total',
    ]);
    expect(Object.keys(mapped.timeline[0] ?? {}).sort()).toEqual(['at', 'status']);
  });

  it('sends the optional fields it does have', () => {
    expect(
      toAccountOrder(
        order({
          couponCode: 'FESTIVE10',
          companyName: 'Anand Sweets & Namkeen',
          gstin: '29ABCDE1234F1Z5',
          poNumber: 'ANS/2026/0412',
        }),
      ),
    ).toMatchObject({
      couponCode: 'FESTIVE10',
      companyName: 'Anand Sweets & Namkeen',
      gstin: '29ABCDE1234F1Z5',
      poNumber: 'ANS/2026/0412',
    });
  });

  /**
   * `address_snapshot` is `jsonb` and therefore has no schema at rest: a row written by an older
   * revision or a hand-run `UPDATE` can hold keys that are not part of an address at all, and a
   * spread would forward every one of them to the client.
   */
  it('copies the address field by field, so a stray jsonb key cannot reach the client', () => {
    const mapped = toAccountOrder(
      order({
        addressSnapshot: {
          ...RETAIL_SNAPSHOT,
          internalNote: 'left with security',
        } as AddressSnapshot & { internalNote: string },
      }),
    );

    expect(mapped.address).toEqual(RETAIL_SNAPSHOT);
    expect(Object.keys(mapped.address)).not.toContain('internalNote');
  });

  /**
   * All three spellings of "there is no second line". `jsonb` has no schema at rest, so the column
   * can hold the key absent, `null`, or `''` — and each of the last two satisfies the declared
   * `string`, so each would reach the page as a blank line in the middle of an address.
   */
  it('omits an empty second address line rather than sending it', () => {
    const absent = { ...RETAIL_SNAPSHOT };
    delete absent.line2;

    const snapshots: AddressSnapshot[] = [
      absent,
      { ...RETAIL_SNAPSHOT, line2: '' },
      { ...RETAIL_SNAPSHOT, line2: null } as unknown as AddressSnapshot,
    ];

    for (const snapshot of snapshots) {
      expect(
        Object.keys(toAccountOrder(order({ addressSnapshot: snapshot })).address),
      ).not.toContain('line2');
    }
  });

  /**
   * `OrderTimeline.tsx` treats the **last** entry as the current step. The events are handed over
   * newest first here, which is the order a `DESC` query or a bare relation load can easily produce,
   * so an implementation that trusts its input renders the timeline backwards with the *first* step
   * marked current — and looks entirely plausible doing it.
   */
  it('sorts the timeline oldest first, whatever order the rows arrive in', () => {
    const mapped = toAccountOrder(
      order({
        status: 'delivered',
        events: [
          event('delivered', '2026-07-31T08:55:00.000Z', 'Left with the recipient.'),
          event('confirmed', '2026-07-28T10:05:00.000Z'),
          event('shipped', '2026-07-30T04:40:00.000Z'),
          event('pending', '2026-07-28T10:02:00.000Z'),
        ],
      }),
    );

    expect(mapped.timeline).toEqual([
      { status: 'pending', at: '2026-07-28T10:02:00.000Z' },
      { status: 'confirmed', at: '2026-07-28T10:05:00.000Z' },
      { status: 'shipped', at: '2026-07-30T04:40:00.000Z' },
      { status: 'delivered', at: '2026-07-31T08:55:00.000Z', note: 'Left with the recipient.' },
    ]);
    expect(mapped.timeline.at(-1)?.status).toBe(mapped.status);
  });

  /** The relation the caller passed is the caller's; reordering it in place would corrupt it. */
  it('sorts a copy, leaving the loaded relation as the caller left it', () => {
    const events = [
      event('confirmed', '2026-07-28T10:05:00.000Z'),
      event('pending', '2026-07-28T10:02:00.000Z'),
    ];
    const subject = order({ status: 'confirmed', events });

    toAccountOrder(subject);

    expect(events.map((entry) => entry.status)).toEqual(['confirmed', 'pending']);
  });

  /**
   * No ladder, no padding. A cancelled order never reaches "shipped", and drawing greyed-out steps
   * it will never reach tells the customer to keep waiting for something that is not coming. The
   * mock's `fromReceipt` invented a two-event timeline and that is one of the things this milestone
   * deletes.
   */
  it('synthesises nothing: one event is one entry', () => {
    const mapped = toAccountOrder(
      order({ status: 'pending', events: [event('pending', '2026-08-12T05:20:00.000Z')] }),
    );

    expect(mapped.timeline).toEqual([{ status: 'pending', at: '2026-08-12T05:20:00.000Z' }]);
  });

  /**
   * TypeORM declares `items` and `events` as non-optional arrays and leaves them `undefined` when
   * the relation was not loaded, so the type system cannot help here. It matters concretely:
   * `CheckoutService.place` returns the entity from `save()` and inserts its first `pending` event
   * *afterwards*, so that order's `events` genuinely is `undefined` — and a mapper that shrugged
   * would answer `POST /checkout/orders` with a real order carrying an empty timeline.
   */
  it('refuses an order whose relations were never loaded', () => {
    expect(() => toAccountOrder(order({ events: undefined }))).toThrow(/items and events loaded/);
    expect(() => toAccountOrder(order({ items: undefined }))).toThrow(/items and events loaded/);
  });
});

/**
 * The six seeded orders of `orders.seed.ts`, by status alone.
 *
 * Statuses only, because what needs proving across all six is about the vocabulary and the ordering,
 * not the money — and a second copy of the seeder's arithmetic here would be a second answer to
 * drift from. The completeness of this table is asserted below rather than trusted, so it cannot
 * quietly stop covering the vocabulary it exists to cover.
 */
const SEEDED_TIMELINES: readonly { channel: OrderChannelEnum; statuses: readonly string[] }[] = [
  {
    channel: OrderChannelEnum.RETAIL,
    statuses: ['pending', 'confirmed', 'processing', 'packed', 'shipped', 'out-for-delivery'],
  },
  {
    channel: OrderChannelEnum.BULK,
    statuses: [
      'quote-requested',
      'quote-sent',
      'quote-accepted',
      'awaiting-payment',
      'approved',
      'processing',
      'shipped',
    ],
  },
  { channel: OrderChannelEnum.RETAIL, statuses: ['pending', 'confirmed', 'cancelled'] },
  {
    channel: OrderChannelEnum.RETAIL,
    statuses: [
      'pending',
      'confirmed',
      'processing',
      'packed',
      'shipped',
      'out-for-delivery',
      'delivered',
    ],
  },
  {
    channel: OrderChannelEnum.RETAIL,
    statuses: ['pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'refunded'],
  },
  {
    channel: OrderChannelEnum.BULK,
    statuses: [
      'quote-requested',
      'quote-sent',
      'quote-accepted',
      'awaiting-payment',
      'approved',
      'processing',
      'shipped',
      'delivered',
    ],
  },
];

/** One event a minute, so the fixture's arrival order and its chronology are the same thing. */
const HOUR_ZERO = Date.parse('2026-08-12T05:20:00.000Z');

const seededOrder = (index: number): Order => {
  const seed = SEEDED_TIMELINES[index];
  if (seed === undefined) throw new Error(`no seeded timeline at ${index}`);
  const last = seed.statuses.at(-1);
  if (last === undefined) throw new Error(`seeded timeline ${index} has no events`);

  return order({
    orderNumber: `NN-2026-00500${index}`,
    channel: seed.channel,
    status: last,
    events: seed.statuses.map((status, step) =>
      event(status, new Date(HOUR_ZERO + step * 60_000).toISOString()),
    ),
  });
};

describe('toAccountOrder over the seeded order history', () => {
  /**
   * Guards the table above. 38 events over exactly `B2C_ORDER_STATUSES ∪ B2B_ORDER_STATUSES`, so
   * the assertions that follow are known to exercise all 14 statuses — and a fifteenth added to
   * `shared` fails here until this fixture covers it, rather than going untested in silence.
   */
  it('covers the whole status vocabulary in 38 events', () => {
    const statuses = SEEDED_TIMELINES.flatMap((seed) => seed.statuses);

    expect(statuses.length).toBe(38);
    expect([...new Set(statuses)].sort()).toEqual(
      [...new Set<string>([...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES])].sort(),
    );
  });

  /**
   * `AccountOrder.timeline`'s docblock states it as an invariant: *"Oldest first. The last entry
   * always matches `status`."* `OrderTimeline.tsx` depends on it — the last entry is the one it
   * marks as the current step — so a timeline whose tail disagrees with the badge beside it is a
   * page contradicting itself.
   */
  it("ends every timeline on the order's own status, oldest first", () => {
    for (const [index, seed] of SEEDED_TIMELINES.entries()) {
      const mapped = toAccountOrder(seededOrder(index));

      expect(mapped.timeline.map((entry) => entry.status)).toEqual(seed.statuses);
      expect(mapped.timeline.at(-1)?.status).toBe(mapped.status);
    }
  });

  /** Every status survives the crossing unchanged — the varchar column is already the wire value. */
  it('passes all 14 statuses through untouched', () => {
    const crossed = SEEDED_TIMELINES.flatMap((_seed, index) =>
      toAccountOrder(seededOrder(index)).timeline.map((entry) => entry.status),
    );

    expect(crossed).toEqual(SEEDED_TIMELINES.flatMap((seed) => seed.statuses));
  });
});
