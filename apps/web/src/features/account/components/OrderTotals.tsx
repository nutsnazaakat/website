import { Separator } from "@/components/ui/separator";
import { inr } from "@/lib/format";
import type { AccountOrder } from "../types";

/**
 * An order's money, in the four parts it is made of and then the sum.
 *
 * Shared by `/account/orders/$id` and `/order-success/$id`. The confirmation used to render a single
 * `Amount paid` line — which on a COD order nobody has paid for was the same class of statement as
 * `fromReceipt`'s "Payment received." note — so it now shows the same breakdown as the order page,
 * from the same component. Two copies of these four rows would be two copies of the two rules below.
 *
 * **The discount row is conditional and names the coupon.** `discount` was on `AccountOrder` all
 * along while `mocks/orders.ts` hardcoded it to `0`, so nothing rendered it and a discounted order
 * showed a total that did not equal its own parts — which for an invoice is not a cosmetic problem.
 * It is omitted rather than shown as `−₹0` when there is none, and the code is in the label because a
 * customer looking at a reduced total months later has no other record of which coupon did it.
 *
 * **`Free`, not `₹0`.** Free delivery is a thing the shop did for the customer, and
 * `freeShippingThreshold` is what decides it; `₹0` reads like a charge that failed to compute.
 */
export function OrderTotals({ order }: { order: AccountOrder }) {
  return (
    <>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd>{inr(order.subtotal)}</dd>
        </div>
        {order.discount > 0 && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              {order.couponCode ? `Discount (${order.couponCode})` : "Discount"}
            </dt>
            <dd>−{inr(order.discount)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted-foreground">GST</dt>
          <dd>{inr(order.gst)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Shipping</dt>
          <dd>{order.shipping === 0 ? "Free" : inr(order.shipping)}</dd>
        </div>
      </dl>
      <Separator className="my-4" />
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Total</span>
        <span className="text-2xl font-bold">{inr(order.total)}</span>
      </div>
    </>
  );
}
