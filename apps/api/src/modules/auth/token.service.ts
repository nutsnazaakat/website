import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { StringValue } from 'ms';
import type { AppConfiguration } from '../../common/config/app.config';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  sessionId: string;
}

/** Injected directly in unit tests so the service does not need a Nest container. */
export interface TokenSettings {
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
}

export const TOKEN_SETTINGS = 'TOKEN_SETTINGS';

const REFRESH_TOKEN_BYTES = 32;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(TOKEN_SETTINGS) private readonly settings: TokenSettings,
  ) {}

  /**
   * Short-lived, 15 minutes by default. Short enough that a revoked session stops working
   * quickly without a database read on every request, which is the trade spec §9 makes.
   */
  signAccessToken(claims: AccessTokenClaims): string {
    // `expiresIn` is typed by `jsonwebtoken` as `ms`'s template-literal `StringValue`, but the
    // TTL arrives as a plain string from configuration (or injected directly in tests). The
    // cast is a type-level bridge only — `jsonwebtoken` still validates the format at runtime
    // and throws if it is not a recognised duration string.
    return this.jwt.sign(claims, {
      expiresIn: this.settings.accessTokenTtl as StringValue,
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token);
  }

  /**
   * An opaque random token, not a JWT.
   *
   * A refresh token needs no claims — it is looked up in `sessions` — and making it opaque
   * means it carries no information at all if it leaks, and cannot be accepted on signature
   * alone by a service that forgets to check revocation.
   */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  /** Only the digest is stored, so a database disclosure yields no usable credential. */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshExpiryFrom(now: Date = new Date()): Date {
    return new Date(now.getTime() + this.settings.refreshTokenTtlDays * MS_PER_DAY);
  }
}

/**
 * Supplies `TOKEN_SETTINGS` from configuration.
 *
 * Registered by **`SessionsModule`**, not `AuthModule`, and that is load-bearing rather than
 * incidental: `SessionsService` injects `TokenService`, and Nest resolves a provider's dependencies
 * only in its declaring module's scope, so the token and its settings have to live where the
 * session service can see them. `AuthModule` imports `SessionsModule` and reuses that one instance
 * instead of declaring a second — two `TokenService` instances would mean the login path and the
 * refresh path holding independent settings objects.
 *
 * An earlier version of this comment credited `AuthModule`, which did not exist yet when it was
 * written and is the wrong owner now that it does.
 */
export function tokenSettingsFactory(config: ConfigService): TokenSettings {
  const app = config.getOrThrow<AppConfiguration>('app');
  return {
    accessTokenTtl: app.auth.accessTokenTtl,
    refreshTokenTtlDays: app.auth.refreshTokenTtlDays,
  };
}
