import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Briefcase, Loader2, MapPin, Package, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useAddresses, useOrders } from "@/features/account/hooks/useAccount";
import { OrdersTable, OrdersTableSkeleton } from "@/features/account/components/OrdersTable";
import { useAuth } from "@/features/auth/AuthProvider";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/account/")({
  // `?upgrade=business` is set by the /business guard when a retail account is turned away.
  // The property is optional rather than `| undefined` so links to `/account` need no search.
  validateSearch: (search: Record<string, unknown>): { upgrade?: "business" } =>
    search.upgrade === "business" ? { upgrade: "business" } : {},
  component: AccountOverview,
});

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

function UpgradeToBusinessCard() {
  const { upgradeToBusiness } = useAuth();
  const navigate = useNavigate();
  const [enabling, setEnabling] = useState(false);

  const enableBusiness = async () => {
    setEnabling(true);
    try {
      // Awaited, not fired and forgotten: `/business/*` is guarded on the role in the
      // localStorage snapshot, and that is only written once the server has confirmed the
      // upgrade. Navigating first would bounce the customer straight back to here.
      await upgradeToBusiness();
      toast.success("Business buying enabled");
      await navigate({ to: "/business/profile" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not enable business buying. Try again.",
      );
    } finally {
      setEnabling(false);
    }
  };

  return (
    <section className="border-primary/40 bg-sand mt-8 rounded-2xl border p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <Briefcase className="size-5" />
        <h2 className="font-display text-2xl">Bulk buying is not switched on yet</h2>
      </div>
      <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
        The business area covers bulk pricing, quote requests and GST invoices. One account serves
        both channels, so there is nothing to sign up for twice — switch it on here and add your
        company details next.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          disabled={enabling}
          onClick={() => {
            void enableBusiness();
          }}
        >
          {enabling ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Enabling…
            </>
          ) : (
            "Enable business buying"
          )}
        </Button>
        <Button asChild variant="outline">
          <Link to="/bulk-orders">See bulk pricing first</Link>
        </Button>
      </div>
    </section>
  );
}

function AccountOverview() {
  const settings = useSiteSettings();
  const { upgrade } = Route.useSearch();
  const { user, role } = useAuth();

  // No email on either read. Both scope from the session, so a client cannot name the account it is
  // reading — the address book was the last one still taking an argument, and it stopped in Task 21.
  const { data: orders, isLoading } = useOrders();
  const { data: addresses = [] } = useAddresses();

  useSeo({
    title: `Your Account | ${settings.brandName}`,
    description: "Your orders, addresses and account details.",
    noindex: true,
  });

  const list = orders ?? [];
  // Cancelled and refunded orders were not money the customer kept spending.
  const spend = list
    .filter((o) => o.status !== "cancelled" && o.status !== "refunded")
    .reduce((sum, o) => sum + o.total, 0);

  return (
    <div>
      <h1 className="font-display text-4xl">Overview</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {user ? `Signed in as ${user.name}.` : ""} Track orders, manage addresses and keep your
        details current.
      </p>

      {upgrade === "business" && role !== "b2b" && <UpgradeToBusinessCard />}

      {isLoading ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <Tile
            icon={<Package className="size-5" />}
            label="Orders placed"
            value={String(list.length)}
            hint="Across retail and bulk."
          />
          <Tile
            icon={<Wallet className="size-5" />}
            label="Total spend"
            value={inr(spend)}
            hint="Excludes cancelled and refunded orders."
          />
          <Tile
            icon={<MapPin className="size-5" />}
            label="Saved addresses"
            value={String(addresses.length)}
            hint="Used to prefill checkout."
          />
        </div>
      )}

      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-2xl">Recent orders</h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/account/orders">View all orders</Link>
          </Button>
        </div>

        {isLoading ? (
          <OrdersTableSkeleton />
        ) : list.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            No orders yet. Anything you order will appear here with its status.
          </p>
        ) : (
          <OrdersTable orders={list.slice(0, 3)} label="Recent orders" />
        )}
      </section>
    </div>
  );
}
