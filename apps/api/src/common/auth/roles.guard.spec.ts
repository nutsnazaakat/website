import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../entities/enums';
import { ROLES_KEY } from './decorators/roles.decorator';
import type { AuthenticatedUser } from './jwt.strategy';
import { RolesGuard } from './roles.guard';

/**
 * Spec §13 makes this guard the **only** thing enforcing admin access — the admin app's own route
 * guard is user experience and stops nothing. It had no unit spec until this file: the first
 * `@Roles(ADMIN)` route arrived with Task 22, whose integration spec covers the two headline paths
 * (a customer gets 403, an admin gets 200). The cases below are the ones a route-level test cannot
 * reach, and one of them is the reason half this guard's code exists.
 */
function harness(options: { required?: UserRole[]; user?: Partial<AuthenticatedUser> }): {
  guard: RolesGuard;
  context: ExecutionContext;
} {
  const request = options.user
    ? { user: { id: 'user-1', sessionId: 'session-1', ...options.user } as AuthenticatedUser }
    : {};

  const context = {
    getHandler: () => function handler(): void {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const reflector = {
    // Key-aware rather than blanket. A guard reading the wrong metadata key would otherwise see
    // `undefined` on every route, take the "no roles required" branch, and let everything through.
    getAllAndOverride: jest.fn((key: string) => (key === ROLES_KEY ? options.required : undefined)),
  } as unknown as Reflector;

  return { guard: new RolesGuard(reflector), context };
}

describe('RolesGuard', () => {
  it('lets any authenticated user through a route with no @Roles()', () => {
    const { guard, context } = harness({ user: { role: UserRole.CUSTOMER } });
    expect(guard.canActivate(context)).toBe(true);
  });

  /**
   * `@Roles()` with no arguments must not be read as "nobody may pass". It is the same absence of a
   * restriction as no decorator at all, and the guard's `required.length === 0` branch says so.
   */
  it('treats an empty @Roles() the same as none', () => {
    const { guard, context } = harness({ required: [], user: { role: UserRole.CUSTOMER } });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('admits a user holding the required role', () => {
    const { guard, context } = harness({
      required: [UserRole.ADMIN],
      user: { role: UserRole.ADMIN },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a user holding a different role', () => {
    const { guard, context } = harness({
      required: [UserRole.ADMIN],
      user: { role: UserRole.CUSTOMER },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  /**
   * No `request.user` at all. Reachable in a way that is easy to miss: `JwtAuthGuard` returns early
   * on a `@Public()` route without populating `request.user`, so a route marked both `@Public()` and
   * `@Roles(ADMIN)` — a plausible mistake — arrives here with nothing to check. It must refuse rather
   * than read `undefined` as satisfying anything.
   */
  it('refuses when no user was attached to the request', () => {
    const { guard, context } = harness({ required: [UserRole.ADMIN] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  /**
   * **The case the guard's `isUserRole` check exists for, and the reason it must not be replaced by a
   * cast.** Two role vocabularies live in this codebase: the token carries the database enum
   * (`ADMIN`), while the response body carries the wire role (`admin`, via `toAuthUser`). A cast to
   * `UserRole` would compile whatever the token actually held, so if anyone ever signed the wire role
   * instead, `required.includes(role)` would compare `'admin'` against `'ADMIN'` and every admin route
   * would return an identical silent 403 with nothing to point at.
   *
   * The claim is verified end to end elsewhere — `auth.service.ts` signs `role: UserRole` — but that
   * is the sort of thing a later refactor changes without noticing. This is the test that notices.
   *
   * **What it pins is the outcome, not the mechanism, and that is worth stating.** Measured: replacing
   * `isUserRole(role)` with `required.includes(role as UserRole)` leaves this test green, because
   * `['ADMIN'].includes('admin')` is false either way — the wire spelling is refused by the other
   * branch. So this case guarantees a mis-signed role cannot pass; it does not guarantee the explicit
   * check survives. Nothing can, while both branches throw the same message and nothing logs which
   * fired. Reported rather than papered over with a test that asserts on source text.
   */
  it('refuses a role that is not one of the enum values, such as the wire spelling', () => {
    const { guard, context } = harness({
      required: [UserRole.ADMIN],
      user: { role: 'admin' },
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  /** The refusal must not say which of the reasons above applied. */
  it('gives the same generic message however it refuses', () => {
    const wrongRole = harness({ required: [UserRole.ADMIN], user: { role: UserRole.CUSTOMER } });
    const noUser = harness({ required: [UserRole.ADMIN] });

    const messageOf = (h: { guard: RolesGuard; context: ExecutionContext }): string => {
      try {
        h.guard.canActivate(h.context);
      } catch (error) {
        return (error as ForbiddenException).message;
      }
      throw new Error('expected a refusal');
    };

    expect(messageOf(wrongRole)).toBe('You do not have permission to perform this action.');
    expect(messageOf(noUser)).toBe(messageOf(wrongRole));
  });
});
