import type {
  Address as WireAddress,
  CouponPreviewResponse,
  PincodeCheckResponse,
  PlaceOrderRequest,
  PlaceOrderResult,
} from "@/contract";
import { http } from "@/lib/http";
import type { Address, CheckoutFormValues } from "../schema";

/**
 * The header `IdempotencyInterceptor` reads, spelled once.
 *
 * `IDEMPOTENCY_HEADER` in `backend/src/common/http/idempotency.interceptor.ts` is lower-case because
 * Node normalises incoming header names and `request.headers` is keyed that way; on the wire the
 * canonical spelling is what a client sends, and header names are case-insensitive, so the two are
 * the same header. Exported so the route stub matches on this constant rather than on a second
 * string literal that could drift by a hyphen.
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * Strips a value the DTO would rather not see at all.
 *
 * `@IsOptional()` in class-validator skips its sibling validators only for `undefined` and `null`;
 * an **empty string is a present value**, so every other decorator runs against it. That is not
 * academic — `CheckoutForm`'s `defaultValues` initialise every optional field to `""`, and on
 * `PlaceOrderDto` that means `companyName` fails `@MinLength(2)` and `gstin` fails
 * `@Matches(GSTIN_REGEX)`. Posting the form object therefore answers **400 naming `companyName` and
 * `gstin`** on a plain retail order, for two fields whose section never rendered.
 */
const omitEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/**
 * An address with its untouched optional second line absent rather than empty.
 *
 * **The required fields go through verbatim, deliberately un-trimmed**, and the asymmetry with
 * `omitEmpty` matters. `addressSchema` bounds `fullName` at `min(2)`, which two spaces satisfy — so
 * trimming here would send `""` to a `@MinLength(2)` the form had just told the customer they had
 * passed, and they would meet a 400 naming a field that looks filled in. Every required field is
 * therefore exactly what the browser validated. Trimming is only ever applied where the result is an
 * *omission*, which no validator can be surprised by.
 */
function toWireAddress(address: Address): WireAddress {
  const line2 = omitEmpty(address.line2);
  return {
    fullName: address.fullName,
    phone: address.phone,
    email: address.email,
    line1: address.line1,
    ...(line2 === undefined ? {} : { line2 }),
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

/**
 * The validated form, rebuilt as the request `PlaceOrderDto` accepts.
 *
 * **Built field by field rather than spread from `values`**, which is the whole point. Every
 * omission below is one the DTO needs — see `omitEmpty` for why `""` is not the same as absent — and
 * a spread would put them all back the next time someone adds a field to the form.
 *
 * Three specifics worth stating, because each is a rule rather than a tidy-up:
 *
 * - **`line2: ""` validates and is *stored*.** `toSnapshot` (`checkout.service.ts:71`) omits only
 *   `undefined`, so an untouched landmark line becomes an empty string on the invoice snapshot
 *   instead of being absent. `couponCode: ""` is harmless by comparison —
 *   `checkout.service.ts:462` treats an empty or whitespace code as no coupon — but it is stripped
 *   with the rest so nothing depends on that leniency.
 * - **`billing` and `billingSameAsShipping` travel together, and only when billing *differs*.** The
 *   service reads `dto.billingSameAsShipping === false && dto.billing !== undefined`, so an omitted
 *   flag already means "the same as shipping". Sending a billing block the customer had unticked and
 *   re-ticked would store a snapshot they disowned.
 * - **No lines, no quantities, no totals.** Spec §13: the server recomputes money from its own cart
 *   row, so there is nothing about the basket for this function to get wrong.
 *
 * The field sets match exactly — `CheckoutFormValues` and `PlaceOrderDto` carry the same nine fields
 * and their address objects agree field for field — so unlike `PUT /cart` there is no
 * `forbidNonWhitelisted` hazard here. That is a measured fact rather than a licence to spread: what
 * makes this safe is the omission, not the overlap.
 */
export function toPlaceOrderRequest(values: CheckoutFormValues): PlaceOrderRequest {
  const couponCode = omitEmpty(values.couponCode);
  const companyName = omitEmpty(values.companyName);
  const gstin = omitEmpty(values.gstin);
  const poNumber = omitEmpty(values.poNumber);
  const specialInstructions = omitEmpty(values.specialInstructions);
  // Read as one value rather than a flag plus a lookup, so the `false` case cannot be sent without
  // the address it makes mandatory — `@ValidateIf` on the DTO rejects exactly that pairing.
  const billing = values.billingSameAsShipping === false ? values.billing : undefined;

  return {
    shipping: toWireAddress(values.shipping),
    paymentMethod: values.paymentMethod,
    ...(couponCode === undefined ? {} : { couponCode }),
    ...(companyName === undefined ? {} : { companyName }),
    ...(gstin === undefined ? {} : { gstin }),
    ...(poNumber === undefined ? {} : { poNumber }),
    ...(specialInstructions === undefined ? {} : { specialInstructions }),
    ...(billing === undefined
      ? {}
      : { billingSameAsShipping: false, billing: toWireAddress(billing) }),
  };
}

export const checkoutApi = {
  /**
   * `POST /checkout/pincode` — the first checkout seam off the mock.
   *
   * **What the mock got wrong, and why the answers move.** It tested `/^[2-8]\d{5}$/`, which
   * conflated two questions: whether six digits are well-formed, and whether we deliver there. So
   * every Delhi pincode came back "not serviceable" — while `serviceable_pincodes` says prefix `1`
   * *is* serviceable, and the table is admin-editable and therefore the authority. The server now
   * answers the second question from that table and the first with a `400`.
   *
   * It also **derived** a per-pincode ETA (`2 + digitSum % 5`, so 2–6 days). The server has one
   * `etaDays` column per prefix, seeded flat at 4 — so any expectation that told two pincodes apart
   * by their ETA was pinning a mock behaviour that no longer exists.
   *
   * A `POST` because spec §6.1 lists it in the public block as one, beside
   * `POST /checkout/coupon/preview`. Through `http` rather than `fetch` because `CsrfGuard` is global:
   * an unsafe method with no `X-CSRF-Token` echoing the readable `nn_csrf` cookie is a 403, which this
   * component would render as nothing at all.
   */
  checkPincode: (pincode: string): Promise<PincodeCheckResponse> =>
    http.post<PincodeCheckResponse>("/checkout/pincode", { pincode }),

  /**
   * `POST /checkout/coupon/preview` — whether the code applies to *this* basket, and for how much.
   *
   * It carries the code and nothing else, deliberately: `PreviewCouponDto` takes no subtotal and no
   * category, because a client-supplied figure would decide `minOrderValue` eligibility against a
   * basket the caller does not have. The server reads the same cart row `GET /cart` returns.
   *
   * The refusal arm is a **200 carrying a reason**, not an error, so `ApiRequestError` never fires
   * for an ineligible coupon and the caller branches on `eligible`.
   */
  previewCoupon: (code: string): Promise<CouponPreviewResponse> =>
    http.post<CouponPreviewResponse>("/checkout/coupon/preview", { code }),

  /**
   * `POST /checkout/orders` — spec §10.4, and the end of the mocked order.
   *
   * **The response *is* the order.** `PlaceOrderResult` is an alias of `AccountOrder`, so what comes
   * back is the exact shape the account area renders — which is what lets a guest's confirmation
   * work at all: their order is written with `userId: null` and
   * `GET /account/orders/:orderNumber` is session-scoped, so they could never fetch it again.
   *
   * `idempotencyKey` is the caller's, not this function's, and that is the whole mechanism. One key
   * per *attempt* — held in a ref across renders and re-sent unchanged on a retry — is what lets
   * `IdempotencyInterceptor` replay the first response instead of placing a second order. Minting it
   * here, once per call, would give every click a fresh key and defeat the interceptor exactly as
   * thoroughly as not sending one.
   */
  placeOrder: (values: CheckoutFormValues, idempotencyKey: string): Promise<PlaceOrderResult> =>
    http.post<PlaceOrderResult>("/checkout/orders", toPlaceOrderRequest(values), {
      [IDEMPOTENCY_HEADER]: idempotencyKey,
    }),
};

/**
 * **The `nn.order.${id}` receipt is gone, and this note is what is left of it.**
 *
 * `saveOrder` wrote the placed order into `sessionStorage` and `getOrder` read it back, because in
 * Phase 1 there was nowhere else for a just-placed order to live. Task 13 narrowed it from an
 * invention — a random order number, a `+4 days` ETA and the client's own tax arithmetic — to a cache
 * of the server's own figures, and the two things that read it are now gone with it: `fromReceipt`
 * reconstructed an order out of it (Task 19), and `/order-success/$id` rendered its detail block from
 * a single synchronous read (Task 23), which is why a reload in a new tab reported the order's details
 * "not available in this browser session".
 *
 * **What replaced it is not a second store but the query cache.** `CheckoutForm` writes the placement
 * response — `PlaceOrderResult` *is* `AccountOrder` — into `accountKeys.order(order.id)`, the key the
 * confirmation reads and `GET /account/orders/:orderNumber` fills. A signed-in customer's reload
 * re-fetches it; a guest's cannot, and that screen says so rather than pretending the order is
 * missing. Nothing in `frontend/src` touches `sessionStorage` any more.
 */
