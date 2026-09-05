import { createFileRoute, Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { OrdersTable, OrdersTableSkeleton } from "@/features/account/components/OrdersTable";
import { useOrders } from "@/features/account/hooks/useAccount";
import { useSeo } from "@/hooks/useSeo";

/**
 * Lives in `orders/` as `index.tsx` rather than as a sibling `orders.tsx`, which would make
 * this file the layout route for `orders/$id` — and with no `<Outlet />` the detail page
 * would render blank with no error. A directory keeps the two routes siblings.
 */
export const Route = createFileRoute("/account/orders/")({ component: AccountOrders });

function AccountOrders() {
  // Whose orders these are is the session's business, not a parameter this page may supply.
  const { data: orders, isLoading } = useOrders();

  useSeo({
    title: `Your Orders | ${settings.brandName}`,
    description: "Every order you have placed, with its current status.",
    noindex: true,
  });

  const list = orders ?? [];

  return (
    <div>
      <h1 className="font-display text-4xl">Your Orders</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Retail and bulk orders together — open one to see its full status history.
      </p>

      {isLoading ? (
        <OrdersTableSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          title="No orders yet."
          body="When you place an order it appears here with its delivery status."
          icon={<Package className="size-10" />}
          action={
            <Button asChild>
              <Link to="/shop">Explore Bestsellers</Link>
            </Button>
          }
        />
      ) : (
        <OrdersTable orders={list} label="Your orders" />
      )}
    </div>
  );
}
