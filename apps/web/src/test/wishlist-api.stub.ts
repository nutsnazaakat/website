import type { Product } from "@/contract";
import { products } from "@/mocks/products";

/**
 * The wishlist endpoints, for the route tests.
 *
 * Delegated to from `installAuthStub` for the reason the catalogue and cart stubs are: there is a
 * single `globalThis.fetch`, so layering a second installer on top would make the tests depend on
 * installation order. `WishlistProvider` mounts on every page and fires `GET /wishlist/slugs`
 * immediately, so without this every route test logs a rejected request.
 *
 * The saved set is **newest first**, which is what the service's `ORDER BY created_at DESC` produces
 * and what `/wishlist` renders. So `add` prepends rather than appends: a stub that appended would
 * agree with the server on membership and disagree on order, and the order is the part a page shows.
 *
 * `add` is idempotent — the real service inserts with `orIgnore()` against a partial unique index, so
 * a double-clicked heart saves one row and answers 200 rather than 409. `remove` on something absent
 * is a no-op for the same reason: a toggle that errors on the second click is worse than one that
 * does nothing.
 *
 * **What it deliberately does not model: CSRF.** `CsrfGuard` demands a cookie-and-header pair on
 * every method but GET/HEAD/OPTIONS, so the real `POST` and `DELETE` here are guarded — but
 * `CsrfBootstrapMiddleware` issues `nn_csrf` to *every* visitor precisely so a guest's first write is
 * not refused, and `installAuthStub` models the opposite: it clears the cookie whenever there is no
 * session. Enforcing the pair here would therefore 403 every guest toggle, which is the one case the
 * real server is built to allow. The cart stub leaves `PUT /cart` unguarded for the same reason. The
 * consequence is honest and worth stating: the CSRF echo is pinned for `/auth/*` and for nothing
 * else.
 */

/** The slugs the stubbed server holds, newest first. */
let saved: string[] = [];
/** Arranged failures, so a test can reach the client's rollback and error paths. */
let failures: { load?: string; write?: string } = {};
/** A products read deliberately out of step with membership. See `freezeWishlistProducts`. */
let frozen: string[] | undefined;

export function resetWishlistStub(): void {
  saved = [];
  failures = {};
  frozen = undefined;
}

/**
 * Freezes what `GET /wishlist` answers, regardless of what has since been saved or unsaved.
 *
 * Models a products read that is a beat behind membership — a list still inside react-query's 60s
 * `staleTime`, or a read replica lagging a write. It is the only arrangement that can tell the
 * wishlist page's "filter the server's list by the live membership set" apart from "wait for the
 * refetch to drop it": with the two in step an unsave removes the card either way, one round trip
 * later. Measured — with the page's filter deleted outright, all 63 cases in `routes.smoke.test.tsx`
 * still passed.
 */
export function freezeWishlistProducts(slugs: string[]): void {
  frozen = [...slugs];
}

/** Arranges what `GET /wishlist/slugs` and `GET /wishlist` answer with. Newest first. */
export function seedWishlist(slugs: string[]): void {
  saved = [...slugs];
}

/** What the stubbed server now holds — the assertion half of `seedWishlist`. */
export function savedWishlist(): string[] {
  return saved;
}

/** Makes both reads fail. The routes are `@Public()`, so a real failure is a 5xx, not a 401. */
export function failWishlistLoad(message: string): void {
  failures.load = message;
}

/** Makes `POST` and `DELETE` fail, which is a save the customer must see rolled back. */
export function failWishlistWrite(message: string): void {
  failures.write = message;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });

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

/** The saved products, in the wishlist's order rather than the catalogue's. */
const savedProducts = (): Product[] =>
  (frozen ?? saved)
    .map((slug) => products.find((p) => p.slug === slug))
    .filter((p): p is Product => p !== undefined);

/**
 * Answers a wishlist request, or returns `undefined` when the URL is not one of them so the caller
 * can fall through to its own handling.
 */
export function handleWishlistRequest(url: string, method: string): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (path === undefined || !path.startsWith("/wishlist")) return undefined;

  if (method === "GET" && path === "/wishlist") {
    return failures.load ? refused(failures.load, 503, url, method) : ok(savedProducts());
  }

  if (method === "GET" && path === "/wishlist/slugs") {
    return failures.load ? refused(failures.load, 503, url, method) : ok({ slugs: saved });
  }

  const slug = decodeURIComponent(path.slice("/wishlist/".length));
  if (slug.length === 0) return undefined;

  if (method === "POST") {
    if (failures.write) return refused(failures.write, 503, url, method);
    if (!saved.includes(slug)) saved = [slug, ...saved];
    return ok({ slugs: saved });
  }

  if (method === "DELETE") {
    if (failures.write) return refused(failures.write, 503, url, method);
    saved = saved.filter((entry) => entry !== slug);
    return ok({ slugs: saved });
  }

  return undefined;
}
