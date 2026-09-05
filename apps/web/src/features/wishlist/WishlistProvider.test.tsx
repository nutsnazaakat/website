import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { SNAPSHOT_KEY } from "@/features/auth/storage";
import type { User } from "@/features/auth/types";
import { useSavedProducts } from "./hooks/useWishlist";
import { useWishlist, WishlistProvider } from "./WishlistProvider";

const ALMONDS = "premium-california-almonds";
const CASHEWS = "w320-cashews";

const asha: User = {
  id: "usr-b2c-001",
  name: "Asha Rao",
  email: "b2c@demo.in",
  phone: "9876543210",
  role: "b2c",
  createdAt: "2025-11-04T09:12:00.000Z",
};

/** `auth-api.stub.ts`'s envelope, so `lib/http` unwraps these exactly as it unwraps the server's. */
const ok = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });

const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, statusCode: status, message }), { status });

interface Recorder {
  /** Slugs of every `POST /wishlist/:slug`, in order. */
  posts: string[];
  /** Slugs of every `DELETE /wishlist/:slug`, in order. */
  deletes: string[];
  /** How many `GET /wishlist/slugs` calls have been made. */
  reads: number;
  /** How many `GET /wishlist` calls have been made — the priced products, for `/wishlist`. */
  productReads: number;
}

interface Handlers {
  /** Answers the nth `GET /wishlist/slugs`. Defaults to an empty set. */
  read?: (nth: number) => Promise<Response>;
  /** Answers a `POST`. Defaults to the previous set plus the slug. */
  post?: (slug: string) => Promise<Response>;
  /** Answers a `DELETE`. Defaults to the previous set minus the slug. */
  remove?: (slug: string) => Promise<Response>;
  /** Answers `GET /auth/me`. Defaults to 401 — nobody is signed in. */
  me?: () => Promise<Response>;
}

/**
 * Answers every request the tree makes, routed by URL rather than by call order.
 *
 * Two go out on mount — `GET /auth/me` and `GET /wishlist/slugs` — and the order between them is not
 * defined, so a `mockResolvedValueOnce` chain cannot express "the second membership read", which is
 * what the sign-out case needs. `useAuth` throws outside `AuthProvider`, so `/auth/me` has to be
 * answered by *this* mock: a second stub on `globalThis.fetch` would make the file depend on
 * installation order.
 *
 * The default `POST`/`DELETE` maintain a real set, so a toggle behaves like the server's idempotent
 * insert rather than echoing whatever it was sent.
 */
function install(handlers: Handlers = {}): Recorder {
  const recorder: Recorder = { posts: [], deletes: [], reads: 0, productReads: 0 };
  let saved: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes("/auth/me")) {
        return handlers.me?.() ?? Promise.resolve(failure(401, "Unauthorized"));
      }
      if (url.includes("/auth/logout")) return Promise.resolve(ok(null));

      if (url.endsWith("/wishlist/slugs")) {
        recorder.reads += 1;
        return handlers.read?.(recorder.reads) ?? Promise.resolve(ok({ slugs: saved }));
      }

      if (url.endsWith("/wishlist") && method === "GET") {
        recorder.productReads += 1;
        return Promise.resolve(ok([]));
      }

      const slug = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));

      if (method === "POST") {
        recorder.posts.push(slug);
        if (handlers.post) return handlers.post(slug);
        if (!saved.includes(slug)) saved = [slug, ...saved];
        return Promise.resolve(ok({ slugs: saved }));
      }

      if (method === "DELETE") {
        recorder.deletes.push(slug);
        if (handlers.remove) return handlers.remove(slug);
        saved = saved.filter((entry) => entry !== slug);
        return Promise.resolve(ok({ slugs: saved }));
      }

      return Promise.reject(new Error(`unexpected ${method} ${url}`));
    },
  );

  return recorder;
}

function Probe() {
  const { has, toggle, count, isLoading, error } = useWishlist();
  const { logout } = useAuth();
  return (
    <div>
      {/*
       * "yes"/"no" rather than "saved"/"not saved", and that is not cosmetic. `toHaveTextContent`
       * matches a **substring**, so `toHaveTextContent("yes")` is satisfied by "not saved" —
       * measured: with the optimistic `commit` deleted outright, "fills the heart before the server
       * has answered" still passed. Two tokens where neither contains the other is what makes the
       * assertions below able to fail.
       */}
      <span data-testid="almonds">{has(ALMONDS) ? "yes" : "no"}</span>
      <span data-testid="cashews">{has(CASHEWS) ? "yes" : "no"}</span>
      <span data-testid="count">{count}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="error">{error ?? ""}</span>
      <button onClick={() => void toggle(ALMONDS)}>toggle almonds</button>
      <button onClick={() => void logout()}>sign out</button>
    </div>
  );
}

/**
 * `/wishlist`'s own subscription to the priced products, mounted only by the case about invalidation.
 *
 * Kept out of `Probe` deliberately: the provider must *not* fetch the products itself, and the case
 * that pins that reads the request log, so a subscription in the default tree would defeat it.
 */
function SavedProducts() {
  const { data } = useSavedProducts();
  return <span data-testid="products">{data?.length ?? -1}</span>;
}

/**
 * The real tree's order, from `providers/AppProviders.tsx`.
 *
 * `WishlistProvider` calls `useAuth()` for its reload-on-identity-change effect and
 * `useQueryClient()` to invalidate the saved-products query, so rendering it alone fails every case
 * here before an assertion runs — "useAuth must be used inside AuthProvider" and "No QueryClient
 * set" respectively. `CartProvider` is absent because nothing in either direction reads the other.
 */
const renderWishlist = ({ withProducts = false } = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <WishlistProvider>
          <Probe />
          {withProducts && <SavedProducts />}
        </WishlistProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
};

const almonds = () => screen.getByTestId("almonds");

describe("WishlistProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the saved set from the server on mount", async () => {
    install({ read: () => Promise.resolve(ok({ slugs: [ALMONDS] })) });
    renderWishlist();
    await waitFor(() => expect(almonds()).toHaveTextContent("yes"));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });

  /**
   * Membership on mount, not the full products. `GET /wishlist` runs the catalogue mapper over every
   * saved row to price and name it; the heart needs one indexed column. Every page renders hearts, so
   * reading the wrong one is a per-page-load cost paid to colour an icon.
   */
  it("reads membership rather than the priced products", async () => {
    install();
    renderWishlist();
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    const paths = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => (typeof input === "string" ? input : input.toString()));
    expect(paths).toContain("/api/v1/wishlist/slugs");
    expect(paths).not.toContain("/api/v1/wishlist");
  });

  /**
   * One read per page load, not two — and the guard against an unmemoised `reload`, which sits in the
   * identity effect's dependency list: a fresh identity every render re-fires the effect, which sets
   * state, which re-renders, an unbounded loop of requests for as long as the page is open.
   */
  it("fetches membership exactly once on mount", async () => {
    const recorder = install({ read: () => Promise.resolve(ok({ slugs: [ALMONDS] })) });
    renderWishlist();
    await waitFor(() => expect(almonds()).toHaveTextContent("yes"));
    // Long enough for a re-firing effect to show itself; a loop reaches hundreds of calls.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(recorder.reads).toBe(1);
  });

  /**
   * The heart responds to the click, not to the round trip.
   *
   * `posts.length` is asserted alongside the fill on purpose: without it the case passes against a
   * purely local toggle that never talks to the server at all — which is precisely the bug this
   * feature exists to fix, so a test that cannot tell the two apart is worthless here.
   */
  it("fills the heart before the server has answered", async () => {
    let release: ((value: Response) => void) | undefined;
    const recorder = install({ post: () => new Promise((resolve) => (release = resolve)) });
    renderWishlist();
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });

    expect(recorder.posts).toEqual([ALMONDS]);
    expect(almonds()).toHaveTextContent("yes");

    await act(async () => {
      release?.(ok({ slugs: [ALMONDS] }));
    });
    expect(almonds()).toHaveTextContent("yes");
  });

  /**
   * An optimistic toggle that cannot fail is a lie: the customer would see a filled heart and find
   * nothing in their list. The rollback is the honest signal, and `error` is what lets a page say
   * why — the card calls `void toggle(slug)`, so the rejection has nowhere else to go.
   */
  it("rolls back the heart when the server refuses the save", async () => {
    install({ post: () => Promise.resolve(failure(503, "Could not save that just now.")) });
    renderWishlist();
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });

    await waitFor(() => expect(almonds()).toHaveTextContent("no"));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.getByTestId("error")).toHaveTextContent("Could not save that just now.");
  });

  /**
   * A refused *unsave* has to roll back the same way, which is the direction with teeth: the
   * optimistic state here is "gone", so a provider that only restored on the add path would leave the
   * customer looking at a product they still have saved, told it is not.
   */
  it("rolls back an unsave the server refuses, restoring what was there", async () => {
    install({
      read: () => Promise.resolve(ok({ slugs: [ALMONDS] })),
      remove: () => Promise.resolve(failure(503, "Could not update your list.")),
    });
    renderWishlist();
    await waitFor(() => expect(almonds()).toHaveTextContent("yes"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });

    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Could not update"));
    expect(almonds()).toHaveTextContent("yes");
  });

  /**
   * The server's set is authoritative, exactly as the cart takes the server's totals.
   *
   * Asserted with a reply the client could not have computed — the customer saved cashews in another
   * tab — so only a provider that *replaces* its set can show both. A provider that merely trusted
   * its own optimistic flip would show one.
   */
  it("replaces its optimistic set with the server's reply", async () => {
    install({ post: () => Promise.resolve(ok({ slugs: [ALMONDS, CASHEWS] })) });
    renderWishlist();
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });

    await waitFor(() => expect(screen.getByTestId("cashews")).toHaveTextContent("yes"));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
  });

  /** The second click unsaves. A toggle that only ever POSTed would fill a heart for ever. */
  it("deletes on the second click rather than saving twice", async () => {
    const recorder = install();
    renderWishlist();
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });
    await waitFor(() => expect(almonds()).toHaveTextContent("yes"));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });
    await waitFor(() => expect(almonds()).toHaveTextContent("no"));

    expect(recorder.posts).toEqual([ALMONDS]);
    expect(recorder.deletes).toEqual([ALMONDS]);
  });

  /**
   * Signing out must stop displaying the account's saved list.
   *
   * The easy half of the identity effect to forget, and the one with a privacy edge: the next person
   * at a shared browser would otherwise see the previous customer's hearts, and the next save would
   * be written against a guest key that never had them. The second read answers as a guest, so only
   * a provider that re-reads on the identity change can show an empty set.
   */
  it("stops showing the account's saved list on sign-out", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(asha));
    const recorder = install({
      me: () => Promise.resolve(ok(asha)),
      read: (nth) => Promise.resolve(ok({ slugs: nth === 1 ? [ALMONDS] : [] })),
    });
    renderWishlist();
    await waitFor(() => expect(almonds()).toHaveTextContent("yes"));

    await act(async () => {
      screen.getByText("sign out").click();
    });

    await waitFor(() => expect(almonds()).toHaveTextContent("no"));
    expect(recorder.reads).toBe(2);
  });

  /**
   * The saved *products* are a separate cached query, and a successful toggle has to invalidate it.
   *
   * `staleTime` is 60s app-wide, so without this a customer who saves something on the shop page and
   * walks straight to `/wishlist` is served the cached list from before the save — the product they
   * just saved is missing, and the page looks broken in the one way nobody would report precisely.
   */
  it("refetches the saved products after a successful toggle", async () => {
    const recorder = install();
    renderWishlist({ withProducts: true });
    await waitFor(() => expect(recorder.productReads).toBe(1));

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });

    await waitFor(() => expect(recorder.productReads).toBe(2));
  });

  /**
   * A click during the very first load must not leave the page loading for ever.
   *
   * The toggle supersedes the in-flight read — it has to, or the read's reply lands on top of the
   * flip — and the read's `finally` therefore declines to clear the flag it set. Without the toggle
   * clearing it, `isLoading` stays true for the life of the page while the answer is already on
   * screen. A fast click on a slow first paint is an ordinary thing to do.
   */
  it("stops loading when a click overtakes the first read", async () => {
    let release: ((value: Response) => void) | undefined;
    install({ read: () => new Promise((resolve) => (release = resolve)) });
    renderWishlist();
    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await act(async () => {
      screen.getByText("toggle almonds").click();
    });
    expect(screen.getByTestId("loading")).toHaveTextContent("false");

    await act(async () => {
      release?.(ok({ slugs: [] }));
    });
    // The overtaken read is discarded, so the flip stands and the page is not still loading.
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(almonds()).toHaveTextContent("yes");
  });
});
