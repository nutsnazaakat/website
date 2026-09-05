import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CartLine, CartTotals, CartValidationResult } from '@nutwala/shared';
import type { Request, Response } from 'express';
import { CurrentUser, OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AppConfiguration } from '../../common/config/app.config';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CartService } from './cart.service';
import { CartReadService } from './cart-read.service';
import { GUEST_TOKEN_COOKIE, issueGuestToken, readGuestToken } from './guest-token';
import { ReplaceCartDto } from './dto/replace-cart.dto';
import { ValidateCartDto } from './dto/validate-cart.dto';

export interface CartResponse {
  lines: CartLine[];
  totals: CartTotals;
}

@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly read: CartReadService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `@Public()` on every route but `merge`, and the owner resolved by hand.
   *
   * A guest must be able to build a basket, so these cannot require a session — but a signed-in
   * customer's cart must be found by their id rather than a cookie. `JwtAuthGuard` runs passport on
   * a `@Public()` route and swallows a failure, so `request.user` is populated for a valid session
   * and absent otherwise, and `@OptionalUser()` reads the difference without either caller being
   * turned away.
   *
   * `@OptionalUser()` and not `@CurrentUser()`: the strict decorator throws when no user was
   * resolved, which is the right behaviour on the routes that require a session and a 500 on every
   * guest's `GET /cart` here.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'The current basket, priced live' })
  async get(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<CartResponse> {
    const cart = await this.cart.find(this.owner(user, request));
    return this.read.present(cart, user);
  }

  @Public()
  @Put()
  @ApiOperation({ summary: 'Replace the whole basket' })
  async replace(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: ReplaceCartDto,
  ): Promise<CartResponse> {
    // A guest writing for the first time needs a key before there is a row to hang off it. A
    // returning guest's key is reused rather than replaced: minting a fresh one per write would
    // orphan the previous cart row on every save.
    const owner = user
      ? { userId: user.id }
      : { guestToken: readGuestToken(request) ?? this.issue(response) };

    const cart = await this.cart.replace(owner, dto);
    return this.read.present(cart, user);
  }

  /**
   * **Nothing in the frontend calls this.** `POST /auth/login` and `POST /auth/register` fold the
   * guest basket in server-side, and Task 24's `cartApi` deliberately has no `merge` — the client
   * only refetches after sign-in. That is the more robust arrangement: a customer whose browser
   * closes the instant they sign in still keeps their basket, which a client-driven merge cannot
   * promise.
   *
   * The endpoint stays for two reasons worth stating so it is not mistaken for dead code and
   * deleted: it gives the integration suite a direct handle on `mergeInto` — the sign-in path
   * swallows merge failures by design, so testing through it can only observe success — and it is
   * the manual recovery path when a swallowed merge has left a guest cart stranded.
   *
   * Not `@Public()`, unlike its neighbours: there is nothing to merge *into* without a session, so
   * `@CurrentUser()` is correct here and the guard answers 401 rather than the handler guessing.
   *
   * Idempotent by construction: the guest cart is deleted inside the merge transaction, so a
   * repeated call finds nothing to fold and cannot double a quantity.
   */
  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fold the guest basket into the signed-in one' })
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartResponse> {
    const guestToken = readGuestToken(request);
    if (!guestToken) {
      const cart = await this.cart.find({ userId: user.id });
      return this.read.present(cart, user);
    }

    const cart = await this.cart.mergeInto(user.id, guestToken);
    // The key is spent. Clearing it stops a stale cookie recreating an empty guest cart on the next
    // anonymous write and keeps the unique index free.
    response.clearCookie(GUEST_TOKEN_COOKIE, { path: '/', domain: this.auth().cookieDomain });
    return this.read.present(cart, user);
  }

  @Public()
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-check stock and reprice, per line' })
  async validate(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Body() dto: ValidateCartDto,
  ): Promise<CartValidationResult> {
    // `length > 0` and not merely `dto.lines`: an explicit empty array is a customer who has just
    // emptied the basket, and validating zero lines would answer `ok: true` about the cart that is
    // still stored.
    if (dto.lines && dto.lines.length > 0) return this.read.validateLines(dto.lines, user);
    const cart = await this.cart.find(this.owner(user, request));
    return this.read.validateStored(cart, user);
  }

  /**
   * Session first, cookie second, and neither when there is neither.
   *
   * The order is the whole of it. A customer who built a basket as a guest and then signed in may
   * still hold `nn_guest_token` — the merge clears it, but a failed merge or a second tab leaves it
   * behind — so a cookie that outranked the session would serve them the wrong basket. `{}` for a
   * first-time visitor is deliberate: `CartService.find` answers null, and no key is minted, so a
   * crawler cannot be handed a 30-day identifier by reading the shop.
   */
  private owner(
    user: AuthenticatedUser | undefined,
    request: Request,
  ): { userId?: string; guestToken?: string } {
    if (user) return { userId: user.id };
    const guestToken = readGuestToken(request);
    return guestToken ? { guestToken } : {};
  }

  private issue(response: Response): string {
    return issueGuestToken(response, this.auth());
  }

  private auth(): { cookieDomain: string; cookieSecure: boolean } {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return { cookieDomain: auth.cookieDomain, cookieSecure: auth.cookieSecure };
  }
}
