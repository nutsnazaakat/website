import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { withMessage, type AuthUser, type Enveloped } from '@nutwala/shared';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import { SkipCsrf } from '../../common/auth/decorators/skip-csrf.decorator';
import type { AppConfiguration } from '../../common/config/app.config';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { CartService } from '../cart/cart.service';
import { GUEST_TOKEN_COOKIE, readGuestToken } from '../cart/guest-token';
import { SessionsService, type SessionMeta } from '../sessions/sessions.service';
import { WishlistService } from '../wishlist/wishlist.service';
import { toUserRole } from '../users/user.mapper';
import { AuthService } from './auth.service';
import { CookieService, REFRESH_COOKIE } from './cookie.service';
import { TokenService } from './token.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/**
 * What the client gets back. The tokens themselves are in httpOnly cookies, never here.
 *
 * This interface is also the DTO boundary the Task 22/23 security review asked for (item 4), and
 * it is load-bearing rather than documentary. `SessionsService.issue` and `.rotate` both hand back
 * a whole `Session` entity, and `Session.refreshTokenHash` has no `select: false` and no
 * `@Exclude()` — unlike `User.passwordHash` — so any `Session` that reached a handler's return
 * value would be serialised digest and all. Declaring every handler's return type explicitly is
 * what makes that impossible instead of merely unlikely: TypeScript's excess-property check
 * rejects an object literal carrying a `session` key, and no field of this type or of `AuthUser`
 * can hold one. There is exactly one `Session`-typed value anywhere in this controller — the
 * `rotate` result inside `refresh` — and the two identifiers read off it are strings.
 */
interface AuthResponse {
  user: AuthUser;
  /** Echoed in `X-CSRF-Token` on state-changing requests. Not a credential — see CsrfGuard. */
  csrfToken: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  /**
   * `config` rather than `auth` for the `ConfigService`: `this.auth` is already `AuthService`, so the
   * `this.auth().cookieDomain` shape `CartController` uses would collide here rather than compile.
   */
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly carts: CartService,
    private readonly wishlists: WishlistService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(AuthController.name);
  }

  @Public()
  // The client has no CSRF cookie yet — this endpoint is what issues it.
  @SkipCsrf()
  // 3 registrations per hour per IP. Spec §9, and see the note on the §13 enumeration gap: this
  // limit is the only control in front of the account-existence oracle until email-verified
  // signup lands, so it must not be relaxed.
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create an account and start a session' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.register(dto, this.meta(request));
    const csrfToken = this.cookies.issue(response, result);
    await this.mergeGuestState(request, response, result.user.id);
    return { user: result.user, csrfToken };
  }

  @Public()
  @SkipCsrf()
  // 5 attempts per 15 minutes. Throttled per IP by @nestjs/throttler's default tracker.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.login(dto, this.meta(request));
    const csrfToken = this.cookies.issue(response, result);
    await this.mergeGuestState(request, response, result.user.id);
    return { user: result.user, csrfToken };
  }

  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const presented = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Rotation revokes the presented token and detects reuse — see SessionsService.
    const { session, refreshToken } = await this.sessions.rotate(presented, this.meta(request));

    // The only two things this handler needs from the entity, both strings. Nothing below this
    // line touches `session` again, which is half of why no digest can reach the response; the
    // other half is the declared `AuthResponse` return type. See the comment on that interface.
    const { id: sessionId, userId } = session;

    // Resolved once. The role is read from the database rather than carried over from the old
    // token, so an admin promoting or demoting a user takes effect on the next refresh rather
    // than waiting for them to sign out.
    const user = await this.auth.me(userId);

    const csrfToken = this.cookies.issue(response, {
      // `toUserRole` converts the wire role on `AuthUser` (`b2c`) back to the database enum
      // (`CUSTOMER`), which is the vocabulary `RolesGuard` narrows a token's claim against.
      // Signing the wire value instead would leave every admin route returning a silent 403.
      accessToken: this.tokens.signAccessToken({
        sub: userId,
        role: toUserRole(user.role),
        sessionId,
      }),
      refreshToken,
    });

    return { user, csrfToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the session and clear cookies' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Enveloped<null>> {
    await this.auth.logout(user.sessionId);
    this.cookies.clear(response);
    // Nominal opt-in — see `Enveloped` in @nutwala/shared. A bare `{ data, message }` object
    // would NOT be lifted.
    return withMessage(null, 'Signed out.');
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUser> {
    return this.auth.me(user.id);
  }

  @Post('upgrade-to-business')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Brief §46 — enable bulk buying on an existing account' })
  upgradeToBusiness(@CurrentUser() user: AuthenticatedUser): Promise<AuthUser> {
    return this.auth.upgradeToBusiness(user.id);
  }

  /**
   * Folds any guest basket **and** any guest saved-items list into the account that just signed in.
   *
   * Server-side rather than a call the client makes after sign-in: a customer whose browser closes
   * the instant they sign in still keeps both, which a client-driven merge cannot promise. One
   * `nn_guest_token` names both sets of rows, so one key produces one merge step.
   *
   * Caught **separately**, not in one shared `try`. The two merges are independent, which is the
   * argument *against* sharing a catch rather than for it: with one block, a cart failure returns
   * before `wishlists.mergeInto` is ever called, so a customer whose basket merge broke silently
   * loses their saved list too — a second loss caused by nothing to do with the wishlist.
   *
   * Still swallowed and logged rather than thrown: losing a basket or a saved list is bad, failing
   * the sign-in is worse, and neither is worth an account the customer cannot get into. The log now
   * names *which* merge failed, which the shared message could not.
   */
  private async mergeGuestState(
    request: Request,
    response: Response,
    userId: string,
  ): Promise<void> {
    const guestToken = readGuestToken(request);
    if (!guestToken) return;

    const { auth } = this.config.getOrThrow<AppConfiguration>('app');

    let allMerged = true;
    const merges = [
      ['cart', () => this.carts.mergeInto(userId, guestToken)],
      ['wishlist', () => this.wishlists.mergeInto(userId, guestToken)],
    ] as const;

    // Sequential on purpose, not `Promise.allSettled`. Both merges open a transaction against rows
    // keyed by the same guest token, and running them concurrently would put two transactions in
    // flight for one visitor for no gain — the whole step is two small statements on a table written
    // once per click.
    for (const [what, run] of merges) {
      try {
        await run();
      } catch (error) {
        allMerged = false;
        this.logger.error(`Guest ${what} merge failed after sign-in`, { userId, error });
      }
    }

    // Cleared only when both succeeded. Clearing it after a failure would strand the guest's rows
    // permanently — the token that names them is gone, so nothing can ever find them again. Leaving
    // the cookie means the next sign-in retries, and a retried merge is harmless: neither
    // `mergeInto` finds anything to fold the second time.
    if (allMerged) {
      response.clearCookie(GUEST_TOKEN_COOKIE, { path: '/', domain: auth.cookieDomain });
    }
  }

  private meta(request: Request): SessionMeta {
    return { userAgent: request.header('user-agent') ?? null, ip: request.ip ?? null };
  }
}
