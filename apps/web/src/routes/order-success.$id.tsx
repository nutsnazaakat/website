import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { CheckCircle2, MapPin, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { LineName } from "@/features/account/components/LineName";
import { OrderStatusBadge } from "@/features/account/components/OrderStatusBadge";
import { OrderTotals } from "@/features/account/components/OrderTotals";
import { accountKeys, useOrder } from "@/features/account/hooks/useAccount";
import type { AccountOrder } from "@/features/account/types";
import { useAuth } from "@/features/auth/AuthProvider";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/order-success/$id")({ component: OrderSuccessPage });

/**
 * The order, rendered from the order — every figure on it is the server's.
 *
 * It used to render `Amount paid` and nothing else, over a `sessionStorage` receipt whose money was
 * the client's own arithmetic. `AccountOrder` carries the breakdown and the status, so both are here
 * now, out of the same two components `/account/orders/$id` renders them with: the confirmation shows
 * a subset of that page, not a second treatment of it.
 *
 * `order.id` rather than the route's `$id` in the pill, deliberately. They are equal by construction
 * — the parameter is what was looked up — but the number a customer quotes to support should be the
 * one the order actually carries, not the one in the address bar.
 */
function Confirmation({ order }: { order: AccountOrder }) {
  return (
    <>
      <div className="border-border rounded-3xl border p-6 text-center sm:p-10">
        <CheckCircle2 className="text-leaf mx-auto size-14" />
        <h1 className="font-display mt-4 text-4xl">Order Confirmed!</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          Thank you. We have your order and will email you when it is dispatched.
        </p>
        <p className="bg-sand mt-5 inline-block rounded-full px-4 py-2 text-sm font-semibold">
          Order ID: {order.id}
        </p>
        {/*
         * The status the order is actually in, which for a fresh COD order is `pending` — "Payment
         * pending", because nothing has been collected yet. The screen used to assert a state it had
         * not been told: a tick, a congratulation and an `Amount paid` figure on an unpaid order.
         */}
        <div className="mt-4 flex justify-center">
          <OrderStatusBadge status={order.status} />
        </div>
      </div>

      <div className="border-border mt-6 rounded-2xl border p-6">
        <h2 className="font-display text-2xl">Order details</h2>

        <section aria-label="Order items">
          <ul className="mt-4 space-y-3">
            {order.items.map((item, i) => (
              <li
                key={`${item.name}-${item.detail}-${i}`}
                className="flex justify-between gap-3 text-sm"
              >
                <span>
                  <LineName item={item} />
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
        </section>

        <Separator className="my-4" />

        <section aria-label="Order totals">
          <OrderTotals order={order} />
        </section>

        <Separator className="my-4" />

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
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
          </div>

          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <PackageCheck className="text-leaf size-4" /> Estimated delivery
            </p>
            <p className="text-muted-foreground mt-2 text-sm">
              {format(new Date(order.estimatedDelivery), "EEEE, d MMM yyyy")}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/account/orders/$id" params={{ id: order.id }}>
            Track Order
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/shop">Continue Shopping</Link>
        </Button>
      </div>
    </>
  );
}

/**
 * State 3: the order is not in this tab's cache and there is nobody to ask on the visitor's behalf.
 *
 * **Not "not found", and that distinction is the reason this state exists.** A guest checkout is the
 * ordinary retail path — neither `/checkout` nor this route is guarded, `requireCustomer` is used by
 * `routes/account/route.tsx` alone — and a guest's order is written with `userId: null`, while
 * `GET /account/orders/:orderNumber` is session-scoped. So a guest reloading their confirmation, or
 * opening it on their phone, cannot be shown the order and **also cannot be told it is missing**: it
 * almost certainly exists, and telling a paying customer their order vanished is the worst thing this
 * screen can do. Nothing is fetched either, because a 401 is the only answer that request can have.
 *
 * **The sign-in offer is honest about not being a solution for everyone.** `CheckoutService.place`
 * stores `userId: owner.userId ?? null` and never resolves an account from the shipping email — spec
 * §13, where an email is data on the order and never a key that grants access to it — so an order
 * placed as a guest is not attached to any account and never becomes visible by signing in. Only the
 * order number can recover that one, which is why it is the heading.
 */
function SignInToSeeIt({ id }: { id: string }) {
  return (
    <div className="text-center">
      <h1 className="font-display text-4xl">Order {id}</h1>
      <p className="text-muted-foreground mt-4 text-sm">
        Order details are only visible to the account that placed the order, and this browser is not
        signed in.
      </p>
      <p className="text-muted-foreground mt-3 text-sm">
        Sign in to open it under Your Orders. A guest order is not linked to an account, so signing
        in will not show one — quote the number above to us instead and we will look it up.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
        <Button asChild size="lg" variant="outline">
          <Link to="/login" search={{ redirect: "/account/orders" }}>
            Sign In
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link to="/contact">Contact Us</Link>
        </Button>
        <Button asChild size="lg">
          <Link to="/shop">Continue Shopping</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * State 2's miss: signed in, asked, and the server does not have this order for this account.
 *
 * Reachable **only** while signed in, which is what lets the copy say "this account" — the guest who
 * cannot be told anything of the sort is answered by `SignInToSeeIt` before this is reached. The 404
 * covers "no such order" and "not yours" as one branch on purpose (order numbers are sequential, so a
 * 403 for someone else's would make the endpoint an existence oracle), so this is the honest screen
 * for both, and the wording is `/account/orders/$id`'s for the same reason.
 */
function NotFound({ id }: { id: string }) {
  return (
    <div className="py-16 text-center">
      <h1 className="font-display text-3xl">Order not found</h1>
      <p className="text-muted-foreground mt-3 text-sm">
        {id} is not on this account. It may have been placed with a different email address, or
        without signing in.
      </p>
      <Link to="/account/orders" className="mt-6 inline-block text-sm underline underline-offset-4">
        Back to your orders
      </Link>
    </div>
  );
}

/**
 * **Three states, and the last two are only distinguishable by the visitor's session.**
 *
 * 1. **The order is in the cache.** `CheckoutForm` writes the placement response into
 *    `accountKeys.order(order.id)` before navigating here, so the normal arrival — guest or
 *    signed-in — renders from that entry and sends **no request at all**. `useOrder` reads the same
 *    key through the same helper, because two hand-written key arrays that drift by one element are a
 *    silent cache miss, which for a guest is a 401 on their own confirmation.
 * 2. **Not cached, and signed in.** Fetch it. A miss here is genuinely not-found: the session is the
 *    scope the endpoint reads, so "not in your history" is the whole answer.
 * 3. **Not cached, and a guest.** Neither fetch nor "not found" — see `SignInToSeeIt`.
 *
 * The screen used to be a single unconditional state: `<h1>Order Confirmed!</h1>` and
 * `Order ID: {id}` were rendered straight from the URL parameter with no lookup, so
 * `/order-success/NN-9999-999999` congratulated anyone who typed it on an order that does not exist.
 * It read its detail block once and synchronously out of a `sessionStorage` receipt, so a reload in a
 * new tab — or the same link on another device — showed "not available in this browser session" for
 * an order the server could describe perfectly well.
 *
 * **`isLoading` from the auth context is in the waiting condition, not just the query's.** A visitor
 * holding valid cookies whose localStorage was cleared has no snapshot, so `isAuthenticated` is
 * `false` for the first paint and only becomes true when `GET /auth/me` answers. Without that term
 * they would be shown state 3 — "this browser is not signed in" — and then have it replaced, which is
 * the flash `AuthProvider.isLoading` exists to prevent.
 *
 * **The basket is not touched here.** `CheckoutService.place` empties the cart inside the placement
 * transaction, and `CheckoutForm` re-reads it on success; the `clear()` this screen used to call on
 * mount was a second opinion about a basket the server had already settled, and a write can lose a
 * line added in another tab.
 */
function OrderSuccessPage() {
  const { id } = Route.useParams();
  const { isAuthenticated, isLoading: sessionPending } = useAuth();
  const queryClient = useQueryClient();

  /**
   * Read during render and not reactive — and it does not need to be. `useOrder` below subscribes to
   * this exact key, so anything that changes the entry re-renders this component and re-reads it.
   */
  const cached = queryClient.getQueryData<AccountOrder>(accountKeys.order(id)) !== undefined;

  const { data: order, isLoading } = useOrder(id, { enabled: !cached && isAuthenticated });

  useSeo({
    title: order
      ? `Order ${order.id} confirmed — ${settings.brandName}`
      : `Order ${id} — ${settings.brandName}`,
    description: "Thank you for your order. Your confirmation and delivery estimate are below.",
    // A confirmation carries the customer's name, phone and street address at an unguarded URL.
    noindex: true,
  });

  return (
    <div className="container-page py-14">
      <div className="mx-auto max-w-2xl">
        {order ? (
          <Confirmation order={order} />
        ) : sessionPending || isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : isAuthenticated ? (
          <NotFound id={id} />
        ) : (
          <SignInToSeeIt id={id} />
        )}
      </div>
    </div>
  );
}
