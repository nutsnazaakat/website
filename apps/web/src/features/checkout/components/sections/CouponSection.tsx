import { type CouponPreviewResponse, type CouponRefusalCode } from "@/contract";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { inr } from "@/lib/format";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";
import { Section } from "./Section";
import { messageOf } from "./shared";

/**
 * Customer-facing wording for every reason a coupon can be refused.
 *
 * A `Record<CouponRefusalCode, …>` for the reason `ORDER_STATUS_LABEL` is one: a seventh member added
 * to `CouponRefusalCode` in `shared` becomes a compile error here rather than a blank line under the
 * coupon input. The codes exist at all because a customer can *act* on
 * `COUPON_MIN_ORDER_VALUE` — add ₹500 and it works — and cannot act on `COUPON_INVALID`, so
 * collapsing them into one "not valid" would throw away the only actionable half.
 *
 * `COUPON_MIN_ORDER_VALUE` is therefore the one arm that cannot be a plain string: it is the only
 * refusal carrying `minOrderValue`, and telling the customer the figure to reach is the entire point
 * of it being a distinct code. The other five are constants.
 */
type RefusalCopy = string | ((minOrderValue: number | undefined) => string);

const COUPON_REFUSAL: Record<CouponRefusalCode, RefusalCopy> = {
  COUPON_INVALID: "We could not find that code. Check the spelling and try again.",
  COUPON_EXPIRED: "That code has expired.",
  COUPON_NOT_APPLICABLE: "That code does not apply to the items in your basket.",
  COUPON_MIN_ORDER_VALUE: (minOrderValue) =>
    minOrderValue === undefined
      ? "Your basket is below the minimum order value for that code."
      : `That code needs an order of ${inr(minOrderValue)} or more.`,
  COUPON_FIRST_ORDER_ONLY: "That code is for first orders only.",
  COUPON_LIMIT_REACHED: "That code has been fully redeemed.",
};

type CouponRefused = Extract<CouponPreviewResponse, { eligible: false }>;

const refusalMessage = (refused: CouponRefused): string => {
  const copy = COUPON_REFUSAL[refused.reason];
  return typeof copy === "string" ? copy : copy(refused.minOrderValue);
};

export function CouponSection({
  form,
  coupon,
  couponCode,
  couponApplied,
  couponRefused,
  step,
}: Pick<CheckoutFormState, "form" | "coupon" | "couponCode" | "couponApplied" | "couponRefused"> & {
  step: number;
}) {
  return (
    <Section title="Coupon" step={step} className="lg:col-start-1">
      <FormField
        control={form.control}
        name="couponCode"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Coupon code</FormLabel>
            <div className="flex gap-2">
              <FormControl>
                <Input
                  placeholder="Enter a code"
                  className="max-w-64"
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    field.onChange(e.target.value.toUpperCase());
                    // The verdict belongs to the code that was checked, so editing it discards
                    // the answer rather than leaving a discount attached to a different code.
                    coupon.reset();
                  }}
                />
              </FormControl>
              {/*
               * It used to be `onClick={() => setCouponNote(true)}` — pure local state under the
               * reassurance *"We will validate this code against your order before it ships."*,
               * which was untrue: nothing validated anything. It now asks the server, which
               * prices the coupon against the caller's own basket.
               */}
              <Button
                type="button"
                variant="outline"
                disabled={couponCode.trim() === "" || coupon.isPending}
                onClick={() => {
                  coupon.mutate(couponCode.trim());
                }}
              >
                {coupon.isPending ? "Checking…" : "Apply"}
              </Button>
            </div>
            {couponApplied && (
              <FormDescription>
                {couponApplied.couponCode} applied — {inr(couponApplied.discount)} off.
              </FormDescription>
            )}
            {couponRefused && (
              <FormDescription role="alert">{refusalMessage(couponRefused)}</FormDescription>
            )}
            {coupon.error !== null && (
              <FormDescription role="alert">{messageOf(coupon.error)}</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )}
      />
    </Section>
  );
}
