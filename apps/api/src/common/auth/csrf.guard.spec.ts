import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';
import { DomainError, ErrorCodes } from '../errors/domain-error';
import { SKIP_CSRF_KEY } from './decorators/skip-csrf.decorator';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

/**
 * Reads the `code` off a synchronous `DomainError`, and fails loudly if the call was *allowed*.
 *
 * `expect(fn).toThrow(/CSRF/i)` cannot work here — `DomainError` keeps `code` as a separate own
 * property and `toThrow(regex)` only ever tests `Error.message`. The two shorter alternatives are
 * both unusable: `toThrow(expect.objectContaining({ code }))` passes Jest and `tsc`, but
 * `objectContaining` returns `any` and `no-unsafe-argument` rejects the call; and a bare
 * `try { ... } catch { expect(...) }` silently passes when the guard wrongly *allows* the
 * request, which is the one failure this suite exists to catch.
 */
function rejectionFrom(call: () => unknown): DomainError {
  try {
    call();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Expected the guard to reject the request, but it allowed it');
}

/** Stand-ins for the decorated handler and its controller, so the metadata targets are checkable. */
const HANDLER = function checkout(): void {};
class CheckoutController {}

function contextFor(method: string, cookie?: string, header?: string): ExecutionContext {
  return {
    getHandler: () => HANDLER,
    getClass: () => CheckoutController,
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        cookies: cookie === undefined ? {} : { [CSRF_COOKIE]: cookie },
        header: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? header : undefined),
      }),
    }),
  } as unknown as ExecutionContext;
}

interface Harness {
  guard: CsrfGuard;
  /** The `Reflector` call the guard makes, so a test can assert *what* it looked up. */
  getAllAndOverride: jest.Mock<boolean | undefined, [string, unknown[]]>;
}

/**
 * The guard reads `@SkipCsrf()` metadata through a `Reflector`, so every construction needs one.
 * `undefined` is what Nest yields for a handler with no such decorator, which is the default case
 * for every route.
 *
 * The stub is deliberately *key-aware* rather than returning `true` for anything asked of it. A
 * blanket mock would keep both exemption tests green even if the guard read the wrong metadata
 * key — `IS_PUBLIC_KEY`, say — which would mean every `@Public()` route silently lost its CSRF
 * check too.
 */
function guardWith(skipCsrf: boolean): Harness {
  const getAllAndOverride = jest.fn((key: string, _targets: unknown[]): boolean | undefined =>
    skipCsrf && key === SKIP_CSRF_KEY ? true : undefined,
  );
  const reflector = { getAllAndOverride };
  return { guard: new CsrfGuard(reflector as unknown as Reflector), getAllAndOverride };
}

describe('CsrfGuard', () => {
  const { guard } = guardWith(false);

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows the safe method %s without a token', (method) => {
    expect(guard.canActivate(contextFor(method))).toBe(true);
  });

  it('allows a state-changing request when the cookie and header match', () => {
    expect(guard.canActivate(contextFor('POST', 'abc123', 'abc123'))).toBe(true);
  });

  it('rejects a state-changing request with no header', () => {
    expect(rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc123'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
  });

  it('rejects a state-changing request with no cookie', () => {
    expect(
      rejectionFrom(() => guard.canActivate(contextFor('POST', undefined, 'abc123'))).code,
    ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
  });

  it('rejects a mismatched token', () => {
    expect(
      rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc123', 'def456'))).code,
    ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
  });

  it('rejects tokens of differing length without throwing from timingSafeEqual', () => {
    expect(rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc', 'abcdef'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
  });

  it('exempts a handler carrying @SkipCsrf() — login has no token to send yet', () => {
    const { guard: exempt, getAllAndOverride } = guardWith(true);

    expect(exempt.canActivate(contextFor('POST'))).toBe(true);
    // The exemption has to come from `@SkipCsrf()` on this handler or its controller, and
    // nothing else. Asserting the key and the targets is what stops the guard from reading some
    // other route's metadata — or a different decorator's — and calling that an exemption.
    expect(getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [HANDLER, CheckoutController]);
  });

  it('does not let the exemption leak to a handler without the decorator', () => {
    // The same guard instance serves every route. If this ever returns true, one `@SkipCsrf()`
    // on login would have silently disabled CSRF for the whole application.
    const { guard: plain, getAllAndOverride } = guardWith(false);

    expect(rejectionFrom(() => plain.canActivate(contextFor('POST'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
    // And it rejected *after* consulting the metadata, rather than by ignoring it — otherwise
    // this test would also pass against a guard that no longer honours the exemption at all.
    expect(getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [HANDLER, CheckoutController]);
  });

  it('guards PATCH, PUT and DELETE as well as POST', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(
        rejectionFrom(() => guard.canActivate(contextFor(method, 'abc123', 'wrong1'))).code,
      ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
    }
  });
});
