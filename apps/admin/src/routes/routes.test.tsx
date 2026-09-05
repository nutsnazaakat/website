import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueryClient } from "@/app/query-client";
import { AppProviders, createAppRouter } from "@/app/router";
import { NAV_GROUPS } from "@/features/shell/navigation";
import {
  ADMIN_USER,
  apiError,
  B2C_USER,
  BULK_SUMMARY,
  DASHBOARD,
  installApi,
  ORDER_DETAIL,
  ORDER_SUMMARY,
  page,
  type Recorded,
  unauthorized,
} from "@/test/server";

/**
 * Route rendering, proved by mounting **the real router** and asserting on content *inside* each
 * route.
 *
 * That phrasing is the whole design of this file. A test that asserts a route "resolved" — that the
 * router settled on the right match, that a container exists, that the URL is what it should be —
 * passes perfectly against a **blank page**, which is exactly what a TanStack layout route without
 * an `<Outlet />` produces: no error, no warning, a successful match and nothing painted. The
 * backend repo hit that three times. So every case below reaches for a specific string the child
 * component is responsible for, and the route file layout (`orders/index.tsx` +
 * `orders/$orderNumber.tsx`, never `orders.tsx` beside them) is what keeps it true.
 *
 * The routes are driven through `createMemoryHistory`, so a case can *start* on
 * `/orders/NN-2026-005107` rather than reaching it by a navigation that would mask a broken
 * deep-link.
 */

let api: { calls: Recorded[]; restore: () => void } | null = null;

function mount(path: string, handlers: Record<string, (call: Recorded) => unknown>) {
  api = installApi(handlers);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppProviders router={router} queryClient={createQueryClient()} />);
  return { router, calls: api.calls };
}

/** Every screen behind the guard needs a session, so this is the signed-in-as-admin baseline. */
const asAdmin = {
  "GET /auth/me": () => ADMIN_USER,
};

beforeEach(() => {
  // A signed-in browser always carries `nn_csrf`; `http.ts` reads its absence as "no session" and
  // skips the refresh. Set for the authenticated cases, cleared per-case where anonymity matters.
  document.cookie = "nn_csrf=test-csrf; path=/";
});

afterEach(() => {
  api?.restore();
  api = null;
  document.cookie = "nn_csrf=; path=/; max-age=0";
});

describe("/login", () => {
  it("renders the sign-in form", async () => {
    document.cookie = "nn_csrf=; path=/; max-age=0";
    mount("/login", {});

    expect(await screen.findByRole("heading", { name: "Admin console" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("the route guard", () => {
  it("sends an anonymous visitor to /login carrying where they were going", async () => {
    document.cookie = "nn_csrf=; path=/; max-age=0";
    const { router } = mount("/orders/NN-2026-005107", {
      "GET /auth/me": () => unauthorized(),
    });

    expect(await screen.findByRole("heading", { name: "Admin console" })).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    // The redirect must survive as the *whole* href, or a deep link into an order is lost the
    // moment a session expires.
    expect(router.state.location.search).toMatchObject({
      redirect: "/orders/NN-2026-005107",
    });
  });

  it("returns the operator to the redirect target after signing in", async () => {
    document.cookie = "nn_csrf=; path=/; max-age=0";
    const user = userEvent.setup();
    let signedIn = false;

    const { router } = mount("/login?redirect=%2Forders", {
      "GET /auth/me": () => (signedIn ? ADMIN_USER : unauthorized()),
      "POST /auth/login": () => {
        signedIn = true;
        return { user: ADMIN_USER, csrfToken: "test-csrf" };
      },
      "GET /admin/orders": () => page([ORDER_SUMMARY]),
    });

    await user.type(await screen.findByLabelText("Email"), "admin@demo.in");
    await user.type(screen.getByLabelText("Password"), "Password123!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Asserted on content, not on the URL: the orders route is reached *and paints*.
    expect(await screen.findByRole("heading", { name: "Orders" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/orders");
  });

  it("refuses a b2c account with an explanation, and does not sign it out", async () => {
    const { calls } = mount("/", { "GET /auth/me": () => B2C_USER });

    expect(
      await screen.findByRole("heading", { name: "This account cannot use the admin console." }),
    ).toBeInTheDocument();
    // Named, because somebody with two accounts otherwise cannot tell which one they used.
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("(b2c@demo.in)")).toBeInTheDocument();
    // Told their session is fine — a 403 means *this account cannot*, not *you are signed out*.
    expect(screen.getByText(/Your session is valid/)).toBeInTheDocument();

    // The decisive assertion: nothing revoked the session on their behalf. Signing out is offered
    // as a button and nothing more.
    expect(calls.some((call) => call.url.includes("/auth/logout"))).toBe(false);
    expect(
      screen.getByRole("button", { name: "Sign out and use another account" }),
    ).toBeInTheDocument();
    // And no admin data was requested for an account that could only be refused it.
    expect(calls.some((call) => call.url.includes("/admin/"))).toBe(false);
  });

  it("refuses a b2c account who signs in at the form, rather than navigating them into a 403", async () => {
    document.cookie = "nn_csrf=; path=/; max-age=0";
    const user = userEvent.setup();

    const { router } = mount("/login", {
      "GET /auth/me": () => unauthorized(),
      "POST /auth/login": () => ({ user: B2C_USER, csrfToken: "t" }),
    });

    await user.type(await screen.findByLabelText("Email"), "b2c@demo.in");
    await user.type(screen.getByLabelText("Password"), "Password123!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", { name: "This account cannot use the admin console." }),
    ).toBeInTheDocument();
    // They were not sent into the console: every screen there would 403 and show them nothing.
    expect(router.state.location.pathname).toBe("/login");
  });

  it("reports a rate-limited sign-in, which carries no code at all", async () => {
    document.cookie = "nn_csrf=; path=/; max-age=0";
    const user = userEvent.setup();

    mount("/login", {
      "GET /auth/me": () => unauthorized(),
      // `ThrottlerException` is not a `DomainError`: a message, a statusCode, and no `code`.
      // Login allows five attempts per fifteen minutes, so this is reachable by accident.
      "POST /auth/login": () =>
        new Response(
          JSON.stringify({
            success: false,
            statusCode: 429,
            message: "ThrottlerException: Too Many Requests",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    });

    await user.type(await screen.findByLabelText("Email"), "admin@demo.in");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Wait a moment and try again.",
    );
  });
});

describe("/ — the dashboard", () => {
  it("renders brief §29's nine cards with the figures the API sent", async () => {
    mount("/", { ...asAdmin, "GET /admin/dashboard": () => DASHBOARD });

    // Waited on a *card*, not on the page heading: the heading is part of the frame and paints
    // while the query is still pending, so `findBy` on it would resolve against a loading screen
    // and every synchronous assertion after it would race.
    expect(await screen.findByText("Total Sales")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();

    // Scoped to the card grid: "Orders" is also a sidebar destination, and an unscoped query would
    // match either and prove neither.
    const cards = screen.getByRole("list", { name: "Dashboard cards" });
    for (const label of [
      "Total Sales",
      "B2C Sales",
      "B2B Sales",
      "Orders",
      "Pending Orders",
      "Pending RFQs",
      "Customers",
      "B2B Customers",
      "Low Stock",
    ]) {
      expect(within(cards).getByText(label)).toBeInTheDocument();
    }

    // The money assertion that matters: the wire is rupees, so ₹83,492.55 — not ₹834.93, which is
    // what treating it as paise would produce.
    expect(screen.getByText("₹83.5K")).toBeInTheDocument();
    expect(screen.getByTitle("₹83,492.55")).toBeInTheDocument();
    expect(screen.getByTitle("₹77,348.25")).toBeInTheDocument();
  });

  it("renders all four of brief §29's charts", async () => {
    mount("/", { ...asAdmin, "GET /admin/dashboard": () => DASHBOARD });

    expect(await screen.findByRole("heading", { name: "Sales over time" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "B2C vs B2B" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top products" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top categories" })).toBeInTheDocument();

    // Drawn, not merely containered — the reason this app has no charting library: a
    // `ResponsiveContainer` measures 0×0 in jsdom and this assertion could not exist.
    const chart = screen.getByRole("img", { name: /Sales over 14 days/ });
    expect(chart).toBeInTheDocument();
    // Fourteen, not three: the server's series is sparse and the gaps are filled, or a fortnight of
    // silence would be drawn as a straight line of steady trade.
    expect(chart.querySelector("polyline")).not.toBeNull();

    expect(screen.getByText("Premium California Almonds")).toBeInTheDocument();
  });

  it("renders zeroes for an empty database, not NaN and not a spinner", async () => {
    mount("/", {
      ...asAdmin,
      "GET /admin/dashboard": () => ({
        cards: {
          totalSales: 0,
          b2cSales: 0,
          b2bSales: 0,
          orders: 0,
          pendingOrders: 0,
          pendingRfqs: 0,
          customers: 0,
          b2bCustomers: 0,
          lowStock: 0,
        },
        charts: {
          salesOverTime: [],
          channelSplit: [
            { channel: "retail", sales: 0, orders: 0 },
            { channel: "bulk", sales: 0, orders: 0 },
          ],
          topProducts: [],
          topCategories: [],
        },
      }),
    });

    expect(await screen.findByText("Total Sales")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getAllByText("₹0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN/)).toBeNull();
    // An empty series says so rather than drawing a flat line that reads as measured trade.
    expect(screen.getByText("No orders in the last 30 days.")).toBeInTheDocument();
    expect(screen.getByText("Nothing has sold yet.")).toBeInTheDocument();
  });

  it("explains itself when the request fails, and offers a retry", async () => {
    mount("/", {
      ...asAdmin,
      "GET /admin/dashboard": () => apiError(500, "Something went wrong on our end."),
    });

    // A 5xx is retried once with a one-second backoff — `createQueryClient` deliberately retries a
    // server error and nothing else — so the default one-second deadline would expire mid-retry.
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toHaveTextContent(
      "The dashboard could not be loaded.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("/orders — the list", () => {
  it("renders brief §33's seven columns and a row per order", async () => {
    mount("/orders", {
      ...asAdmin,
      "GET /admin/orders": () => page([ORDER_SUMMARY, BULK_SUMMARY], 2),
    });

    const table = await screen.findByRole("table", { name: "Orders, newest first" });
    expect(screen.getByRole("heading", { name: "Orders" })).toBeInTheDocument();
    for (const column of [
      "Order ID",
      "Customer",
      "B2C/B2B",
      "Amount",
      "Payment",
      "Status",
      "Date",
    ]) {
      expect(within(table).getByRole("columnheader", { name: column })).toBeInTheDocument();
    }

    expect(within(table).getByRole("link", { name: "NN-2026-005107" })).toBeInTheDocument();
    expect(within(table).getByText("₹1,020.85")).toBeInTheDocument();
    expect(within(table).getByText("Out for Delivery")).toBeInTheDocument();
    expect(within(table).getByText("Anand Sweets & Namkeen")).toBeInTheDocument();
    // Brief §33's column is B2C/B2B; the wire says retail/bulk.
    expect(within(table).getByText("B2B")).toBeInTheDocument();
  });

  it("reads its filters out of the URL and sends them to the API", async () => {
    const { calls } = mount("/orders?status=pending&channel=retail&from=2026-08-01&to=2026-08-27", {
      ...asAdmin,
      "GET /admin/orders": () => page([]),
    });

    await screen.findByRole("table", { name: "Orders, newest first" }).catch(() => null);
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/orders"));
      expect(found).toBeDefined();
      return found;
    });

    // Date-only bounds, so the server resolves them in the business timezone — the one thing plan
    // 9.4 exists to keep consistent between this screen and the dashboard.
    expect(request?.url).toContain("status=pending");
    expect(request?.url).toContain("channel=retail");
    expect(request?.url).toContain("from=2026-08-01");
    expect(request?.url).toContain("to=2026-08-27");
    // The filter state is genuinely in the URL, so the controls reflect it on a cold load.
    expect(screen.getByLabelText("Status")).toHaveValue("pending");
    expect(screen.getByLabelText("Channel")).toHaveValue("retail");
  });

  it("drops a filter value the API would reject rather than sending it", async () => {
    // Hand-edited address bar. `forbidNonWhitelisted` would answer 400, which an operator cannot
    // interpret; `validateSearch` narrows through the contract's own tuples instead — and
    // `search: { strict: true }` on the router is what makes that narrowing actually remove the
    // value rather than merely fail to add it. `bogus` is here to prove the second half.
    const { calls } = mount("/orders?status=definitely-not-a-status&bogus=1", {
      ...asAdmin,
      "GET /admin/orders": () => page([ORDER_SUMMARY]),
    });

    await screen.findByRole("table", { name: "Orders, newest first" });
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/admin/orders"))).toBe(true);
    });
    const request = calls.find((call) => call.url.includes("/admin/orders"));
    expect(request?.url).not.toContain("definitely-not-a-status");
    expect(request?.url).not.toContain("status=");
    expect(request?.url).not.toContain("bogus");
  });

  it("writes a changed filter back into the URL, so the view is shareable", async () => {
    const user = userEvent.setup();
    const { router } = mount("/orders", {
      ...asAdmin,
      "GET /admin/orders": () => page([ORDER_SUMMARY]),
    });

    await screen.findByRole("table", { name: "Orders, newest first" });
    await user.selectOptions(screen.getByLabelText("Channel"), "bulk");

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ channel: "bulk" });
    });
  });

  it("says so when nothing matches, and offers a way back", async () => {
    mount("/orders?status=refunded", { ...asAdmin, "GET /admin/orders": () => page([]) });

    expect(await screen.findByText("No orders match these filters.")).toBeInTheDocument();
    // Two: one in the filter bar, one in the empty state. Both are deliberate — the operator's eye
    // is on whichever of the two they were last looking at.
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(2);
  });
});

describe("/orders/$orderNumber — the detail", () => {
  /**
   * The blank-child trap, caught head-on. Every assertion here is on markup owned by
   * `orders/$orderNumber.tsx`, so a layout route that resolved this path and painted nothing would
   * fail — where an assertion on `router.state.location.pathname` would not.
   */
  it("renders the items, totals, address and timeline inside the route", async () => {
    mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ORDER_DETAIL,
    });

    // Not the heading: it renders the order number while the query is still pending, so it would
    // resolve against the loading screen.
    const items = await screen.findByRole("table", { name: "Items on order NN-2026-005107" });
    expect(screen.getByRole("heading", { name: "NN-2026-005107" })).toBeInTheDocument();
    expect(within(items).getByText("Premium California Almonds")).toBeInTheDocument();
    expect(within(items).getByText("Roasted Makhana")).toBeInTheDocument();

    expect(screen.getByText("₹1,197")).toBeInTheDocument();
    expect(screen.getByText("₹59.85")).toBeInTheDocument();
    expect(screen.getByText("₹1,020.85")).toBeInTheDocument();

    expect(screen.getByText("12 Brigade Road")).toBeInTheDocument();
    expect(screen.getByText("560001")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByText("With the rider")).toBeInTheDocument();
  });

  it("offers only the transitions the contract says are legal from here", async () => {
    mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ORDER_DETAIL,
    });

    // `out-for-delivery` has exactly one successor.
    expect(await screen.findByRole("button", { name: "Mark Delivered" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Cancelled" })).toBeNull();
  });

  it("changes the status and shows the new one", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ORDER_DETAIL,
      "POST /admin/orders/NN-2026-005107/status": () => ({
        ...ORDER_DETAIL,
        status: "delivered",
        timeline: [
          ...ORDER_DETAIL.timeline,
          { status: "delivered", at: "2026-08-24T07:44:13.405Z" },
        ],
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Mark Delivered" }));

    // `delivered` has one successor of its own, so the panel re-offers the next real move.
    expect(await screen.findByRole("button", { name: "Mark Refunded" })).toBeInTheDocument();

    const write = calls.find((call) => call.url.endsWith("/status"));
    expect(write?.method).toBe("POST");
    expect(write?.body).toBe(JSON.stringify({ status: "delivered" }));
  });

  it("renders `allowed` from a 422 instead of saying the write failed", async () => {
    const user = userEvent.setup();
    // The real refusal, measured against the running service: 422, code
    // `ILLEGAL_STATUS_TRANSITION`, `details.allowed` naming what *is* legal.
    mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ({ ...ORDER_DETAIL, status: "shipped" }),
      "POST /admin/orders/NN-2026-005107/status": () =>
        apiError(
          422,
          'An order that is "shipped" cannot become "pending".',
          "ILLEGAL_STATUS_TRANSITION",
          {
            orderNumber: "NN-2026-005107",
            from: "shipped",
            to: "pending",
            allowed: ["out-for-delivery"],
          },
        ),
    });

    await user.click(await screen.findByRole("button", { name: "Mark Out for Delivery" }));

    expect(await screen.findByRole("status")).toHaveTextContent("The server refused that move.");
    expect(
      await screen.findByRole("button", { name: "Mark Out for Delivery" }),
    ).toBeInTheDocument();
  });

  it("offers COD collection while it is outstanding", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ORDER_DETAIL,
      "POST /admin/orders/NN-2026-005107/payment/collect": () => ({
        ...ORDER_DETAIL,
        paymentStatus: "collected",
        paymentCollectedAt: "2026-08-24T07:44:13.405Z",
        paymentReference: "DLV-1",
      }),
    });

    await user.type(await screen.findByLabelText("Receipt number (optional)"), "DLV-1");
    await user.click(screen.getByRole("button", { name: "Record COD collected" }));

    // The control is gone once it is collected — the endpoint is idempotent and a second call
    // writes nothing at all, so a button that stayed would report success having changed nothing.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Record COD collected" })).toBeNull();
    });
    expect(screen.getByText("DLV-1")).toBeInTheDocument();

    const write = calls.find((call) => call.url.endsWith("/payment/collect"));
    expect(write?.body).toBe(JSON.stringify({ reference: "DLV-1" }));
  });

  it("does not offer COD collection on an order that is already collected", async () => {
    mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => ({
        ...ORDER_DETAIL,
        paymentStatus: "collected",
        paymentCollectedAt: "2026-08-24T07:44:13.405Z",
        paymentReference: "DLV-9",
      }),
    });

    expect(await screen.findByText("COD collected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record COD collected" })).toBeNull();
    expect(screen.getByText("DLV-9")).toBeInTheDocument();
  });

  it("records a shipment, and says that it also ships the order", async () => {
    const user = userEvent.setup();
    const packed = { ...ORDER_DETAIL, status: "packed" as const };
    const { calls } = mount("/orders/NN-2026-005107", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-005107": () => packed,
      "POST /admin/orders/NN-2026-005107/shipment": () => ({
        ...packed,
        status: "shipped",
        shipments: [
          {
            id: "shp-1",
            courier: "Delhivery",
            trackingNumber: "AWB123",
            status: "dispatched",
            shippedAt: "2026-08-24T07:44:13.405Z",
            deliveredAt: null,
            createdAt: "2026-08-24T07:44:13.405Z",
          },
        ],
      }),
    });

    expect(await screen.findByText("This also moves the order to Shipped.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Courier"), "Delhivery");
    await user.type(screen.getByLabelText("Tracking number (optional)"), "AWB123");
    await user.click(screen.getByRole("button", { name: "Record dispatch" }));

    expect(await screen.findByText("Delhivery")).toBeInTheDocument();
    // Neither a second dispatch nor a late AWB can be recorded: there is no route to amend one.
    expect(await screen.findByText(/A second dispatch cannot be recorded/)).toBeInTheDocument();

    const write = calls.find((call) => call.url.endsWith("/shipment"));
    expect(write?.body).toBe(JSON.stringify({ courier: "Delhivery", trackingNumber: "AWB123" }));
  });

  it("does not offer a dispatch form when shipping is not a legal move", async () => {
    mount("/orders/NN-2026-005107", {
      ...asAdmin,
      // `out-for-delivery` cannot become `shipped`, and the endpoint attempts the transition
      // first — so offering the form would offer a write that can only fail.
      "GET /admin/orders/NN-2026-005107": () => ORDER_DETAIL,
    });

    expect(
      await screen.findByText(/Recording a dispatch also moves the order to Shipped/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record dispatch" })).toBeNull();
  });

  it("explains a missing order rather than rendering an empty detail", async () => {
    mount("/orders/NN-2026-000999", {
      ...asAdmin,
      "GET /admin/orders/NN-2026-000999": () =>
        apiError(404, "No order NN-2026-000999 exists.", "NOT_FOUND"),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("This order could not be loaded.");
    expect(screen.getByText("No order NN-2026-000999 exists.")).toBeInTheDocument();
  });
});

describe("the shell", () => {
  it("names the signed-in admin and lists all eighteen routes, marking the unbuilt ones", async () => {
    mount("/", { ...asAdmin, "GET /admin/dashboard": () => DASHBOARD });

    const nav = await screen.findByRole("navigation", { name: "Console" });
    expect(within(nav).getByText("Nazaakat Admin")).toBeInTheDocument();
    expect(within(nav).getByText("admin@demo.in")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    /**
     * **Every one of §7.1's nav destinations is named here, and the list is hardcoded on purpose**
     * — it is what pins that none of them is quietly dropped as the console is finished. What is
     * *derived* from `NAV_GROUPS` is only which of them are built yet, because plan 9.6b builds
     * them in two concurrent groups and a hardcoded split would fail on whichever half landed
     * first for a reason that has nothing to do with the routes.
     *
     * "Audit log" is the one entry §7.1 does not name. Task B9 says to put it where it is useful
     * and the sidebar is where an operator will look, so it belongs in this list — otherwise the
     * assertion would fail the day it was added, which is the opposite of what a drift check does.
     */
    const EXPECTED_NAV = [
      "Dashboard",
      "Orders",
      "Quote requests",
      "Customers",
      "Businesses",
      "Products",
      "Categories",
      "Inventory",
      "B2B pricing",
      "Coupons",
      "Reviews",
      "Blog",
      "Support",
      "Settings",
      "Audit log",
    ];
    const items = NAV_GROUPS.flatMap((group) => group.items);
    expect(items.map((item) => item.label)).toEqual(EXPECTED_NAV);

    for (const item of items) {
      expect(within(nav).getByText(item.label)).toBeInTheDocument();
      if (item.built) {
        // A built destination is a real link with a route behind it.
        expect(within(nav).getByRole("link", { name: item.label })).toBeInTheDocument();
      } else {
        // The rest are visible and marked, not hidden — an operator who cannot see them has no way
        // to tell an unfinished console from a broken one. They are not links, because there is no
        // route behind them and a link would resolve to the blank page all of this prevents.
        expect(within(nav).queryByRole("link", { name: item.label })).toBeNull();
      }
    }
    /*
     * `queryAllByText`, not `getAllByText`: with plan 9.6b finished there are **no** "Soon" markers
     * left at all, and `getAllByText` throws on an empty result rather than returning one. The
     * assertion means the same thing either way — it just survives the day it becomes zero, which
     * is the day it would otherwise have failed for having succeeded.
     */
    expect(within(nav).queryAllByText("Soon")).toHaveLength(
      items.filter((item) => !item.built).length,
    );
  });

  it("signs out through the server, so the session row is really revoked", async () => {
    const user = userEvent.setup();
    let signedIn = true;
    const { calls } = mount("/", {
      "GET /auth/me": () => (signedIn ? ADMIN_USER : unauthorized()),
      "GET /admin/dashboard": () => DASHBOARD,
      "POST /auth/logout": () => {
        signedIn = false;
        return null;
      },
      "GET /admin/orders": () => page([]),
    });

    const nav = await screen.findByRole("navigation", { name: "Console" });
    await user.click(within(nav).getByRole("button", { name: "Sign out" }));

    // Not merely a local state reset: a logout that does not revoke leaves a 30-day refresh cookie
    // valid, which is the exact failure `http.ts`'s `NEVER_REFRESH` set is shaped around.
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/auth/logout"))).toBe(true);
    });
    expect(await screen.findByRole("heading", { name: "Admin console" })).toBeInTheDocument();
  });
});
