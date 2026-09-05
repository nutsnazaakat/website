import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueryClient } from "@/app/query-client";
import { AppProviders, createAppRouter } from "@/app/router";
import {
  APPROVED_REVIEW,
  AUDIT_ENTRIES,
  DRAFT_POST,
  FRESH_COUPON,
  PENDING_REVIEW,
  PUBLISHED_POST,
  REDEEMED_COUPON,
  SETTINGS,
  TICKET_DETAIL,
  TICKET_SUMMARY,
} from "@/test/operations-fixtures";
import { ADMIN_USER, apiError, installApi, page, type Recorded } from "@/test/server";

/**
 * The operations screens — coupons, reviews, the blog, support, settings and the audit log —
 * **mounted through the real router**, asserting on content *inside* each route.
 *
 * Every case waits for something only the loaded screen can produce, never for the page heading:
 * `<Page title=…>` renders during the pending state too, so a heading assertion resolves against a
 * skeleton and everything after it races the fetch.
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

describe("/coupons", () => {
  it("lists brief §36's levers, in rupees", async () => {
    mount("/coupons", {
      "GET /admin/coupons": () => page([REDEEMED_COUPON, FRESH_COUPON]),
    });

    expect(await screen.findByText("DIWALI25")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    // A percentage with its cap, and a flat amount — both read straight off the wire.
    expect(table.getByText("25% off, capped at ₹500")).toBeInTheDocument();
    expect(table.getByText("₹500 off")).toBeInTheDocument();
    expect(table.getByText(/Min ₹2,000/)).toBeInTheDocument();
    expect(table.getByText(/First order only/)).toBeInTheDocument();
  });

  it("renders the redemption count when a delete is refused, and offers switching off instead", async () => {
    const user = userEvent.setup();
    mount("/coupons", {
      "GET /admin/coupons": () => page([REDEEMED_COUPON]),
      "DELETE /admin/coupons/DIWALI25": () =>
        apiError(
          409,
          "This coupon has been redeemed, and its redemption history must outlive it. Switch it off with isActive instead.",
          "ENTITY_IN_USE",
          { code: "DIWALI25", redemptions: 14 },
        ),
    });

    await screen.findByText("DIWALI25");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    /*
     * A refusal is a normal case to render, not an error to hide. The count is what turns "delete
     * failed" into an instruction: fourteen orders reference this code, so switching it off is the
     * operation that was actually wanted.
     */
    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent("redeemed 14 times");
    expect(refusal).toHaveTextContent("Switch it off instead");
    expect(screen.getByRole("button", { name: "Switch off" })).toBeInTheDocument();
  });

  it("freezes the code when editing, because three things key on it", async () => {
    const user = userEvent.setup();
    mount("/coupons", {
      "GET /admin/coupons": () => page([REDEEMED_COUPON]),
    });

    await screen.findByText("DIWALI25");
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const code = await screen.findByLabelText("Code");
    expect(code).toBeDisabled();
    expect(code).toHaveValue("DIWALI25");
    expect(
      screen.getByText(/The code cannot be changed once the coupon exists/),
    ).toBeInTheDocument();
    // And a past expiry is a legitimate way to end a campaign, not an error to prevent.
    expect(screen.getByText(/An expiry in the past is/)).toBeInTheDocument();
  });

  it("sends both sides of the discount so a type change cannot trip the check constraint", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/coupons", {
      "GET /admin/coupons": () => page([REDEEMED_COUPON]),
      "PATCH /admin/coupons/DIWALI25": () => REDEEMED_COUPON,
    });

    await screen.findByText("DIWALI25");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Code");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
    const body = JSON.parse(calls.find((call) => call.method === "PATCH")?.body ?? "{}") as Record<
      string,
      unknown
    >;
    // Both fields on every save, the unused one explicitly null. A bare `{"type":"flat"}` would
    // reach `ck_coupons_value_exclusive` with the percentage still set, and surface as a 500.
    expect(body).toMatchObject({ type: "percent", percentValue: 25, flatValue: null });
    // Never the code: `UpdateCouponDto` omits it.
    expect(body).not.toHaveProperty("code");
  });
});

describe("/reviews", () => {
  it("opens on the pending queue and offers no “all statuses” it cannot serve", async () => {
    const { calls } = mount("/reviews", {
      "GET /admin/reviews": () => page([PENDING_REVIEW]),
    });

    expect(await screen.findByText(/Fresh and crunchy/)).toBeInTheDocument();
    expect(screen.getByText("Meera Iyer")).toBeInTheDocument();
    expect(screen.getByText("Verified purchase")).toBeInTheDocument();

    // The endpoint always filters on exactly one status and defaults to pending, so an "All"
    // option would be a label promising something the API cannot answer.
    const queue = screen.getByLabelText("Queue");
    expect(within(queue).queryByText(/All/)).toBeNull();
    expect(queue).toHaveValue("pending");
    // Nothing is sent for the default, because the default is the server's.
    expect(calls.some((call) => call.url.includes("status="))).toBe(false);
  });

  it("approves a review and says that this is what publishes it", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/reviews", {
      "GET /admin/reviews": () => page([PENDING_REVIEW]),
      [`POST /admin/reviews/${PENDING_REVIEW.id}/approve`]: () => APPROVED_REVIEW,
    });

    await screen.findByText(/Fresh and crunchy/);
    expect(screen.getByText(/adds its rating to the public average/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/approve"))).toBe(true);
    });
  });

  it("asks for a reason before rejecting, and keeps it for the next moderator", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/reviews", {
      "GET /admin/reviews": () => page([PENDING_REVIEW]),
      [`POST /admin/reviews/${PENDING_REVIEW.id}/reject`]: () => APPROVED_REVIEW,
    });

    await screen.findByText(/Fresh and crunchy/);
    await user.click(screen.getByRole("button", { name: "Reject" }));

    const reason = await screen.findByLabelText("Reason (optional)");
    // Said out loud on the control, because a moderator would otherwise reasonably assume the
    // author is told why.
    expect(reason).toHaveAttribute("placeholder", expect.stringContaining("never shown"));

    await user.type(reason, "Mentions a competitor.");
    await user.click(screen.getByRole("button", { name: "Confirm reject" }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/reject"))).toBe(true);
    });
    expect(calls.find((call) => call.url.endsWith("/reject"))?.body).toContain(
      "Mentions a competitor.",
    );
  });
});

describe("/blog", () => {
  it("lists drafts alongside published posts, which the public list does not", async () => {
    mount("/blog", {
      "GET /admin/posts": () => page([PUBLISHED_POST, DRAFT_POST]),
    });

    expect(await screen.findByText("How to Store Dry Fruits at Home")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("W320 vs W240 Cashews: What's the Difference?")).toBeInTheDocument();
    /*
     * Queried by the badges' own titles rather than by the word "Published", which is also a column
     * header — and asserting on the header would pass against a table with no rows in it.
     */
    expect(table.getByTitle("Live on the public blog.")).toHaveTextContent("Published");
    expect(table.getByTitle(/The public list filters drafts out/)).toHaveTextContent("Draft");
    // A draft has never gone live, so its publication date is not a date.
    expect(table.getByText("Never")).toBeInTheDocument();
  });

  it("warns before a published post's slug change breaks the live URL, and saves nothing first", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/blog?edit=${PUBLISHED_POST.slug}`, {
      "GET /admin/posts": () => page([PUBLISHED_POST]),
      [`PATCH /admin/posts/${PUBLISHED_POST.slug}`]: () => PUBLISHED_POST,
    });

    const slug = await screen.findByLabelText("Slug");
    await user.clear(slug);
    await user.type(slug, "storing-dry-fruits");
    await user.click(screen.getByRole("button", { name: "Save…" }));

    // The warning names both URLs, because the point is *which link dies*.
    expect(
      await screen.findByText("This changes a live URL, and the old one will 404."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\/blog\/how-to-store-dry-fruits-at-home stops resolving/),
    ).toBeInTheDocument();
    expect(screen.getByText(/no redirect table/)).toBeInTheDocument();

    // Decisive: the interrupted save wrote nothing. A warning that fires after the request would
    // be an apology, not a warning.
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    // And it is an interruption, not a veto — the operator may have a good reason.
    await user.click(screen.getByRole("button", { name: "Save anyway, and break the old URL" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
  });

  it("changes a draft's slug without a warning, because nothing has ever linked to it", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/blog?edit=${DRAFT_POST.slug}`, {
      "GET /admin/posts": () => page([DRAFT_POST]),
      [`PATCH /admin/posts/${DRAFT_POST.slug}`]: () => DRAFT_POST,
    });

    const slug = await screen.findByLabelText("Slug");
    await user.clear(slug);
    await user.type(slug, "w320-vs-w240");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
    expect(screen.queryByText(/This changes a live URL/)).toBeNull();
  });
});

describe("/support", () => {
  it("lists the queue and marks the order number as the customer's own claim", async () => {
    mount("/support", {
      "GET /admin/support/tickets": () => page([TICKET_SUMMARY]),
    });

    expect(await screen.findByRole("link", { name: "ST-2026-000318" })).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Vikram Shah")).toBeInTheDocument();
    expect(table.getByText("NN-2026-005107")).toBeInTheDocument();
    expect(table.getByText("P1")).toBeInTheDocument();
    // The "not" is inside a `<strong>`, and `getByText` reads only an element's own text nodes.
    expect(screen.getByText(/checked against the orders table/)).toBeInTheDocument();
  });

  it("renders one ticket, its message and its note trail", async () => {
    mount(`/support/${TICKET_DETAIL.ticketNumber}`, {
      [`GET /admin/support/tickets/${TICKET_DETAIL.ticketNumber}`]: () => TICKET_DETAIL,
    });

    expect(await screen.findByText("The message")).toBeInTheDocument();
    expect(screen.getByText(/nothing arrived yesterday/)).toBeInTheDocument();
    expect(screen.getByText("Courier says reattempt today.")).toBeInTheDocument();
    // The resolution date follows the status and cannot be typed.
    expect(screen.getByText("Not resolved")).toBeInTheDocument();
    expect(screen.getByText(/Moving it back to an open state clears it again/)).toBeInTheDocument();
  });

  it("triages a ticket and adds an internal note that is never sent to the customer", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/support/${TICKET_DETAIL.ticketNumber}`, {
      [`GET /admin/support/tickets/${TICKET_DETAIL.ticketNumber}`]: () => TICKET_DETAIL,
      [`PATCH /admin/support/tickets/${TICKET_DETAIL.ticketNumber}`]: () => TICKET_DETAIL,
      [`POST /admin/support/tickets/${TICKET_DETAIL.ticketNumber}/notes`]: () => TICKET_DETAIL,
    });

    await screen.findByText("The message");
    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
    expect(calls.find((call) => call.method === "PATCH")?.body).toContain('"status":"open"');

    await user.type(screen.getByLabelText("New internal note"), "Reattempt booked.");
    await user.click(screen.getByRole("button", { name: "Add internal note" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/notes"))).toBe(true);
    });
    // `isInternal` is never sent, so the column's `true` default stands — a note written today
    // cannot be published retrospectively if customer-visible replies ever ship.
    expect(calls.find((call) => call.url.endsWith("/notes"))?.body).not.toContain("isInternal");
  });
});

describe("/settings", () => {
  it("says that an empty field is the correct state, not a missing one", async () => {
    mount("/settings", {
      "GET /admin/settings": () => SETTINGS,
    });

    expect(await screen.findByText(/An empty field here is a real answer./)).toBeInTheDocument();
    expect(screen.getByText(/brief §26 and §37 forbid inventing them/)).toBeInTheDocument();

    // The five the storefront is actually waiting for are present and blank.
    expect(screen.getByLabelText("WhatsApp number")).toHaveValue("");
    expect(screen.getByLabelText("GSTIN")).toHaveValue("");
    expect(screen.getByLabelText("FSSAI licence number")).toHaveValue("");
    expect(screen.getByLabelText("Certifications")).toHaveValue("");
  });

  it("names the timezone as the thing that changes every dated admin figure", async () => {
    mount("/settings", {
      "GET /admin/settings": () => SETTINGS,
    });

    expect(await screen.findByLabelText("Business timezone")).toHaveValue("Asia/Kolkata");
    expect(screen.getByText(/decides what .today. means/)).toBeInTheDocument();
    // Reported, and not editable: it says whether the storefront may read the row.
    expect(screen.getAllByText("Private").length).toBe(1);
  });

  it("sends only the keys that changed, so the audit trail stays readable", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/settings", {
      "GET /admin/settings": () => SETTINGS,
      "PUT /admin/settings": () => SETTINGS,
    });

    const whatsapp = await screen.findByLabelText("WhatsApp number");
    await user.type(whatsapp, "919876543210");
    await user.click(screen.getByRole("button", { name: "Save 1 change" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PUT")).toBe(true);
    });
    const body = JSON.parse(calls.find((call) => call.method === "PUT")?.body ?? "{}") as {
      settings: { key: string; value: unknown }[];
    };
    // One entry, not the whole table: the server writes one audit row per key that changed.
    expect(body.settings).toEqual([{ key: "whatsappNumber", value: "919876543210" }]);
  });

  it("renders an unknown key the server refused, rather than reporting a failed save", async () => {
    const user = userEvent.setup();
    mount("/settings", {
      "GET /admin/settings": () => SETTINGS,
      "PUT /admin/settings": () =>
        apiError(
          404,
          "No such setting. A new setting is added by the seed, alongside the code that reads it.",
          "NOT_FOUND",
          { keys: ["whatsappNumber"] },
        ),
    });

    await user.type(await screen.findByLabelText("WhatsApp number"), "919876543210");
    await user.click(screen.getByRole("button", { name: "Save 1 change" }));

    expect(await screen.findByText("The server does not have those settings.")).toBeInTheDocument();
    expect(screen.getByText(/Refused: whatsappNumber/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing in this save was written/)).toBeInTheDocument();
  });
});

describe("/audit-logs", () => {
  it("says stock movements are absent before showing a table that lacks them", async () => {
    mount("/audit-logs", {
      "GET /admin/audit-logs": () => page(AUDIT_ENTRIES),
    });

    expect(await screen.findByText("Stock movements are not in this trail.")).toBeInTheDocument();
    expect(
      screen.getByText(/the reason, the resulting balance and who made it/),
    ).toBeInTheDocument();
    // And it points at where they actually are. Scoped to `<main>`, because the sidebar carries an
    // "Inventory" link of its own and an unscoped query would match the shell rather than the page.
    expect(
      within(screen.getByRole("main")).getByRole("link", { name: "Inventory" }),
    ).toBeInTheDocument();
  });

  it("renders each row's before and after, including a delete that has no after", async () => {
    mount("/audit-logs", {
      "GET /admin/audit-logs": () => page(AUDIT_ENTRIES),
    });

    const table = within(await screen.findByRole("table"));
    expect(table.getByText("coupon.delete")).toBeInTheDocument();
    // Twice: as the row's entity id, and as the `code` inside the deleted row's `before` snapshot —
    // which is the only place that row survives at all.
    expect(table.getAllByText("SUMMER5")).toHaveLength(2);
    // A setting change shows both sides; an empty string is named rather than rendered as a gap.
    expect(table.getByText("(empty)")).toBeInTheDocument();
    expect(table.getByText("919876543210")).toBeInTheDocument();
  });

  it("keeps its date bounds as whole days, never as instants", async () => {
    const { calls } = mount("/audit-logs?from=2026-08-01&to=2026-08-31", {
      "GET /admin/audit-logs": () => page(AUDIT_ENTRIES),
    });

    await screen.findByRole("table");
    const request = calls.find((call) => call.url.includes("/admin/audit-logs"));
    // Date-only: the service resolves these in the business timezone. An instant computed here
    // would reintroduce the browser's timezone as a second answer to "what day is it".
    expect(request?.url).toContain("from=2026-08-01");
    expect(request?.url).toContain("to=2026-08-31");
    expect(request?.url).not.toContain("T00%3A00");
  });
});
