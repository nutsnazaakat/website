import {
  toRupees,
  type AdminOrder,
  type AdminOrderCustomer,
  type AdminOrderSummary,
  type AdminShipment,
  type AdminShipmentStatus,
} from '@nutwala/shared';
import type { Payment } from '../../../entities/commerce/payment.entity';
import type { Shipment } from '../../../entities/commerce/shipment.entity';
import { ShipmentStatus } from '../../../entities/enums';
import type { Order } from '../../../entities/commerce/order.entity';
import {
  toAccountOrder,
  toWireChannel,
  toWirePaymentMethod,
  toWirePaymentStatus,
  toWireOrderStatus,
} from './order.mapper';

/**
 * An order as the admin console reads it.
 *
 * **`toAccountOrder` does all of it but one field, and that is the point of the file being this
 * short.** Spec §5a puts admin wire types in `@nutwala/shared` *extending* the storefront shape
 * rather than restating it, and the mapping follows the type: items, totals, the address, the
 * timeline and the payment state are the same facts the customer's own page renders, produced by
 * the same function. A second assembly of an order would be a second contract, and the first
 * divergence between them would be an operator and a customer looking at one order and disagreeing
 * about it — which is `order.mapper.ts`'s own stated reason for existing, one level up.
 *
 * It also inherits that mapper's refusal to map an order whose `items` and `events` are not loaded,
 * which is what stops an admin read answering with a real order, an empty basket and no timeline.
 *
 * `payment` and `shipments` are passed in rather than reached through relations on `Order`: the
 * entity declares neither, and adding them would put loadable arrays on every read in the codebase
 * to serve three fields on one admin shape.
 */
export function toAdminOrder(
  order: Order,
  payment: Payment | null,
  shipments: readonly Shipment[],
): AdminOrder {
  return {
    ...toAccountOrder(order),
    customer: toAdminOrderCustomer(order),
    /**
     * From the `payments` row, not from `orders.paymentStatus`.
     *
     * The two are a denormalised pair kept in step by `AdminOrdersService.collectPayment` inside one
     * transaction, and reporting both from their own sources is what makes a drift between them
     * visible on the screen rather than silent. `null` when there is no payment row at all, which is
     * not a state placement can produce — `CheckoutService.place` writes one — but is one a fixture
     * or a hand-run `DELETE` can, and a detail page that threw over it would be unable to show the
     * operator the very order they were investigating.
     */
    paymentCollectedAt: payment?.collectedAt?.toISOString() ?? null,
    paymentReference: payment?.reference ?? null,
    shipments: shipments.map((shipment) => toAdminShipment(shipment)),
  };
}

/**
 * `shipments.status` -> the wire vocabulary.
 *
 * A `Record` keyed on the database enum rather than `value.toLowerCase()`, and this is the exact
 * enum `order.mapper.ts` names as the reason that shortcut is wrong: `IN_TRANSIT` lowercases to
 * `in_transit`, while every hyphenated value in this project's wire vocabularies —
 * `out-for-delivery`, `quote-requested` — says the spelling is `in-transit`. The map requires a row
 * per member and typechecks each against the wire union, so neither side can grow alone.
 */
const SHIPMENT_STATUS: Readonly<Record<ShipmentStatus, AdminShipmentStatus>> = {
  [ShipmentStatus.PENDING]: 'pending',
  [ShipmentStatus.DISPATCHED]: 'dispatched',
  [ShipmentStatus.IN_TRANSIT]: 'in-transit',
  [ShipmentStatus.DELIVERED]: 'delivered',
  [ShipmentStatus.RETURNED]: 'returned',
};

/**
 * One dispatch.
 *
 * `courier` is non-null on the wire because the endpoint that creates a shipment requires it, while
 * the column is nullable — a row written before this milestone, or by hand, could hold null, so it
 * falls back to an empty string rather than sending null against a `string` field or throwing on a
 * detail page an operator is trying to read.
 */
export function toAdminShipment(shipment: Shipment): AdminShipment {
  return {
    id: shipment.id,
    courier: shipment.courier ?? '',
    trackingNumber: shipment.trackingNumber,
    status: SHIPMENT_STATUS[shipment.status],
    shippedAt: shipment.shippedAt?.toISOString() ?? null,
    deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
    createdAt: shipment.createdAt.toISOString(),
  };
}

/**
 * Brief §33's **Customer** column, and the detail an operator needs to ring somebody.
 *
 * **Contact details come from the order's own `address_snapshot`, not from the account**, for the
 * three reasons `order.mapper.ts` gives about `email` — `orders` has no contact columns, `user_id`
 * is nullable because guest checkout is supported, and a signed-in customer's order contact may
 * legitimately differ from their account's. These are the details the parcel was addressed with,
 * which is what a delivery query is actually about.
 *
 * `userId` is therefore the only field that reports the *account*, and it is null for a guest
 * order. It is a link, not a contact detail: plan 9.3's `GET /admin/customers/:id` is addressed by
 * it, and without it "no account" and "an account whose holder shares the delivery name" are
 * indistinguishable.
 *
 * `companyName` is the order's snapshotted column rather than `business.name`, so it survives the
 * business being renamed or deleted exactly as the address survives the address book being edited.
 * `businessId` is `SET NULL`, so a company name can outlive its id — both are reported as they are
 * rather than reconciled.
 */
export function toAdminOrderCustomer(order: Order): AdminOrderCustomer {
  return {
    userId: order.userId,
    name: order.addressSnapshot.fullName,
    email: order.addressSnapshot.email,
    phone: order.addressSnapshot.phone,
    businessId: order.businessId,
    companyName: order.companyName,
  };
}

/**
 * One row of `GET /admin/orders` — brief §33's seven columns and no more.
 *
 * **The one mapper here that does not go through `toAccountOrder`, and it must not.** That function
 * refuses to map an order whose `items` and `events` are unloaded, by design; the list deliberately
 * loads neither, because a page of 24 orders would otherwise be 24 baskets and 24 timelines joined
 * in. So this reads only columns that live on `orders` itself, and the compiler is what keeps it
 * honest: `AdminOrderSummary` has no field that would need a relation.
 *
 * The four vocabulary conversions are `order.mapper.ts`'s own `Record`s, imported rather than
 * repeated — `channel` and the two payment enums are `UPPERCASE` in the column and lowercase on the
 * wire, while `status` is already stored in the wire spelling. Getting that asymmetry backwards is
 * invisible to the compiler (every one of them is a `string`) and renders an empty badge rather
 * than an error, which is that file's stated reason for existing.
 *
 * `total` is `totalPaise` through `toRupees`, once — spec §8's boundary. It is the GST-inclusive
 * figure, the same one the dashboard's revenue cards sum, so the list and the cards cannot disagree
 * about what an order was worth.
 */
export function toAdminOrderSummary(order: Order): AdminOrderSummary {
  return {
    id: order.orderNumber,
    customer: toAdminOrderCustomer(order),
    channel: toWireChannel(order.channel),
    status: toWireOrderStatus(order.status, `order ${order.orderNumber}`),
    total: toRupees(order.totalPaise),
    paymentMethod: toWirePaymentMethod(order.paymentMethod),
    paymentStatus: toWirePaymentStatus(order.paymentStatus),
    placedAt: order.placedAt.toISOString(),
  };
}
