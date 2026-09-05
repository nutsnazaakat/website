import type { AuthUser, Credentials } from "@/contract";
import { http } from "@/lib/http";

/**
 * The auth seam.
 *
 * Every screen reads the API through a `features/<name>/api/` module, exactly as the storefront
 * does —
 * that seam is what let it swap mocks for the real API without touching a component. Nothing
 * outside these modules imports `http`.
 */

/**
 * What `POST /auth/login` and `POST /auth/refresh` answer with.
 *
 * **Not a redeclared contract type.** `AuthUser` is imported from `@/contract`; this interface is
 * the shape of the *envelope's `data`* for two auth routes, which `@nutwala/shared` does not
 * declare — the backend states it as a local `AuthResponse` interface inside `auth.controller.ts`
 * rather than in `shared/`. If it ever moves into the contract, this goes and the import replaces
 * it.
 *
 * The tokens are **not** in here: `nn_access_token` and `nn_refresh_token` are httpOnly cookies.
 * `csrfToken` is echoed for convenience and is the same value as the readable `nn_csrf` cookie
 * that `http.ts` picks up on its own, so nothing needs to hold on to it.
 */
export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
}

export function login(credentials: Credentials): Promise<AuthSession> {
  return http.post<AuthSession>("/auth/login", credentials);
}

/**
 * The signed-in operator, or a 401 if there is nobody.
 *
 * A 401 here is an ordinary answer, not a failure to report: it is how the app learns it is signed
 * out on first paint. `http.ts` will have already tried a refresh if a session plausibly existed.
 */
export function me(signal?: AbortSignal): Promise<AuthUser> {
  return http.get<AuthUser>("/auth/me", signal);
}

/**
 * Revokes the session server-side.
 *
 * Returns `null` in the envelope's `data`, so there is nothing to hand back. Worth knowing that
 * this route needs a **valid access token** to name the session row it is revoking, which is why
 * `http.ts` deliberately allows a 401 here to trigger a refresh-and-retry — see `NEVER_REFRESH`.
 */
export function logout(): Promise<void> {
  return http.post<void>("/auth/logout");
}
