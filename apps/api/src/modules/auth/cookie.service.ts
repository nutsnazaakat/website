import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import type { AppConfiguration } from '../../common/config/app.config';
import { baseCookieOptions, rememberedCsrfToken } from '../../common/http/cookie-options';

/**
 * Cookie names, chosen so the log redactor defends them without being told about them.
 *
 * `redact()` (`common/logging/pii-redactor.ts`) removes any value whose *key* contains `token`,
 * `csrf`, `cookie` and friends. It has no list of this application's cookie names, and no
 * `VALUE_PATTERNS` entry matches an opaque 43-character base64url blob — so a name the keyword
 * list does not recognise is a name whose value gets logged verbatim.
 *
 * `nn_refresh_token` is spelled out in full for exactly that reason, and **must not be shortened
 * to `nn_rt` for symmetry with the other two**. Its value *is* the raw refresh token, the
 * longest-lived credential this service issues, and `nn_rt` normalises to `nnrt`, which matches
 * nothing in the keyword list. Anything that ever logs a request's cookies by key — an error
 * path, a debug line, a future interceptor — would then write a live 30-day credential into the
 * logs in plaintext. Verified both ways against the real `redact()`.
 *
 * `nn_access_token` is spelled out for exactly the same reason, one credential lifetime down. It
 * carries a 15-minute JWT, and `nn_at` normalised to `nnat`, matching nothing either — so a debug
 * line dumping cookies by key printed a live access token. Fifteen minutes is a much smaller
 * window than thirty days, but it is still a working credential, and "shorter-lived" is not a
 * reason to log it in plaintext. Renaming also removes the asymmetry that would otherwise invite
 * someone to shorten the refresh cookie back for consistency.
 *
 * `nn_csrf` genuinely is a different class and keeps its short name: it matches `csrf` and is
 * redacted anyway, and its token is deliberately readable by JavaScript — it is not a credential,
 * only proof the caller could read a same-site cookie.
 *
 * Related invariant, which no type can enforce: the refresh token goes in this cookie and nowhere
 * else. Never a URL, a query parameter or a redirect target — the redactor's value patterns do not
 * match it inside a URL string, so a token in a path survives into the logs even when every
 * key-based rule is working.
 */
export const ACCESS_COOKIE = 'nn_access_token';
export const REFRESH_COOKIE = 'nn_refresh_token';
export const CSRF_COOKIE = 'nn_csrf';

const REFRESH_PATH = '/api/v1/auth';
const MS_PER_DAY = 86_400_000;
/** Slightly longer than the 15-minute token, so the cookie never outlives its own contents. */
const ACCESS_COOKIE_MAX_AGE_MS = 20 * 60 * 1000;

@Injectable()
export class CookieService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Writes the session cookies.
   *
   * The access and refresh cookies are `httpOnly`, so no JavaScript — including injected
   * script — can read them. That is the whole point of spec §3.1 departure 1.
   *
   * The CSRF cookie is deliberately readable, because the frontend has to echo it back in a
   * header. It is not a credential: it proves only that the request came from a page that
   * could read the cookie, which a cross-site attacker cannot do.
   */
  issue(response: Response, tokens: { accessToken: string; refreshToken: string }): string {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');

    response.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.base(),
      maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    });

    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.base(),
      // Scoped to the auth routes, so the long-lived token is not attached to every request
      // and cannot leak through an unrelated endpoint.
      path: REFRESH_PATH,
      // Strict rather than Lax: nothing should ever send this cross-site, not even a
      // top-level navigation.
      sameSite: 'strict',
      maxAge: auth.refreshTokenTtlDays * MS_PER_DAY,
    });

    /**
     * Reuses the token `CsrfBootstrapMiddleware` already queued on this response, if it did.
     *
     * That middleware mints `nn_csrf` for any visitor who arrives without one, and it runs on this
     * request too — so on a brand-new client's register or login, both would set the cookie and
     * `res.cookie` appends rather than replaces. The response would carry two `Set-Cookie: nn_csrf`
     * entries with different values while the body named only this one.
     *
     * A client that arrived *with* a token gets a fresh one here, because the middleware stays out
     * of the way in that case: a token that predates the sign-in is still rotated. And reusing a
     * bootstrapped one concedes nothing — it was generated moments ago in this same request and is
     * leaving in this same response.
     *
     * The two `maxAge` values agree today (`REFRESH_TOKEN_TTL_DAYS` defaults to 30, and the
     * middleware uses 30 days), so which of the two set the cookie is not observable. If they ever
     * diverge, a bootstrapped token would carry the middleware's lifetime — harmless, because this
     * cookie is not a credential and `clear()` removes it on logout.
     */
    const bootstrapped = rememberedCsrfToken(response);
    if (bootstrapped) return bootstrapped;

    const csrfToken = randomBytes(32).toString('base64url');
    response.cookie(CSRF_COOKIE, csrfToken, {
      ...this.base(),
      httpOnly: false,
      maxAge: auth.refreshTokenTtlDays * MS_PER_DAY,
    });

    return csrfToken;
  }

  clear(response: Response): void {
    const base = this.base();
    response.clearCookie(ACCESS_COOKIE, base);
    response.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
    response.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  }

  /**
   * Delegated to `common/http/cookie-options`, which is the single definition of these attributes.
   *
   * `auth` carries `cookieDomain` and `cookieSecure`, which is the whole of `CookieSettings`, so
   * there is no adapter here. Still a method rather than a constant because `issue()` and `clear()`
   * spread it and override on top — the refresh cookie's `sameSite: 'strict'` and narrower `path`,
   * the CSRF cookie's `httpOnly: false` — and a shared constant would be mutated by that.
   */
  private base(): CookieOptions {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return baseCookieOptions(auth);
  }
}
