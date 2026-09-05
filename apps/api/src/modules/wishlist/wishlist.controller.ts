import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Product, WishlistSlugs } from '@nutwala/shared';
import type { Request, Response } from 'express';
import { OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AppConfiguration } from '../../common/config/app.config';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { issueGuestToken, readGuestToken } from '../cart/guest-token';
import { WishlistService, type WishlistOwner } from './wishlist.service';

/**
 * `@Public()` throughout, with the owner resolved by hand — the same shape as `CartController`, and for
 * the same reason: a visitor must be able to save something before they have an account.
 *
 * `@OptionalUser()` and **not** `@CurrentUser()`, for the reason spelled out on both decorators: the
 * strict one throws when `JwtAuthGuard` resolved nobody, which on a `@Public()` route is every guest.
 * `@CurrentUser() user: AuthenticatedUser | undefined` type-checks cleanly and then 500s on the first
 * anonymous request, because a param factory's return type is not the declared parameter type.
 */
@ApiTags('wishlist')
@Controller('wishlist')
export class WishlistController {
  constructor(
    private readonly wishlist: WishlistService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Saved products, newest first' })
  async list(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<Product[]> {
    const owner = this.owner(user, request);
    // A visitor who has never saved anything has no key and no rows. An empty list, not a 404.
    if (!owner.userId && !owner.guestToken) return [];
    return this.wishlist.list(owner, user);
  }

  /**
   * Membership only — the read every listing page makes, and the one the heart on a `ProductCard`
   * depends on. A 24-card shop page needs to know which of 24 hearts are filled, so answering with
   * `list()`'s fully priced products would run the catalogue mapper to decide the colour of an icon.
   *
   * Declared directly beneath `@Get()` and **above** the two `:slug` patterns. There is no
   * `@Get(':slug')` today, so nothing shadows it as things stand; the placement is
   * `catalog.controller.ts`'s ordering rule applied in advance, because a `GET /wishlist/:slug`
   * added later and declared first would swallow this route and answer 404 for a product nobody
   * named. `wishlist.controller.spec.ts` pins the table.
   */
  @Public()
  @Get('slugs')
  @ApiOperation({ summary: 'The slugs of every saved product, newest first' })
  async slugs(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<WishlistSlugs> {
    const owner = this.owner(user, request);
    // Same short-circuit as `list`: `ownerWhere` throws for an ownerless call, so a first-time
    // visitor would get a 404 on the request their first page load fires.
    if (!owner.userId && !owner.guestToken) return { slugs: [] };
    return { slugs: await this.wishlist.slugs(owner) };
  }

  /**
   * Both mutations answer **200 with the new set of saved slugs**, not 204.
   *
   * Two reasons, and the first is a correctness one. `TransformInterceptor` is global and turns a
   * handler returning `undefined` into `{ success: true, data: null }` — so `@HttpCode(204)` would emit
   * a 204 *with a body*, which RFC 9110 forbids and which no route in this service currently does. The
   * choice is therefore between exempting these two routes from the one enforced response shape, or not
   * using 204. Not using 204 is cheaper and keeps `http.ts`'s envelope unwrapping working unchanged.
   *
   * The second is that returning the new state makes the client's optimistic toggle trivial to
   * reconcile — the reply is authoritative, exactly as `PUT /cart` returns the new basket. Slugs rather
   * than full products keeps it small: the heart only needs to know membership, and the wishlist page
   * fetches the products itself.
   *
   * `@HttpCode(HttpStatus.OK)` is what makes "200" true rather than aspirational: Nest answers a `POST`
   * with **201** unless told otherwise, and 201 Created is a lie here — `add` is idempotent, so the
   * commonest second click creates nothing at all. `POST /cart/validate`, `/cart/merge` and
   * `/auth/login` all pin the same way.
   */
  @Public()
  @Post(':slug')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save a product, returning the new set of saved slugs' })
  async add(
    @Param('slug') slug: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WishlistSlugs> {
    // Writing needs an owner, so this is the one route that mints a key — the read and delete
    // handlers above and below short-circuit a cookie-less visitor instead. A returning guest's key
    // is reused rather than replaced: minting a fresh one per save would orphan every row saved
    // under the previous key.
    const owner: WishlistOwner = user
      ? { userId: user.id }
      : { guestToken: readGuestToken(request) ?? issueGuestToken(response, this.cookieSettings()) };
    await this.wishlist.add(owner, slug);
    return { slugs: await this.wishlist.slugs(owner) };
  }

  @Public()
  @Delete(':slug')
  @ApiOperation({ summary: 'Unsave a product, returning the new set of saved slugs' })
  async remove(
    @Param('slug') slug: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<WishlistSlugs> {
    const owner = this.owner(user, request);
    if (!owner.userId && !owner.guestToken) return { slugs: [] };
    await this.wishlist.remove(owner, slug);
    return { slugs: await this.wishlist.slugs(owner) };
  }

  /**
   * Session first, cookie second, and neither when there is neither — `CartController.owner`'s
   * reasoning, unchanged: a customer who saved things as a guest and then signed in may still hold
   * `nn_guest_token`, so a cookie that outranked the session would serve them someone else's list.
   */
  private owner(user: AuthenticatedUser | undefined, request: Request): WishlistOwner {
    if (user) return { userId: user.id };
    const guestToken = readGuestToken(request);
    return guestToken ? { guestToken } : {};
  }

  private cookieSettings(): { cookieDomain: string; cookieSecure: boolean } {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return { cookieDomain: auth.cookieDomain, cookieSecure: auth.cookieSecure };
  }
}
