import type { CookieOptions } from 'express';
import { rememberCsrfToken } from '../../common/http/cookie-options';
import { ACCESS_COOKIE, CSRF_COOKIE, CookieService, REFRESH_COOKIE } from './cookie.service';

const TOKENS = { accessToken: 'access-jwt', refreshToken: 'refresh-token' };

const service = () =>
  new CookieService({
    getOrThrow: () => ({
      auth: { cookieDomain: '127.0.0.1', cookieSecure: false, refreshTokenTtlDays: 30 },
    }),
  } as never);

const responseMock = () => ({
  cookie: jest.fn<void, [string, string, CookieOptions]>(),
  locals: {},
});

const csrfCalls = (response: ReturnType<typeof responseMock>) =>
  response.cookie.mock.calls.filter(([name]) => name === CSRF_COOKIE);

describe('CookieService.issue', () => {
  it('sets the three session cookies', () => {
    const response = responseMock();

    service().issue(response as never, TOKENS);

    expect(response.cookie.mock.calls.map(([name]) => name)).toEqual([
      ACCESS_COOKIE,
      REFRESH_COOKIE,
      CSRF_COOKIE,
    ]);
  });

  /**
   * A client that arrived holding a token gets a fresh one: `CsrfBootstrapMiddleware` stays out of
   * the way when the request already carries `nn_csrf`, so nothing is recorded on the response and
   * a token that predates the sign-in is still rotated here.
   */
  it('mints and returns a fresh token when nothing was bootstrapped', () => {
    const response = responseMock();

    const token = service().issue(response as never, TOKENS);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfCalls(response)).toHaveLength(1);
    expect(csrfCalls(response)[0]?.[1]).toBe(token);
  });

  /**
   * The collision this exists to prevent, and it is reachable on the very first request a new
   * customer makes: `POST /register` runs the bootstrap middleware — which mints, because the client
   * has no cookie — and then this method.
   *
   * `res.cookie` appends rather than replaces, so minting again would put **two**
   * `Set-Cookie: nn_csrf` entries on one response with different values, while the body reported only
   * the second. A client reading the first is then echoing a token the guard will not match, and
   * every write it makes answers 403.
   */
  it('reuses a token the bootstrap middleware already queued, setting no second cookie', () => {
    const response = responseMock();
    rememberCsrfToken(response as never, 'bootstrapped-token');

    const token = service().issue(response as never, TOKENS);

    expect(token).toBe('bootstrapped-token');
    expect(csrfCalls(response)).toHaveLength(0);
  });
});
