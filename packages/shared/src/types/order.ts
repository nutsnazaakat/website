import type { OrderChannel, OrderStatus } from '../constants/order-status';

export interface Address {
  fullName: string;
  phone: string;
  /**
   * Where this order's paperwork goes — the confirmation, the invoice, the tracking link.
   *
   * **Client-supplied, and it has to be.** `AddressDto.email` is `@IsEmail()` and required, the
   * checkout form sends it, and checkout is open to guests — who have no session to populate it
   * from, and who are exactly the customers for whom this is the only contact the order has. A
   * signed-in customer's order email may also legitimately differ from their account email: a gift
   * sent to a relative, a consignment to a work address. The two are not expected to match.
   *
   * **It is data on the order, never a key that grants access to it.** Spec §13: order history is
   * scoped by `userId`, and one order is fetched by `orderNumber` within that scope. Filtering or
   * authorising on an email the caller supplied is the IDOR hole — anyone who knows an address
   * could read its orders — which is why `OrderFilters` has no email field.
   */
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

/** An entry in the account address book. */
export interface SavedAddress extends Address {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface OrderEvent {
  status: OrderStatus;
  at: string;
  note?: string;
}

export interface OrderLine {
  slug?: string;
  name: string;
  /** Pack size for a retail line, "25 kg" for a bulk one. */
  detail: string;
  qty: number;
  /** Null when the line was fulfilled against a negotiated quote. */
  total: number | null;
}

export type PaymentMethod = 'cod' | 'online';
export type PaymentStatus = 'pending' | 'collected' | 'failed' | 'refunded';

export interface AccountOrder {
  /** `NN-{year}-{at least 6 digits}` — the order number, never the uuid. See `ORDER_NUMBER_PATTERN`. */
  id: string;
  email: string;
  channel: OrderChannel;
  status: OrderStatus;
  placedAt: string;
  estimatedDelivery: string;
  /** Oldest first. The last entry always matches `status`. */
  timeline: OrderEvent[];
  items: OrderLine[];
  subtotal: number;
  discount: number;
  gst: number;
  shipping: number;
  total: number;
  address: Address;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  couponCode?: string;
  companyName?: string;
  gstin?: string;
  poNumber?: string;
}

export interface OrderFilters {
  channel?: OrderChannel;
}

/**
 * What `POST /checkout/orders` accepts.
 *
 * **Carries no lines and no money, deliberately.** Spec §13: the server recomputes subtotal, GST,
 * shipping, discount and total from the database, and client-supplied money is ignored entirely — so
 * the basket comes from the caller's own server-side cart and this request carries only the things
 * the server cannot know: where it is going, how it is being paid for, and the B2B fields.
 *
 * Every field here exists on `PlaceOrderDto`; the two are checked against each other by the
 * backend's own compilation, since the controller binds the DTO and answers `PlaceOrderResult`.
 */
export interface PlaceOrderRequest {
  shipping: Address;
  paymentMethod: PaymentMethod;
  couponCode?: string;
  companyName?: string;
  gstin?: string;
  poNumber?: string;
  billingSameAsShipping?: boolean;
  billing?: Address;
  specialInstructions?: string;
}

/**
 * What placement returns: the created order, in the same shape the account area already renders.
 *
 * **An alias, not a copy.** The success screen and the order-detail screen render the same order, so
 * a separate "created order" interface would be a second definition of one thing — and the one that
 * drifts. It is also what lets a guest's confirmation screen work at all: a guest's order has
 * `userId: null` and cannot be re-fetched, so the placement response *is* the order they are shown.
 */
export type PlaceOrderResult = AccountOrder;

/**
 * Why a coupon was refused.
 *
 * **The reason, not a boolean.** A customer can act on `COUPON_MIN_ORDER_VALUE` — add ₹500 and it
 * works — and cannot act on `COUPON_INVALID`; collapse them into one "not valid" and the distinction
 * cannot be recovered downstream.
 *
 * `backend/src/modules/checkout/coupon.service.ts` keeps a `Record<CouponRefusalCode, ErrorCode>`
 * checking every member against the error registry in both directions. That guard cannot live here —
 * `shared` has no access to `ErrorCodes` — so it stays in the backend, pointed at this declaration.
 */
export type CouponRefusalCode =
  | 'COUPON_INVALID'
  | 'COUPON_EXPIRED'
  | 'COUPON_NOT_APPLICABLE'
  | 'COUPON_MIN_ORDER_VALUE'
  | 'COUPON_FIRST_ORDER_ONLY'
  | 'COUPON_LIMIT_REACHED';

/**
 * What `POST /checkout/coupon/preview` returns.
 *
 * Money in rupees, per §8's boundary rule: the service works in `bigint` paise and converts once,
 * here. A stringified paise value would not throw — `BigInt.prototype.toJSON` is patched — it would
 * quietly render as `₹NaN` or concatenate, which is the failure this shape exists to prevent.
 *
 * A discriminated union whose two arms deliberately do **not** share a field name for two meanings:
 * `couponCode` on the accepted arm, `reason` on the refused one. The service's internal type uses
 * `code` for the refusal *reason*, which is a landmine for whoever reads `result.code` next, and the
 * wire does not inherit it. `couponId` is on neither arm — an internal uuid nothing on the page needs.
 */
export type CouponPreviewResponse =
  | {
      eligible: true;
      /** The coupon's canonical, stored spelling — `save10` typed, `SAVE10` returned. */
      couponCode: string;
      discount: number;
      /** What the discount was taken from: the whole subtotal, or a category's share of it. */
      eligibleSubtotal: number;
    }
  | {
      eligible: false;
      reason: CouponRefusalCode;
      /** Only on `COUPON_MIN_ORDER_VALUE`: the figure the customer has to reach, in rupees. */
      minOrderValue?: number;
    };

/**
 * What `POST /checkout/pincode` returns — spec §6.1's *"serviceability + ETA + shipping"*, in the
 * **public** block, because the checker sits on the product page and is reachable anonymously.
 *
 * Money in rupees, per §8's boundary rule. `PincodeVerdict.shippingPaise` is a `bigint` and the
 * controller converts it once with `toRupees`. A stray paise value would not throw —
 * `BigInt.prototype.toJSON` is patched — it would quietly ship the *string* `"7900"`, which is
 * exactly the failure that patch exists to make visible rather than fatal.
 *
 * `serviceable`, not the entity's `isServiceable`: this is the spelling `PincodeChecker.tsx` already
 * renders, and the wire is not obliged to inherit a column name.
 *
 * **`matchedPrefix` is deliberately absent.** `PincodeVerdict` carries it so a caller can log *why* a
 * pincode was refused; which region row outranked a customer's pincode is not something to tell the
 * customer, and it is the one field of the verdict that describes the table rather than the delivery.
 */
export interface PincodeCheckResponse {
  /** Echoed back, so an answer can be matched to the pincode that was asked about. */
  pincode: string;
  serviceable: boolean;
  /**
   * Working days from dispatch, and **meaningless when `serviceable` is false** — where it is also
   * not reliably zero. `PincodeService` answers `0` when no row matched at all and the row's own
   * `etaDays` when a stored row refused, so the seeded `9` prefix reports four days it will never
   * deliver in. Read it only on the serviceable arm.
   */
  etaDays: number;
  /**
   * The per-destination charge in rupees, before the free-shipping threshold.
   *
   * What delivery to this pincode costs, not what a basket will be billed: the order's shipping is
   * this figure *or zero*, decided at placement by `CheckoutService.shippingFor` against the
   * subtotal. A page that prints this as the customer's shipping line will overcharge every basket
   * over `freeShippingThreshold`.
   */
  shipping: number;
}
