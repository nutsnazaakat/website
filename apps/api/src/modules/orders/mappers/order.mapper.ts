import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  toRupees,
  type AccountOrder,
  type Address,
  type OrderChannel,
  type OrderEvent as WireOrderEvent,
  type OrderLine,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@nutwala/shared';
import type { OrderEvent } from '../../../entities/commerce/order-event.entity';
import type { OrderItem } from '../../../entities/commerce/order-item.entity';
import type { AddressSnapshot, Order } from '../../../entities/commerce/order.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../../entities/enums';

/**
 * The **only** place an `Order` becomes an `AccountOrder`.
 *
 * `POST /checkout/orders` answers with `PlaceOrderResult`, which *is* `AccountOrder`, and
 * `GET /account/orders/:orderNumber` answers with the same shape — deliberately, so a customer who
 * has just placed an order and a customer opening it a week later are looking at one contract. Two
 * mappings would be two contracts, and the second one to change would be the one nobody noticed.
 *
 * The entity and the wire disagree in three ways, and this file is the only thing that may know:
 *
 * | | Entity | Wire |
 * | --- | --- | --- |
 * | Money | `bigint` paise (`@PaiseColumn`) | `number` rupees |
 * | Channel, payment method, payment status | `UPPERCASE` enums (`RETAIL`, `COD`) | lowercase |
 * | Status | `varchar(24)`, already lowercase-hyphen | the same |
 *
 * Note the asymmetry in the last two rows, because getting it backwards is invisible to the
 * compiler: `orders.status` is stored in the *wire* vocabulary already — its check constraint
 * mirrors `shared`'s 14-value tuple — while `channel` and `paymentMethod` are Postgres enums that
 * have to be lowered. Sending `RETAIL` where a status belongs misses every
 * `Record<OrderStatus, …>` lookup in `frontend/src/features/account/status.ts` and renders an
 * **empty badge** rather than an error.
 */

/**
 * Every legal status, from `shared`'s own two tuples.
 *
 * `orders.status` and `order_events.status` are `varchar(24)`, so the compiler cannot tell a status
 * from any other string and the cast to `OrderStatus` is where the type system stops helping. This
 * is the boundary, so it is checked here rather than asserted: an unknown value reaching
 * `ORDER_STATUS_LABEL` renders a blank badge with no error anywhere, and a blank badge is the
 * hardest kind of wrong answer to trace back.
 *
 * Membership in the **union**, not in the order's channel. A bulk order carrying a retail status is
 * a data problem the database's check constraint permits, and it is `OrderStatusService`'s business
 * to refuse writing one — not this function's business to refuse *reading* one, which would take a
 * customer's order page down over a row admin already saved.
 */
const ORDER_STATUSES: ReadonlySet<string> = new Set<string>([
  ...B2C_ORDER_STATUSES,
  ...B2B_ORDER_STATUSES,
]);

function toOrderStatus(value: string, subject: string): OrderStatus {
  if (!ORDER_STATUSES.has(value)) {
    throw new Error(`${subject} carries status "${value}", which is not an order status`);
  }
  return value as OrderStatus;
}

/**
 * The three enum vocabularies, spelled out rather than lowercased.
 *
 * `value.toLowerCase() as OrderChannel` would work today and would keep working right up until an
 * enum gains a member whose wire spelling is not simply its lowercase. `ShipmentStatus.IN_TRANSIT`
 * is already that member waiting to happen: it lowercases to `in_transit`, while every hyphenated
 * value in this project's wire vocabularies — `out-for-delivery`, `quote-requested` — says the wire
 * spelling would be `in-transit`. A cast makes that a runtime surprise;
 * `Record<OrderChannelEnum, OrderChannel>` requires a row per enum member and typechecks every
 * value against the wire union, so the two vocabularies sit adjacent in the source and neither can
 * grow without the other.
 */
const CHANNEL: Readonly<Record<OrderChannelEnum, OrderChannel>> = {
  [OrderChannelEnum.RETAIL]: 'retail',
  [OrderChannelEnum.BULK]: 'bulk',
};

const PAYMENT_METHOD: Readonly<Record<PaymentMethodEnum, PaymentMethod>> = {
  [PaymentMethodEnum.COD]: 'cod',
  [PaymentMethodEnum.ONLINE]: 'online',
};

const PAYMENT_STATUS: Readonly<Record<PaymentStatusEnum, PaymentStatus>> = {
  [PaymentStatusEnum.PENDING]: 'pending',
  [PaymentStatusEnum.COLLECTED]: 'collected',
  [PaymentStatusEnum.FAILED]: 'failed',
  [PaymentStatusEnum.REFUNDED]: 'refunded',
};

/**
 * The four vocabulary conversions, exported as functions rather than as the maps themselves.
 *
 * `admin-order.mapper.ts` needs every one of them for `GET /admin/orders`, whose rows are built
 * from the `orders` columns alone — it cannot go through `toAccountOrder`, which requires the
 * `items` and `events` relations a list deliberately does not load. Without these it would hold a
 * second copy of each map, which is exactly the drift the `Record`s above exist to prevent.
 *
 * Functions, not `export const CHANNEL`, for two reasons. The maps stay closed, so nothing outside
 * can read one with a key the enum does not have; and the call sites read as conversions rather
 * than as lookups, which is what stops the asymmetry in the table above being applied backwards —
 * `channel` and the two payment enums are `UPPERCASE` in the column and lowercase on the wire,
 * while a status is already stored in the wire spelling. `toWireOrderStatus` is therefore a
 * *validation* rather than a map, and keeps its `subject` argument so an unknown value names the
 * row it came from.
 */
export function toWireChannel(channel: OrderChannelEnum): OrderChannel {
  return CHANNEL[channel];
}

export function toWirePaymentMethod(method: PaymentMethodEnum): PaymentMethod {
  return PAYMENT_METHOD[method];
}

export function toWirePaymentStatus(status: PaymentStatusEnum): PaymentStatus {
  return PAYMENT_STATUS[status];
}

export function toWireOrderStatus(value: string, subject: string): OrderStatus {
  return toOrderStatus(value, subject);
}

/**
 * The stored snapshot as the wire's `Address`, copied field by field.
 *
 * Not a spread, for the same reason `CheckoutService.toSnapshot` is not one: `address_snapshot` is
 * `jsonb`, so it holds whatever was written to it at any point in this schema's history and a
 * spread would forward every one of those keys to the client.
 *
 * `line2` is omitted rather than sent, on truthiness rather than `=== undefined`. `AddressSnapshot`
 * declares it optional and `toSnapshot` omits it, but `jsonb` has no schema at rest — a row written
 * by an older revision, an import, or a hand-run `UPDATE` can hold `null` or `''` there, both of
 * which satisfy the declared `string` and would reach the page. `account/orders/$id.tsx` renders
 * `{order.address.line2 && …}`, so an empty second line is already nothing; this keeps it nothing
 * on the wire as well.
 */
function toAddress(snapshot: AddressSnapshot): Address {
  return {
    fullName: snapshot.fullName,
    phone: snapshot.phone,
    email: snapshot.email,
    line1: snapshot.line1,
    ...(snapshot.line2 ? { line2: snapshot.line2 } : {}),
    city: snapshot.city,
    state: snapshot.state,
    pincode: snapshot.pincode,
  };
}

/**
 * One purchased line.
 *
 * `slug` is always sent. `OrderLine.slug` is optional only because the Phase 1 receipt had none —
 * `LineName` in `account/orders/$id.tsx` links to the product exactly when it is present, and
 * `order_items.product_slug` is a non-null snapshot column, so a real order always links.
 *
 * A null `lineTotalPaise` stays null. It means "fulfilled against a negotiated quote", which the
 * page renders as *Quote Required*; passing it through `toRupees` would make it `Number(null) / 100`
 * — a confident **₹0** against goods that were quoted, on an invoice.
 */
function toOrderLine(item: OrderItem): OrderLine {
  return {
    slug: item.productSlug,
    name: item.name,
    detail: item.detail,
    qty: item.qty,
    total: item.lineTotalPaise === null ? null : toRupees(item.lineTotalPaise),
  };
}

/** `at` is the row's own `created_at` — spec §10.3, the tracking page reads these rows. */
function toOrderEvent(event: OrderEvent): WireOrderEvent {
  return {
    status: toOrderStatus(event.status, `order event ${event.id}`),
    at: event.createdAt.toISOString(),
    // Omitted rather than null: `OrderEvent.note` is optional on the wire, and a note exists to say
    // something the status does not.
    ...(event.note === null ? {} : { note: event.note }),
  };
}

/**
 * The order's history, **oldest first**, and nothing invented.
 *
 * `OrderTimeline.tsx` treats the *last* entry as the current step and draws the dot and the "current
 * step" label against it. Newest-first would render the timeline backwards with the first step
 * marked current, and it would look entirely plausible — which is worse than looking broken.
 *
 * Sorted here rather than left to the caller's `ORDER BY`. A query with no explicit order returns
 * rows in whatever order Postgres finds them, and `CheckoutService.place` builds its order's events
 * without going near a query at all — so "the reads happen to be ordered" is not a property this
 * function can borrow. The sort is on a copy: `events` is a loaded relation and reordering it in
 * place would mutate the entity the caller still holds.
 *
 * No padding. One event means one entry — a cancelled order never reaches "shipped", and the
 * synthetic two-step ladder `fromReceipt` used to invent is one of the things this milestone
 * deletes.
 */
function toTimeline(events: readonly OrderEvent[]): WireOrderEvent[] {
  return [...events]
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((event) => toOrderEvent(event));
}

/**
 * An order as its customer sees it.
 *
 * **`id` is the order *number*, not the primary key.** `AccountOrder.id`'s docblock says
 * `` `NN-{year}-{at least 6 digits}` `` (`ORDER_NUMBER_PATTERN` in `shared`), and `Order` carries both — `id` (uuid) and `orderNumber`. Mapping
 * `order.id` typechecks perfectly because both are `string`, and produces an order-success URL
 * holding a uuid, a `POST /account/orders/:orderNumber/cancel` looking up a value that is not an
 * order number, and `/^Order ID: NN-\d{4}-\d{6}$/` failing in `routes.smoke.test.tsx`. Note that
 * `AccountOrder` has **no field for the uuid**, deliberately: nothing on the wire needs it, so
 * nothing on the wire gets it, and every customer-facing route is keyed by the number a customer
 * can read down a phone line.
 *
 * **`email` comes from the address snapshot, and that is the only source that works.** `orders` has
 * no email column and `user_id` is nullable because guest checkout is supported, so
 * `order.user?.email` is undefined for exactly the orders a guest most needs to see.
 * `AddressSnapshot.email` is filled field by field at placement from a required `AddressDto.email`.
 * It is data on the order and never a key that grants access to it — history is scoped by `userId`,
 * never by matching email strings.
 *
 * Requires `items` and `events` to be loaded, and says so loudly rather than answering without
 * them. TypeORM types both relations as non-optional arrays while leaving them `undefined` when
 * unloaded, so an order mapped straight out of `CheckoutService.place` — which inserts its first
 * `pending` event *after* `save`, and never reloads — would otherwise render a real order with an
 * empty timeline and no lines. That is the plausible-looking wrong answer this whole file exists to
 * avoid.
 */
export function toAccountOrder(order: Order): AccountOrder {
  // Widened deliberately: the declared types say these are always arrays and an unloaded relation
  // is the case they are wrong about.
  const items: OrderItem[] | undefined = order.items;
  const events: OrderEvent[] | undefined = order.events;
  if (items === undefined || events === undefined) {
    throw new Error(
      `Order ${order.orderNumber} cannot be mapped without its items and events loaded`,
    );
  }

  return {
    id: order.orderNumber,
    email: order.addressSnapshot.email,
    channel: CHANNEL[order.channel],
    status: toOrderStatus(order.status, `order ${order.orderNumber}`),
    placedAt: order.placedAt.toISOString(),
    estimatedDelivery: order.estimatedDelivery.toISOString(),
    timeline: toTimeline(events),
    items: items.map((item) => toOrderLine(item)),
    subtotal: toRupees(order.subtotalPaise),
    discount: toRupees(order.discountPaise),
    gst: toRupees(order.gstPaise),
    shipping: toRupees(order.shippingPaise),
    total: toRupees(order.totalPaise),
    address: toAddress(order.addressSnapshot),
    paymentMethod: PAYMENT_METHOD[order.paymentMethod],
    paymentStatus: PAYMENT_STATUS[order.paymentStatus],
    // Omitted rather than sent as null, matching the four optional fields on `AccountOrder`. The
    // detail page renders each behind a `&&`, and `''` — which `poNumber`'s `@IsString()` accepts —
    // is as absent as null for that purpose.
    ...(order.couponCode ? { couponCode: order.couponCode } : {}),
    ...(order.companyName ? { companyName: order.companyName } : {}),
    ...(order.gstin ? { gstin: order.gstin } : {}),
    ...(order.poNumber ? { poNumber: order.poNumber } : {}),
  };
}
