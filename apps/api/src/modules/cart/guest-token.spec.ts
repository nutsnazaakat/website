import { redact } from '../../common/logging/pii-redactor';
import { GUEST_TOKEN_COOKIE, issueGuestToken, readGuestToken } from './guest-token';

const requestWith = (cookies: Record<string, string>) => ({ cookies }) as never;

/**
 * A realistically shaped key: 43 base64url characters, exercising both `-` and `_` — the two
 * characters `base64url` emits and plain base64 does not.
 *
 * The plan wrote this fixture as `'abc123'`, which `readGuestToken` rejects by design. Measured,
 * that spelling gives 5 passed / 1 failed rather than the 6 the plan predicts, because the third
 * test below demands exactly that rejection. Loosening `KEY_PATTERN` to admit a six-character
 * value would also have made both green, and would have discarded the property the validation
 * exists for: a value this service could not have issued must never reach a query.
 */
const ISSUED_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';

describe('readGuestToken', () => {
  it('reads the key from its cookie', () => {
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: ISSUED_KEY }))).toBe(ISSUED_KEY);
  });

  it('returns undefined when there is no cookie at all', () => {
    expect(readGuestToken(requestWith({}))).toBeUndefined();
    expect(readGuestToken({} as never)).toBeUndefined();
  });

  /**
   * The key names a cart row, so a caller who can guess or inject one reads someone else's basket.
   * Anything that is not a key this service issued is rejected rather than passed to a query — which
   * also stops a malformed value reaching a `varchar(64)` column and failing at the driver.
   */
  it('rejects a value this service could not have issued', () => {
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: 'not a key' }))).toBeUndefined();
    expect(
      readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: '../../etc/passwd' })),
    ).toBeUndefined();
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: 'a'.repeat(200) }))).toBeUndefined();
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: '' }))).toBeUndefined();
  });
});

describe('issueGuestToken', () => {
  it('sets an httpOnly cookie and returns the key it set', () => {
    const response = { cookie: jest.fn() };
    const key = issueGuestToken(response as never, {
      cookieDomain: 'localhost',
      cookieSecure: false,
    });

    expect(key).toHaveLength(43);
    expect(response.cookie).toHaveBeenCalledWith(
      GUEST_TOKEN_COOKIE,
      key,
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        domain: 'localhost',
      }),
    );
  });

  /**
   * Not in the plan's test list, and added because its absence was measured: with
   * `secure: settings.cookieSecure` replaced by a hardcoded `secure: false` in `baseCookieOptions`
   * — every cookie this service sets losing its `Secure` flag, production included — the full
   * backend unit suite (185 tests) and the auth integration suite (31) both stayed green. The other
   * cases here only ever pass `cookieSecure: false` and `cookieDomain: 'localhost'`, so a constant
   * satisfies them, and `auth.integration.spec.ts` asserts `HttpOnly`, `SameSite` and `Path` but
   * never `Secure` or `Domain`.
   *
   * That is exactly the defect Step 2's rationale names — "the copy that gets forgotten when that
   * policy changes is the one that sets a session cookie over plain HTTP" — so it should not be the
   * one attribute nothing pins. Since `CookieService.base()` now delegates to the same function,
   * this case guards the access, refresh and CSRF cookies as much as the guest one.
   */
  it('carries the environment settings through rather than assuming a local default', () => {
    const response = { cookie: jest.fn() };
    issueGuestToken(response as never, {
      cookieDomain: 'shop.example.in',
      cookieSecure: true,
    });

    expect(response.cookie).toHaveBeenCalledWith(
      GUEST_TOKEN_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true, domain: 'shop.example.in' }),
    );
  });

  it('issues a different key every time', () => {
    const response = { cookie: jest.fn() };
    const settings = { cookieDomain: 'localhost', cookieSecure: false };
    expect(issueGuestToken(response as never, settings)).not.toBe(
      issueGuestToken(response as never, settings),
    );
  });

  /**
   * `issueGuestToken` and `readGuestToken` have to agree, and nothing else in this file makes them.
   * Every other case either hand-writes a value or checks only the issued key's length, so a
   * `KEY_PATTERN` that drifted from the generator — 32 random bytes widened to 48, say — would
   * leave this suite green while every returning guest silently got an empty basket. That is
   * precisely the failure `KEY_PATTERN`'s own docblock warns about, and it was otherwise untested.
   */
  it('reads back a key it just issued', () => {
    const response = { cookie: jest.fn() };
    const key = issueGuestToken(response as never, {
      cookieDomain: 'localhost',
      cookieSecure: false,
    });

    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: key }))).toBe(key);
  });

  it('is named so the log redactor scrubs it', () => {
    // Assert against the **real** `redact()`, not against the naming convention. An earlier version of
    // this test did `GUEST_TOKEN_COOKIE.replace(/[^a-z0-9]/g, '')).toContain('token')`, which only
    // restates the convention back to itself: it stays green if someone drops `token` from the
    // redactor's keyword list, which is the failure that actually matters. `pii-redactor.spec.ts`
    // already keys on real cookie names (`Cookie: 'nn_access_token=x'`) — follow that.
    //
    // A guest token is a bearer credential for a basket *and* the same visitor's wishlist. Plan 1
    // shipped `nn_rt`, which normalised to `nnrt` and matched nothing, before that lesson was learned.
    expect(redact({ [GUEST_TOKEN_COOKIE]: 'SECRETVALUE' })).toEqual({
      [GUEST_TOKEN_COOKIE]: '[REDACTED]',
    });
    expect(redact({ Cookie: `${GUEST_TOKEN_COOKIE}=SECRETVALUE` })).toEqual({
      Cookie: '[REDACTED]',
    });
  });
});
