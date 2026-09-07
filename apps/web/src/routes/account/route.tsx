import { createFileRoute, Link, linkOptions, Outlet, useNavigate } from "@tanstack/react-router";
import { Briefcase, LayoutDashboard, LogOut, MapPin, Package, UserCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useAuth } from "@/features/auth/AuthProvider";
import { requireCustomer } from "@/features/auth/guards";

/**
 * Every `/account/*` page is private, so the guard sits on the layout they all share.
 *
 * `requireCustomer`, not `requireAuth`: being signed in is not enough, because an administrator is
 * signed in too and this is not their area.
 */
export const Route = createFileRoute("/account")({
  beforeLoad: ({ location }) => {
    requireCustomer(location.href);
  },
  component: AccountLayout,
});

const nav = [
  { opts: linkOptions({ to: "/account" }), label: "Overview", icon: LayoutDashboard, end: true },
  { opts: linkOptions({ to: "/account/orders" }), label: "Orders", icon: Package, end: false },
  { opts: linkOptions({ to: "/account/addresses" }), label: "Addresses", icon: MapPin, end: false },
  { opts: linkOptions({ to: "/account/profile" }), label: "Profile", icon: UserCog, end: false },
];

const linkClass =
  "flex items-center gap-2 whitespace-nowrap rounded-xl border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 lg:border-transparent lg:px-3";

function AccountLayout() {
  const settings = useSiteSettings();
  const { user, role, logout } = useAuth();
  const navigate = useNavigate();

  /**
   * `logout()` revokes the session server-side and only then clears the local snapshot. It is
   * awaited before navigating, and its rejection is reported: a failed revoke leaves the 30-day
   * refresh cookie valid, so telling the customer nothing happened would be a lie about the one
   * action where it matters most.
   */
  const signOut = async () => {
    try {
      await logout();
    } catch {
      toast.error("We could not sign you out completely. Check your connection and try again.");
    }
    await navigate({ to: "/" });
  };

  return (
    <div className="container-page py-10">
      <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
        {settings.brandName} Account
      </p>

      <div className="mt-6 gap-10 lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Account" className="mb-8 lg:mb-0">
          <ul className="flex gap-2 overflow-x-auto pb-2 lg:sticky lg:top-24 lg:flex-col lg:overflow-visible lg:pb-0">
            {nav.map((n) => (
              <li key={n.label}>
                <Link
                  {...n.opts}
                  activeOptions={{ exact: n.end }}
                  className={linkClass}
                  activeProps={{
                    className: "border-primary bg-sand font-semibold text-foreground",
                  }}
                >
                  <n.icon className="size-4 shrink-0" />
                  {n.label}
                </Link>
              </li>
            ))}

            {/* Spec §46 — the same account holds both channels, so this is a switch, not a login. */}
            {role === "b2b" && (
              <li>
                <Link to="/business" className={linkClass}>
                  <Briefcase className="size-4 shrink-0" />
                  Switch to Business
                </Link>
              </li>
            )}

            <li className="lg:mt-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground w-full justify-start gap-2 px-4 text-sm lg:px-3"
                onClick={() => {
                  void signOut();
                }}
              >
                <LogOut className="size-4 shrink-0" />
                Log out
              </Button>
            </li>
          </ul>

          {user && (
            <p className="text-muted-foreground mt-4 hidden text-xs lg:block">
              Signed in as {user.email}
            </p>
          )}
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
