import { gstOn, sumPaise, toPaise } from '@nutwala/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { Order, type AddressSnapshot } from '../../entities/commerce/order.entity';
import { OrderEvent } from '../../entities/commerce/order-event.entity';
import { OrderItem } from '../../entities/commerce/order-item.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { Business } from '../../entities/identity/business.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../entities/enums';
import {
  loadProductHsnBySlug,
  loadProductIdsBySlug,
  loadUserIdsByEmail,
  loadVariantIdsByKey,
  requireValue,
  variantKey,
} from './seed-context';

/**
 * The six orders from `frontend/src/mocks/orders.ts`.
 *
 * Between them they exercise every brief §33 status: the four retail orders rest in the states
 * worth looking at — out for delivery, cancelled, delivered, refunded — and carry the in-flight
 * ones inside their timelines, while the two bulk orders cover all eight B2B states.
 *
 * These are historical fixtures and deliberately write **no** `InventoryTransaction` rows. A
 * SALE row would have to be matched by a reduction in `Inventory.onHand` to keep
 * `SUM(delta) = onHand` true, which would turn the seed into a stock simulation with six
 * orders' worth of arithmetic to keep straight. Every variant therefore stays at the opening
 * figure `catalog.seed.ts` gave it.
 */

const GST_RATE = 5;
const FLAT_SHIPPING = 79;

const RETAIL_ADDRESS: AddressSnapshot = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

const BUSINESS_ADDRESS: AddressSnapshot = {
  fullName: 'Rakesh Anand',
  phone: '9845012345',
  email: 'b2b@demo.in',
  line1: 'Unit 7, Peenya Industrial Area, Phase II',
  line2: 'Goods entrance on the rear road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560058',
};

interface ItemSeed {
  productSlug: string;
  name: string;
  /** Matches the frontend's `detail`: a pack size for retail, "25 kg" for bulk. */
  detail: string;
  /** `ProductVariant.size`, which is what resolves the line back to a SKU. */
  variantSize: string;
  qty: number;
  /** Rupees per unit, GST-exclusive. For a bulk line the unit is the whole consignment. */
  unitRupees: number;
  /** Set on a bulk line only, matching `OrderItem.kg`. */
  kg: number | null;
}

/**
 * A retail pack line. `unitRupees` is the seeded variant's own listed price, so these lines
 * cost what the shop charges today rather than a figure typed in beside it.
 */
const retail = (
  productSlug: string,
  name: string,
  size: string,
  qty: number,
  unitRupees: number,
): ItemSeed => ({ productSlug, name, detail: size, variantSize: size, qty, unitRupees, kg: null });

/**
 * A bulk consignment line, one unit of `kg` kilograms. `ratePerKg` is the resolved pricing-tier
 * rate: 25kg lands in the 25–49kg slab (0.85x base), 10kg in the 10–24kg slab (0.9x base).
 */
const bulk = (productSlug: string, name: string, kg: number, ratePerKg: number): ItemSeed => ({
  productSlug,
  name,
  detail: `${kg} kg`,
  variantSize: `${kg}kg`,
  qty: 1,
  unitRupees: kg * ratePerKg,
  kg,
});

interface EventSeed {
  status: string;
  at: string;
  note?: string;
}

interface OrderSeed {
  orderNumber: string;
  email: string;
  channel: OrderChannelEnum;
  status: string;
  placedAt: string;
  estimatedDelivery: string;
  timeline: EventSeed[];
  items: ItemSeed[];
  shippingRupees: number;
  address: AddressSnapshot;
  /**
   * Follows the order's status, exactly as the mock has it: `delivered` collects, `refunded`
   * refunds, and everything else — cancelled included, since nothing was ever taken at the
   * door — is still pending. Every seeded order is COD.
   */
  paymentStatus: PaymentStatusEnum;
  companyName?: string;
  gstin?: string;
  poNumber?: string;
}

const ORDER_SEEDS: OrderSeed[] = [
  {
    orderNumber: 'NN-2026-005107',
    email: 'b2c@demo.in',
    channel: OrderChannelEnum.RETAIL,
    status: 'out-for-delivery',
    placedAt: '2026-08-12T05:20:00.000Z',
    estimatedDelivery: '2026-08-15T12:00:00.000Z',
    timeline: [
      { status: 'pending', at: '2026-08-12T05:20:00.000Z' },
      { status: 'confirmed', at: '2026-08-12T05:22:00.000Z', note: 'Payment received.' },
      { status: 'processing', at: '2026-08-13T05:00:00.000Z' },
      { status: 'packed', at: '2026-08-13T09:40:00.000Z' },
      { status: 'shipped', at: '2026-08-14T03:30:00.000Z' },
      {
        status: 'out-for-delivery',
        at: '2026-08-15T02:45:00.000Z',
        note: 'With the delivery partner for today.',
      },
    ],
    items: [
      retail('roasted-makhana', 'Roasted Makhana', '250g', 3, 299),
      retail('premium-pistachios', 'Premium Pistachios', '250g', 1, 509),
    ],
    shippingRupees: 0,
    address: RETAIL_ADDRESS,
    paymentStatus: PaymentStatusEnum.PENDING,
  },
  {
    orderNumber: 'NN-2026-005042',
    email: 'b2b@demo.in',
    channel: OrderChannelEnum.BULK,
    status: 'shipped',
    placedAt: '2026-08-08T04:30:00.000Z',
    estimatedDelivery: '2026-08-16T12:00:00.000Z',
    timeline: [
      {
        status: 'quote-requested',
        at: '2026-08-08T04:30:00.000Z',
        note: 'Purchase order ANS/2026/0412.',
      },
      { status: 'quote-sent', at: '2026-08-08T09:00:00.000Z' },
      { status: 'quote-accepted', at: '2026-08-09T05:15:00.000Z' },
      { status: 'awaiting-payment', at: '2026-08-09T06:00:00.000Z' },
      { status: 'approved', at: '2026-08-10T04:20:00.000Z', note: 'Payment received against PO.' },
      {
        status: 'processing',
        at: '2026-08-10T05:00:00.000Z',
        note: 'Grading and vacuum packing.',
      },
      {
        status: 'shipped',
        at: '2026-08-13T03:45:00.000Z',
        note: 'Sent by surface freight. Tracking details emailed.',
      },
    ],
    items: [
      bulk('w320-cashews', 'W320 Cashews', 25, 934),
      bulk('premium-pistachios', 'Premium Pistachios', 10, 1529),
    ],
    shippingRupees: 0,
    address: BUSINESS_ADDRESS,
    paymentStatus: PaymentStatusEnum.PENDING,
    companyName: 'Anand Sweets & Namkeen',
    gstin: '29ABCDE1234F1Z5',
    poNumber: 'ANS/2026/0412',
  },
  {
    orderNumber: 'NN-2026-004977',
    email: 'b2c@demo.in',
    channel: OrderChannelEnum.RETAIL,
    status: 'cancelled',
    placedAt: '2026-08-05T14:10:00.000Z',
    estimatedDelivery: '2026-08-09T12:00:00.000Z',
    timeline: [
      { status: 'pending', at: '2026-08-05T14:10:00.000Z' },
      { status: 'confirmed', at: '2026-08-05T14:12:00.000Z' },
      {
        status: 'cancelled',
        at: '2026-08-06T04:30:00.000Z',
        note: 'Cancelled at your request before dispatch.',
      },
    ],
    items: [retail('medjool-dates', 'Medjool Dates', '500g', 1, 659)],
    shippingRupees: FLAT_SHIPPING,
    address: RETAIL_ADDRESS,
    paymentStatus: PaymentStatusEnum.PENDING,
  },
  {
    orderNumber: 'NN-2026-004821',
    email: 'b2c@demo.in',
    channel: OrderChannelEnum.RETAIL,
    status: 'delivered',
    placedAt: '2026-07-28T10:02:00.000Z',
    estimatedDelivery: '2026-08-01T12:00:00.000Z',
    timeline: [
      { status: 'pending', at: '2026-07-28T10:02:00.000Z' },
      { status: 'confirmed', at: '2026-07-28T10:05:00.000Z', note: 'Payment received.' },
      { status: 'processing', at: '2026-07-29T06:30:00.000Z' },
      { status: 'packed', at: '2026-07-29T11:15:00.000Z' },
      { status: 'shipped', at: '2026-07-30T04:40:00.000Z' },
      { status: 'out-for-delivery', at: '2026-07-31T03:10:00.000Z' },
      { status: 'delivered', at: '2026-07-31T08:55:00.000Z', note: 'Left with the recipient.' },
    ],
    items: [
      retail('w320-cashews', 'W320 Cashews', '500g', 2, 599),
      retail('premium-california-almonds', 'Premium California Almonds', '1kg', 1, 999),
    ],
    shippingRupees: 0,
    address: RETAIL_ADDRESS,
    paymentStatus: PaymentStatusEnum.COLLECTED,
  },
  {
    orderNumber: 'NN-2026-004650',
    email: 'b2c@demo.in',
    channel: OrderChannelEnum.RETAIL,
    status: 'refunded',
    placedAt: '2026-07-09T08:00:00.000Z',
    estimatedDelivery: '2026-07-13T12:00:00.000Z',
    timeline: [
      { status: 'pending', at: '2026-07-09T08:00:00.000Z' },
      { status: 'confirmed', at: '2026-07-09T08:02:00.000Z' },
      { status: 'processing', at: '2026-07-10T05:15:00.000Z' },
      { status: 'packed', at: '2026-07-10T10:20:00.000Z' },
      { status: 'shipped', at: '2026-07-11T04:05:00.000Z' },
      { status: 'delivered', at: '2026-07-13T07:30:00.000Z' },
      {
        status: 'refunded',
        at: '2026-07-18T06:00:00.000Z',
        note: 'Returned and refunded to the original payment method.',
      },
    ],
    items: [
      retail('california-walnuts', 'California Walnut Kernels', '500g', 1, 709),
      retail('golden-raisins', 'Golden Raisins', '500g', 1, 269),
    ],
    shippingRupees: FLAT_SHIPPING,
    address: RETAIL_ADDRESS,
    paymentStatus: PaymentStatusEnum.REFUNDED,
  },
  {
    orderNumber: 'NN-2026-004488',
    email: 'b2b@demo.in',
    channel: OrderChannelEnum.BULK,
    status: 'delivered',
    placedAt: '2026-06-24T05:10:00.000Z',
    estimatedDelivery: '2026-07-02T12:00:00.000Z',
    timeline: [
      {
        status: 'quote-requested',
        at: '2026-06-24T05:10:00.000Z',
        note: 'Purchase order ANS/2026/0388.',
      },
      { status: 'quote-sent', at: '2026-06-24T10:30:00.000Z' },
      { status: 'quote-accepted', at: '2026-06-25T06:15:00.000Z' },
      { status: 'awaiting-payment', at: '2026-06-25T07:00:00.000Z' },
      { status: 'approved', at: '2026-06-26T04:10:00.000Z', note: 'Payment received against PO.' },
      { status: 'processing', at: '2026-06-26T04:50:00.000Z' },
      { status: 'shipped', at: '2026-06-30T03:20:00.000Z' },
      {
        status: 'delivered',
        at: '2026-07-03T04:15:00.000Z',
        note: 'GST invoice emailed to accounts.',
      },
    ],
    items: [
      bulk('premium-california-almonds', 'Premium California Almonds', 25, 849),
      bulk('afghani-black-raisins', 'Afghani Black Raisins', 25, 552),
    ],
    shippingRupees: 0,
    address: BUSINESS_ADDRESS,
    paymentStatus: PaymentStatusEnum.COLLECTED,
    companyName: 'Anand Sweets & Namkeen',
    gstin: '29ABCDE1234F1Z5',
    poNumber: 'ANS/2026/0388',
  },
];

interface PricedItem {
  seed: ItemSeed;
  unitPricePaise: bigint;
  lineTotalPaise: bigint;
  gstAmountPaise: bigint;
}

/**
 * Line money, then order money as the sum of it.
 *
 * GST is computed per line and summed, never applied to the aggregate subtotal — spec §8,
 * because an invoice whose tax does not equal the sum of its lines' tax cannot be reconciled.
 * This is the one place the seeded figures are more precise than the mock's, which rounds a
 * single aggregate to the rupee; the difference is at most a rupee per order, and the
 * alternative would leave `Order.gstPaise` disagreeing with its own `OrderItem` rows.
 */
function priceItems(items: readonly ItemSeed[]): PricedItem[] {
  return items.map((seed) => {
    const unitPricePaise = toPaise(seed.unitRupees);
    const lineTotalPaise = unitPricePaise * BigInt(seed.qty);
    return {
      seed,
      unitPricePaise,
      lineTotalPaise,
      gstAmountPaise: gstOn(lineTotalPaise, GST_RATE),
    };
  });
}

function eventAt(seed: OrderSeed, status: string): Date | null {
  const event = seed.timeline.find((entry) => entry.status === status);
  return event === undefined ? null : new Date(event.at);
}

export async function seedOrders(dataSource: DataSource): Promise<number> {
  const [userIdByEmail, productIdBySlug, productHsnBySlug, variantIdByKey] = await Promise.all([
    loadUserIdsByEmail(dataSource),
    loadProductIdsBySlug(dataSource),
    loadProductHsnBySlug(dataSource),
    loadVariantIdsByKey(dataSource),
  ]);

  if (userIdByEmail.size === 0 || productIdBySlug.size === 0) {
    throw new Error('No users or products found. Run the users and catalog seeders first.');
  }

  return dataSource.transaction(async (manager) => {
    const businesses = await manager
      .getRepository(Business)
      .find({ select: { id: true, userId: true } });
    const businessIdByUserId = new Map(
      businesses.map((business) => [business.userId, business.id]),
    );

    let rows = 0;
    for (const seed of ORDER_SEEDS) {
      rows += await seedOrder(manager, seed, {
        userIdByEmail,
        productIdBySlug,
        productHsnBySlug,
        variantIdByKey,
        businessIdByUserId,
      });
    }
    return rows;
  });
}

interface Lookups {
  userIdByEmail: ReadonlyMap<string, string>;
  productIdBySlug: ReadonlyMap<string, string>;
  productHsnBySlug: ReadonlyMap<string, string>;
  variantIdByKey: ReadonlyMap<string, string>;
  businessIdByUserId: ReadonlyMap<string, string>;
}

async function seedOrder(
  manager: EntityManager,
  seed: OrderSeed,
  lookups: Lookups,
): Promise<number> {
  const userId = requireValue(
    lookups.userIdByEmail.get(seed.email),
    `user "${seed.email}" for order ${seed.orderNumber}`,
  );
  // A retail order has no company behind it. A bulk one always does, so an unresolved lookup
  // there is a broken fixture rather than a null to write.
  const businessId =
    seed.channel === OrderChannelEnum.BULK
      ? requireValue(
          lookups.businessIdByUserId.get(userId),
          `a business for "${seed.email}" on bulk order ${seed.orderNumber}`,
        )
      : null;

  const priced = priceItems(seed.items);
  const subtotalPaise = sumPaise(priced.map((item) => item.lineTotalPaise));
  const gstPaise = sumPaise(priced.map((item) => item.gstAmountPaise));
  const shippingPaise = toPaise(seed.shippingRupees);
  // No coupon applies to any seeded order, so the discount is zero everywhere.
  const discountPaise = 0n;
  const totalPaise = subtotalPaise - discountPaise + gstPaise + shippingPaise;

  const placedAt = new Date(seed.placedAt);
  const cancelledEvent = seed.timeline.find((entry) => entry.status === 'cancelled');

  await manager.getRepository(Order).upsert(
    {
      orderNumber: seed.orderNumber,
      userId,
      businessId,
      channel: seed.channel,
      status: seed.status,
      paymentMethod: PaymentMethodEnum.COD,
      paymentStatus: seed.paymentStatus,
      subtotalPaise,
      discountPaise,
      gstPaise,
      shippingPaise,
      totalPaise,
      couponCode: null,
      addressSnapshot: seed.address,
      billingSnapshot: null,
      companyName: seed.companyName ?? null,
      gstin: seed.gstin ?? null,
      poNumber: seed.poNumber ?? null,
      specialInstructions: null,
      placedAt,
      estimatedDelivery: new Date(seed.estimatedDelivery),
      cancelledAt: cancelledEvent === undefined ? null : new Date(cancelledEvent.at),
      cancelReason: cancelledEvent?.note ?? null,
      // The row's own creation date is when the order was placed, not when the seed ran.
      createdAt: placedAt,
    },
    ['orderNumber'],
  );
  let rows = 1;

  const order = requireValue(
    (await manager
      .getRepository(Order)
      .findOne({ where: { orderNumber: seed.orderNumber }, select: { id: true } })) ?? undefined,
    `order ${seed.orderNumber} immediately after upserting it`,
  );

  // Items, events and payments have no natural key of their own, so the seeded order's
  // children are replaced wholesale on a re-run. Only rows belonging to these six fixture
  // orders are touched. This is why the stock ledger is handled differently in
  // `catalog.seed.ts` — that table can hold genuine movements the seed does not own.
  await manager.getRepository(OrderItem).delete({ orderId: order.id });
  await manager.getRepository(OrderEvent).delete({ orderId: order.id });
  await manager.getRepository(Payment).delete({ orderId: order.id });

  await manager.getRepository(OrderItem).insert(
    priced.map(({ seed: item, unitPricePaise, lineTotalPaise, gstAmountPaise }) => ({
      orderId: order.id,
      // These three columns are nullable in the schema so a snapshot survives its product being
      // deleted — `ON DELETE SET NULL`. At seed time every one of them must resolve, so they go
      // through `requireValue`: a mistyped slug or `variantSize` would otherwise write an order
      // line pointing at nothing, and no test asserts these resolve.
      productId: requireValue(
        lookups.productIdBySlug.get(item.productSlug),
        `product "${item.productSlug}" on order ${seed.orderNumber}`,
      ),
      variantId: requireValue(
        lookups.variantIdByKey.get(variantKey(item.productSlug, item.variantSize)),
        `variant "${item.variantSize}" of product "${item.productSlug}" on order ${seed.orderNumber}`,
      ),
      productSlug: item.productSlug,
      name: item.name,
      // Snapshotted from the product being sold. Required on a compliant Indian GST invoice,
      // and the only way to reprint one after the product is reclassified or deleted.
      hsn: requireValue(
        lookups.productHsnBySlug.get(item.productSlug),
        `an HSN code for product "${item.productSlug}" on order ${seed.orderNumber}`,
      ),
      detail: item.detail,
      size: item.variantSize,
      grams: item.kg === null ? null : item.kg * 1000,
      kg: item.kg === null ? null : String(item.kg),
      qty: item.qty,
      unitPricePaise,
      lineTotalPaise,
      gstRate: String(GST_RATE),
      gstAmountPaise,
    })),
  );
  rows += priced.length;

  await manager.getRepository(OrderEvent).insert(
    seed.timeline.map((entry) => ({
      orderId: order.id,
      status: entry.status,
      note: entry.note ?? null,
      // These fixtures predate any admin account acting on them, so the timeline is unattributed.
      actorUserId: null,
      // Spec §10.3 — the customer's tracking page reads these rows, so `at` is the row's date.
      createdAt: new Date(entry.at),
    })),
  );
  rows += seed.timeline.length;

  const collectedAt =
    seed.paymentStatus === PaymentStatusEnum.COLLECTED ||
    seed.paymentStatus === PaymentStatusEnum.REFUNDED
      ? eventAt(seed, 'delivered')
      : null;

  await manager.getRepository(Payment).insert({
    orderId: order.id,
    method: PaymentMethodEnum.COD,
    status: seed.paymentStatus,
    amountPaise: totalPaise,
    collectedAt,
    // A COD receipt number is written when cash is taken. Nothing here has one to record.
    reference: null,
    createdAt: placedAt,
  });
  rows += 1;

  return rows;
}
