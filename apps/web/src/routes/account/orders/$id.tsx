import { nextStatuses } from "@/contract";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { Download, MapPin, PackageCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSiteSettings } from "@/config/useSiteSettings";
import { LineName } from "@/features/account/components/LineName";
import { OrderStatusBadge } from "@/features/account/components/OrderStatusBadge";
import { OrderTimeline } from "@/features/account/components/OrderTimeline";
import { OrderTotals } from "@/features/account/components/OrderTotals";
import { useCancelOrder, useOrder } from "@/features/account/hooks/useAccount";
import type { AccountOrder } from "@/features/account/types";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/account/orders/$id")({ component: AccountOrderDetail });

/**
 * Phase 1 has no invoice generator. A button that silently does nothing is worse than one
 * that says why it cannot, so this one is disabled and explains itself on hover and focus.
 */
function InvoiceButton() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-block">
            <Button variant="outline" size="sm" disabled className="pointer-events-none">
              <Download className="mr-2 size-4" />
              Download Invoice
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Available after Phase 2</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Cancel, and it is `@/contract`'s transition map that decides whether it renders at all.
 *
 * `nextStatuses(channel, status).includes("cancelled")` — **not** a local list of the four
 * pre-dispatch statuses, and not a `status === "pending"` test. Those would be a second copy of a
 * rule the server enforces from `RETAIL_TRANSITIONS`, and the second copy is the one that drifts: a
 * button offered on an order the server refuses is a 422 the customer cannot act on, and a button
 * withheld from one it would accept is a support call. One map, two consumers.
 *
 * It answers correctly for bulk too, without a special case. `BULK_TRANSITIONS` has no `cancelled`
 * state anywhere in it — a quoted, approved consignment is unwound by agreement — so this returns
 * `false` for every status a business order can be in, at no cost here.
 *
 * **The confirmation is not decoration.** `cancelled` is terminal, so there is no undo and no
 * "reinstate": `nextStatuses(channel, "cancelled")` is `[]`, which is the map saying the same thing.
 * The trigger sits in the same header row as Download Invoice, where a misclick is entirely plausible.
 *
 * A refusal surfaces the server's own sentence rather than a generic one. The 422 says which status
 * the order is really in — the page was stale, which is the only way this button can be pressed on
 * an uncancellable order — and that is more use to the customer than "something went wrong".
 */
function CancelOrderButton({ order }: { order: AccountOrder }) {
  const cancel = useCancelOrder(order.id);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={cancel.isPending}>
          <XCircle className="mr-2 size-4" />
          {cancel.isPending ? "Cancelling…" : "Cancel Order"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel order {order.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone. Anything held for this order goes back on sale straight away, and
            you would need to place a new order to buy it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep my order</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              cancel.mutate(undefined, {
                onSuccess: () => toast.success(`Order ${order.id} cancelled`),
                onError: (error: Error) => toast.error(error.message),
              });
            }}
          >
            Yes, cancel it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AccountOrderDetail() {
  const settings = useSiteSettings();
  const { id } = Route.useParams();
  const { data: order, isLoading } = useOrder(id);

  useSeo({
    title: `Order ${id} | ${settings.brandName}`,
    description: "Order status, items, totals and delivery address.",
    noindex: true,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="py-16 text-center">
        <h1 className="font-display text-3xl">Order not found</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          {id} is not on this account. It may have been placed with a different email address.
        </p>
        <Link
          to="/account/orders"
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          Back to your orders
        </Link>
      </div>
    );
  }

  return (
    <div>
      <nav className="text-muted-foreground text-xs">
        <Link to="/account/orders" className="hover:text-foreground">
          Your Orders
        </Link>{" "}
        / <span className="text-foreground">{order.id}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-4xl">Order {order.id}</h1>
        <div className="flex items-center gap-3">
          <OrderStatusBadge status={order.status} />
          {nextStatuses(order.channel, order.status).includes("cancelled") && (
            <CancelOrderButton order={order} />
          )}
          <InvoiceButton />
        </div>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        Placed {format(new Date(order.placedAt), "d MMM yyyy")} ·{" "}
        {order.channel === "bulk" ? "Bulk order" : "Retail order"}
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <section
            aria-label="Order items"
            className="border-border overflow-hidden rounded-2xl border"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[440px] text-sm">
                <thead className="bg-sand text-left">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Item</th>
                    <th className="px-4 py-3 font-semibold">Pack</th>
                    <th className="px-4 py-3 text-right font-semibold">Qty</th>
                    <th className="px-4 py-3 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item, i) => (
                    <tr key={`${item.name}-${item.detail}-${i}`} className="border-border border-t">
                      <td className="px-4 py-3">
                        <LineName item={item} />
                      </td>
                      <td className="text-muted-foreground px-4 py-3">{item.detail}</td>
                      <td className="px-4 py-3 text-right">{item.qty}</td>
                      <td className="px-4 py-3 text-right font-semibold">
                        {item.total === null ? "Quote Required" : inr(item.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/*
           * The four parts and the sum, from the component `/order-success/$id` renders them with
           * too — including the discount row this page gained in Task 20, which no fixture could
           * express while `mocks/orders.ts` hardcoded `discount = 0`. The confirmation screen shows
           * a subset of this page, so the money it shows has to be the same money.
           */}
          <section aria-label="Order totals" className="border-border mt-6 rounded-2xl border p-5">
            <OrderTotals order={order} />
          </section>

          {order.channel === "bulk" && (
            <section className="border-border mt-6 rounded-2xl border p-5">
              <h2 className="font-display text-2xl">Business details</h2>
              <dl className="mt-4 grid gap-y-2 text-sm sm:grid-cols-[160px_minmax(0,1fr)]">
                {order.companyName && (
                  <>
                    <dt className="text-muted-foreground">Company</dt>
                    <dd>{order.companyName}</dd>
                  </>
                )}
                {order.gstin && (
                  <>
                    <dt className="text-muted-foreground">GSTIN</dt>
                    <dd>{order.gstin}</dd>
                  </>
                )}
                {order.poNumber && (
                  <>
                    <dt className="text-muted-foreground">PO number</dt>
                    <dd>{order.poNumber}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
        </div>

        <div className="space-y-6">
          <section className="border-border rounded-2xl border p-5">
            <h2 className="font-display text-2xl">Status</h2>
            <div className="mt-4">
              <OrderTimeline events={order.timeline} />
            </div>
          </section>

          <section className="border-border rounded-2xl border p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="text-leaf size-4" /> Delivery address
            </p>
            <address className="text-muted-foreground mt-2 text-sm not-italic">
              <span className="block">{order.address.fullName}</span>
              <span className="block">{order.address.line1}</span>
              {order.address.line2 && <span className="block">{order.address.line2}</span>}
              <span className="block">
                {order.address.city}, {order.address.state} {order.address.pincode}
              </span>
              <span className="block">{order.address.phone}</span>
            </address>

            <p className="mt-4 flex items-center gap-2 text-sm font-semibold">
              <PackageCheck className="text-leaf size-4" /> Estimated delivery
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {format(new Date(order.estimatedDelivery), "EEEE, d MMM yyyy")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
