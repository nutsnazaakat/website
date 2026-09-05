import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { DomainError, ErrorCodes } from '../errors/domain-error';
import { SKIP_CSRF_KEY } from './decorators/skip-csrf.decorator';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

export const CSRF_HEADER = 'x-csrf-token';

/** Methods that do not change state need no token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check.
 *
 * `SameSite` already blocks the common cross-site POST, but it is a browser policy and not
 * every client honours it identically. This adds a second, independent condition: the caller
 * must be able to *read* the CSRF cookie, which a cross-origin page cannot do.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    // Mirrors how `JwtAuthGuard` honours `@Public()`. Handler first, then class, so a
    // method-level decorator wins over its controller.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const cookie = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = request.header(CSRF_HEADER);

    if (!cookie || !header) throw this.reject();

    const cookieBuffer = Buffer.from(cookie);
    const headerBuffer = Buffer.from(header);
    // `timingSafeEqual` throws on differing lengths, so compare those first.
    if (cookieBuffer.length !== headerBuffer.length) throw this.reject();
    if (!timingSafeEqual(cookieBuffer, headerBuffer)) throw this.reject();

    return true;
  }

  private reject(): DomainError {
    return new DomainError(
      ErrorCodes.CSRF_TOKEN_INVALID,
      'Your request could not be verified. Please refresh the page and try again.',
      HttpStatus.FORBIDDEN,
    );
  }
}
