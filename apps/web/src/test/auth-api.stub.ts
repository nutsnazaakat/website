import type { AuthUser, RegisterInput } from "@/contract";
import { handleAccountRequest, resetAccountStub } from "./account-api.stub";
import { handleBusinessRequest, resetBusinessStub } from "./business-api.stub";
import { handleCartRequest, resetCartStub } from "./cart-api.stub";
import { handleCatalogRequest, resetCatalogStub } from "./catalog-api.stub";
import { handleCheckoutRequest, resetCheckoutStub } from "./checkout-api.stub";
import { handleContactRequest, resetContactStub } from "./contact-api.stub";
import { handleContentRequest, resetContentStub } from "./content-api.stub";
import { handleRfqRequest, resetRfqStub } from "./rfq-api.stub";
import { handleWishlistRequest, resetWishlistStub } from "./wishlist-api.stub";

/**
 * A stand-in for the API, for the route tests.
 *
 * Auth is written out here; the catalogue and review endpoints live in `catalog-api.stub.ts`, the
 * cart in `cart-api.stub.ts`, the wishlist in `wishlist-api.stub.ts`, checkout's serviceability
 * lookup and placement in `checkout-api.stub.ts`, the account's order history, address book and
 * profile in `account-api.stub.ts`, the two RFQ front doors plus the caller's own queue in
 * `rfq-api.stub.ts`, and the business profile in `business-api.stub.ts`, all seven delegated to
 * below, because every part has to answer through the same `globalThis.fetch`.
 *
 * Auth stopped being a mock in Task 28: `features/auth/api` now goes through `lib/http`, which
 * calls `fetch`. In jsdom that fetch resolves against `http://localhost:3000` and is refused, so
 * without a stub every route test would mount a provider whose `GET /auth/me` fails, and any test
 * that signs in would only ever see a network error.
 *
 * It is written to behave like the real service rather than to make assertions pass, because a
 * lenient stub is how the CSRF plumbing and the refresh-on-401 path would silently rot:
 *
 * - the success envelope is `{ success: true, data }` and failures carry the real `message` and
 *   `code` values from `auth.service.ts` and `domain-error.ts`;
 * - `POST /auth/logout` and `POST /auth/upgrade-to-business` **require** `X-CSRF-Token` to match
 *   the readable `nn_csrf` cookie, and answer 403 when it does not — so a client that stops
 *   echoing the cookie fails the sign-out test instead of passing quietly;
 * - `login`, `register` and `refresh` are CSRF-exempt, as they are on the server;
 * - a request without a session answers 401, which is what drives the client's
 *   refresh-and-retry, and `POST /auth/refresh` answers 401 too when there is nothing to rotate.
 *
 * What it cannot model is the httpOnly access and refresh cookies: jsdom's `document.cookie`
 * cannot set them and no script may read them, which is the whole point. The stub therefore keeps
 * the session in a closure and only puts `nn_csrf` — the deliberately readable one — into
 * `document.cookie`. Whether the real cookies work is a browser question, not a jsdom one.
 */
const PREFIX = "/api/v1/auth";
const CSRF_COOKIE = "nn_csrf";
const CSRF_TOKEN = "stub-csrf-token";

/** The seeded development password, so the tests read like the real sign-in. */
export const STUB_PASSWORD = "Password123!";

export interface AuthStubOptions {
  /** The account `GET /auth/me` reports — the session the browser's cookies already carry. */
  session?: AuthUser | null;
  /** Accounts that can sign in. Defaults to whatever `session` was given. */
  accounts?: AuthUser[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok<T>(data: T): Response {
  return json(200, { success: true, data });
}

function fail(
  status: number,
  message: string,
  request: { path: string; method: string },
  code?: string,
): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-19T00:00:00.000Z",
    path: request.path,
    method: request.method,
    message,
    ...(code === undefined ? {} : { code }),
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

function setCsrfCookie(): void {
  document.cookie = `${CSRF_COOKIE}=${CSRF_TOKEN}; path=/`;
}

function clearCsrfCookie(): void {
  document.cookie = `${CSRF_COOKIE}=; path=/; max-age=0`;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname;
  return input.url;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key === name)?.[1];
  return (headers as Record<string, string>)[name];
}

/**
 * Installs the stub on `globalThis.fetch`. Returns the restore function; call it in `afterEach`,
 * or the next file's tests inherit a session.
 */
export function installAuthStub(options: AuthStubOptions = {}): () => void {
  const original = globalThis.fetch;
  // A review submitted by one test must not be visible to the next, and neither may a basket:
  // `CartProvider` reads its lines from `GET /cart` now, so a leaked basket is a leaked cart page.
  // Nor may a saved product: every page renders hearts, so a leaked wishlist is a leaked heart on
  // the next file's shop grid.
  resetCatalogStub();
  resetCartStub();
  resetWishlistStub();
  resetCheckoutStub();
  // And neither may an order: `handleAccountRequest` serves a placed order out of the same store the
  // seeded six live in, so one test's placement would appear in the next test's order history.
  resetAccountStub();
  // Nor an RFQ: `handleRfqRequest` scopes `GET /rfqs` by the signed-in email, so a leaked enquiry
  // would surface under the next test's account of the same name.
  resetRfqStub();
  // Nor a saved business profile edit: one test's `PUT /business/me` would otherwise still be
  // sitting there the next time this account signs in.
  resetBusinessStub();
  // Nor a contact-form submission: `contactSubmissions()` is what the route test asserts on, so a
  // message left behind by the previous test would appear in the next one's list.
  resetContactStub();
  resetContentStub();
  let session: AuthUser | null = options.session ?? null;
  const accounts = new Map<string, AuthUser>(
    (options.accounts ?? (options.session ? [options.session] : [])).map((account) => [
      account.email.toLowerCase(),
      account,
    ]),
  );

  // A pre-existing session means the browser already holds all three cookies.
  if (session) setCsrfCookie();
  else clearCsrfCookie();

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (!url.startsWith(PREFIX)) {
      // The catalogue, review, cart, wishlist, checkout and account seams also call `fetch` now, and
      // one installer has to answer all of them: there is a single `globalThis.fetch`, so layering a
      // second stub on top of this one would make the tests depend on installation order.
      const catalogue = handleCatalogRequest(url, method, init);
      if (catalogue) return Promise.resolve(catalogue);

      const cart = handleCartRequest(url, method, init);
      if (cart) return Promise.resolve(cart);

      const wishlist = handleWishlistRequest(url, method);
      if (wishlist) return Promise.resolve(wishlist);

      // The blog. Reached only since Milestone 11 Task 2 — before it, `features/content/api` read
      // `src/mocks/posts.ts` and no request was ever made.
      const content = handleContentRequest(url, method);
      if (content) return Promise.resolve(content);

      // The placing account, not the shipping address's email: an order is scoped by `user_id`, and
      // a guest's placement — the ordinary retail path — belongs to nobody and cannot be read back
      // from either account route.
      const checkout = handleCheckoutRequest(url, method, init, session?.email ?? null);
      if (checkout) return Promise.resolve(checkout);

      // The sixth handler. Both create routes are public — a prospect needs no account to raise
      // an enquiry — and both reads are session-scoped, exactly as `RfqsController`'s own docblock
      // states the split.
      const rfq = handleRfqRequest(url, method, init, session);
      if (rfq) return Promise.resolve(rfq);

      // The fifth handler also *writes*: `PATCH /account/profile` answers with the whole profile, so
      // the session it edited has to be this one — otherwise `GET /auth/me` would keep serving the
      // old name and only the page that made the edit would know about it. `accounts` is updated too,
      // so signing out and back in during a test does not undo the edit.
      const account = handleAccountRequest(
        url,
        method,
        session,
        (updated) => {
          session = updated;
          accounts.set(updated.email.toLowerCase(), updated);
        },
        init,
      );
      if (account) return Promise.resolve(account);

      // The seventh handler. Session-scoped in both directions — a `GET`/`PUT /business/me` with
      // no session is a 401, matching `BusinessesController`'s global guard pair.
      const business = handleBusinessRequest(url, method, init, session);
      if (business) return Promise.resolve(business);

      // The eighth handler. Public, unauthenticated, no session to scope by — the same shape
      // `RfqsController`'s two create routes have.
      const contact = handleContactRequest(url, method, init);
      if (contact) return Promise.resolve(contact);

      // Everything else in the frontend still goes through `src/mocks`. A real fetch reaching
      // here is a new API seam that needs its own stub, so say so instead of hanging.
      return Promise.reject(new Error(`api stub received an unexpected request: ${method} ${url}`));
    }

    const path = url.slice("/api/v1".length);
    const where = { path: url, method };
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

    // Mirrors CsrfGuard: unsafe methods need the header to match the readable cookie, except on
    // the three @SkipCsrf() endpoints.
    const exempt = new Set(["/auth/login", "/auth/register", "/auth/refresh"]);
    if (method !== "GET" && method !== "HEAD" && !exempt.has(path)) {
      const header = headerOf(init, "X-CSRF-Token");
      if (!header || header !== CSRF_TOKEN) {
        return Promise.resolve(
          fail(
            403,
            "Your request could not be verified. Please refresh the page and try again.",
            where,
            "CSRF_TOKEN_INVALID",
          ),
        );
      }
    }

    switch (`${method} ${path}`) {
      case "GET /auth/me": {
        if (!session) return Promise.resolve(unauthenticated(where));
        return Promise.resolve(ok(session));
      }

      case "POST /auth/refresh": {
        // Nothing to rotate without a session, which is what an anonymous visitor's
        // hydration sees before it settles on "signed out".
        if (!session) return Promise.resolve(sessionExpired(where));
        setCsrfCookie();
        return Promise.resolve(ok({ user: session, csrfToken: CSRF_TOKEN }));
      }

      case "POST /auth/login": {
        const credentials = body as { email: string; password: string };
        const found = accounts.get(credentials.email.trim().toLowerCase());
        if (!found || credentials.password !== STUB_PASSWORD) {
          // One message for every failed sign-in, as spec §13 requires.
          return Promise.resolve(
            fail(401, "Invalid email or password.", where, "INVALID_CREDENTIALS"),
          );
        }
        session = found;
        setCsrfCookie();
        return Promise.resolve(ok({ user: found, csrfToken: CSRF_TOKEN }));
      }

      case "POST /auth/register": {
        const input = body as RegisterInput;
        const email = input.email.trim().toLowerCase();
        if (accounts.has(email)) {
          return Promise.resolve(
            fail(409, "An account with this email address already exists.", where, "EMAIL_IN_USE"),
          );
        }
        const created: AuthUser = {
          id: `usr-stub-${String(accounts.size + 1)}`,
          name: input.name.trim(),
          email,
          phone: input.phone,
          role: input.isBusiness ? "b2b" : "b2c",
          ...(input.isBusiness && input.company ? { company: input.company } : {}),
          createdAt: "2026-08-19T00:00:00.000Z",
        };
        accounts.set(email, created);
        session = created;
        setCsrfCookie();
        return Promise.resolve(ok({ user: created, csrfToken: CSRF_TOKEN }));
      }

      case "POST /auth/logout": {
        if (!session) return Promise.resolve(unauthenticated(where));
        session = null;
        clearCsrfCookie();
        return Promise.resolve(json(200, { success: true, data: null, message: "Signed out." }));
      }

      case "POST /auth/upgrade-to-business": {
        if (!session) return Promise.resolve(unauthenticated(where));
        const upgraded: AuthUser = { ...session, role: "b2b" };
        accounts.set(upgraded.email.toLowerCase(), upgraded);
        session = upgraded;
        return Promise.resolve(ok(upgraded));
      }

      default:
        return Promise.resolve(fail(404, `Cannot ${method} ${url}`, where));
    }
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = original;
    clearCsrfCookie();
  };
}

/**
 * What `JwtAuthGuard` actually emits, measured against the running service: a bare
 * `UnauthorizedException`, so the body carries `message: "Unauthorized"` and **no `code`**. Worth
 * being exact about — it is another reason nothing may branch on `code` to detect "not signed in".
 */
function unauthenticated(where: { path: string; method: string }): Response {
  return fail(401, "Unauthorized", where);
}

/** `/auth/refresh` is the one 401 here that *is* a DomainError, so it does carry a code. */
function sessionExpired(where: { path: string; method: string }): Response {
  return fail(401, "Your session has expired. Please sign in again.", where, "SESSION_EXPIRED");
}
