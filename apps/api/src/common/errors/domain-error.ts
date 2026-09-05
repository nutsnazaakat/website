import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A business-rule rejection carrying a stable machine-readable `code`.
 *
 * The code is what a client switches on — `OUT_OF_STOCK` needs different UI from
 * `COUPON_EXPIRED` — and it must not change when the human-readable message is reworded.
 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class DomainError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

/** The codes this service emits. Add here rather than inventing a string at a throw site. */
export const ErrorCodes = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_IN_USE: 'EMAIL_IN_USE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  BELOW_MOQ: 'BELOW_MOQ',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',
  // A coupon can be refused for reasons the customer can act on and reasons they cannot, and the
  // distinction cannot be recovered once it is collapsed into a single "not valid". `COUPON_INVALID`
  // means stop retyping it; `COUPON_MIN_ORDER_VALUE` means add ₹500 and it works;
  // `COUPON_NOT_APPLICABLE` means it is real but not for this basket; `COUPON_FIRST_ORDER_ONLY` is
  // the one refusal that would otherwise be reported as `COUPON_LIMIT_REACHED`, which tells a
  // returning customer to wait for a limit to reset that never will.
  COUPON_MIN_ORDER_VALUE: 'COUPON_MIN_ORDER_VALUE',
  COUPON_NOT_APPLICABLE: 'COUPON_NOT_APPLICABLE',
  COUPON_FIRST_ORDER_ONLY: 'COUPON_FIRST_ORDER_ONLY',
  PAYMENT_METHOD_UNAVAILABLE: 'PAYMENT_METHOD_UNAVAILABLE',
  PINCODE_NOT_SERVICEABLE: 'PINCODE_NOT_SERVICEABLE',
  ILLEGAL_STATUS_TRANSITION: 'ILLEGAL_STATUS_TRANSITION',
  CART_EMPTY: 'CART_EMPTY',
  NOT_FOUND: 'NOT_FOUND',
  // Both of these were being thrown as bare string literals before the registry was enforced —
  // exactly the drift the comment above warns against, and invisible while `code` was a plain
  // `string`. Narrowing the constructor turned them into typecheck failures.
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  /**
   * A destructive admin action refused because history references the row — Milestone 9.
   *
   * Separate from `VALIDATION_FAILED` because nothing about the request was wrong: the operator
   * asked a legal question and the answer is "not while this has been sold". The admin console
   * branches on it to offer unpublish or deactivate instead of a delete, which a generic
   * validation failure gives it no way to do. `details` names what referenced the row.
   */
  ENTITY_IN_USE: 'ENTITY_IN_USE',
  /**
   * A slug or SKU already taken — Milestone 9.
   *
   * One code, not three: `products.slug`, `categories.slug` and `product_variants.sku` are all
   * unique indexes, and the actionable advice is identical in every case ("choose another"). The
   * refused value and which field it was travel in `details`, which is where a client that wants
   * to highlight one input reads them from.
   */
  IDENTIFIER_IN_USE: 'IDENTIFIER_IN_USE',
  /**
   * A pricing tier whose quantity range overlaps one that already exists — Milestone 9, plan 9.3.
   *
   * Separate from `VALIDATION_FAILED` because nothing about the request is malformed: every field is
   * a legal value, and the refusal is about the ladder the row would join. Separate from
   * `IDENTIFIER_IN_USE` because no identifier is duplicated — two rungs can share every column and
   * still be legal if their ranges are disjoint. The console branches on it to point at the rung
   * that is in the way, which `details` names along with its bounds.
   *
   * **Why it is refused at all**: `pricing.resolver.ts` builds one ladder for a viewer and
   * `bulkTierFor` takes the **first** rung whose range contains the weight, over an array sorted by
   * `minKg`. Two overlapping rungs therefore make the price depend on row order — and
   * `CheckoutService` snapshots the resolved rate onto the invoice, so the disagreement is a
   * money one, not a display one.
   */
  PRICING_TIER_OVERLAP: 'PRICING_TIER_OVERLAP',
} as const;
