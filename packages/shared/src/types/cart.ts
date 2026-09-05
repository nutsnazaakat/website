import type { Channel } from './catalog';

/**
 * One basket line. Moved out of `frontend/src/features/cart/types.ts` because the server now owns
 * the cart and has to produce this shape.
 *
 * Deliberately carries **no price, name or image**. Prices are resolved live on every read, so a
 * basket built before a price change bills the new price — which is what the customer sees on the
 * product page at the moment they check out. A cached price on the line is how a cart comes to
 * disagree with the catalogue.
 */
export interface CartLine {
  id: string;
  slug: string;
  mode: Channel;
  /** Retail only. */
  size?: string;
  /** Retail only. */
  grams?: number;
  /** Bulk only. */
  kg?: number;
  qty: number;
}

/** Money totals for a basket, in rupees, matching the frontend's existing contract. */
export interface CartTotals {
  subtotal: number;
  gst: number;
  shipping: number;
  total: number;
  /**
   * True when any line resolves to a quote-required bulk tier.
   *
   * Narrow on purpose: this is the flag that routes a basket onto the **business** track. The cart page
   * offers "Request Quote" on it and `CheckoutForm` switches to `b2bCheckoutSchema`, which requires a
   * GSTIN. So it must mean "needs a quote" and nothing else — a basket whose only problem is a sold-out
   * pack is not a B2B order, and asking that customer for a GST number is a dead end.
   */
  hasQuoteLines: boolean;

  /**
   * True when any line was left out of the money for **any** reason — a quote-required tier, a
   * sold-out variant, a quantity under the minimum, a slug the catalogue no longer has.
   *
   * This is the honest one: it says the displayed total does not cover the whole basket, which the
   * customer needs to know regardless of *why*. `hasQuoteLines` implies it; the converse does not hold,
   * and collapsing the two is what put a retail customer with one empty pack on the business track.
   * `POST /cart/validate` supplies the per-line reason.
   */
  hasUnpriceableLines: boolean;
}

/**
 * The reasons a cart line can be rejected.
 *
 * Every entry must also exist in the backend's `ErrorCodes` registry
 * (`backend/src/common/errors/domain-error.ts`), because these are the same codes a client sees on
 * an `ApiError.code` when the equivalent rule is enforced at checkout rather than at validation.
 * The registry cannot be the source of truth for this type: `shared/` must not import from
 * `backend/` — the dependency runs the other way — and moving the whole registry here is a wider
 * change than this contract needs.
 *
 * So the drift guard belongs on the backend side, where both names are in scope. The cart service
 * owes a compile-time assertion that this vocabulary is a subset of the registry, e.g.
 *
 * ```ts
 * const _codesExist: Record<CartValidationCode, ErrorCode> = {
 *   OUT_OF_STOCK: ErrorCodes.OUT_OF_STOCK,
 *   BELOW_MOQ: ErrorCodes.BELOW_MOQ,
 *   QUOTE_REQUIRED: ErrorCodes.QUOTE_REQUIRED,
 *   NOT_FOUND: ErrorCodes.NOT_FOUND,
 * };
 * ```
 *
 * Without it, renaming a registry entry leaves this list quietly describing a code the server has
 * stopped sending, and the client keeps branching on it. Declared as a tuple rather than a bare
 * union so that assertion — and a client narrowing a `string` code off `ApiError` — has something
 * to check membership against at runtime.
 */
export const CART_VALIDATION_CODES = [
  'OUT_OF_STOCK',
  'BELOW_MOQ',
  'QUOTE_REQUIRED',
  'NOT_FOUND',
] as const;

export type CartValidationCode = (typeof CART_VALIDATION_CODES)[number];

/** One line's verdict from `POST /cart/validate`. */
export interface CartValidationLine {
  id: string;
  slug: string;
  /** Present when the product or variant no longer exists, so the line cannot be priced. */
  unavailable: boolean;
  /** `onHand - reserved` for the resolved variant. Null for a bulk line, which is not variant-bound. */
  availableQty: number | null;
  /** The quantity requested by the line, echoed so a caller need not re-read the cart. */
  requestedQty: number;
  /** The live line total in rupees, or null when the line needs a quote. */
  lineTotal: number | null;
  /** Machine-readable reason, when there is a problem. */
  code?: CartValidationCode;
}

/** The whole verdict. `ok` is true only when no line has a `code`. */
export interface CartValidationResult {
  ok: boolean;
  lines: CartValidationLine[];
  totals: CartTotals;
}
