import {
  GSTIN_REGEX,
  type CartLine,
  type CartTotals,
  type CouponPreviewResponse,
  type OrderLine,
  type PincodeCheckResponse,
  type PlaceOrderRequest,
  type PlaceOrderResult,
} from "@/contract";
import { lineTotal } from "@/features/cart/cart-math";
import { IDEMPOTENCY_HEADER } from "@/features/checkout/api";
import { products } from "@/mocks/products";
import { recordPlacedOrder } from "./account-api.stub";
import { consumeStoredCart } from "./cart-api.stub";

/**
 * The checkout endpoints, for the route tests.
 *
 * Delegated to from `installAuthStub` for the reason the catalogue, cart and wishlist stubs are:
 * there is a single `globalThis.fetch`, so layering a second stub on top would make the tests depend
 * on installation order. Without this file the smoke suite fails with *"api stub received an
 * unexpected request: POST /api/v1/checkout/pincode"* — the dispatcher working as designed, not a
 * bug to hunt.
 *
 * Task 12 needed only `POST /checkout/pincode`; Task 13 added `POST /checkout/coupon/preview` and
 * `POST /checkout/orders` to the same handler.
 *
 * **What it models, and why the pincode table is a table rather than a regex.** `checkPincode` used
 * to be `/^[2-8]\d{5}$/` plus a digit-sum ETA, which conflated "six well-formed digits" with "we
 * deliver there" and therefore refused every Delhi pincode as malformed. The server answers
 * deliverability from `serviceable_pincodes` — longest matching prefix wins — and answers
 * malformedness with a 400. Reproducing that as a prefix table keeps the two separable here too, so
 * a test can tell a typo from a delivery limit exactly as a customer can.
 *
 * **`POST /checkout/orders` validates like `PlaceOrderDto`, and that strictness is the point.**
 * `@IsOptional()` skips its sibling validators only for `undefined`/`null`, so an empty string runs
 * them all: `companyName: ""` fails `@MinLength(2)` and `gstin: ""` fails `@Matches(GSTIN_REGEX)`.
 * A lenient stub here would accept the form object spread straight from `defaultValues` — where every
 * optional starts as `""` — and the 400 that a plain retail order actually gets against the real
 * server would be invisible to this suite. So the refusals below are the assertion: a client that
 * stops stripping empty optionals fails placement outright rather than passing quietly.
 *
 * **Three fidelity gaps to know about, because a green suite will not tell you.**
 *
 * - **No CSRF check**, matching `cart-api.stub.ts`. `CsrfGuard` is global on the server, so a `POST`
 *   with no `X-CSRF-Token` matching the readable `nn_csrf` cookie is a 403 — and mirroring that here
 *   would fail the product-page test for a reason production does not have: the real
 *   `CsrfBootstrapMiddleware` puts a token on *every* response, so any earlier `GET` seeds one, while
 *   `installAuthStub` deliberately holds no cookie for a visitor with no session. The real proof that
 *   these routes carry the header lives in `checkout.integration.spec.ts`, which asserts the 403.
 * - **No `matchedPrefix`, and no `NO_MATCH` reachable from the seeded shape.** The ten rows below are
 *   the ten leading digits, so every six-digit string matches one and the "nothing is known about
 *   this pincode" verdict — `etaDays: 0`, `shipping: 0` — cannot be produced. That is true of the
 *   seeded database too, which is why it is reproduced rather than fixed.
 * - **The money is the client's own `cart-math.ts`, not the server's arithmetic**, for the reason
 *   `cart-api.stub.ts` records: the smoke suite pins exact rupee figures derived from
 *   `src/mocks/products.ts`, and a second implementation here would either drift from them or agree
 *   today and diverge silently later. The real server computes GST per line in paise and rounds
 *   differently, which is disagreement 5 and Task 18's to record.
 */

/**
 * `backend/src/database/seeds/pincodes.seed.ts`, row for row: one rule per leading digit, four
 * working days everywhere, ₹79 where we deliver. `0` and `9` are the two prefixes India issues no
 * civilian pincodes under, so they are the honest refusals — and their `shippingPaise` is `0`, which
 * is why a refused row reports `shipping: 0` while still reporting the ETA it will never deliver in.
 */
const ETA_DAYS = 4;
const SHIPPING = 79;

/** One delivery rule, in the shape the wire carries it. */
type Rule = Omit<PincodeCheckResponse, "pincode">;

const SEEDED: Record<string, Rule> = Object.fromEntries([
  ...["1", "2", "3", "4", "5", "6", "7", "8"].map((prefix) => [
    prefix,
    { serviceable: true, etaDays: ETA_DAYS, shipping: SHIPPING },
  ]),
  ...["0", "9"].map((prefix) => [prefix, { serviceable: false, etaDays: ETA_DAYS, shipping: 0 }]),
]);

/** `/^\d{6}$/` — `PINCODE_REGEX`, which is the only thing the DTO checks. */
const WELL_FORMED = /^\d{6}$/;

/** The table the stubbed server currently holds. Reset to `SEEDED` between tests. */
let table: Record<string, Rule> = { ...SEEDED };

/**
 * `PincodeService.resolve`'s rule, not merely its current data: every prefix of the pincode is a
 * candidate and the longest match wins, so a test may add a six-digit exception row above a region
 * one and see it honoured. The zeroes are `NO_MATCH` — deliberately not the seeded four days and
 * ₹79, so a caller reading them without checking `serviceable` gets an obviously broken figure.
 */
function resolve(pincode: string): Rule {
  for (let length = pincode.length; length > 0; length--) {
    const row = table[pincode.slice(0, length)];
    if (row) return { ...row };
  }
  return { serviceable: false, etaDays: 0, shipping: 0 };
}

/** Every pincode the client has asked about, in order. */
let checks: string[] = [];

/** The coupons the stubbed server knows about, keyed by upper-cased code. */
let coupons: Record<string, CouponPreviewResponse> = {};

/** Every `POST /checkout/orders` body the client has sent, in order. */
let placements: PlaceOrderRequest[] = [];

/** The `Idempotency-Key` header of every placement attempt, in order — including refused ones. */
let attemptKeys: (string | undefined)[] = [];

/** Every order this stub has issued, in order. */
let issued: PlaceOrderResult[] = [];

/** `idempotency_keys`, in miniature: the claimed key against its request hash and its answer. */
let claimed: Record<string, { hash: string; body: PlaceOrderResult }> = {};

/** An arranged placement failure, so a test can reach the form's error state and its retry. */
let placementFailure: string | undefined;

/**
 * The order-number sequence, which is deliberately **not** random.
 *
 * `NN-{year}-{6 digits}` allocated from Postgres is what the real service does, and the old mock
 * generated `Math.floor(Math.random() * 900000) + 100000` client-side. Both satisfy
 * `ORDER_NUMBER_PATTERN`, so a test asserting only the *shape* of the rendered id passes just as
 * happily against a client that never sent the request — the exact trap this plan keeps producing. A
 * known sequence lets a case assert the id the *server* issued.
 */
let sequence = 0;

export function resetCheckoutStub(): void {
  checks = [];
  table = { ...SEEDED };
  coupons = {};
  placements = [];
  attemptKeys = [];
  issued = [];
  claimed = {};
  placementFailure = undefined;
  sequence = 0;
}

/**
 * Adds or replaces one rule, which is what an admin editing `serviceable_pincodes` does.
 *
 * **The point is to answer something the seed does not**, so a test can prove a figure was *read
 * from the response* rather than hardcoded next to the markup. Measured: replacing
 * `{data.etaDays}` in `PincodeChecker.tsx` with a literal `4` failed **none** of the 67 cases in
 * `routes.smoke.test.tsx` — every seeded prefix carries four days, so a test that only ever sees the
 * seeded figure cannot tell the two apart. That mutant was not hypothetical: it is exactly
 * disagreement 3's `addDays(new Date(), 4)`, which was still live in `CheckoutForm`'s Shipping card
 * until Task 13 pointed it at this endpoint.
 *
 * A longer prefix than the seeded single digit wins on length, so a six-digit row overrides the
 * region rule it sits inside — the same carve-out `PincodeService` supports.
 */
export function seedPincodeRule(prefix: string, rule: Rule): void {
  table[prefix] = rule;
}

/**
 * Arranges what `POST /checkout/coupon/preview` answers for one code.
 *
 * A table rather than a rule engine: `CouponService.preview` applies nine eligibility rules against
 * the caller's own basket, and reproducing them here would be a second implementation of the thing
 * `coupon.service.spec.ts` already proves. What the *form* has to get right is narrower — send the
 * code, render the discount, and render the right sentence for each of the six refusal reasons — so
 * the arrangement is the verdict itself.
 *
 * An unseeded code answers `COUPON_INVALID`, which is what the real service answers for a code no
 * row matches.
 */
export function seedCoupon(code: string, verdict: CouponPreviewResponse): void {
  coupons[code.toUpperCase()] = verdict;
}

/** Makes the next `POST /checkout/orders` fail with `message`, as a 422 the form must surface. */
export function failPlacement(message: string): void {
  placementFailure = message;
}

/** Clears an arranged failure, so a retry can succeed. */
export function allowPlacement(): void {
  placementFailure = undefined;
}

/**
 * The pincodes the client has posted, in order.
 *
 * The analogue of `lastCartWrite()`, and load-bearing for the same reason: `http.post` takes its body
 * as `unknown`, so `tsc` cannot see a client that sends `{ code }` instead of `{ pincode }`, or that
 * stops sending a body at all. Without this, a test can only assert what was *rendered*, and a stub
 * that answered the same verdict for every request would satisfy it.
 */
export function pincodeChecks(): string[] {
  return checks;
}

/**
 * Every placement body the client has sent, in order — the analogue of `cartWrites()`.
 *
 * This is what makes "sends what it validates" assertable at all. `toPlaceOrderRequest` omits every
 * optional whose value is `""`, and **no type can see that**: `PlaceOrderRequest`'s optional fields
 * accept `string | undefined`, so a client that sent `companyName: ""` on a retail order would
 * typecheck perfectly. Only the recorded body, or the 400 the validator below answers, can tell.
 */
export function placementRequests(): PlaceOrderRequest[] {
  return placements;
}

/** The most recent placement body, or undefined when there has been none. */
export function lastPlacement(): PlaceOrderRequest | undefined {
  return placements.at(-1);
}

/**
 * The `Idempotency-Key` of every attempt, in order.
 *
 * Includes refused attempts, which is the whole point: one key per *attempt* means a retry after a
 * failure presents the **same** key, and a key minted inside the submit handler would present two
 * different ones. Nothing rendered can distinguish those, so this is the only place the rule is
 * observable.
 */
export function idempotencyKeys(): (string | undefined)[] {
  return attemptKeys;
}

/** Every order this stub has issued, in order. */
export function issuedOrders(): PlaceOrderResult[] {
  return issued;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });

const created = <T>(data: T): Response => json(201, { success: true, data });

function failure(
  status: number,
  message: string,
  code: string,
  path: string,
  method: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-21T00:00:00.000Z",
    path,
    method,
    message,
    code,
    ...(details === undefined ? {} : { details }),
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

function validationFailed(
  details: Record<string, string[]>,
  path: string,
  method: string,
): Response {
  return json(400, {
    success: false,
    statusCode: 400,
    timestamp: "2026-08-21T00:00:00.000Z",
    path,
    method,
    message: "Validation failed",
    code: "VALIDATION_FAILED",
    details,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/** `ConflictException` carries a message and no `code`, unlike a `DomainError`. */
function conflict(message: string, path: string, method: string): Response {
  return json(409, {
    success: false,
    statusCode: 409,
    timestamp: "2026-08-21T00:00:00.000Z",
    path,
    method,
    message,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/** `AddressDto`'s fields, so an extra one is refused rather than stripped. */
const ADDRESS_FIELDS = new Set([
  "fullName",
  "phone",
  "email",
  "line1",
  "line2",
  "city",
  "state",
  "pincode",
]);

/** `PlaceOrderDto`'s fields, same reason. */
const ORDER_FIELDS = new Set([
  "shipping",
  "paymentMethod",
  "couponCode",
  "companyName",
  "gstin",
  "poNumber",
  "billingSameAsShipping",
  "billing",
  "specialInstructions",
]);

/**
 * The rules `AddressDto` applies, in the order class-validator reports them.
 *
 * Every bound is the column width the DTO cites, not a round number, so an address that clears this
 * check is one the address book could also store.
 */
function addressErrors(prefix: string, raw: unknown): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null) {
    details[prefix] = ["shipping must be an object"];
    return details;
  }
  const address = raw as Record<string, unknown>;

  for (const key of Object.keys(address)) {
    if (!ADDRESS_FIELDS.has(key))
      details[`${prefix}.${key}`] = [`property ${key} should not exist`];
  }

  const bounded = (key: string, min: number, max: number): void => {
    const value = address[key];
    if (typeof value !== "string") {
      details[`${prefix}.${key}`] = [`${key} must be a string`];
      return;
    }
    if (value.length < min) {
      details[`${prefix}.${key}`] = [`${key} must be longer than or equal to ${min} characters`];
    } else if (value.length > max) {
      details[`${prefix}.${key}`] = [`${key} must be shorter than or equal to ${max} characters`];
    }
  };

  bounded("fullName", 2, 120);
  bounded("line1", 4, 255);
  bounded("city", 2, 80);
  bounded("state", 2, 80);

  if (typeof address.email !== "string" || !address.email.includes("@")) {
    details[`${prefix}.email`] = ["email must be an email"];
  }
  if (typeof address.phone !== "string" || !/^[6-9]\d{9}$/.test(address.phone)) {
    details[`${prefix}.phone`] = ["Enter a valid 10-digit Indian mobile number"];
  }
  if (typeof address.pincode !== "string" || !WELL_FORMED.test(address.pincode)) {
    details[`${prefix}.pincode`] = ["Enter a valid 6-digit pincode"];
  }
  // `@IsOptional() @IsString() @MaxLength(255)`: absent is fine, `""` is a *present* value and runs
  // the rest — which it happens to pass, and is then **stored** on the invoice snapshot. That is why
  // the client strips it rather than relying on this being lenient.
  if (address.line2 !== undefined) {
    if (typeof address.line2 !== "string") {
      details[`${prefix}.line2`] = ["line2 must be a string"];
    } else if (address.line2.length > 255) {
      details[`${prefix}.line2`] = ["line2 must be shorter than or equal to 255 characters"];
    }
  }

  return details;
}

/**
 * `PlaceOrderDto`, decorator for decorator, for the optionals that matter.
 *
 * The four rows of the task's validator table are the whole reason this function exists:
 * `companyName: ""` fails `@MinLength(2)`, `gstin: ""` fails `@Matches(GSTIN_REGEX)`, and
 * `poNumber: ""` / `specialInstructions: ""` pass. So a spread form object is refused **400 naming
 * `companyName` and `gstin`** on a plain retail order, for two fields the customer never saw.
 */
function orderErrors(raw: unknown): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;

  for (const key of Object.keys(dto)) {
    if (!ORDER_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  Object.assign(details, addressErrors("shipping", dto.shipping));

  if (dto.paymentMethod !== "cod") {
    details.paymentMethod = ["Only cash on delivery is available at the moment"];
  }

  const optionalString = (key: string, min: number, max: number): void => {
    const value = dto[key];
    if (value === undefined) return;
    if (typeof value !== "string") {
      details[key] = [`${key} must be a string`];
      return;
    }
    if (value.length < min) {
      details[key] = [`${key} must be longer than or equal to ${min} characters`];
    } else if (value.length > max) {
      details[key] = [`${key} must be shorter than or equal to ${max} characters`];
    }
  };

  optionalString("couponCode", 0, 40);
  optionalString("companyName", 2, 160);
  optionalString("poNumber", 0, 60);
  optionalString("specialInstructions", 0, 2000);

  if (dto.gstin !== undefined && (typeof dto.gstin !== "string" || !GSTIN_REGEX.test(dto.gstin))) {
    details.gstin = ["Enter a valid 15-character GSTIN"];
  }

  if (dto.billingSameAsShipping !== undefined && typeof dto.billingSameAsShipping !== "boolean") {
    details.billingSameAsShipping = ["billingSameAsShipping must be a boolean value"];
  }

  // `@ValidateIf(dto => dto.billingSameAsShipping === false)`, not `@IsOptional()`: "bill somewhere
  // else" with no address is the one request being rejected here.
  if (dto.billingSameAsShipping === false) {
    Object.assign(details, addressErrors("billing", dto.billing));
  } else if (dto.billing !== undefined) {
    Object.assign(details, addressErrors("billing", dto.billing));
  }

  return details;
}

const find = (slug: string) => products.find((product) => product.slug === slug);

/**
 * The basket as the order records it, which is **not** the shape the checkout summary builds.
 *
 * `slug` is carried through, because `OrderItem` the entity holds `productSlug` and
 * `account/orders/$id.tsx`'s `LineName` links to the product only when it is present. Disagreement 6:
 * the mock's local `OrderItem` had no `slug`, so a just-placed order rendered unlinked names while a
 * seeded one linked — and it disappears the moment the endpoint is real, which is here.
 */
function toOrderLine(line: CartLine): OrderLine {
  return {
    slug: line.slug,
    name: find(line.slug)?.name ?? line.slug,
    detail: line.mode === "bulk" ? `${String(line.kg ?? 0)} kg` : (line.size ?? ""),
    qty: line.qty,
    total: lineTotal(line, find),
  };
}

/**
 * Answers a checkout request, or returns `undefined` when the URL is not one of them so the caller
 * can offer it to the next handler.
 */
export function handleCheckoutRequest(
  url: string,
  method: string,
  init?: RequestInit,
  owner: string | null = null,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (method !== "POST") return undefined;

  if (path === "/checkout/pincode") return handlePincode(url, method, init);
  if (path === "/checkout/coupon/preview") return handleCouponPreview(url, method, init);
  if (path === "/checkout/orders") return handlePlacement(url, method, init, owner);
  return undefined;
}

function handlePincode(url: string, method: string, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}")) as { pincode?: unknown };
  const pincode = body.pincode;

  // `@Matches(PINCODE_REGEX)` on a non-string is `false`, not a throw — `class-validator`'s `matches`
  // is `typeof value === "string" && pattern.test(value)` — so a number or a missing field is the
  // same 400 as a five-digit typo, carrying the form's own message.
  if (typeof pincode !== "string" || !WELL_FORMED.test(pincode)) {
    return validationFailed({ pincode: ["Enter a valid 6-digit pincode"] }, url, method);
  }

  checks.push(pincode);
  return ok<PincodeCheckResponse>({ pincode, ...resolve(pincode) });
}

function handleCouponPreview(url: string, method: string, init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}")) as { code?: unknown };
  const code = body.code;

  // `@IsString() @MinLength(1) @MaxLength(40)`, so a missing or empty code is a 400 rather than a
  // refusal verdict — the form disables Apply on an empty input for exactly this reason.
  if (typeof code !== "string" || code.length === 0 || code.length > 40) {
    return validationFailed({ code: ["code must be a non-empty string"] }, url, method);
  }

  const verdict = coupons[code.trim().toUpperCase()] ?? {
    eligible: false as const,
    reason: "COUPON_INVALID" as const,
  };
  // A refusal is a **200 carrying a reason**, not an error: `previewCoupon` answers the customer's
  // question, and "no, because" is an answer. A 4xx would put it in `ApiRequestError` and leave the
  // component's refusal branch unreachable.
  return ok<CouponPreviewResponse>(verdict);
}

/**
 * `owner` is who was signed in when the request arrived, which becomes the order's `user_id`.
 *
 * `null` for a guest, and that is the ordinary retail path rather than an edge case: `/checkout` has
 * no route guard, so a guest's order is written with `userId: null` and neither account route can
 * ever answer with it again. Deliberately **not** `dto.shipping.email` — that field is data on the
 * order (a gift goes to the recipient's address) and never a key that grants access to it.
 */
function handlePlacement(
  url: string,
  method: string,
  init: RequestInit | undefined,
  owner: string | null,
): Response {
  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const key = headerOf(init, IDEMPOTENCY_HEADER);
  attemptKeys.push(key);

  const details = orderErrors(raw);
  if (Object.keys(details).length > 0) return validationFailed(details, url, method);
  const dto = raw as PlaceOrderRequest;

  /**
   * `IdempotencyInterceptor`, in miniature — and it runs **before** validation on the real server
   * (interceptors run before pipes), which is why the hash is over the raw body. Ordered after it
   * here only because a stub cannot answer a request it has not parsed; nothing in this suite
   * depends on the difference.
   *
   * A failed attempt leaves **no** claim, matching the interceptor's `error:` callback deleting the
   * row — or the customer's retry would meet their own key against a response that was never
   * written.
   */
  if (key !== undefined) {
    const hash = JSON.stringify(raw);
    const existing = claimed[key];
    if (existing) {
      if (existing.hash !== hash) {
        return conflict(
          "This Idempotency-Key was already used with a different request body.",
          url,
          method,
        );
      }
      // The replay. Deliberately *not* a fresh order: one key, one order, however many clicks.
      return created<PlaceOrderResult>(existing.body);
    }
  }

  if (placementFailure !== undefined) {
    return failure(422, placementFailure, "OUT_OF_STOCK", url, method);
  }

  const { serviceable } = resolve(dto.shipping.pincode);
  if (!serviceable) {
    return failure(
      422,
      `We do not deliver to ${dto.shipping.pincode} yet.`,
      "PINCODE_NOT_SERVICEABLE",
      url,
      method,
      { pincode: dto.shipping.pincode },
    );
  }

  // Read and emptied in one step, because `CheckoutService.place` does it inside the placement
  // transaction. A client that also wrote an empty basket would be a second opinion about it.
  const { lines, totals } = consumeStoredCart();
  if (lines.length === 0) {
    return failure(
      422,
      "Your basket is empty, so there is nothing to order.",
      "CART_EMPTY",
      url,
      method,
    );
  }

  const order = toPlacedOrder(dto, lines, totals);
  placements.push(dto);
  issued.push(order);
  // Filed under the placing account, so `GET /account/orders/:orderNumber` can answer with it — the
  // two stubs are one database, exactly as the two endpoints are one schema.
  recordPlacedOrder(order, owner);
  if (key !== undefined) claimed[key] = { hash: JSON.stringify(raw), body: order };
  return created<PlaceOrderResult>(order);
}

function toPlacedOrder(
  dto: PlaceOrderRequest,
  lines: CartLine[],
  totals: CartTotals,
): PlaceOrderResult {
  sequence += 1;
  const placedAt = new Date();
  const { etaDays, shipping: perDestination } = resolve(dto.shipping.pincode);

  const honoured = dto.couponCode === undefined ? undefined : coupons[dto.couponCode.toUpperCase()];
  // A refused coupon does **not** fail the order — `honouredCoupon` records the coupon the order
  // actually honoured and nothing else.
  const applied = honoured?.eligible === true ? honoured : undefined;
  const discount = applied?.discount ?? 0;

  // `shippingFor`'s rule: free shipping still wins, and otherwise the pincode row is what is billed.
  const shipping = totals.shipping === 0 ? 0 : perDestination;

  return {
    id: `NN-${String(placedAt.getFullYear())}-${String(100000 + sequence)}`,
    email: dto.shipping.email,
    channel: lines.some((line) => line.mode === "bulk") ? "bulk" : "retail",
    // Placement's first and only event. `OrderTimeline` renders the order's own history, oldest
    // first, and does not pad it out to a nine-step ladder.
    status: "pending",
    placedAt: placedAt.toISOString(),
    estimatedDelivery: new Date(placedAt.getTime() + etaDays * 86_400_000).toISOString(),
    timeline: [{ status: "pending", at: placedAt.toISOString() }],
    items: lines.map(toOrderLine),
    subtotal: totals.subtotal,
    discount,
    gst: totals.gst,
    shipping,
    total: totals.subtotal - discount + totals.gst + shipping,
    address: dto.shipping,
    paymentMethod: "cod",
    paymentStatus: "pending",
    ...(applied === undefined ? {} : { couponCode: applied.couponCode }),
    ...(dto.companyName === undefined ? {} : { companyName: dto.companyName }),
    ...(dto.gstin === undefined ? {} : { gstin: dto.gstin }),
    ...(dto.poNumber === undefined ? {} : { poNumber: dto.poNumber }),
  };
}

/** `init.headers` may be a `Headers`, an array of pairs, or a record; all three reach `fetch`. */
function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([header]) => header === name)?.[1];
  return (headers as Record<string, string>)[name];
}
