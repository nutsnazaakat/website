import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthenticatedUser } from './jwt.strategy';

const SIGNED_IN: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };

/** The `AuthGuard('jwt')` mixin `JwtAuthGuard` extends — the `super.canActivate` under test. */
const passportPrototype = Object.getPrototypeOf(JwtAuthGuard.prototype) as {
  canActivate: (context: ExecutionContext) => Promise<boolean>;
};

interface Harness {
  guard: JwtAuthGuard;
  request: { user?: AuthenticatedUser };
  context: ExecutionContext;
  /** Stands in for passport: resolves and populates `request.user`, or rejects. */
  authenticate: jest.SpyInstance<Promise<boolean>, [ExecutionContext]>;
}

function harness(options: { isPublic: boolean; validSession: boolean }): Harness {
  const request: { user?: AuthenticatedUser } = {};
  const context = {
    getHandler: () => function handler(): void {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const reflector = {
    // Key-aware rather than blanket: a guard reading the wrong metadata key would otherwise
    // still see `true` and every route would go public.
    getAllAndOverride: jest.fn((key: string) =>
      key === IS_PUBLIC_KEY && options.isPublic ? true : undefined,
    ),
  } as unknown as Reflector;

  const authenticate = jest.spyOn(passportPrototype, 'canActivate').mockImplementation(() => {
    if (!options.validSession) return Promise.reject(new UnauthorizedException());
    // Exactly what passport does on success, and the effect the cart depends on.
    request.user = SIGNED_IN;
    return Promise.resolve(true);
  });

  return { guard: new JwtAuthGuard(reflector), request, context, authenticate };
}

afterEach(() => jest.restoreAllMocks());

describe('JwtAuthGuard', () => {
  it('requires a valid session on a route with no @Public()', async () => {
    const { guard, context, request } = harness({ isPublic: false, validSession: true });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(SIGNED_IN);
  });

  it('rejects a protected route when the session is absent or revoked', async () => {
    const { guard, context } = harness({ isPublic: false, validSession: false });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * The case the cart needs, and the one the previous implementation got wrong.
   *
   * `if (isPublic) return true` short-circuits before passport runs, so `request.user` stays unset
   * even for a customer presenting a perfectly valid session cookie. A `@Public()` cart route would
   * then read every signed-in customer as a guest: their basket would be looked up by guest cookie,
   * the cart they built while signed in would appear empty, and a write would create a *second*,
   * guest-owned cart beside it. Nothing errors — it just silently serves the wrong basket.
   */
  it('resolves the user on a public route, so an optional-auth handler can see them', async () => {
    const { guard, context, request, authenticate } = harness({
      isPublic: true,
      validSession: true,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith(context);
    expect(request.user).toEqual(SIGNED_IN);
  });

  /**
   * And the other half: a public route stays public. An absent, expired or revoked session is not
   * an error here — it is the ordinary case for a first-time visitor, who must still be able to
   * fetch the shop and build a basket.
   */
  it('lets a guest through a public route with no session at all', async () => {
    const { guard, context, request } = harness({ isPublic: true, validSession: false });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});
