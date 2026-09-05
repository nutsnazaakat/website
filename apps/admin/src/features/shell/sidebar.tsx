import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useAuth } from "@/features/auth/auth-context";
import { NAV_GROUPS } from "@/features/shell/navigation";
import { cn } from "@/lib/utils";

/**
 * The console's navigation. Permanent, never collapsed.
 *
 * An operator moves between orders, stock and quote requests constantly, so a drawer would charge
 * a click for every one of those moves. 200px fixed, which is enough for the longest label
 * ("Quote requests") and costs a table nothing at 1280px.
 */
export function Sidebar() {
  const { user, signOut } = useAuth();

  return (
    <nav
      aria-label="Console"
      className="bg-sidebar border-sidebar-border flex w-[200px] shrink-0 flex-col border-r"
    >
      <div className="border-sidebar-border flex flex-col gap-0.5 border-b px-3 py-3">
        <span className="text-[13px] font-semibold">Nuts &amp; Nazaakat</span>
        <span className="text-muted-foreground text-[11px] tracking-wide uppercase">
          Admin console
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="mb-3">
            <p className="text-muted-foreground px-3 pb-1 text-[10px] font-semibold tracking-widest uppercase">
              {group.heading}
            </p>
            <ul>
              {group.items.map((item) => (
                <li key={item.to}>
                  {item.built ? (
                    <Link
                      to={item.to}
                      // `exact` on "/" only. Without it the dashboard link, whose path is a prefix
                      // of every other, would render active on every screen in the console.
                      activeOptions={item.to === "/" ? { exact: true } : undefined}
                      activeProps={{
                        className: "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                      }}
                      className="hover:bg-sidebar-accent/60 mx-1 flex items-center gap-2 rounded px-2 py-1.5 text-[13px]"
                    >
                      <item.icon className="size-3.5 shrink-0" />
                      {item.label}
                    </Link>
                  ) : (
                    /*
                     * Not a `<Link>`, and not a disabled one either: there is no route file behind
                     * these paths, so a link would resolve to nothing and render the blank page
                     * this whole arrangement exists to prevent. A `<span>` cannot be clicked into
                     * anything, and `title` says why.
                     */
                    <span
                      title="Not built yet — plan 9.6b."
                      className={cn(
                        "text-muted-foreground/70 mx-1 flex cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-[13px]",
                      )}
                    >
                      <item.icon className="size-3.5 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      <span className="border-border rounded border px-1 text-[9px] tracking-wide uppercase">
                        Soon
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-sidebar-border flex items-center gap-2 border-t px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium">{user?.name ?? "—"}</p>
          <p className="text-muted-foreground truncate text-[11px]">{user?.email ?? ""}</p>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          aria-label="Sign out"
          title="Sign out"
          className="hover:bg-sidebar-accent rounded p-1.5"
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    </nav>
  );
}
