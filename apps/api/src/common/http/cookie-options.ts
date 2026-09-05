import type { CookieOptions, Response } from 'express';

/** The two environment-dependent cookie settings, validated at boot by `env.schema.ts`. */
export interface CookieSettings {
  cookieDomain: string;
  cookieSecure: boolean;
}

/**
 * The attributes every cookie this service sets shares. One definition, three callers:
 * `CookieService.base()`, `issueGuestToken` and `csrfBootstrap`.
 *
 * Each caller spreads this and overrides only what genuinely differs — the refresh cookie's
 * `sameSite: 'strict'` and narrower `path`, the CSRF cookie's `httpOnly: false`, and each one's
 * `maxAge`. Anything not in that list is not allowed to differ.
 */
export function baseCookieOptions(settings: CookieSettings): CookieOptions {
  return {
    httpOnly: true,
    // `lax` rather than `strict`: a customer arriving from a Google result or a WhatsApp link must
    // still find the basket they built before they left, and a guest token grants nothing but a
    // basket and a wishlist. Forced `secure` in production by the env schema.
    sameSite: 'lax',
    secure: settings.cookieSecure,
    domain: settings.cookieDomain,
    path: '/',
  };
}

/** Where a response records the `nn_csrf` value it has already queued. */
interface CsrfCarrier {
  nnCsrfToken?: string;
}

/**
 * Records the `nn_csrf` value this response is already setting, so nothing sets a second one.
 *
 * Two things mint that cookie — `CsrfBootstrapMiddleware` for a visitor who arrives without one,
 * and `CookieService.issue()` on login, register and refresh — and on a brand-new client's
 * `POST /register` **both run on the same request**. `res.cookie` appends rather than replaces, so
 * the response then carried two `Set-Cookie: nn_csrf` entries with different values while the body
 * reported only the second. A browser applies them in order and ends up consistent, but the response
 * contradicts itself on the wire: any client reading the first entry — `cookieEntry` in
 * `auth.integration.spec.ts` does exactly that, and it is what caught this — gets a token that does
 * not match the `csrfToken` it was told to echo, and every write it makes is refused.
 *
 * Passed through `res.locals` rather than a field on the request, deliberately: putting the minted
 * token where `request.cookies` lives would let `CsrfGuard` accept a pair the server had just
 * issued, which is the one thing the bootstrap must not buy.
 */
export function rememberCsrfToken(response: Response, token: string): void {
  (response.locals as CsrfCarrier).nnCsrfToken = token;
}

/**
 * The `nn_csrf` value already queued on this response, if any.
 *
 * A caller that finds one must reuse it rather than mint its own. It is no less fresh than a new
 * one — it was generated moments earlier in this same request and has not left the process — so
 * reusing it gives up nothing.
 */
export function rememberedCsrfToken(response: Response): string | undefined {
  return (response.locals as CsrfCarrier | undefined)?.nnCsrfToken;
}
