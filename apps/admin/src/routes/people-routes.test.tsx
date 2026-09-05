import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueryClient } from "@/app/query-client";
import { AppProviders, createAppRouter } from "@/app/router";
import {
  B2B_CUSTOMER_DETAIL,
  BUSINESS_DETAIL,
  BUSINESS_ID,
  BUSINESS_SUMMARY,
  CUSTOMER_DETAIL,
  CUSTOMER_ID,
  CUSTOMER_SUMMARY,
  GIFTING_RFQ_DETAIL,
  RFQ_DETAIL,
  RFQ_SUMMARY,
} from "@/test/people-fixtures";
import { ADMIN_USER, apiError, installApi, page, type Recorded } from "@/test/server";

/**
 * The people screens — customers, businesses and quote requests — **mounted through the real
 * router**, asserting on content *inside* each route.
 *
 * That phrasing is `routes.test.tsx`'s and the reason is the same: a test that only asserts a route
 * "resolved" passes perfectly against a blank page, which is exactly what a TanStack layout route
 * without an `<Outlet />` renders. So every case reaches for a specific string the child component
 * is responsible for, and the file layout — `rfqs/index.tsx` beside `rfqs/$rfqNumber.tsx`, with no
 * `rfqs.tsx` next to the directory — is what keeps that meaningful.
 *
 * A separate file from `routes.test.tsx` rather than an addition to it, because plan 9.6b's two
 * groups of screens are built on concurrent branches and both would otherwise be appending to the
 * same 650-line file.
 */

let api: { calls: Recorded[]; restore: () => void } | null = null;

function mount(path: string, handlers: Record<string, (call: Recorded) => unknown>) {
  api = installApi({ "GET /auth/me": () => ADMIN_USER, ...handlers });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppProviders router={router} queryClient={createQueryClient()} />);
  return { router, calls: api.calls };
}

beforeEach(() => {
  document.cookie = "nn_csrf=test-csrf; path=/";
});

afterEach(() => {
  api?.restore();
  api = null;
  document.cookie = "nn_csrf=; path=/; max-age=0";
});

describe("/customers", () => {
  it("lists customers and names the two figures that deliberately disagree", async () => {
    mount("/customers", {
      "GET /admin/customers": () => page([CUSTOMER_SUMMARY]),
    });

    /*
     * Awaited on a **row**, not on the page heading.
     *
     * `<Page title="Customers">` renders during the pending state too, so `findByRole("heading")`
     * would resolve against a skeleton and every assertion after it would race the fetch. Every
     * case below therefore waits for something only the loaded screen can produce.
     */
    expect(await screen.findByRole("link", { name: "Asha Rao" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Customers" })).toBeInTheDocument();
    expect(screen.getByText("b2c@demo.in")).toBeInTheDocument();

    /*
     * The decisive money assertion. `totalSpend` is 6144.3 **rupees** on the wire, so the cell must
     * read ₹6,144.3 — a screen that called `toRupees` on it would print ₹61.44 and an operator
     * approving a refund would be out by a factor of a hundred.
     */
    expect(screen.getByText("₹6,144.3")).toBeInTheDocument();

    // And the sentence that stops somebody reconciling two different questions.
    expect(screen.getByText(/leaves out cancelled and refunded/)).toBeInTheDocument();
  });

  it("puts the search term in the URL rather than sending it per keystroke", async () => {
    const user = userEvent.setup();
    const { router, calls } = mount("/customers", {
      "GET /admin/customers": () => page([CUSTOMER_SUMMARY]),
    });

    await screen.findByRole("link", { name: "Asha Rao" });
    await user.type(screen.getByLabelText("Name, email or phone"), "asha");
    // Still one request. The box is uncontrolled, so four keystrokes are four keystrokes and not
    // four requests against a 120/min limit.
    expect(calls.filter((call) => call.url.includes("/admin/customers")).length).toBe(1);

    // Enter applies it, as it does on every other list in the console.
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: "asha" });
    });
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("q=asha"))).toBe(true);
    });
  });

  it("drops a hand-edited parameter no route declared, so it never reaches the API", async () => {
    const { calls } = mount("/customers?role=admin&bogus=1", {
      "GET /admin/customers": () => page([CUSTOMER_SUMMARY]),
    });

    await screen.findByRole("link", { name: "Asha Rao" });
    const request = calls.find((call) => call.url.includes("/admin/customers"));
    // `role=admin` is not one of the two the DTO accepts, and `bogus` is not a parameter at all.
    // Both would be a 400 under `forbidNonWhitelisted`; `search.strict` is what removes them.
    expect(request?.url).not.toContain("bogus");
    expect(request?.url).not.toContain("role=");
  });

  it("renders a customer's account, address book and business record", async () => {
    mount(`/customers/${B2B_CUSTOMER_DETAIL.id}`, {
      [`GET /admin/customers/${B2B_CUSTOMER_DETAIL.id}`]: () => B2B_CUSTOMER_DETAIL,
    });

    expect(await screen.findByRole("heading", { name: "Rakesh Anand" })).toBeInTheDocument();
    // Twice on this screen — the panel's hint and the "Company" row — so the count is not asserted,
    // only that the business is named at all.
    expect(screen.getAllByText("Anand Sweets & Namkeen").length).toBeGreaterThan(0);
    // Rupees again, on the detail this time.
    expect(screen.getByText("₹77,348.25")).toBeInTheDocument();
    expect(
      screen.getByText(/Read-only — there is no endpoint that changes it/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the full business profile" }),
    ).toBeInTheDocument();
  });

  it("shows the address book, and says an account cannot be edited from here", async () => {
    mount(`/customers/${CUSTOMER_ID}`, {
      [`GET /admin/customers/${CUSTOMER_ID}`]: () => CUSTOMER_DETAIL,
    });

    expect(await screen.findByRole("heading", { name: "Asha Rao" })).toBeInTheDocument();
    expect(screen.getByText("12 Brigade Road")).toBeInTheDocument();
    expect(screen.getByText(/there is no admin write path for an account/)).toBeInTheDocument();
  });

  it("explains a failure instead of rendering an empty detail", async () => {
    mount(`/customers/${CUSTOMER_ID}`, {
      [`GET /admin/customers/${CUSTOMER_ID}`]: () =>
        apiError(404, "No such customer.", "NOT_FOUND"),
    });

    expect(await screen.findByText("This customer could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("No such customer.")).toBeInTheDocument();
  });
});

describe("/businesses", () => {
  it("lists brief §35's B2B columns", async () => {
    mount("/businesses", {
      "GET /admin/businesses": () => page([BUSINESS_SUMMARY]),
    });

    expect(await screen.findByRole("link", { name: "Anand Sweets & Namkeen" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Businesses" })).toBeInTheDocument();
    expect(screen.getByText("29ABCDE1234F1Z5")).toBeInTheDocument();
    expect(screen.getByText("₹77,348.25")).toBeInTheDocument();
    // Open out of total.
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("says the price band and salesperson are read-only, and offers no input for them", async () => {
    mount(`/businesses/${BUSINESS_ID}`, {
      [`GET /admin/businesses/${BUSINESS_ID}`]: () => BUSINESS_DETAIL,
    });

    expect(
      await screen.findByRole("heading", { name: "Anand Sweets & Namkeen" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Distributor")).toBeInTheDocument();
    expect(screen.getByText(/PATCH \/admin\/businesses\/:id/)).toBeInTheDocument();
    expect(screen.getByText(/was never built/)).toBeInTheDocument();

    /*
     * The assertion that makes the sentence true rather than decorative: there is **no control** to
     * change either field. An input that answered 404 would teach an operator that the console is
     * broken, rather than that the endpoint does not exist.
     */
    const commercial = screen.getByText("Price band").closest("dl");
    expect(commercial).not.toBeNull();
    expect(within(commercial as HTMLElement).queryByRole("combobox")).toBeNull();
    expect(within(commercial as HTMLElement).queryByRole("textbox")).toBeNull();
  });

  it("shows a shipping address that was never set as not set, not as blank", async () => {
    mount(`/businesses/${BUSINESS_ID}`, {
      [`GET /admin/businesses/${BUSINESS_ID}`]: () => BUSINESS_DETAIL,
    });

    expect(await screen.findByText("44 Commercial Street")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });
});

describe("/rfqs", () => {
  it("lists brief §34's columns, lines included", async () => {
    mount("/rfqs", {
      "GET /admin/rfqs": () => page([RFQ_SUMMARY]),
    });

    expect(await screen.findByRole("link", { name: "RFQ-2026-000412" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quote requests" })).toBeInTheDocument();

    // Scoped to the table: "Contacted" is also one of the filter dropdown's options, and an
    // unscoped `getByText` would match two elements and fail for a reason about the filter bar.
    const table = within(screen.getByRole("table"));
    expect(table.getByText(/premium-california-almonds \(120 kg\)/)).toBeInTheDocument();
    expect(table.getByText("200 kg")).toBeInTheDocument();
    // Rupees: 84500 on the wire is ₹84,500 on the screen, not ₹845.
    expect(table.getByText("₹84,500")).toBeInTheDocument();
    expect(table.getByText("Contacted")).toBeInTheDocument();
  });

  it("labels the prospect's own note and the private sales trail apart", async () => {
    mount(`/rfqs/${RFQ_DETAIL.id}`, {
      [`GET /admin/rfqs/${RFQ_DETAIL.id}`]: () => RFQ_DETAIL,
    });

    /*
     * Awaited on a panel the loaded screen owns, not on the page heading: `<Page title={rfqNumber}>`
     * renders during the pending state too, so the heading is present before the enquiry is.
     */
    expect(await screen.findByText("What the customer wrote")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: RFQ_DETAIL.id })).toBeInTheDocument();

    // The customer's own words, under a heading that says they can see them.
    expect(screen.getByText(/We need vacuum packing for the cashews/)).toBeInTheDocument();
    expect(screen.getByText(/rendered back to them on their enquiry page/)).toBeInTheDocument();

    // The sales trail, under a heading that says nobody else can.
    expect(screen.getAllByText("Internal notes").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Rang the buyer; wants 200kg a month from October."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never shown to the customer and are not reachable/),
    ).toBeInTheDocument();

    /*
     * The decisive one: the only writable note box is the internal one. There is no control
     * anywhere on this screen that writes the customer-visible field, because no endpoint does.
     */
    expect(screen.getByLabelText("New internal note")).toBeInTheDocument();
  });

  it("writes a sales note to the internal endpoint and never to the customer's field", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/rfqs/${RFQ_DETAIL.id}`, {
      [`GET /admin/rfqs/${RFQ_DETAIL.id}`]: () => RFQ_DETAIL,
      [`POST /admin/rfqs/${RFQ_DETAIL.id}/notes`]: () => RFQ_DETAIL,
    });

    await screen.findByLabelText("New internal note");
    await user.type(screen.getByLabelText("New internal note"), "Quoted 410/kg.");
    await user.click(screen.getByRole("button", { name: "Add internal note" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/notes") && call.method === "POST")).toBe(
        true,
      );
    });
    const note = calls.find((call) => call.url.endsWith("/notes"));
    expect(note?.body).toContain("Quoted 410/kg.");
    // Nothing ever PATCHes `notes` — the prospect's field has no admin write path at all.
    expect(
      calls.some((call) => call.method === "PATCH" && (call.body ?? "").includes('"notes"')),
    ).toBe(false);
  });

  it("renders the statuses the server says are allowed when it refuses a move", async () => {
    const user = userEvent.setup();
    mount(`/rfqs/${RFQ_DETAIL.id}`, {
      [`GET /admin/rfqs/${RFQ_DETAIL.id}`]: () => RFQ_DETAIL,
      [`PATCH /admin/rfqs/${RFQ_DETAIL.id}`]: () =>
        apiError(
          422,
          'An RFQ that is "contacted" cannot become "quote-sent".',
          "ILLEGAL_STATUS_TRANSITION",
          // The real 422 payload: `allowed` is the server's own answer about what is legal now.
          { rfqNumber: RFQ_DETAIL.id, from: "contacted", to: "quote-sent", allowed: ["rejected"] },
        ),
    });

    await user.click(await screen.findByRole("button", { name: "Mark Quote Sent" }));

    // Not "that failed": the server already worked out the real choices, so they are rendered.
    expect(await screen.findByText(/The server refused that move/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark Rejected" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Quote Sent" })).toBeNull();
  });

  it("shows a gifting enquiry's boxes rather than a misleading zero kilos", async () => {
    mount(`/rfqs/${GIFTING_RFQ_DETAIL.id}`, {
      [`GET /admin/rfqs/${GIFTING_RFQ_DETAIL.id}`]: () => GIFTING_RFQ_DETAIL,
    });

    expect(await screen.findByText("Gifting brief")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: GIFTING_RFQ_DETAIL.id })).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    // Rupees per box.
    expect(screen.getByText("₹1,200")).toBeInTheDocument();
    expect(screen.getByText(/the gift box is the packaging/)).toBeInTheDocument();
  });

  it("says so when the prospect typed nothing, rather than showing an empty panel", async () => {
    mount(`/rfqs/${GIFTING_RFQ_DETAIL.id}`, {
      [`GET /admin/rfqs/${GIFTING_RFQ_DETAIL.id}`]: () => GIFTING_RFQ_DETAIL,
    });

    expect(
      await screen.findByText(/Nothing was typed into the .additional requirements. box/),
    ).toBeInTheDocument();
  });
});
