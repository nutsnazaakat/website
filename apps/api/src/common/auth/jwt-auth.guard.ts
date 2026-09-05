import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Registered globally, so **authentication is the default** and every unauthenticated route
 * carries an explicit `@Public()`. The inverse — opting routes in — is how an endpoint ends up
 * unprotected because someone forgot a decorator.
 *
 * Note the shape of the default: `getAllAndOverride` returns `undefined` for a handler with no
 * `@Public()`, which is falsy, so control falls through to `super.canActivate` and the request
 * must present a valid session cookie. Absent metadata means *closed*, never open.
 *
 * **`@Public()` means "a session is not required", not "do not look for one".** A public route still
 * runs passport, and a failure there is swallowed rather than raised — so `request.user` is populated
 * for a customer presenting a valid session cookie and left unset for a guest, and neither is turned
 * away. `@OptionalUser()` is how a handler reads the difference.
 *
 * That distinction is load-bearing for the cart. `if (isPublic) return true` short-circuits before
 * passport runs, which left `request.user` unset even for a signed-in customer: a `@Public()` cart
 * route would then read every customer as a guest, serve the basket their guest cookie names instead
 * of their own, and create a second guest-owned cart on write. Nothing errors — it silently serves
 * the wrong basket.
 *
 * The cost is one session lookup on a public request that carries an access cookie. Deliberately not
 * optimised with a "skip unless the cookie is present" pre-check: passport already answers in
 * microseconds when there is no token to extract, and the pre-check would be a second, untested
 * condition deciding whether authentication happens at all.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isPublic) return (await super.canActivate(context)) as boolean;

    try {
      await super.canActivate(context);
    } catch {
      // Absent, expired or revoked — all ordinary states for a visitor to a public route, and none
      // of them a reason to refuse one. The handler sees no user and treats the caller as a guest.
    }
    return true;
  }
}
