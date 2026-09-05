import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createQueryClient } from "@/app/query-client";
import { AppProviders, createAppRouter } from "@/app/router";

/**
 * The console driven against the **real backend**, real Postgres and real seed data.
 *
 * Not part of `npm test`: `vite.config.ts` excludes `*.integration.tsx`, and
 * `vitest.live.config.ts` includes only those. It needs a service on :4400 and a seeded database.
 * Kept rather than deleted after plan 9.6a's verification, because what it checks cannot be checked
 * any other way — a suite that has only ever spoken to a stub agrees with whatever the stub was
 * written to believe. Every shape in `src/test/server.ts` was measured against this service, and
 * this file is what keeps that true as the API moves.
 *
 *   cd ~/Desktop/nutwala-backend && npm run db:up && npm run migration:run && npm run seed && npm run dev
 *   cd ~/Desktop/nutwala-admin   && npm run test:live
 *
 * **Two things to know before running it twice.**
 *
 * 1. **It mutates the database** — case 3 transitions a real order from `out-for-delivery` to
 *    `delivered`, which is a one-way move. Re-seed between runs: `npm run seed` rewrites each
 *    order's status, items, events and payments.
 * 2. **`POST /auth/login` is throttled at 5 per 15 minutes per IP.** This suite therefore signs in
 *    exactly **twice** — once as the admin, once as the customer — and shares the admin session
 *    across the four cases that need it. A file that signed in per case would rate-limit itself on
 *    the second run and report five failures that look like application bugs and are not.
 *    (Measured: that is exactly what happened first time.) The throttler's storage is in-memory, so
 *    restarting the backend clears it.
 */

const API = "http://localhost:4400/api/v1";
const ADMIN = { email: "admin@demo.in", password: "Password123!" };
const CUSTOMER = { email: "b2c@demo.in", password: "Password123!" };

/** Seeded `out-for-delivery`; its only legal successor is `delivered`. */
const MOVEABLE_ORDER = "NN-2026-005107";
/** Seeded `refunded`, which is terminal — so its `allowed` list is empty, and that is an answer. */
const TERMINAL_ORDER = "NN-2026-004650";

/**
 * A cookie jar, because node's `fetch` has none.
 *
 * The browser keeps `nn_access_token`, `nn_refresh_token` and `nn_csrf` and replays them on its
 * own. Here they have to be captured off `set-cookie` and sent back, and `nn_csrf` additionally
 * written into `document.cookie` — that is the one the application reads, in `http.ts`, to echo as
 * `X-CSRF-Token`. Getting that wrong is a 403 on every write, which is the class of failure this
 * file exists to catch.
 */
const jar = new Map<string, string>();
let realFetch: typeof globalThis.fetch;

function clearSession(): void {
  jar.clear();
  document.cookie = "nn_csrf=; path=/; max-age=0";
}

beforeAll(() => {
  // Fails loudly rather than producing a suite of confusing 404s against a relative URL.
  expect(import.meta.env.VITE_API_URL).toBe(API);

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) {
      headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await realFetch(input, { ...init, headers });

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "") jar.delete(name);
      else jar.set(name, value);
      if (name === "nn_csrf") document.cookie = `nn_csrf=${value}; path=/`;
    }
    return response;
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  clearSession();
});

afterEach(() => {
  cleanup();
});

function mount(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppProviders router={router} queryClient={createQueryClient()} />);
  return router;
}

async function signInThroughTheForm(as: { email: string; password: string }) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), as.email);
  await user.type(screen.getByLabelText("Password"), as.password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("against the live backend", () => {
  it("1. signs the admin fixture in through the form and lands on the dashboard", async () => {
    clearSession();
    mount("/login");
    await signInThroughTheForm(ADMIN);

    expect(await screen.findByText("Total Sales", {}, { timeout: 15_000 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Console" });
    expect(within(nav).getByText("Nazaakat Admin")).toBeInTheDocument();
    expect(within(nav).getByText("admin@demo.in")).toBeInTheDocument();

    // Real figures out of real SQL. Asserted as a shape rather than a value, because the database
    // moves: a rupee amount, never `NaN`, and never the paise-sized integer that a double
    // conversion would produce.
    const card = screen.getByText("Total Sales").parentElement;
    expect(card?.textContent).toMatch(/₹[\d,.]+(K|L|Cr)?/);
    expect(screen.queryByText(/NaN/)).toBeNull();

    for (const chart of ["Sales over time", "B2C vs B2B", "Top products", "Top categories"]) {
      expect(screen.getByRole("heading", { name: chart })).toBeInTheDocument();
    }
  });

  it("2. lists real orders with brief §33's columns", async () => {
    // Reuses case 1's session rather than signing in again — see the throttle note above.
    mount("/orders");

    const table = await screen.findByRole(
      "table",
      { name: "Orders, newest first" },
      { timeout: 15_000 },
    );
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
    // Real seeded order numbers, so the table is not passing vacuously on zero rows.
    const rows = within(table).getAllByRole("link", { name: /^NN-\d{4}-\d{6}$/ });
    expect(rows.length).toBeGreaterThan(0);
  });

  it("3. changes a real order's status through the real endpoint", async () => {
    mount(`/orders/${MOVEABLE_ORDER}`);

    const button = await screen.findByRole(
      "button",
      { name: "Mark Delivered" },
      { timeout: 15_000 },
    );
    await userEvent.setup().click(button);

    // `delivered` has exactly one successor of its own, so the panel re-offering it is proof the
    // write landed and the re-read order came back carrying the new status.
    expect(
      await screen.findByRole("button", { name: "Mark Refunded" }, { timeout: 15_000 }),
    ).toBeInTheDocument();

    // And the server agrees, independently of what this app is rendering.
    const check = await fetch(`${API}/admin/orders/${MOVEABLE_ORDER}`);
    const body = (await check.json()) as { data: { status: string } };
    expect(body.data.status).toBe("delivered");
  });

  it("4. is refused an illegal transition with the `allowed` list the screen renders", async () => {
    // Driven at the API rather than through the UI, because the UI correctly never offers an
    // illegal move — so the only honest way to exercise the 422 path against the real service is to
    // ask it for one. This pins the shape `allowedTransitionsFrom` reads.
    const csrf = jar.get("nn_csrf") ?? "";
    expect(csrf).not.toBe("");

    const refused = await fetch(`${API}/admin/orders/${TERMINAL_ORDER}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ status: "delivered" }),
    });
    const body = (await refused.json()) as {
      code: string;
      details: { from: string; allowed: string[] };
    };

    expect(refused.status).toBe(422);
    expect(body.code).toBe("ILLEGAL_STATUS_TRANSITION");
    expect(body.details.from).toBe("refunded");
    // An empty array is a real answer, not a missing one: the order is terminal.
    expect(body.details.allowed).toEqual([]);
  });

  it("5. refuses the b2c fixture with an explanation and leaves its session alone", async () => {
    clearSession();
    mount("/login");
    await signInThroughTheForm(CUSTOMER);

    expect(
      await screen.findByRole(
        "heading",
        { name: "This account cannot use the admin console." },
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("(b2c@demo.in)")).toBeInTheDocument();

    // The decisive part: their session really is still valid. A 403 means *this account cannot*,
    // not *your session expired*, and nothing signed them out on their behalf.
    const me = await fetch(`${API}/auth/me`);
    expect(me.status).toBe(200);

    // And the server does refuse them the admin surface, which is why the screen must explain
    // rather than navigate.
    const admin = await fetch(`${API}/admin/dashboard`);
    expect(admin.status).toBe(403);
  });
});
