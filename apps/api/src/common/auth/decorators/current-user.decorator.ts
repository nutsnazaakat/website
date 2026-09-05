import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../jwt.strategy';

/**
 * Injects the authenticated user resolved from the token.
 *
 * Every scoped query reads its owner from here and never from a route parameter or body
 * field — that is the IDOR defence in spec §13, applied at the point of use.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) throw new Error('CurrentUser used on a route without JwtAuthGuard');
    return request.user;
  },
);

/**
 * The same user, on a route where **not** having one is legitimate.
 *
 * For `@Public()` routes that serve guests and customers alike — the cart, and the wishlist after
 * it. `JwtAuthGuard` runs passport on a public route and swallows the failure, so `request.user` is
 * populated for a valid session and absent otherwise; this is how a handler reads which.
 *
 * A separate decorator rather than a `| undefined` on `@CurrentUser()`, because the parameter's
 * declared type is not what a param factory returns: `@CurrentUser() user: AuthenticatedUser |
 * undefined` type-checks cleanly and then throws `CurrentUser used on a route without JwtAuthGuard`
 * on the first guest request — a 500 on `GET /cart` for every visitor who has never signed in. Two
 * names keeps that safety net intact on the fifty routes that genuinely require a session, and makes
 * the handful that do not greppable.
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>().user,
);
