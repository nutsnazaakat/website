import {
  BadgePercent,
  Boxes,
  Building2,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  MessageSquareQuote,
  Package,
  Receipt,
  ScrollText,
  Settings,
  Star,
  Tags,
  Users,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * All eighteen console routes, from backend design spec §7.1.
 *
 * **The fifteen this plan does not build are listed and visibly disabled, not omitted.** An
 * operator who cannot see them has no idea the console is unfinished rather than broken; one who
 * clicks into a blank page learns nothing at all. `built: false` renders a non-interactive row with
 * a "Soon" marker, and there is no route file behind it — so there is nothing to click into by
 * accident and nothing for the router to resolve to an empty layout.
 *
 * Detail routes (`/products/$id`, `/orders/$id`, `/rfqs/$id`) are not nav entries: they are reached
 * from their list. §7.1 counts them among the eighteen because they are screens to build, not
 * because they are destinations to navigate to.
 */
export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  built: boolean;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    heading: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, built: true }],
  },
  {
    heading: "Trade",
    items: [
      { to: "/orders", label: "Orders", icon: Receipt, built: true },
      { to: "/rfqs", label: "Quote requests", icon: MessageSquareQuote, built: true },
      { to: "/customers", label: "Customers", icon: Users, built: true },
      { to: "/businesses", label: "Businesses", icon: Building2, built: true },
    ],
  },
  {
    heading: "Catalogue",
    items: [
      { to: "/products", label: "Products", icon: Package, built: true },
      { to: "/categories", label: "Categories", icon: Tags, built: true },
      { to: "/inventory", label: "Inventory", icon: Boxes, built: true },
      { to: "/pricing", label: "B2B pricing", icon: BadgePercent, built: true },
      { to: "/coupons", label: "Coupons", icon: BadgePercent, built: true },
    ],
  },
  {
    heading: "Content",
    items: [
      { to: "/reviews", label: "Reviews", icon: Star, built: true },
      { to: "/blog", label: "Blog", icon: FileText, built: true },
      { to: "/support", label: "Support", icon: LifeBuoy, built: true },
      { to: "/settings", label: "Settings", icon: Settings, built: true },
      /**
       * **Not one of §7.1's eighteen**, and listed anyway — plan 9.6b's task B9 says to put it
       * where it is useful, and a trail nobody can reach is a trail nobody reads. Under Content
       * rather than Overview because it is a record to consult, not a screen to work from.
       */
      { to: "/audit-logs", label: "Audit log", icon: ScrollText, built: true },
    ],
  },
];

/**
 * Every route §7.1 names, including the detail screens the sidebar does not link to.
 *
 * **Not the length of `NAV_GROUPS`**, and the two must not be conflated. §7.1's eighteen are the
 * fourteen nav destinations plus `/products/new`, `/products/$id`, `/orders/$orderNumber` and
 * `/rfqs/$rfqNumber`. The console also carries screens §7.1 never named — the audit log, and the
 * customer, business and support-ticket details their lists link to — so the finished app has more
 * routes than this number, which is the point of stating what it counts.
 */
export const CONSOLE_ROUTE_COUNT = 18;
