import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, FileCheck2, Package, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { useBusinessStats } from "@/features/business/hooks/useBusiness";
import { useCart } from "@/features/cart/CartProvider";
import { RfqStatusBadge } from "@/features/rfq/components/RfqStatusBadge";
import { useRfqs } from "@/features/rfq/hooks/useRfqs";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/business/")({ component: BusinessDashboard });

function Tile({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border-border rounded-2xl border p-5">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-muted-foreground mt-3 text-sm">{label}</p>
      <p className="mt-1 text-3xl font-bold">{value}</p>
      <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
    </div>
  );
}

/**
 * Brief §16/§34's four dashboard tiles, three of them server-computed since Task 19.
 *
 * `openRfqs`, `bulkSpend` and `bulkOrders` come from `GET /business/stats` untouched — no
 * `reduce` over order totals, no `filter(status === 'new')`, both deleted along with the
 * `GET /account/orders?channel=bulk` fetch they needed and nothing else on this page used.
 *
 * "Previous Quotes" is not one of the three the endpoint answers, and is not deleted either:
 * it is `list.length - stats.openRfqs` — the caller's whole RFQ count, already fetched for the
 * "Recent quote requests" section below, minus the *correct* open count Task 7's seven-status
 * vocabulary now gives it, rather than the old page's own `status === 'new'` guess.
 */
function BusinessDashboard() {
  const { data: rfqs, isLoading: rfqsLoading } = useRfqs();
  const { data: stats, isLoading: statsLoading } = useBusinessStats();
  const { lines, totals } = useCart();

  useSeo({
    title: `Business Dashboard | ${settings.brandName}`,
    description:
      "Your bulk activity at a glance — orders, spend, open quote requests and past quotations.",
  });

  const list = rfqs ?? [];
  const bulkLines = lines.filter((l) => l.mode === "bulk");
  const previousQuotes = stats ? list.length - stats.openRfqs : 0;

  return (
    <div>
      <h1 className="font-display text-4xl">Dashboard</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Bulk buying, quotations and account details in one place.
      </p>

      {rfqsLoading || statsLoading || !stats ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            icon={<Package className="size-5" />}
            label="Total Orders"
            value={String(stats.bulkOrders)}
            hint="Bulk orders placed on this account."
          />
          <Tile
            icon={<Wallet className="size-5" />}
            label="Total Spend"
            value={inr(stats.bulkSpend)}
            hint="Billed across all bulk orders, GST included."
          />
          <Tile
            icon={<ClipboardList className="size-5" />}
            label="Active RFQs"
            value={String(stats.openRfqs)}
            hint="New, contacted, quoted or in negotiation."
          />
          <Tile
            icon={<FileCheck2 className="size-5" />}
            label="Previous Quotes"
            value={String(previousQuotes)}
            hint="Approved, rejected or converted."
          />
        </div>
      )}

      <section className="border-border mt-10 rounded-2xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl">Bulk cart</h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/business/bulk-cart">Open bulk cart</Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          {bulkLines.length === 0
            ? "Nothing in your bulk cart yet."
            : `${bulkLines.length} bulk ${bulkLines.length === 1 ? "line" : "lines"} worth ${inr(totals.subtotal)} before GST.`}
        </p>
      </section>

      <section className="border-border mt-6 rounded-2xl border p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl">Recent quote requests</h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/business/rfqs">View all</Link>
          </Button>
        </div>
        {list.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">No quote requests raised yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {list.slice(0, 3).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3">
                <Link
                  to="/business/rfqs/$id"
                  params={{ id: r.id }}
                  className="text-sm font-semibold hover:underline"
                >
                  {r.id}
                </Link>
                <RfqStatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
