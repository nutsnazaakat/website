import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as reachable without a session. `JwtAuthGuard` (Task 30) is registered
 * globally, so authentication is the default and every exception is explicit and greppable.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
