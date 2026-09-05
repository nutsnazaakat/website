import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CartLine, CartTotals, Product } from "@/contract";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { SNAPSHOT_KEY } from "@/features/auth/storage";
import type { User } from "@/features/auth/types";
import type { CartState } from "./api";
import { CartProvider, useCart } from "./CartProvider";

/**
 * One retail product, so the optimistic total is a real number rather than zero.
 *
 * That matters for exactly one case below — "replaces its optimistic total with the server's reply".
 * With no catalogue the client's own figure would be 0, and a server figure of anything non-zero
 * would pass whether the provider replaced its guess or merely had none. Priced at ₹299 with 5% GST
 * and the ₹79 flat shipping under the ₹999 threshold, the client's guess for one pack is ₹393 — a
 * number the server's reply must be seen to overwrite.
 */
const almonds = {
  slug: "almonds",
  name: "Almonds",
  category: "almonds",
  gstRate: 5,
  variants: [
    {
      sku: "A-250",
      size: "250g",
      grams: 250,
      channel: "retail",
      price: 299,
      mrp: 349,
      moq: 1,
      available: 40,
      soldOut: false,
    },
  ],
  bulkTiers: [],
  moqKg: 10,
  soldOut: false,
} as unknown as Product;

const OPTIMISTIC_TOTAL_FOR_ONE_PACK = 393;

const totals = (over: Partial<CartTotals> = {}): CartTotals => ({
  subtotal: 0,
  gst: 0,
  shipping: 0,
  total: 0,
  hasQuoteLines: false,
  hasUnpriceableLines: false,
  ...over,
});

const line = (qty: number): CartLine => ({
  id: "r:almonds:250g",
  slug: "almonds",
  mode: "retail",
  size: "250g",
  grams: 250,
  qty,
});

const state = (qty: number): CartState =>
  qty === 0
    ? { lines: [], totals: totals() }
    : {
        lines: [line(qty)],
        totals: totals({ subtotal: 299 * qty, gst: 15 * qty, shipping: 79, total: 393 * qty }),
      };

const asha: User = {
  id: "usr-b2c-001",
  name: "Asha Rao",
  email: "b2c@demo.in",
  phone: "9876543210",
  role: "b2c",
  createdAt: "2025-11-04T09:12:00.000Z",
};

const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });

const failure = (status: number, message: string, code?: string) =>
  new Response(
    JSON.stringify({ success: false, statusCode: status, message, ...(code ? { code } : {}) }),
    { status },
  );

interface Recorder {
  /** Bodies of every `PUT /cart`, in order. */
  puts: { lines: unknown[] }[];
  /** How many `GET /cart` calls have been made. */
  gets: number;
}

interface Handlers {
  /** Answers the nth `GET /cart`. Defaults to an empty basket. */
  cart?: (nth: number) => Promise<Response>;
  /** Answers the nth `PUT /cart`. Defaults to echoing the request back as the stored basket. */
  put?: (body: { lines: unknown[] }, nth: number) => Promise<Response>;
  /** Answers `GET /auth/me`. Defaults to 401 — nobody is signed in. */
  me?: () => Promise<Response>;
}

/**
 * Answers every request the tree makes on mount, routed by URL rather than by call order.
 *
 * Three requests go out on mount — `GET /auth/me`, `GET /cart` and the catalogue — and the order
 * between them is not defined. A `mockResolvedValueOnce` chain therefore cannot express "the second
 * `/cart` call", which is what the optimistic cases need; routing on the URL can.
 */
function install(handlers: Handlers = {}): Recorder {
  const recorder: Recorder = { puts: [], gets: 0 };

  vi.spyOn(globalThis, "fetch").mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/auth/me")) {
        return handlers.me?.() ?? Promise.resolve(failure(401, "Unauthorized"));
      }
      if (url.includes("/auth/logout")) return Promise.resolve(ok(null));
      if (url.includes("/catalog/")) {
        return Promise.resolve(ok({ items: [almonds], total: 1, page: 1, limit: 60 }));
      }
      if (url.includes("/cart") && method === "GET") {
        recorder.gets += 1;
        return handlers.cart?.(recorder.gets) ?? Promise.resolve(ok(state(0)));
      }
      if (url.includes("/cart") && method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { lines: unknown[] };
        recorder.puts.push(body);
        return (
          handlers.put?.(body, recorder.puts.length) ??
          Promise.resolve(ok({ lines: [], totals: totals() }))
        );
      }
      return Promise.reject(new Error(`unexpected ${method} ${url}`));
    },
  );

  return recorder;
}

function Probe() {
  const cart = useCart();
  const { logout } = useAuth();
  return (
    <div>
      <span data-testid="count">{cart.count}</span>
      <span data-testid="total">{cart.totals.total}</span>
      <span data-testid="error">{cart.error ?? ""}</span>
      <button onClick={() => void cart.addRetail("almonds", "250g", 250, 1)}>add</button>
      <button onClick={() => void cart.addBulk("cashews", 10)}>add bulk</button>
      <button onClick={() => void cart.clear()}>clear</button>
      <button onClick={() => void logout()}>sign out</button>
    </div>
  );
}

/**
 * `AuthProvider` and `QueryClientProvider` must both wrap it, and this mirrors the real tree
 * (`providers/AppProviders.tsx` orders them `QueryClientProvider > AuthProvider > CartProvider`).
 *
 * `CartProvider` calls `useAuth()` for the reload-on-identity-change effect, and `useAuth` throws
 * "useAuth must be used inside AuthProvider" — so rendering `<CartProvider>` alone fails every case
 * in this file before any assertion runs. It also reads the catalogue through react-query for the
 * optimistic total, which needs a client in context.
 */
const renderCart = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <CartProvider>
          <Probe />
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
};

describe("CartProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the basket from the server on mount", async () => {
    install({ cart: () => Promise.resolve(ok(state(2))) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
  });

  /**
   * One `GET /cart` per page load, not two.
   *
   * The identity effect runs on mount as well, so a `void cartApi.get()` beside it would fire twice
   * — and which reply wins the race is undefined. This is also the guard against an unmemoised
   * `reload`: it sits in that effect's dependency list, so a fresh identity on every render makes
   * the effect re-fire, which sets state, which re-renders — an unbounded loop of `GET /cart` for as
   * long as the page is open.
   */
  it("fetches the basket exactly once on mount", async () => {
    const recorder = install({ cart: () => Promise.resolve(ok(state(2))) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
    // Long enough for a re-firing effect to show itself; a loop reaches hundreds of calls.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(recorder.gets).toBe(1);
  });

  /**
   * The server's totals are authoritative. `cart-math.ts` accumulates float rupees and rounds once;
   * the server computes per-line GST in paise, so the two can differ by a rupee. The provider must
   * *replace* its optimistic figure with the reply, never keep its own.
   *
   * Asserted across a mutation rather than on the mount fetch, because on mount there is no
   * optimistic figure to replace and the case would pass either way. Here the client's own figure is
   * a real ₹393 and the server answers ₹777, so only a provider that takes the reply can show 777.
   */
  it("replaces its optimistic total with the server's reply", async () => {
    install({
      put: () =>
        Promise.resolve(ok({ lines: [line(1)], totals: totals({ subtotal: 700, total: 777 }) })),
    });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });

    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("777"));
  });

  /**
   * The optimistic window is the client's own arithmetic, and it must not be zero.
   *
   * `puts.length` is asserted alongside the figure on purpose. Without it this case passes against a
   * purely local cart that never talks to the server at all — measured: it was one of two cases in
   * this file that stayed green against the `localStorage` provider — so it would pin the arithmetic
   * while saying nothing about there being a request to be optimistic *about*.
   */
  it("shows its own total while the write is in flight", async () => {
    let release: ((value: Response) => void) | undefined;
    const recorder = install({ put: () => new Promise((resolve) => (release = resolve)) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });

    expect(recorder.puts.length).toBe(1);
    expect(release).toBeDefined();
    expect(screen.getByTestId("total")).toHaveTextContent(String(OPTIMISTIC_TOTAL_FOR_ONE_PACK));
    await act(async () => {
      release?.(ok(state(1)));
    });
  });

  /** Same reason as above for the `puts.length` assertion: a local-only cart passes without it. */
  it("shows the change immediately and does not wait for the round trip", async () => {
    let release: ((value: Response) => void) | undefined;
    const recorder = install({ put: () => new Promise((resolve) => (release = resolve)) });

    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });
    // Optimistic: the count moved before the PUT resolved.
    expect(recorder.puts.length).toBe(1);
    expect(release).toBeDefined();
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    await act(async () => {
      release?.(ok(state(1)));
    });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  });

  /**
   * A rejected write must not leave the UI claiming something is in the basket that is not on the
   * server. Rolling back is less pleasant than pretending, and far less unpleasant than a customer
   * reaching checkout with a basket the server never had.
   */
  it("rolls back an optimistic change when the server refuses it", async () => {
    install({ put: () => Promise.resolve(failure(422, "We no longer stock that.", "NOT_FOUND")) });

    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
    await act(async () => {
      screen.getByText("add").click();
    });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
  });

  /**
   * Rolling the total back too, not only the lines.
   *
   * Without this the basket shows no items and a ₹393 total — and the money is the half a customer
   * reads. It also has to be the *server's last authoritative* figure that comes back, not the
   * client's recomputation of the previous basket, which is why the pre-mutation figure asserted
   * here (₹41) is one the client's own arithmetic would never produce.
   */
  it("rolls the total back to the server's last figure, not to its own recomputation", async () => {
    install({
      cart: () => Promise.resolve(ok({ lines: [], totals: totals({ total: 41 }) })),
      put: () => Promise.resolve(failure(422, "We no longer stock that.", "NOT_FOUND")),
    });

    renderCart();
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("41"));
    await act(async () => {
      screen.getByText("add").click();
    });
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("41"));
  });

  /**
   * Every mutator is fire-and-forget at the call site, so a rejected write goes nowhere visible
   * unless the provider records it. A silent failure here is a customer clicking Add to Cart,
   * seeing nothing happen, and clicking again.
   */
  it("records the server's message so a call site can render it", async () => {
    install({ put: () => Promise.resolve(failure(422, "We no longer stock that.", "NOT_FOUND")) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });

    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("We no longer stock that."),
    );
  });

  it("clears the error on the next successful mutation", async () => {
    install({
      put: (_body, nth) =>
        nth === 1
          ? Promise.resolve(failure(422, "We no longer stock that.", "NOT_FOUND"))
          : Promise.resolve(ok(state(1))),
    });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("stock"));

    await act(async () => {
      screen.getByText("add").click();
    });
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent(""));
  });

  /**
   * `CartLine` is what the server *sends*; `CartLineDto` is what it *accepts*, and `id` and `grams`
   * are absent from it. The pipe runs with `whitelist` **and** `forbidNonWhitelisted`, so they are
   * refused rather than stripped — measured against the running service, every `PUT /cart` carrying
   * a raw `CartLine` answers 400 with `"property id should not exist"`.
   *
   * `tsc` cannot catch it, because `lines` is a variable and excess-property checking does not
   * apply. So the field list is pinned here, exactly, in both directions: the four fields a retail
   * line must carry and the two it must not.
   */
  it("posts the narrowed line shape, without id or grams", async () => {
    const recorder = install({ put: () => Promise.resolve(ok(state(1))) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add").click();
    });

    await waitFor(() => expect(recorder.puts.length).toBe(1));
    expect(recorder.puts[0]).toEqual({
      lines: [{ slug: "almonds", mode: "retail", size: "250g", qty: 1 }],
    });
  });

  it("posts kg rather than size for a bulk line", async () => {
    const recorder = install({ put: () => Promise.resolve(ok(state(0))) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => {
      screen.getByText("add bulk").click();
    });

    await waitFor(() => expect(recorder.puts.length).toBe(1));
    expect(recorder.puts[0]).toEqual({
      lines: [{ slug: "cashews", mode: "bulk", kg: 10, qty: 1 }],
    });
  });

  it("sends an empty basket when the cart is cleared", async () => {
    const recorder = install({ cart: () => Promise.resolve(ok(state(2))) });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

    await act(async () => {
      screen.getByText("clear").click();
    });

    await waitFor(() => expect(recorder.puts.length).toBe(1));
    expect(recorder.puts[0]).toEqual({ lines: [] });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
  });

  /**
   * A reply that has been overtaken must be discarded.
   *
   * `/order-success/$id` calls `clear()` in a mount effect, so the emptying `PUT` and the mount
   * `GET` are in flight together. If the `GET` reply is applied after the `PUT` has emptied the
   * basket, the page shows the basket it just cleared — and the next add-to-cart writes those lines
   * back to the server. Task 23 found the same shape on the backend: overlapping writes left three
   * copies of one line.
   */
  it("ignores a load that a later write has overtaken", async () => {
    let releaseGet: ((value: Response) => void) | undefined;
    install({
      cart: () => new Promise((resolve) => (releaseGet = resolve)),
      put: () => Promise.resolve(ok(state(0))),
    });

    renderCart();
    await waitFor(() => expect(releaseGet).toBeDefined());

    // The basket is emptied while the load is still outstanding.
    await act(async () => {
      screen.getByText("clear").click();
    });

    await act(async () => {
      releaseGet?.(ok(state(2)));
    });

    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  /**
   * Watching `userId` — a **string** — rather than the `user` object.
   *
   * `AuthProvider` holds `user` in `useState(() => readSnapshot())`, so it is populated
   * synchronously on the first render, and its `GET /auth/me` validation then sets a *different
   * object with the same id*. On the object that is a changed dependency and refetches the cart for
   * nothing; on the id it is not.
   */
  it("does not refetch when /auth/me returns a new object for the same account", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(asha));
    const recorder = install({ me: () => Promise.resolve(ok({ ...asha })) });

    renderCart();
    await waitFor(() => expect(recorder.gets).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(recorder.gets).toBe(1);
  });

  /**
   * Sign-out is the direction that is easy to miss. The account's cart is no longer reachable and
   * the customer reverts to a fresh guest cart; without a refetch the browser keeps displaying the
   * signed-out user's basket, and the next add-to-cart writes it into a guest cart that never had
   * those lines.
   */
  it("reloads the basket when the customer signs out", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(asha));
    const recorder = install({
      me: () => Promise.resolve(ok({ ...asha })),
      cart: (nth) => Promise.resolve(ok(state(nth === 1 ? 2 : 0))),
    });

    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));

    await act(async () => {
      screen.getByText("sign out").click();
    });

    await waitFor(() => expect(recorder.gets).toBe(2));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
  });

  /**
   * `GET /cart` is a public route, so a 401 is impossible on it and any failure is a real one. It
   * belongs in `error` rather than being swallowed, or a customer whose basket failed to load sees
   * an empty cart and no reason for it.
   */
  it("reports a failed load rather than showing an empty basket silently", async () => {
    install({ cart: () => Promise.resolve(failure(500, "Something went wrong.")) });
    renderCart();
    await waitFor(() =>
      expect(screen.getByTestId("error")).toHaveTextContent("Something went wrong."),
    );
  });
});
