import { SetMetadata } from '@nestjs/common';

/**
 * Exempts a handler from `CsrfGuard`.
 *
 * Only for the three endpoints that issue the CSRF cookie rather than consume it. Every other
 * state-changing route must carry a token; if you find yourself reaching for this decorator
 * elsewhere, the route is wrong, not the guard.
 */
export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = (): MethodDecorator => SetMetadata(SKIP_CSRF_KEY, true);
