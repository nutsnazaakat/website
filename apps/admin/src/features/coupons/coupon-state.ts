import type { AdminCoupon } from "@/contract";
import { inr } from "@/lib/format";

/**
 * What a coupon is actually doing right now, which is **not** what `isActive` says on its own.
 *
 * `coupons.isActive` is one of four things that can stop a coupon working, and an operator looking
 * at a list of twenty wants the answer, not the input: a coupon whose window closed last Tuesday is
 * as dead as one that was switched off, and `CouponService.preview` refuses both. It refuses them
 * with *different messages*, which is why they are named apart here rather than collapsed into
 * "inactive".
 *
 * Derived at render time from the row's own fields, never stored: the server does not send a
 * computed state and should not, because the answer changes with the clock.
 */
export type CouponState = "live" | "scheduled" | "expired" | "exhausted" | "off";

export function couponState(coupon: AdminCoupon, now: Date = new Date()): CouponState {
  if (!coupon.isActive) return "off";
  if (coupon.expiresAt !== null && new Date(coupon.expiresAt) <= now) return "expired";
  if (coupon.startsAt !== null && new Date(coupon.startsAt) > now) return "scheduled";
  if (coupon.usageLimit !== null && coupon.timesRedeemed >= coupon.usageLimit) return "exhausted";
  return "live";
}

export const COUPON_STATE_LABEL: Readonly<Record<CouponState, string>> = {
  live: "Live",
  scheduled: "Scheduled",
  expired: "Expired",
  exhausted: "Limit reached",
  off: "Off",
};

export const COUPON_STATE_HINT: Readonly<Record<CouponState, string>> = {
  live: "A customer can redeem this now.",
  scheduled: "Its window has not opened yet.",
  expired: "Its window has closed. A past expiry is a legitimate way to end a campaign.",
  exhausted: "It has been redeemed as many times as its usage limit allows.",
  off: "Switched off with isActive. Its redemption history is untouched.",
};

/**
 * Brief §36's discount, as one readable phrase.
 *
 * `ck_coupons_value_exclusive` guarantees exactly one of the two values is set, so the `null` on
 * the other side is the constraint speaking rather than missing data — and the fallback text below
 * would only ever appear against a row that violated it.
 */
export function discountLabel(coupon: AdminCoupon): string {
  if (coupon.type === "percent") {
    if (coupon.percentValue === null) return "Percentage, value missing";
    const capped = coupon.maxDiscount === null ? "" : `, capped at ${inr(coupon.maxDiscount)}`;
    return `${String(coupon.percentValue)}% off${capped}`;
  }
  if (coupon.flatValue === null) return "Flat, value missing";
  return `${inr(coupon.flatValue)} off`;
}
