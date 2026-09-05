import type { CookieOptions } from 'express';
import { rememberedCsrfToken } from '../http/cookie-options';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';
import { CsrfBootstrapMiddleware } from './csrf-bootstrap.middleware';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const middlewareWith = (settings: { cookieDomain: string; cookieSecure: boolean }) =>
  new CsrfBootstrapMiddleware({ getOrThrow: () => ({ auth: settings }) } as never);

const local = () => middlewareWith({ cookieDomain: 'localhost', cookieSecure: false });

describe('CsrfBootstrapMiddleware', () => {
  it('mints a token for a visitor who arrives with no cookies at all', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };
    const next = jest.fn();

    local().use({} as never, response as never, next);

    expect(response.cookie).toHaveBeenCalledTimes(1);
    expect(response.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({ sameSite: 'lax', path: '/', maxAge: THIRTY_DAYS_MS }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('mints a token for a visitor carrying unrelated cookies', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };

    local().use({ cookies: { nn_guest_token: 'x' } } as never, response as never, jest.fn());

    expect(response.cookie).toHaveBeenCalledTimes(1);
  });

  /**
   * The case a naive implementation gets wrong, and the reason this is a condition rather than an
   * unconditional `response.cookie`.
   *
   * `CookieService.issue()` sets `nn_csrf` at sign-in and returns that same token in the response
   * body, which the client then echoes in `X-CSRF-Token` on every write. Rotating it here would
   * replace the cookie under a client still sending the old header, and `CsrfGuard` compares the
   * two — so every subsequent write from a signed-in customer would answer 403
   * `CSRF_TOKEN_INVALID`, on a request that did nothing wrong.
   */
  it('never rotates a token the visitor already holds', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };
    const next = jest.fn();

    local().use({ cookies: { [CSRF_COOKIE]: 'already-mine' } } as never, response as never, next);

    expect(response.cookie).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  /**
   * `httpOnly: false` is the one attribute that must differ from `baseCookieOptions`, and it is
   * asserted exactly rather than inside an `objectContaining` that a `true` would also satisfy.
   *
   * The frontend has to *read* this cookie to echo it in the header — that is the whole of the
   * double-submit. Minted `httpOnly`, the token would be invisible to the client, no write could
   * ever carry a matching header, and the guest cart would 403 exactly as it does with no cookie
   * at all: the bug this middleware exists to fix, reintroduced by one attribute.
   */
  it('mints a cookie the frontend can read, which is the whole of the double-submit', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };

    local().use({} as never, response as never, jest.fn());

    expect(response.cookie.mock.calls[0]?.[2]).toMatchObject({ httpOnly: false });
  });

  /**
   * Same lesson as `issueGuestToken`'s: `secure` and `domain` must come from configuration, or the
   * copy that gets forgotten is the one that sets a cookie over plain HTTP. Every other case here
   * passes the local defaults, so a hardcoded `secure: false` / `domain: 'localhost'` would satisfy
   * them all.
   *
   * `domain` matters twice over here. A cookie jar keys on (name, domain, path), so a bootstrap
   * cookie whose domain disagrees with `CookieService`'s leaves the client holding **two** `nn_csrf`
   * cookies; `cookie-parser` then hands `CsrfGuard` whichever came first, which need not be the one
   * the client is echoing.
   */
  it('carries the configured cookie settings through rather than assuming a local default', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };

    middlewareWith({ cookieDomain: 'shop.example.in', cookieSecure: true }).use(
      {} as never,
      response as never,
      jest.fn(),
    );

    expect(response.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true, domain: 'shop.example.in' }),
    );
  });

  it('mints a different token for every visitor', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };
    const middleware = local();

    middleware.use({} as never, response as never, jest.fn());
    middleware.use({} as never, response as never, jest.fn());

    const [first, second] = response.cookie.mock.calls;
    expect(first?.[1]).not.toBe(second?.[1]);
  });
  /**
   * The minted token has to be reachable by `CookieService.issue()`, which runs later in this same
   * request on login, register and refresh. Without this the response carries two
   * `Set-Cookie: nn_csrf` entries with different values and the body names only the second — which
   * is what broke `auth.integration.spec.ts`'s "the body's token and the cookie's are the same
   * value" assertion.
   */
  it('records the token on the response, so nothing queues a second one', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };

    local().use({} as never, response as never, jest.fn());

    expect(rememberedCsrfToken(response as never)).toBe(response.cookie.mock.calls[0]?.[1]);
  });

  it('records nothing when it minted nothing', () => {
    const response = { cookie: jest.fn<void, [string, string, CookieOptions]>(), locals: {} };

    local().use(
      { cookies: { [CSRF_COOKIE]: 'already-mine' } } as never,
      response as never,
      jest.fn(),
    );

    expect(rememberedCsrfToken(response as never)).toBeUndefined();
  });
});
