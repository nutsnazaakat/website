import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Everything `POST /checkout/coupon/preview` takes: the code, and **nothing else**.
 *
 * No lines, no categories, no subtotal — deliberately, and this is a departure from the plan's own
 * sketch of this DTO, which described it as carrying "the basket-derived category ids and channel".
 * Two things rule that out:
 *
 * - **Spec §13.** *"Server recomputes subtotal, GST, shipping, discount and total from the database;
 *   client-supplied money is ignored entirely."* A client-supplied subtotal decides
 *   `minOrderValuePaise` eligibility, and a client-supplied category id decides which lines a
 *   `CATEGORY`-scoped coupon discounts. Both would let a caller unlock a coupon against a basket it
 *   does not have, and would answer "₹500 off" about a basket placement then prices differently.
 * - **The client does not have the figures.** `shared`'s `CartLine` carries no price and no
 *   `categoryId` — its docblock says so and says why ("prices are resolved live on every read") — so
 *   the checkout form could not send them honestly even if it were trusted to. What it has is what
 *   the customer typed into one input.
 *
 * `POST` rather than `GET` survives the change, and for the reasons that were never about the body: a
 * coupon code must not sit in a URL, in an access log or in a browser history, and this answer must
 * not be cached — the same code stops being eligible the moment someone else redeems the last one.
 */
export class PreviewCouponDto {
  /**
   * `coupons.code` is `varchar(40)`, and `orders.coupon_code` stores the same width. Matched
   * case-insensitively and trimmed by `CouponService`, so `save10` finds `SAVE10`; the bounds here
   * exist so an unbounded string never reaches a query.
   */
  @ApiProperty({ maxLength: 40 })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code: string;
}
