import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '../../entities/enums';
import { ROLES_KEY } from './decorators/roles.decorator';
import type { AuthenticatedUser } from './jwt.strategy';

const USER_ROLES: readonly string[] = Object.values(UserRole);

/** Narrows a token's `role` claim, which is a plain `string`, to the enum the guard compares. */
function isUserRole(role: string): role is UserRole {
  return USER_ROLES.includes(role);
}

/**
 * Registered globally alongside `JwtAuthGuard`. A route with no `@Roles()` is open to any
 * authenticated user; `@Roles(UserRole.ADMIN)` restricts it.
 *
 * Spec §13: this is the *only* thing that enforces admin access. The frontend's `/admin` route
 * guard is user experience — it stops a customer seeing a broken screen, and stops nothing else.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const role = request.user?.role;

    // The role comes from the signed token, never from a header or body field.
    //
    // Membership is tested against the enum's real values rather than by casting `role` to
    // `UserRole`. The cast would compile whatever the token actually carries, and there are two
    // role vocabularies in this codebase — the token carries the database enum (`ADMIN`), the
    // response body carries the wire role (`admin`, via `toAuthUser`). If anyone ever signs the
    // wire role instead, a cast would leave every admin route returning a silent, identical 403
    // with nothing to point at. This way the anomaly is distinguishable in the logs while the
    // client still gets the same generic refusal.
    //
    // **That last sentence overstates what exists today, measured rather than assumed.** Nothing here
    // logs which branch fired, and both throw the identical message, so from outside the two are
    // indistinguishable — replacing this check with `required.includes(role as UserRole)` leaves every
    // test green, including the one written for it (`roles.guard.spec.ts`). The check is kept because
    // it is the correct shape and costs nothing, but it is currently **unobservable**: if the log
    // distinction is ever wanted, it has to be added, not relied on.
    if (role === undefined || !isUserRole(role)) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }
    if (!required.includes(role)) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }
    return true;
  }
}
