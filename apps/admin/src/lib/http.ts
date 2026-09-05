import type { ApiError, ApiSuccess } from "@/contract";

/**
 * The one place that talks to the API.
 *
 * **A trimmed copy of `nutwala-client/src/lib/http.ts`, deliberately not a rewrite.** It encodes
 * security behaviour — the CSRF echo, which 401s may retry, why a logout that fails to revoke
 * leaves a 30-day refresh cookie valid — and a rewrite invites divergence in exactly the places
 * where divergence is a vulnerability rather than a bug. Every comment below was carried across
 * with its reasoning intact; `http.test.ts` was carried across with it, because a copied
 * security-critical file with no tests is worse than a rewrite: it looks trustworthy.
 *
 * **What was removed, and why.** Only one thing: the per-request `headers` option, which the
 * storefront added for `Idempotency-Key` on `POST /checkout/orders`. `IdempotencyInterceptor` is
 * registered for `checkout:orders` and nothing else in the service, so no `/admin/*` route reads
 * that header and no caller here could supply one meaningfully. Removing it also removes the
 * "caller headers are merged last so the CSRF token cannot be silently lost" subtlety along with
 * the only case that needed it. If an admin route ever wants a header, it should come back with
 * its own reason attached rather than sit here unused.
 *
 * Nothing else was storefront-specific: there is no cart, wishlist or catalogue knowledge in this
 * file to strip. The three `NEVER_REFRESH` exclusions stay at three — `/auth/register` is not a
 * route this app calls, but the set is a statement about which 401s mean "wrong credentials"
 * rather than a list of this app's endpoints, and shrinking it would make the two copies differ
 * for no gain.
 *
 * Nothing above this file should ever call `fetch` directly.
 *
 * Annotated `: string` deliberately. `ImportMetaEnv` carries an `[key: string]: any` index
 * signature, so `import.meta.env.VITE_API_URL` is `any`, and without the annotation that `any`
 * would spread into `BASE_URL` and from there into every URL built below.
 */
const BASE_URL: string = import.meta.env.VITE_API_URL ?? "/api/v1";

/** Not httpOnly, by design: the frontend has to read it to echo it back. */
const CSRF_COOKIE = "nn_csrf";
const CSRF_HEADER = "X-CSRF-Token";

/** `OPTIONS` is absent on purpose — the browser sends preflights, this client never does. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * A failed request, carrying the backend's stable `code` so callers can branch on it.
 *
 * `status` is on here as well as `code`, and both are load-bearing. A 429 carries **no `code`**:
 * `ThrottlerException` is not a `DomainError`, so a rate-limited response has a `message` and a
 * `statusCode` and nothing machine-readable — measured against the running service. Any UI that
 * branches on `code` alone therefore sees nothing for the one failure an operator is most likely
 * to hit by accident, so rate limiting must be detected as `status === 429`.
 *
 * `details` is how the server explains itself in machine-readable terms, and the admin console
 * leans on it harder than the storefront does: `ILLEGAL_STATUS_TRANSITION` carries
 * `{ from, to, allowed }`, so an operator can be told which statuses are legal from here rather
 * than that something "failed". See `features/orders/api/errors.ts`.
 */
export class ApiRequestError extends Error {
  /**
   * Fields are declared and assigned rather than written as constructor parameter properties.
   * `tsconfig.app.json` sets `erasableSyntaxOnly`, under which `constructor(readonly status: …)`
   * is TS1294 — it emits code, and this project only allows type syntax that erases to nothing.
   */
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readCsrfCookie(): string | undefined {
  const prefix = `${CSRF_COOKIE}=`;
  const entry = document.cookie.split("; ").find((candidate) => candidate.startsWith(prefix));
  // `slice`, not `split("=")[1]`: a cookie value may contain `=`, and splitting would hand back a
  // silently truncated token that fails the server's constant-time compare as an unexplainable 403.
  return entry?.slice(prefix.length);
}

/**
 * The three paths where a 401 must NOT trigger a refresh-and-retry.
 *
 * `/auth/refresh` would recurse. On `/auth/login` and `/auth/register` a 401 means the credentials
 * were wrong, and refreshing would be answering the wrong question.
 *
 * Deliberately an exact-match set rather than a `path.startsWith("/auth/")` test, because that
 * prefix is far too broad and breaks the one guarantee the server-side session table exists to
 * provide. `POST /auth/logout` needs a valid access token to identify the session it is revoking;
 * after the access cookie's 20 minutes it answers 401. Under the prefix test no refresh is
 * attempted, so logout fails — the UI clears its local snapshot and looks signed out while **the
 * session row is never revoked and the 30-day refresh cookie stays valid**. A logout that does not
 * revoke is precisely the failure this design was chosen to avoid.
 *
 * `GET /auth/me` breaks the same way: an operator returning to a tab with an expired access cookie
 * and 29 days of refresh validity left would 401, hydrate as `null`, and be bounced to sign-in.
 */
const NEVER_REFRESH = new Set(["/auth/refresh", "/auth/login", "/auth/register"]);

/** The Web Locks name every tab on this origin contends for before refreshing. */
const REFRESH_LOCK = "nn-auth-refresh";

/**
 * Serialises concurrent refreshes **within this tab**.
 *
 * Without it, three requests failing with 401 at once would each POST `/auth/refresh`. The first
 * rotates the token and the other two present the now-revoked one — which the backend correctly
 * reads as token reuse and answers by revoking the whole session family. So the frontend must
 * refresh once and have the others wait. A dashboard that fires several queries on mount is
 * exactly the burst this describes.
 *
 * It is not sufficient on its own, which is what `withRefreshLock` below is for: this is a
 * module-level variable, so it is per JavaScript context — per tab.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * `navigator.locks`, read at call time so a test can substitute one.
 *
 * Typed non-optional in `lib.dom`, but genuinely absent at runtime in jsdom, in older browsers,
 * and — the case that matters in production — in **any non-secure context**, since Web Locks is
 * secure-context only. `http://localhost` counts as secure, so development gets the real thing;
 * a plain-http staging box on a LAN address does not. Hence the check, and hence a fallback that
 * still works rather than a crash.
 */
function getLockManager(): LockManager | undefined {
  const nav: Navigator | undefined = globalThis.navigator;
  const locks: LockManager | undefined = nav?.locks;
  return locks;
}

/**
 * Elects one refreshing tab per origin.
 *
 * `refreshInFlight` is per tab, and that gap is not theoretical — least of all here. An operator
 * works with the order list in one tab and a detail in another as a matter of course. Both idle
 * past the access cookie's twenty minutes, both wake to a 401, each fires its own refresh. Exactly
 * one wins; the loser's family revoke then kills the winner's brand-new session too, by design,
 * because from the server's side two parties presented one token and neither can be trusted. Net
 * effect: **the operator is signed out of both tabs for doing nothing wrong**, and reports it as
 * "it randomly logs me out" — a description nobody would connect to refresh-token rotation.
 *
 * A lock fixes it without weakening anything: the losers simply wait, and by the time the lock
 * releases the winner has already set fresh cookies, so the loser's own refresh presents the new
 * token and rotates cleanly. Reuse detection stays strict, which is the point — the session table
 * exists so that a replayed token is caught.
 *
 * The alternative of asking the backend for a grace window that accepts the immediately-preceding
 * token is deliberately **not** taken. It is the obvious suggestion and it reopens exactly the hole
 * that took a measured 19-in-20 failure rate to find: inside that window a stolen token is
 * indistinguishable from a racing tab.
 *
 * Without the API this degrades to the in-flight promise alone — "occasionally signed out with two
 * tabs open", never "insecure".
 */
async function withRefreshLock(run: () => Promise<boolean>): Promise<boolean> {
  const locks = getLockManager();
  if (!locks) return run();

  try {
    return (await locks.request(REFRESH_LOCK, run)) as boolean;
  } catch {
    // A lock request can reject for reasons that have nothing to do with auth — a document going
    // inactive mid-request is the documented one. An unserialised refresh is strictly better than
    // reporting a live session dead, so fall through rather than propagate.
    return run();
  }
}

/**
 * Never rejects. `withRefreshLock` runs this as the lock callback, and a throw there would reject
 * the lock request itself and send us down the fallback path — refreshing a second time.
 */
async function postRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    return response.ok;
  } catch {
    // A network failure is not a rejected session. Report "not refreshed" and let the caller
    // surface the original 401 rather than inventing a different error.
    return false;
  }
}

function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const attempt = withRefreshLock(postRefresh);
  refreshInFlight = attempt;
  void attempt.finally(() => {
    // Identity-checked so a late-settling attempt cannot clear a newer one, which would leave
    // every subsequent caller waiting on a promise that has already resolved.
    if (refreshInFlight === attempt) refreshInFlight = null;
  });

  return attempt;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Internal: prevents a refresh loop when the retried request also 401s. */
  retry?: boolean;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    // Required, or the browser sends no cookies and every request is anonymous.
    credentials: "include",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // `NEVER_REFRESH` is matched against the path without its query string: the storefront's paths
  // arrive bare, but every admin list route is called as `/admin/orders?page=1&status=…` by
  // `toQueryString`. An exact-match `Set` against the raw path would still work for the three
  // entries — none of them takes a query — but it would be an accident rather than a decision, and
  // the first exclusion that did take one would fail silently.
  const routePath = path.split("?")[0] ?? path;

  if (response.status === 401 && !options.retry && !NEVER_REFRESH.has(routePath)) {
    // Only attempt a refresh if there is plausibly a session to refresh.
    //
    // `nn_csrf` is the readable half of the cookie set: it is issued alongside the two token
    // cookies, carries the same 30-day lifetime as the refresh cookie, and `CookieService.clear`
    // removes all three together. So its absence means no session, and refreshing cannot succeed.
    //
    // Without this check every anonymous page load spent a `POST /auth/refresh` that could only
    // 401 — `GET /auth/me` legitimately refreshes on 401, and a signed-out operator always 401s.
    // That is wasted traffic and log noise on every first paint, and it is measured against the
    // refresh route's limit, so someone sitting on the sign-in screen reloading could rate-limit
    // the endpoint their eventual sign-in depends on.
    //
    // A false negative is possible and cheap: someone who deletes only `nn_csrf` while keeping a
    // valid refresh cookie is treated as signed out until they sign in again.
    if (readCsrfCookie() !== undefined) {
      const refreshed = await refreshSession();
      if (refreshed) return apiRequest<T>(path, { ...options, retry: true });
    }
  }

  // 204 and an empty body are valid successes with nothing to parse.
  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = payload as ApiError | null;
    throw new ApiRequestError(
      response.status,
      error?.message ?? "Something went wrong. Please try again.",
      error?.code,
      error?.details,
    );
  }

  // A 204, or any empty body, is a success with nothing to unwrap. Returning `undefined` is the
  // honest answer; reading `.data` off the parsed `null` throws a TypeError that reads like a
  // JSON parse bug and sends the next reader looking in the wrong place.
  if (payload === null) return undefined as T;

  return (payload as ApiSuccess<T>).data;
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: "DELETE" }),
};
