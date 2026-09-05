import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { inr } from "@/lib/format";
import { OrderStatusBadge } from "./OrderStatusBadge";
import type { AccountOrder } from "../types";

const summarise = (order: AccountOrder) => {
  const [first, ...rest] = order.items;
  if (!first) return "—";
  return rest.length === 0 ? first.name : `${first.name} +${rest.length} more`;
};

export function OrdersTableSkeleton() {
  return (
    <div className="mt-6 space-y-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** Shared by the account and business order lists — the same rows, a different filter. */
export function OrdersTable({ orders, label }: { orders: AccountOrder[]; label: string }) {
  return (
    <section aria-label={label} className="border-border mt-6 overflow-hidden rounded-2xl border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-sand text-left">
            <tr>
              <th className="px-4 py-3 font-semibold">Order</th>
              <th className="px-4 py-3 font-semibold">Placed</th>
              <th className="px-4 py-3 font-semibold">Items</th>
              <th className="px-4 py-3 text-right font-semibold">Total</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-border border-t align-top">
                <td className="px-4 py-3">
                  <Link
                    to="/account/orders/$id"
                    params={{ id: o.id }}
                    className="font-semibold hover:underline"
                  >
                    {o.id}
                  </Link>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {o.channel === "bulk" ? "Bulk order" : "Retail order"}
                  </p>
                </td>
                <td className="text-muted-foreground px-4 py-3">
                  {format(new Date(o.placedAt), "d MMM yyyy")}
                </td>
                <td className="px-4 py-3">{summarise(o)}</td>
                <td className="px-4 py-3 text-right font-semibold">{inr(o.total)}</td>
                <td className="px-4 py-3">
                  <OrderStatusBadge status={o.status} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to="/account/orders/$id"
                    params={{ id: o.id }}
                    className="text-sm underline underline-offset-4"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
