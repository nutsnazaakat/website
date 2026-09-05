import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { AdminDashboardCards } from "@/contract";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { fetchDashboard } from "@/features/dashboard/api/dashboard";
import {
  ChannelSplitChart,
  SalesOverTimeChart,
  TopSellersChart,
} from "@/features/dashboard/charts";
import { fillSalesSeries } from "@/features/dashboard/series";
import { errorMessage } from "@/features/orders/api/errors";
import { count, inr, inrCompact } from "@/lib/format";

export const Route = createFileRoute("/_console/")({
  component: DashboardScreen,
});

/**
 * Brief §29's nine cards, in the brief's own order.
 *
 * `money: true` renders through `inrCompact` with the exact figure on the element's `title`. The
 * others are counts. **Nothing here divides by a hundred**: the wire is rupees (spec §8 converts at
 * the mapper boundary), so `totalSales: 83492.55` is already ₹83,492.55.
 *
 * Two of them pull in opposite directions on purpose and the hints say so, because an operator who
 * notices the discrepancy without an explanation will report it as a bug: **Total Sales excludes
 * cancelled and refunded orders while Orders counts every one of them**, so that the revenue figure
 * matches what the customer was told and the order count matches the row count of `/orders`.
 */
const CARD_HINTS: Partial<Record<keyof AdminDashboardCards, string>> = {
  totalSales: "Excludes cancelled and refunded",
  b2cSales: "Retail channel",
  b2bSales: "Bulk channel",
  orders: "Every order, cancellations included",
  pendingOrders: "Awaiting confirmation",
  pendingRfqs: "Quote requests awaiting a reply",
  customers: "Every non-admin account",
  b2bCustomers: "The business subset of Customers",
  lowStock: "Variants at or below their threshold",
};

const CARDS: { key: keyof AdminDashboardCards; label: string; money: boolean }[] = [
  { key: "totalSales", label: "Total Sales", money: true },
  { key: "b2cSales", label: "B2C Sales", money: true },
  { key: "b2bSales", label: "B2B Sales", money: true },
  { key: "orders", label: "Orders", money: false },
  { key: "pendingOrders", label: "Pending Orders", money: false },
  { key: "pendingRfqs", label: "Pending RFQs", money: false },
  { key: "customers", label: "Customers", money: false },
  { key: "b2bCustomers", label: "B2B Customers", money: false },
  { key: "lowStock", label: "Low Stock", money: false },
];

function DashboardScreen() {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: ({ signal }) => fetchDashboard(signal),
  });

  return (
    <Page
      title="Dashboard"
      description="Last 30 days, in the business's timezone"
      actions={
        <Button variant="outline" onClick={() => void dashboard.refetch()}>
          Refresh
        </Button>
      }
    >
      {dashboard.isPending ? (
        <Loading label="Loading the dashboard" />
      ) : dashboard.isError ? (
        <Panel>
          <Notice
            tone="error"
            title="The dashboard could not be loaded."
            body={errorMessage(dashboard.error)}
            action={
              <Button variant="outline" onClick={() => void dashboard.refetch()}>
                Try again
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {/*
            Nine cards on one row at 1600px, three at 1024px. A grid rather than a flex wrap so the
            columns line up between rows — nine cards of differing label lengths that each sized
            themselves would read as nine unrelated things.
          */}
          <ul
            aria-label="Dashboard cards"
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9"
          >
            {CARDS.map((card) => {
              const value = dashboard.data.cards[card.key];
              return (
                <li key={card.key}>
                  <Panel className="flex h-full flex-col gap-0.5 px-3 py-2">
                    <span className="text-muted-foreground text-[11px] font-medium">
                      {card.label}
                    </span>
                    <span
                      className="tnum text-[17px] leading-tight font-semibold"
                      // The exact figure, always reachable: a card reading ₹83.5K must not be the
                      // only place the number exists.
                      title={card.money ? inr(value) : count(value)}
                    >
                      {card.money ? inrCompact(value) : count(value)}
                    </span>
                    <span className="text-muted-foreground text-[10px] leading-tight">
                      {CARD_HINTS[card.key]}
                    </span>
                  </Panel>
                </li>
              );
            })}
          </ul>

          <div className="grid gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2">
              <PanelHeader
                title="Sales over time"
                hint="Daily, business timezone"
                action={
                  <Link to="/orders" className="text-primary text-[11px] hover:underline">
                    All orders
                  </Link>
                }
              />
              <SalesOverTimeChart points={fillSalesSeries(dashboard.data.charts.salesOverTime)} />
            </Panel>

            <Panel>
              <PanelHeader title="B2C vs B2B" hint="Share of sales" />
              <ChannelSplitChart points={dashboard.data.charts.channelSplit} />
            </Panel>

            <Panel>
              <PanelHeader title="Top products" hint="By sales" />
              <TopSellersChart
                rows={dashboard.data.charts.topProducts}
                emptyTitle="Nothing has sold yet."
              />
            </Panel>

            <Panel>
              <PanelHeader title="Top categories" hint="By sales" />
              <TopSellersChart
                rows={dashboard.data.charts.topCategories}
                emptyTitle="No category has sales yet."
              />
            </Panel>
          </div>
        </div>
      )}
    </Page>
  );
}
