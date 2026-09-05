import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { inr } from "@/lib/format";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";
import { messageOf } from "./shared";

/**
 * The sticky basket panel. Not a `Section` — it carries no step number and is an `aside` — but it is
 * a sibling of the sections in the form's grid, placed by `lg:col-start-2 lg:row-start-1` rather
 * than by its position in the markup, which is why it sits between the business and coupon blocks
 * here exactly as it did inline.
 */
export function OrderSummary({
  items,
  totals,
  discount,
  couponApplied,
  shipping,
  payable,
  placement,
  submitting,
  takingOrders,
}: Pick<
  CheckoutFormState,
  | "items"
  | "totals"
  | "discount"
  | "couponApplied"
  | "shipping"
  | "payable"
  | "placement"
  | "submitting"
  | "takingOrders"
>) {
  return (
    <aside
      aria-label="Order summary"
      className="border-border rounded-2xl border p-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1"
    >
      <h2 className="font-display text-2xl">Order Summary</h2>

      <ul className="mt-4 space-y-3">
        {items.map((item, i) => (
          <li
            key={`${item.name}-${item.detail}-${i}`}
            className="flex justify-between gap-3 text-sm"
          >
            <span>
              {item.name}
              <span className="text-muted-foreground">
                {item.detail ? ` · ${item.detail}` : ""} × {item.qty}
              </span>
            </span>
            <span className="shrink-0 font-semibold">
              {item.total === null ? "Quote Required" : inr(item.total)}
            </span>
          </li>
        ))}
      </ul>

      <Separator className="my-4" />

      <div className="space-y-2.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-semibold">{inr(totals.subtotal)}</span>
        </div>
        {/*
         * The discount line the summary has never had. `mocks/orders.ts:52` already computes
         * `subtotal - discount + gst + shipping`, so the arithmetic was right and only the
         * display was missing — which for a discounted order means a total that does not equal
         * its own parts. Rendered only when there is one, so an order with no coupon does not
         * gain a "−₹0" row.
         */}
        {discount > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              Discount{couponApplied ? ` (${couponApplied.couponCode})` : ""}
            </span>
            <span className="text-leaf font-semibold">−{inr(discount)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">GST</span>
          <span className="font-semibold">{inr(totals.gst)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Shipping</span>
          <span className="font-semibold">{shipping === 0 ? "Free" : inr(shipping)}</span>
        </div>
      </div>

      <Separator className="my-4" />

      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Total payable</span>
        <span className="text-2xl font-bold">{inr(payable)}</span>
      </div>

      {totals.hasQuoteLines ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Quote-required items are billed separately once we send you a price.
        </p>
      ) : (
        totals.hasUnpriceableLines && (
          <p className="text-muted-foreground mt-2 text-xs">
            Some items are unavailable and are not included in this total.
          </p>
        )
      )}

      {placement.error !== null && (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {messageOf(placement.error)}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        className="mt-5 w-full"
        disabled={submitting || !takingOrders}
      >
        {submitting ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" /> Placing order…
          </>
        ) : (
          "Place Order"
        )}
      </Button>
      {/*
       * "Payments are simulated in this preview build." was true while `placeOrder` was a mock
       * and false the moment this button placed a real COD order against real stock — the same
       * class of defect as a docblock that outlives what it described, except that this one is a
       * promise about money. Replaced with what is now true.
       */}
      <p className="text-muted-foreground mt-3 flex items-center justify-center gap-2 text-xs">
        <Lock className="size-3.5" /> Cash on delivery. Nothing is charged online.
      </p>
    </aside>
  );
}
