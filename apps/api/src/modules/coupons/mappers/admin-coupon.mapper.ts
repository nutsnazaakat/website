import {
  toRupees,
  type AdminCoupon,
  type AdminCouponChannel,
  type AdminCouponScope,
  type AdminCouponType,
} from '@nutwala/shared';
import type { Coupon } from '../../../entities/commerce/coupon.entity';
import { CouponChannel, CouponScope, CouponType } from '../../../entities/enums';

/**
 * Database enums to wire vocabularies, through `Record`s keyed on the database side.
 *
 * The same translation shape `review.mapper.ts` and `order.mapper.ts` use, and for the identical
 * reason: a member added to either enum is a compile error here rather than a value that reaches a
 * client as `undefined`. `toLowerCase()` would work today for all three and would stop working the
 * first time a member is spelled with an underscore — `order.mapper.ts` records `IN_TRANSIT`
 * becoming `in_transit` instead of `in-transit` as exactly that mistake, caught late.
 */
const TO_WIRE_TYPE: Record<CouponType, AdminCouponType> = {
  [CouponType.PERCENT]: 'percent',
  [CouponType.FLAT]: 'flat',
};

const TO_WIRE_SCOPE: Record<CouponScope, AdminCouponScope> = {
  [CouponScope.ALL]: 'all',
  [CouponScope.CATEGORY]: 'category',
};

const TO_WIRE_CHANNEL: Record<CouponChannel, AdminCouponChannel> = {
  [CouponChannel.ALL]: 'all',
  [CouponChannel.RETAIL]: 'retail',
  [CouponChannel.BULK]: 'bulk',
};

/** The reverse maps, so a write goes through one definition rather than a second, hand-kept one. */
export const TO_ENTITY_TYPE: Record<AdminCouponType, CouponType> = {
  percent: CouponType.PERCENT,
  flat: CouponType.FLAT,
};

export const TO_ENTITY_SCOPE: Record<AdminCouponScope, CouponScope> = {
  all: CouponScope.ALL,
  category: CouponScope.CATEGORY,
};

export const TO_ENTITY_CHANNEL: Record<AdminCouponChannel, CouponChannel> = {
  all: CouponChannel.ALL,
  retail: CouponChannel.RETAIL,
  bulk: CouponChannel.BULK,
};

/**
 * `Coupon` to `AdminCoupon`.
 *
 * `timesRedeemed` is passed in rather than read here: it is a `count(*)` over
 * `coupon_redemptions`, and a mapper that issued a query would be one statement per row of a
 * 60-row page. `AdminCouponsService` counts a whole page in one grouped statement instead.
 *
 * **`percentValue` goes through `Number`, not `toRupees`.** It is a `numeric(5,2)` percentage, not
 * money, and `pg` hands a `numeric` back as a string — so `'15.00'` would serialise as a quoted
 * string on the wire if it were passed through untouched, and would be compared as one by any
 * client that tried. The three money columns beside it are `bigint` paise and go through `toRupees`
 * like every other figure in this codebase.
 */
export function toAdminCoupon(coupon: Coupon, timesRedeemed: number): AdminCoupon {
  return {
    code: coupon.code,
    type: TO_WIRE_TYPE[coupon.type],
    percentValue: coupon.percentValue === null ? null : Number(coupon.percentValue),
    flatValue: coupon.flatValuePaise === null ? null : toRupees(coupon.flatValuePaise),
    minOrderValue: coupon.minOrderValuePaise === null ? null : toRupees(coupon.minOrderValuePaise),
    maxDiscount: coupon.maxDiscountPaise === null ? null : toRupees(coupon.maxDiscountPaise),
    appliesTo: TO_WIRE_SCOPE[coupon.appliesTo],
    categoryId: coupon.categoryId,
    channel: TO_WIRE_CHANNEL[coupon.channel],
    firstOrderOnly: coupon.firstOrderOnly,
    usageLimit: coupon.usageLimit,
    usageLimitPerUser: coupon.usageLimitPerUser,
    timesRedeemed,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    isActive: coupon.isActive,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
  };
}
