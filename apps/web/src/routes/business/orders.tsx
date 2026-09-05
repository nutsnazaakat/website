import { createFileRoute, Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { OrdersTable, OrdersTableSkeleton } from "@/features/account/components/OrdersTable";
import { useBusinessOrders } from "@/features/business/hooks/useBusiness";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/business/orders")({ component: BusinessOrders });

function BusinessOrders() {
  // `GET /business/orders` — deep-equal to `GET /account/orders?channel=bulk` on the wire
  // (`BusinessesController.listOrders`'s own docblock), at the URL this page actually calls.
  const { data: orders, isLoading } = useBusinessOrders();

  useSeo({
    title: `Business Orders | ${settings.brandName}`,
    description: "Your bulk order history, invoices and dispatch status.",
    noindex: true,
  });

  const list = orders ?? [];

  return (
    <div>
      <h1 className="font-display text-4xl">Orders</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Bulk orders, GST invoices and dispatch status.
      </p>

      {isLoading ? (
        <OrdersTableSkeleton />
      ) : list.length === 0 ? (
        <EmptyState
          title="No business orders yet."
          body="Once you place a bulk order it appears here with its invoice and dispatch status."
          icon={<Package className="size-10" />}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button asChild>
                <Link to="/bulk/$category" params={{ category: "all" }}>
                  Browse bulk products
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/business/rfqs/new">Request a Quote</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <OrdersTable orders={list} label="Bulk orders" />
      )}
    </div>
  );
}
