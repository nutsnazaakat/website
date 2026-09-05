import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AppConfiguration } from '../config/app.config';
import { setContextUserId } from '../logging/request-context';
import { SessionsService } from '../../modules/sessions/sessions.service';
import { ACCESS_COOKIE } from '../../modules/auth/cookie.service';
import type { AccessTokenClaims } from '../../modules/auth/token.service';

export interface AuthenticatedUser {
  id: string;
  role: string;
  sessionId: string;
}

/** Reads the access token from the httpOnly cookie, not an Authorization header. */
function fromCookie(request: Request): string | null {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.[ACCESS_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly sessions: SessionsService,
  ) {
    const app = config.getOrThrow<AppConfiguration>('app');
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromCookie]),
      secretOrKey: app.auth.jwtSecret,
      ignoreExpiration: false,
    });
  }

  /**
   * A valid signature is not enough. The session must still be active, which is what makes
   * logout and admin force-logout take effect rather than waiting out the token's 15 minutes.
   */
  async validate(claims: AccessTokenClaims): Promise<AuthenticatedUser> {
    if (!claims.sessionId) throw new UnauthorizedException();

    const active = await this.sessions.isActive(claims.sessionId);
    if (!active) throw new UnauthorizedException();

    setContextUserId(claims.sub);
    return { id: claims.sub, role: claims.role, sessionId: claims.sessionId };
  }
}
