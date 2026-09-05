import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseInterceptors } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  toRupees,
  type AccountOrder,
  type CouponPreviewResponse,
  type PincodeCheckResponse,
} from '@nutwala/shared';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { Order } from '../../entities/commerce/order.entity';
import { readGuestToken } from '../cart/guest-token';
import { toAccountOrder } from '../orders/mappers/order.mapper';
import { ITEMS_IN_ORDER } from '../orders/orders.service';
import { CheckoutIdempotencyInterceptor } from './checkout-idempotency.interceptor';
import { CheckoutService, type CartOwner } from './checkout.service';
import type { CouponPreview } from './coupon.service';
import { CheckPincodeDto } from './dto/check-pincode.dto';
import { PlaceOrderDto } from './dto/place-order.dto';
import { PreviewCouponDto } from './dto/preview-coupon.dto';
import { PincodeService } from './pincode.service';

function toCouponPreviewResponse(preview: CouponPreview): CouponPreviewResponse {
  if (preview.eligible) {
    return {
      eligible: true,
      couponCode: preview.couponCode,
      discount: toRupees(preview.discountPaise),
      eligibleSubtotal: toRupees(preview.eligibleSubtotalPaise),
    };
  }

  return {
    eligible: false,
    reason: preview.code,
    // Omitted rather than sent as null, matching the optional field: it is present on exactly one
    // refusal, and `COUPON_INVALID` carrying `minOrderValue: 0` would read as "spend ₹0 and it works".
    ...(preview.minOrderValuePaise === undefined
      ? {}
      : { minOrderValue: toRupees(preview.minOrderValuePaise) }),
  };
}

@ApiTags('checkout')
@Controller('checkout')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    /**
     * Injected directly rather than reached through `CheckoutService`, which is the only route here
     * that does not go through it.
     *
     * `previewCoupon` and `place` both need the caller's *basket* — `CheckoutService` is where the
     * cart is found, priced and assessed — and serviceability needs none of it: it is one read of an
     * admin-editable table, keyed by six digits from the request. A `CheckoutService.checkPincode`
     * passing straight through to `PincodeService.resolve` would add a layer with nothing in it and
     * a second place for the paise-to-rupees boundary to drift to.
     */
    private readonly pincodes: PincodeService,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  /**
   * `POST /checkout/pincode` — spec §6.1's *"serviceability + ETA + shipping"*.
   *
   * **`@Public()`, and it takes no owner at all.** The checker lives on the *product* page
   * (`features/catalog/components/PincodeChecker.tsx`, the only consumer), not on checkout, so most
   * callers have neither a session nor a basket — and the answer does not depend on either. That is
   * why this handler declares no `@OptionalUser()` and no `@Req()`: there is nothing to resolve, and
   * a parameter accepted here would be a parameter someone later branches on.
   *
   * **Rupees on the wire, converted once, here.** `PincodeVerdict.shippingPaise` is a `bigint`, and
   * returning it unmapped would not throw — `bigint-json.ts` patches `BigInt.prototype.toJSON` — it
   * would ship the *string* `"7900"` and the checker would print `₹NaN`. That patch exists to keep a
   * stray bigint from being a 500; it does not make one correct.
   *
   * **A refusal is a `200` with `serviceable: false`, not an error.** `CheckoutService.place` answers
   * the same table with a 422, and rightly — there, an unserviceable pincode is a placement that
   * cannot happen. Here the customer is *asking*, and "no" is the answer to their question rather
   * than a failed request; the checker renders it as "We don't deliver here yet." A 4xx would put it
   * in `ApiRequestError` and leave the component's success branch permanently unreachable.
   *
   * `etaDays` and `shipping` are passed through as the verdict gives them, including on the refusing
   * arm, where `PincodeService` answers zeroes for an unmatched pincode and the *row's* figures for a
   * stored refusal. Not normalised to zero here: the two are genuinely different answers — nothing is
   * known about this pincode, versus a rule says no — and flattening them would hide which the
   * database gave.
   */
  @Public()
  @Post('pincode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether we deliver to a pincode, with the ETA and shipping charge' })
  async checkPincode(@Body() dto: CheckPincodeDto): Promise<PincodeCheckResponse> {
    const verdict = await this.pincodes.resolve(dto.pincode);

    return {
      pincode: dto.pincode,
      serviceable: verdict.isServiceable,
      etaDays: verdict.etaDays,
      shipping: toRupees(verdict.shippingPaise),
    };
  }

  /**
   * `@Public()` on every route here, and on the two basket-bound ones the owner resolved by hand —
   * the same arrangement `CartController`
   * uses, for the same reason: **checkout is reachable anonymously.** A guest builds a basket and
   * places an order against their `nn_guest_token`, and a signed-in customer must be found by their
   * id rather than by a cookie they may still be holding.
   *
   * `@OptionalUser()` and never `@CurrentUser()`. The strict decorator *throws* when `request.user` is
   * absent, which on a `@Public()` route is every guest — measured as a 500 on every anonymous
   * request when it happened on the wishlist. It typechecks cleanly as
   * `@CurrentUser() user: AuthenticatedUser | undefined`, because a param decorator's return type is
   * not the declared parameter type, so neither `tsc` nor a hand-built controller test can see it.
   * `checkout.controller.spec.ts` runs the factories against a user-less context for exactly that.
   *
   * That a *signed-in* customer is still recognised here rests on `JwtAuthGuard` attempting passport
   * on a `@Public()` route and swallowing only the failure. Both halves are load-bearing: placement
   * must find a customer by id and a guest by cookie, and the two carts are different rows.
   */
  @Public()
  @Post('coupon/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Whether a coupon applies to the current basket, and for how much' })
  async previewCoupon(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Body() dto: PreviewCouponDto,
  ): Promise<CouponPreviewResponse> {
    const preview = await this.checkout.previewCoupon(this.owner(user, request), dto.code, user);
    return toCouponPreviewResponse(preview);
  }

  /**
   * `POST /checkout/orders` — spec §10.4.
   *
   * **201, not 200.** The success route keys on the created order, and a `200` would make "created"
   * and "already existed" indistinguishable — which the interceptor's replay turns from a theoretical
   * distinction into a real one. Know what the replay actually restores, though: the interceptor
   * stores `statusCode` and `claim()` returns `existing.responseBody` alone, so a replayed request is
   * answered by `of(replay)` and takes its status from this `@HttpCode` — the stored column is
   * written and never read. For placement the two coincide, so nothing is broken, but a test
   * asserting "the replay returns the original 201" would pass without the stored value being
   * consulted at all. Pin the **body** instead: the same order number, and exactly one order row.
   *
   * **The interceptor is on placement only.** A replayed preview is harmless and costs nothing; a
   * replayed placement is a second order and a second stock decrement. It is also safe *here*
   * specifically because this handler answers with an object: `claim()` returns `null` for "no
   * replay" and the interceptor branches on truthiness, so a route whose entire body were `0`,
   * `false` or `''` would store correctly and then be replayed as though no claim existed.
   */
  @Public()
  @Post('orders')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(CheckoutIdempotencyInterceptor)
  @ApiOperation({ summary: 'Place a COD order from the current basket' })
  async place(
    @OptionalUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Body() dto: PlaceOrderDto,
  ): Promise<AccountOrder> {
    const placed = await this.checkout.place(this.owner(user, request), dto, user);
    return toAccountOrder(await this.reload(placed));
  }

  /**
   * The order read back with the relations `toAccountOrder` needs, because `place()`'s return value
   * does not have them.
   *
   * `place` builds its draft with `items`, calls `save(draft)`, and inserts the first `pending`
   * `OrderEvent` **separately and afterwards** — so the entity it returns has `events === undefined`
   * while TypeORM types `Order.events` as a non-optional `OrderEvent[]`. Handing that straight to the
   * mapper **typechecks perfectly** and, before the mapper grew its guard, answered `timeline: []`:
   * a brand-new order rendering a confirmation with no history at all, in an `<ol>`
   * `OrderTimeline.tsx` draws without complaint. The mapper now throws instead, which is why this is
   * found immediately rather than shipped — it is not a reason the reload can be skipped.
   *
   * Reloaded here rather than by changing what `place()` returns, because `place`'s return value is
   * what Tasks 6, 7 and 8's suites and both concurrency proofs assert against. A presentation concern
   * is not worth reopening a proven transaction over.
   *
   * A plain `Error` for the missing row, not a `DomainError`: the transaction has committed by the
   * time this runs, so an order that cannot be read back a moment later is a server fault and should
   * be a 500 with the order number in the log — not a 404 telling the customer their order does not
   * exist when it very much does.
   */
  private async reload(placed: Order): Promise<Order> {
    const order = await this.orders.findOne({
      where: { id: placed.id },
      relations: { items: true, events: true },
      // The same `items: { id: 'ASC' }` `OrdersService` reads with, imported rather than repeated.
      // `order_items` has no natural order and every line of an order shares one `createdAt`, so an
      // unordered reload answered in physical sequence while the account read answered in uuid
      // sequence: the same invoice, its lines rearranged between the confirmation screen and the
      // order page, about half the time. See that constant's docblock.
      order: ITEMS_IN_ORDER,
    });
    if (order === null) {
      throw new Error(`Order ${placed.orderNumber} was placed but could not be read back`);
    }
    return order;
  }

  /**
   * Session first, cookie second, and neither when there is neither — `CartController.owner`'s rule,
   * and the order is the whole of it.
   *
   * A customer who built a basket as a guest and then signed in may still hold `nn_guest_token` — the
   * merge clears it, but a failed merge or a second tab leaves it behind — so a cookie that outranked
   * the session would place an order from someone else's basket.
   *
   * `{}` for a visitor with neither, and **no token is minted here**, unlike `PUT /cart`. Placement
   * needs a basket that already exists, and a basket cannot exist without a session or a key; minting
   * one would create an owner for an empty cart and answer `CART_EMPTY` a query later having handed a
   * crawler a 30-day identifier. `CartService.find({})` answers null, which is the same refusal
   * without the cookie.
   */
  private owner(user: AuthenticatedUser | undefined, request: Request): CartOwner {
    if (user) return { userId: user.id };
    const guestToken = readGuestToken(request);
    return guestToken ? { guestToken } : {};
  }
}
