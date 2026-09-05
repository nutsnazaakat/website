import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfiguration } from '../config/app.config';
import { baseCookieOptions, rememberCsrfToken } from '../http/cookie-options';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ensures every visitor holds an `nn_csrf` cookie, so a guest's first write is not refused.
 *
 * `CsrfGuard` demands a cookie-and-header pair on every method but GET/HEAD/OPTIONS, and `nn_csrf`
 * was otherwise minted only by `CookieService.issue()` during sign-in — so the entire guest cart and
 * wishlist would 403. Bootstrapping here rather than in a handler means it is already set by the
 * time any request reaches a guard, whatever the client fetched first.
 *
 * Safe to hand to anyone: the token proves only that the caller could read a same-site cookie. It is
 * not a credential, and it is deliberately readable by JavaScript — that is how the double-submit
 * works.
 *
 * **It must never rotate an existing token.** `CookieService.issue()` sets its own during sign-in and
 * returns it in the response body for the client to echo, so overwriting one mid-session invalidates
 * a header the client is already sending — which would turn every subsequent write into a 403 for a
 * signed-in customer.
 *
 * **What this does not buy, and must not.** The cookie is set on the *response*, so it is usable from
 * the next request onward; it cannot satisfy `CsrfGuard` on the request that minted it, because the
 * client had nothing to echo. A cold write is therefore still a 403, and that is correct — a guard
 * that accepted a pair it had just issued would hand the same pair to a cross-site POST and stop
 * being a CSRF defence at all. What it buys is that *any* prior request of any kind seeds the cookie,
 * instead of only the two `GET`s a provider happens to make on mount.
 *
 * A `NestMiddleware` class rather than the plain function the plan sketched, and the difference is
 * `ConfigService`. The plan read `COOKIE_DOMAIN` and `COOKIE_SECURE` from `process.env` on the
 * grounds that "plain Express middleware in this chain has no DI container" — but the chain accepts
 * injectable classes too, and `RequestTrackingMiddleware`, first in that same list, is one. So the
 * stated constraint is not real, and the `process.env` read has a measured cost: `COOKIE_DOMAIN` is
 * `z.string().min(1).default('localhost')`, and `loadEnv()` does not write its defaults back, so with
 * the variable unset (as it is under `test/setup.ts`) `process.env.COOKIE_DOMAIN ?? ''` yields `''`
 * while `CookieService` emits `Domain=localhost`. A cookie jar keys on (name, domain, path), so the
 * two would be *different* `nn_csrf` cookies in the same jar, and `cookie-parser` hands `CsrfGuard`
 * whichever the client sends first — not necessarily the one it is echoing. Reading the same
 * validated configuration `CookieService` reads removes the question.
 */
@Injectable()
export class CsrfBootstrapMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const existing = (request as { cookies?: Record<string, string> }).cookies?.[CSRF_COOKIE];

    if (!existing) {
      const { auth } = this.config.getOrThrow<AppConfiguration>('app');
      const token = randomBytes(32).toString('base64url');
      // Recorded so `CookieService.issue()` reuses it instead of queueing a second `nn_csrf` on the
      // same response — see `rememberCsrfToken`. Login, register and refresh all run this middleware
      // first, and a brand-new client hits every one of them without a token.
      rememberCsrfToken(response, token);
      response.cookie(CSRF_COOKIE, token, {
        ...baseCookieOptions(auth),
        // The one attribute that genuinely differs: the frontend has to read this cookie to echo it
        // back in the header, which is how the double-submit works at all.
        httpOnly: false,
        maxAge: THIRTY_DAYS_MS,
      });
    }

    next();
  }
}
