import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  applyFlat,
  applyPercent,
  sumPaise,
  type CouponRefusalCode,
  type Paise,
} from '@nutwala/shared';
import { Repository } from 'typeorm';
import { ErrorCodes, type ErrorCode } from '../../common/errors/domain-error';
import { CouponRedemption } from '../../entities/commerce/coupon-redemption.entity';
import { Coupon } from '../../entities/commerce/coupon.entity';
import { Order } from '../../entities/commerce/order.entity';
import { CouponChannel, CouponScope, CouponType } from '../../entities/enums';

/** One basket line, reduced to the two things a coupon rule reads. */
export interface CouponBasketLine {
  /** The line's product category, for a `CATEGORY`-scoped coupon. */
  categoryId: string | null;
  lineTotalPaise: Paise;
}

/**
 * The basket a coupon is measured against, in the wire's channel vocabulary rather than the
 * entity's, because the caller of `preview` is an HTTP request body.
 */
export interface CouponBasket {
  channel: 'retail' | 'bulk';
  lines: readonly CouponBasketLine[];
  /** The billable subtotal, GST-exclusive, as the order will bill it. */
  subtotalPaise: Paise;
}

/**
 * Why a coupon was refused.
 *
 * **The reason, not a boolean.** The customer can act on `COUPON_MIN_ORDER_VALUE` — add ₹500 and it
 * works — and cannot act on `COUPON_INVALID`; and once both are collapsed into one "not valid" there
 * is no way to recover the distinction downstream.
 *
 * Now declared in `@nutwala/shared` and re-exported here, so the frontend branches on the same six
 * strings the server sends. The guard below is what keeps them honest and cannot move with the type,
 * because `shared` has no access to `ErrorCodes`.
 */
export type { CouponRefusalCode };

/**
 * Compile-time proof that every refusal code is a real `ErrorCode`, the same guard
 * `cart-read.service.ts` puts on `CartValidationCode`.
 *
 * Not decoration: without it, renaming a code in the registry leaves a client branching on a string
 * the server has stopped sending, and nothing fails. It checks both directions — a code added here
 * with no registry entry is a missing property, and a registry rename is an unknown one.
 */
const _refusalCodesExist: Record<CouponRefusalCode, ErrorCode> = {
  COUPON_INVALID: ErrorCodes.COUPON_INVALID,
  COUPON_EXPIRED: ErrorCodes.COUPON_EXPIRED,
  COUPON_NOT_APPLICABLE: ErrorCodes.COUPON_NOT_APPLICABLE,
  COUPON_MIN_ORDER_VALUE: ErrorCodes.COUPON_MIN_ORDER_VALUE,
  COUPON_FIRST_ORDER_ONLY: ErrorCodes.COUPON_FIRST_ORDER_ONLY,
  COUPON_LIMIT_REACHED: ErrorCodes.COUPON_LIMIT_REACHED,
};
void _refusalCodesExist;

/**
 * An eligible coupon, with the figures the order will store.
 *
 * `couponCode` and not `code`: on the refusal arm `code` is the *reason*, and one name for two
 * meanings across the two arms of the same union is a landmine for whoever reads
 * `result.code` next.
 */
export interface CouponAccepted {
  eligible: true;
  couponId: string;
  couponCode: string;
  discountPaise: Paise;
  /** What the discount was taken from — the whole subtotal, or a category's share of it. */
  eligibleSubtotalPaise: Paise;
  code?: undefined;
  minOrderValuePaise?: undefined;
}

export interface CouponRefused {
  eligible: false;
  code: CouponRefusalCode;
  /** Only on `COUPON_MIN_ORDER_VALUE`: the figure the customer has to reach. */
  minOrderValuePaise?: Paise;
  couponId?: undefined;
  couponCode?: undefined;
  discountPaise?: undefined;
  eligibleSubtotalPaise?: undefined;
}

/**
 * Both arms declare every field, the absent ones as `?: undefined`.
 *
 * That keeps the union a discriminated one — assigning a `discountPaise` to a refusal is still a type
 * error — while letting a caller read `result.discountPaise` or `result.code` without narrowing
 * first, which is what a test and a controller both want to do.
 */
export type CouponPreview = CouponAccepted | CouponRefused;

function refuse(
  code: CouponRefusalCode,
  extra: { minOrderValuePaise?: Paise } = {},
): CouponRefused {
  return { eligible: false, code, ...extra };
}

/**
 * The wire's channel words mapped to the entity's, explicitly rather than by upper-casing a string.
 * Two vocabularies joined by `toUpperCase()` agree until one of them gains a value.
 */
const ENTITY_CHANNEL: Record<CouponBasket['channel'], CouponChannel> = {
  retail: CouponChannel.RETAIL,
  bulk: CouponChannel.BULK,
};

@Injectable()
export class CouponService {
  constructor(
    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,
    @InjectRepository(CouponRedemption)
    private readonly redemptions: Repository<CouponRedemption>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  /**
   * Every eligibility rule the `coupons` columns imply, evaluated against one basket. Read-only:
   * redeeming a coupon is `CheckoutService`'s, under `SELECT … FOR UPDATE`, because counting and then
   * inserting is a race two concurrent checkouts can both win.
   *
   * Order of the checks is deliberate and cost-shaped: the six that read only the row come first, so
   * a switched-off coupon costs one query rather than four, and the three that count come last.
   *
   * One departure from the column order the task lists, and it is forced: `minOrderValuePaise` is
   * measured against the **eligible** subtotal, and for a `CATEGORY` coupon that figure does not exist
   * until the scope has been resolved. So scope and channel are settled first, and the minimum is
   * compared against what the coupon can actually discount — otherwise "spend ₹1,000 on almonds" is
   * satisfied by ₹1,000 of cashews.
   *
   * `userId` null is a guest, and it is a real customer rather than an unverifiable one. A guest is
   * **eligible** for `firstOrderOnly` — by definition it is their first order — and has zero personal
   * redemptions. The other reading, refuse what you cannot verify, blocks precisely the customer a
   * first-order coupon exists to attract.
   */
  async preview(code: string, basket: CouponBasket, userId: string | null): Promise<CouponPreview> {
    // Stored uppercase (`Coupon.code`'s docblock), so `save10` finds `SAVE10`. `.trim()` because the
    // code arrives from a text input a customer pasted into.
    const row = await this.coupons.findOne({ where: { code: code.trim().toUpperCase() } });

    // An unknown code and a switched-off one answer the same thing on purpose: a distinct "this
    // exists but is disabled" tells anyone who asks which codes the business has ever run.
    if (row === null || !row.isActive) return refuse('COUPON_INVALID');

    const now = new Date();
    // Not yet started reads as `COUPON_INVALID`, not `COUPON_EXPIRED`: "starts on Friday" leaks an
    // unannounced campaign, and the customer's action is the same either way. Expired is its own code
    // because it *is* actionable — stop retyping a code that will never work again.
    if (row.startsAt !== null && row.startsAt > now) return refuse('COUPON_INVALID');
    if (row.expiresAt !== null && row.expiresAt <= now) return refuse('COUPON_EXPIRED');

    if (row.channel !== CouponChannel.ALL && row.channel !== ENTITY_CHANNEL[basket.channel]) {
      return refuse('COUPON_NOT_APPLICABLE');
    }

    const eligibleSubtotalPaise = eligibleSubtotal(row, basket);
    if (eligibleSubtotalPaise === null) return refuse('COUPON_NOT_APPLICABLE');

    if (row.minOrderValuePaise !== null && eligibleSubtotalPaise < row.minOrderValuePaise) {
      // Carries the figure, because this is the one refusal the customer can act on.
      return refuse('COUPON_MIN_ORDER_VALUE', { minOrderValuePaise: row.minOrderValuePaise });
    }

    /**
     * `firstOrderOnly` counts **orders**, not redemptions.
     *
     * A customer whose first order used no coupon has still had a first order. Counting redemptions
     * instead would let them spend a first-order coupon on their fifth purchase — the coupon would
     * be the thing that had never been used, not the customer.
     *
     * No `status` filter, deliberately: a cancelled order still counts. Excluding cancellations
     * reads as fairer and is a loophole — place an order with the first-order coupon, cancel it,
     * and the eligibility is back.
     */
    if (row.firstOrderOnly && userId !== null) {
      if ((await this.orders.count({ where: { userId } })) > 0) {
        return refuse('COUPON_FIRST_ORDER_ONLY');
      }
    }

    // Skipped entirely when the column is null: an uncapped coupon should not cost a `count(*)`.
    if (row.usageLimit !== null) {
      const used = await this.redemptions.count({ where: { couponId: row.id } });
      if (used >= row.usageLimit) return refuse('COUPON_LIMIT_REACHED');
    }

    if (row.usageLimitPerUser !== null && userId !== null) {
      const usedByUser = await this.redemptions.count({ where: { couponId: row.id, userId } });
      if (usedByUser >= row.usageLimitPerUser) return refuse('COUPON_LIMIT_REACHED');
    }

    const discountPaise = discountOn(row, eligibleSubtotalPaise);
    // Reachable only from a row that breaks `ck_coupons_value_exclusive` — or from a narrowed
    // `select` that omitted the column, which arrives as `undefined` and would otherwise reach
    // `applyPercent` as `NaN` and 500. A coupon whose value cannot be read is not a zero discount
    // the customer gets to "apply" successfully; it is an invalid coupon.
    if (discountPaise === null) return refuse('COUPON_INVALID');

    return {
      eligible: true,
      couponId: row.id,
      couponCode: row.code,
      discountPaise,
      eligibleSubtotalPaise,
    };
  }
}

/**
 * What this coupon can discount, or null when nothing in the basket qualifies.
 *
 * `ALL` uses the caller's `subtotalPaise` rather than re-summing the lines: that is the figure the
 * order will bill, and a second derivation here is a second answer that can disagree with it. A
 * `CATEGORY` coupon has no choice but to sum, because only part of the basket is eligible — "10% off
 * almonds" must not take 10% off the cashews sitting beside them.
 */
function eligibleSubtotal(coupon: Coupon, basket: CouponBasket): Paise | null {
  if (coupon.appliesTo !== CouponScope.CATEGORY) {
    return basket.subtotalPaise > 0n ? basket.subtotalPaise : null;
  }

  /**
   * `Coupon.category` is `ON DELETE SET NULL`, and the entity's docblock says losing the link
   * "widens the coupon's scope back to `ALL` … application validation is expected to catch any scope
   * mismatch this creates". This is that validation: deleting the almonds category must not silently
   * turn "10% off almonds" into "10% off everything".
   */
  if (coupon.categoryId === null) return null;

  const eligible = basket.lines.filter((line) => line.categoryId === coupon.categoryId);
  if (eligible.length === 0) return null;
  return sumPaise(eligible.map((line) => line.lineTotalPaise));
}

/**
 * The discount, in paise, or null when the row does not carry the value its `type` requires.
 *
 * `applyPercent` and `applyFlat` come from `shared/src/money.ts`, which already caps a percentage at
 * `maxDiscountPaise` and clamps **both** kinds to the amount they are taken from — a ₹500 flat coupon
 * on a ₹300 order gives ₹300, not a negative total. Re-deriving that arithmetic here would be a
 * second copy of the money rules, and `Order.totalPaise` is a bigint with no check constraint, so
 * nothing downstream would catch the copy drifting.
 */
function discountOn(coupon: Coupon, amountPaise: Paise): Paise | null {
  switch (coupon.type) {
    case CouponType.PERCENT: {
      // `numeric(5,2)` arrives from `pg` as a string — '10.00'.
      const percent = coupon.percentValue === null ? NaN : Number(coupon.percentValue);
      if (!Number.isFinite(percent)) return null;
      return applyPercent(amountPaise, percent, coupon.maxDiscountPaise ?? undefined);
    }
    case CouponType.FLAT:
      return coupon.flatValuePaise === null ? null : applyFlat(amountPaise, coupon.flatValuePaise);
  }
}
