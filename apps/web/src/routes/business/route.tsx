import { createFileRoute, Link, linkOptions, Outlet } from "@tanstack/react-router";
import {
  ClipboardList,
  LayoutDashboard,
  Package,
  ShoppingCart,
  UserCog,
  UserRound,
} from "lucide-react";
import { settings } from "@/config/settings";
import { requireBusiness } from "@/features/auth/guards";
import { useCart } from "@/features/cart/CartProvider";

/**
 * Layout for the whole business area.
 *
 * Spec §7 guards `/business/*` on `role === "b2b"`. `requireBusiness` sends an anonymous
 * visitor to `/login?redirect=…` and a signed-in retail customer to `/account`, which
 * offers to switch bulk buying on. Both targets sit outside this layout — redirecting to
 * `/business`, as the spec's wording suggested, would bounce the visitor straight back
 * into the route that just turned them away.
 */
export const Route = createFileRoute("/business")({
  beforeLoad: ({ location }) => {
    requireBusiness(location.href);
  },
  component: BusinessLayout,
});

const nav = [
  { opts: linkOptions({ to: "/business" }), label: "Dashboard", icon: LayoutDashboard, end: true },
  { opts: linkOptions({ to: "/business/profile" }), label: "Profile", icon: UserCog, end: false },
  { opts: linkOptions({ to: "/business/orders" }), label: "Orders", icon: Package, end: false },
  { opts: linkOptions({ to: "/business/rfqs" }), label: "RFQs", icon: ClipboardList, end: false },
  {
    opts: linkOptions({ to: "/business/bulk-cart" }),
    label: "Bulk Cart",
    icon: ShoppingCart,
    end: false,
  },
];

function BusinessLayout() {
  const { lines } = useCart();
  const bulkCount = lines.filter((l) => l.mode === "bulk").length;

  return (
    <div className="container-page py-10">
      <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
        {settings.brandName} for Business
      </p>

      <div className="mt-6 gap-10 lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Business area" className="mb-8 lg:mb-0">
          <ul className="flex gap-2 overflow-x-auto pb-2 lg:sticky lg:top-24 lg:flex-col lg:overflow-visible lg:pb-0">
            {nav.map((n) => (
              <li key={n.label}>
                <Link
                  {...n.opts}
                  activeOptions={{ exact: n.end }}
                  className="border-border text-muted-foreground hover:border-primary/50 flex items-center gap-2 rounded-xl border px-4 py-2 text-sm whitespace-nowrap transition-colors lg:border-transparent lg:px-3"
                  activeProps={{
                    className: "border-primary bg-sand font-semibold text-foreground",
                  }}
                >
                  <n.icon className="size-4 shrink-0" />
                  {n.label}
                  {n.label === "Bulk Cart" && bulkCount > 0 && (
                    <span className="bg-primary text-primary-foreground ml-auto rounded-full px-2 text-[11px] font-semibold">
                      {bulkCount}
                    </span>
                  )}
                </Link>
              </li>
            ))}

            {/* One account, two channels — the way back must be as easy as the way in. */}
            <li className="lg:mt-4">
              <Link
                to="/account"
                className="border-border text-muted-foreground hover:border-primary/50 flex items-center gap-2 rounded-xl border px-4 py-2 text-sm whitespace-nowrap transition-colors lg:border-transparent lg:px-3"
              >
                <UserRound className="size-4 shrink-0" />
                Personal Account
              </Link>
            </li>
          </ul>
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
