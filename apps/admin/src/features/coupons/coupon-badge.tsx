import type { AdminCoupon } from "@/contract";
import { ToneBadge } from "@/components/status-badge";
import {
  COUPON_STATE_HINT,
  COUPON_STATE_LABEL,
  couponState,
} from "@/features/coupons/coupon-state";

/**
 * A coupon's live state, in the console's four tones.
 *
 * A file of its own beside `coupon-state.ts`, which holds the derivation and the wording, because a
 * module that exports both a component and plain functions loses fast refresh — oxlint's
 * `react/only-export-components` says so and is right. The split is along the useful line anyway:
 * `couponState` is testable without React, and this is the two lines that colour it.
 *
 * Only `live` reads as a success. `scheduled` is neutral — nothing is wrong, it simply has not
 * started — and the other three are all "this coupon does not work", which is the answer an
 * operator wondering why a customer's code was refused actually needs.
 */
export function CouponStateBadge({ coupon }: { coupon: AdminCoupon }) {
  const state = couponState(coupon);
  return (
    <ToneBadge
      tone={state === "live" ? "done" : state === "scheduled" ? "working" : "stopped"}
      title={COUPON_STATE_HINT[state]}
    >
      {COUPON_STATE_LABEL[state]}
    </ToneBadge>
  );
}
