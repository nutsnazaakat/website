import type { CartLine, CartTotals, Product } from "@/contract";
import { settings } from "@/config/settings";
import { cartTotals } from "@/features/cart/cart-math";
import { products } from "@/mocks/products";

/**
 * The cart endpoints, for the route tests.
 *
 * The basket stopped being a `localStorage` array in Task 24: `CartProvider` reads it from
 * `GET /cart` and writes it with `PUT /cart`, so a route test can no longer arrange a basket by
 * seeding a key, and can no longer assert one by reading it back. Both halves live here —
 * `seedCart` arranges what the server answers, `cartWrites` records what the client sent.
 *
 * Delegated to from `installAuthStub` for the reason the catalogue stub is: there is a single
 * `globalThis.fetch`, so layering a second stub on top would make the tests depend on installation
 * order.
 *
 * Two things it models deliberately, because they are what the client now has to get right:
 *
 * - **`PUT /cart` refuses a property outside `CartLineDto`.** The real pipe runs with `whitelist`
 *   **and** `forbidNonWhitelisted`, so `id` and `grams` — both present on the `CartLine` the server
 *   *sends* — are rejected rather than stripped, and the 400 names them. Measured against the
 *   running service on `localhost:4400`:
 *   `{"details":{"lines.0.id":["property id should not exist"],
 *                "lines.0.grams":["property grams should not exist"]}}`.
 *   A lenient stub here would leave `cartApi`'s `toRequestLine` pinned by nothing in this suite, and
 *   `tsc` cannot catch it either: `lines` is a variable, so excess-property checking does not apply.
 * - **The server composes the line id itself**, from `slug` + `size`/`kg`, using the same
 *   `r:${slug}:${size}` / `b:${slug}:${kg}` scheme the client builds optimistically. Verified live:
 *   a `POST /cart/validate` carrying no id answers `"id":"r:premium-california-almonds:250g"` and
 *   `"id":"b:w320-cashews:10"`. That is why an id in the request would be meaningless, and it is
 *   where the composed line identity the smoke suite pins actually comes from.
 *
 * What it does **not** model is the server's arithmetic. Totals come from the client's own
 * `cart-math.ts` over the seeded catalogue, which is a deliberate choice rather than a shortcut: the
 * smoke suite pins exact rupee figures derived from `src/mocks/products.ts` (₹329, ₹5,220, ₹9,890,
 * "Add ₹670 more"), and those figures came from that function. Recomputing them a second way here
 * would either drift from them or agree today and diverge silently later. The real server rounds
 * differently — it answers `gst: 14.95` where this rounds to 15 — and it alone can report a line as
 * unpriceable for want of stock. That the provider takes the server's figures over its own is
 * therefore pinned in `CartProvider.test.tsx`, against a stub that answers a deliberately different
 * number, and not here.
 */

/** Mirrors `cartLineId` in `backend/src/modules/cart/cart-line.mapper.ts`. */
const cartLineId = (line: { slug: string; mode: "retail" | "bulk"; size?: string; kg?: number }) =>
  line.mode === "bulk" ? `b:${line.slug}:${line.kg ?? 0}` : `r:${line.slug}:${line.size ?? ""}`;

/** The properties `CartLineDto` declares. Anything else is refused, exactly as the pipe refuses it. */
const ALLOWED = new Set(["slug", "mode", "size", "kg", "qty"]);

/**
 * A basket line as the *client sends it* — `CartLineDto`'s shape, which is what `toRequestLine`
 * narrows a `CartLine` down to. Exported because it is also the shape `seedCart` takes: a test
 * arranges the identity of a line, and the server fills in the id and `grams`.
 */
export interface SeedLine {
  slug: string;
  mode: "retail" | "bulk";
  size?: string;
  kg?: number;
  qty: number;
}

/** The basket the stubbed server currently holds. */
let stored: CartLine[] = [];
/** The `lines` array of every `PUT /cart`, in order. */
let writes: SeedLine[][] = [];
/** Arranged failures, so a test can reach the client's error state. */
/**
 * Set by `holdCartLoad`, and **deliberately not cleared by `resetCartStub`**.
 *
 * `renderAt` calls `installAuthStub`, which resets every stub — so a hold arranged before the
 * render would be wiped, and one arranged after it comes too late, because the read has already
 * gone. Surviving the reset is the only ordering that works. The caller must release it; every
 * user does so in a `finally`.
 */
let pendingLoad: Promise<void> | null = null;
let failures: { load?: string; write?: string } = {};

export function resetCartStub(): void {
  stored = [];
  writes = [];
  failures = {};
}

/**
 * Makes `GET /cart` fail with `message`.
 *
 * The route is `@Public()`, so a 401 is impossible on it and a real failure is a 5xx. Without an
 * arrangement like this the client's error path is unreachable from a route test, and "render the
 * error" is a requirement nothing pins — measured: deleting the cart page's error banner outright
 * failed no test at all.
 */
export function failCartLoad(message: string): void {
  failures.load = message;
}

/** Makes `PUT /cart` fail with `message`, which is a rejected add-to-cart or quantity change. */
export function failCartWrite(message: string): void {
  failures.write = message;
}

/**
 * Parks `GET /cart` until the returned function is called.
 *
 * The one state a route test otherwise cannot reach: **a basket that has not loaded and an empty
 * basket are the same value.** `CartProvider` starts at `lines: []` with `isLoading: true`, so a
 * page keyed off the array alone tells a signed-in customer holding a full basket that it is
 * empty, until the read answers.
 *
 * Measured: without a hold, a test that seeds a basket and asserts the empty copy is absent
 * **passes with the loading guard removed** — the seeded line arrives before anything can observe
 * the gap. Parking the read is what makes the assertion mean something.
 */
export function holdCartLoad(): () => void {
  let release!: () => void;
  pendingLoad = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    release();
    pendingLoad = null;
  };
}

/**
 * Arranges the basket the server answers with.
 *
 * This replaces seeding `localStorage`, and it is a real change in what a test arranges: the old
 * form seeded the client's own store, this seeds the server's answer. The lines are passed in the
 * shape a caller cares about — slug, mode, size or kg, qty — and the id and `grams` are filled in
 * the way the server fills them, from the catalogue, so a test cannot arrange a basket the server
 * could not have produced.
 */
export function seedCart(lines: SeedLine[]): void {
  stored = lines.map(toStoredLine);
}

/** The `lines` array of every `PUT /cart` the client has sent, in order. */
export function cartWrites(): SeedLine[][] {
  return writes;
}

/** The `lines` array of the most recent `PUT /cart`, or undefined when there has been none. */
export function lastCartWrite(): SeedLine[] | undefined {
  return writes.at(-1);
}

/** The basket the server holds, as `GET /cart` would report it. */
export function storedCart(): CartLine[] {
  return stored;
}

/**
 * The basket, read and emptied in one step — what **placement** does to it.
 *
 * `CheckoutService.place` deletes the cart's items inside the placement transaction
 * (`checkout.service.ts:321`), which is why `checkout-api.stub.ts` calls this rather than the client
 * sending a `PUT /cart` with an empty array. Exposed as one function rather than a getter plus a
 * setter because the two halves are one transaction on the server, and a stub that let a caller read
 * the basket and forget to empty it would model the bug this replaced.
 */
export function consumeStoredCart(): { lines: CartLine[]; totals: CartTotals } {
  const lines = stored;
  const totals = totalsFor(lines);
  stored = [];
  return { lines, totals };
}

const find = (slug: string): Product | undefined => products.find((p) => p.slug === slug);

/** `toCartLine`'s shape: the id composed server-side, and `grams` resolved from the variant. */
function toStoredLine(line: SeedLine): CartLine {
  const variant =
    line.mode === "retail"
      ? find(line.slug)?.variants.find((v) => v.size === line.size)
      : undefined;
  return {
    id: cartLineId(line),
    slug: line.slug,
    mode: line.mode,
    ...(line.size === undefined ? {} : { size: line.size }),
    ...(variant === undefined ? {} : { grams: variant.grams }),
    ...(line.kg === undefined ? {} : { kg: line.kg }),
    qty: line.qty,
  };
}

function totalsFor(lines: CartLine[]): CartTotals {
  return cartTotals(lines, find, settings.freeShippingThreshold);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });

const present = (): Response => ok({ lines: stored, totals: totalsFor(stored) });

function refused(message: string, status: number, path: string, method: string): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-20T00:00:00.000Z",
    path,
    method,
    message,
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
    timestamp: "2026-08-20T00:00:00.000Z",
    path,
    method,
    message: "Validation failed",
    code: "VALIDATION_FAILED",
    details,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/**
 * `whitelist` + `forbidNonWhitelisted`, plus the two `@ValidateIf` rules: a retail line must carry
 * `size` and a bulk line must carry `kg`. Both are conditional rather than merely optional on the
 * server, because a bulk line stored with `kg = null` reports `BELOW_MOQ` forever.
 */
function reject(lines: unknown[]): Record<string, string[]> | undefined {
  const details: Record<string, string[]> = {};

  lines.forEach((raw, index) => {
    const line = raw as Record<string, unknown>;
    for (const key of Object.keys(line)) {
      if (!ALLOWED.has(key)) {
        details[`lines.${String(index)}.${key}`] = [`property ${key} should not exist`];
      }
    }
    if (line.mode === "retail" && typeof line.size !== "string") {
      details[`lines.${String(index)}.size`] = ["size must be a string"];
    }
    if (line.mode === "bulk" && typeof line.kg !== "number") {
      details[`lines.${String(index)}.kg`] = ["kg must be a number"];
    }
  });

  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Answers a cart request, or returns `undefined` when the URL is not one of them so the caller can
 * fall through to its own handling.
 */
export function handleCartRequest(
  url: string,
  method: string,
  init?: RequestInit,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (path !== "/cart") return undefined;

  if (method === "GET") {
    const answer = (): Response =>
      failures.load ? refused(failures.load, 503, url, method) : present();
    // The dispatcher wraps every handler in `Promise.resolve`, so returning a promise costs it
    // nothing.
    return pendingLoad ? (pendingLoad.then(answer) as unknown as Response) : answer();
  }

  if (method === "PUT") {
    if (failures.write) return refused(failures.write, 422, url, method);
    const body = JSON.parse(String(init?.body ?? "{}")) as { lines?: unknown[] };
    const lines = body.lines ?? [];
    const details = reject(lines);
    if (details) return validationFailed(details, url, method);

    writes.push(lines as SeedLine[]);
    stored = (lines as SeedLine[]).map(toStoredLine);
    return present();
  }

  return undefined;
}
