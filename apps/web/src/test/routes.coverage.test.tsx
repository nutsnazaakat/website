/**
 * Every route renders real content.
 *
 * This is the gate that catches the TanStack layout trap. A file `x.tsx` becomes the layout
 * route for a sibling `x.$id.tsx`, and without an `<Outlet />` the child renders **blank** —
 * no error, no console warning, and the route still resolves. Curl returns 200. A test that
 * only asserts "the route loaded" passes against an empty page.
 *
 * So every case here asserts a real `<h1>` inside the route's own content, not merely that
 * navigation succeeded. This build hit that trap three times before it was caught.
 *
 * If you add a route, add it here.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { User } from "@/features/auth/types";
import { CartProvider } from "@/features/cart/CartProvider";
import { WishlistProvider } from "@/features/wishlist/WishlistProvider";
import { routeTree } from "@/routeTree.gen";
import { installAuthStub } from "./auth-api.stub";

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/**
 * `features/auth/storage`'s key. The snapshot is display state, not a credential — the guards in
 * `beforeLoad` read it to decide which screen to paint — so seeding it is how a test lands inside
 * `/account/*` or `/business/*`. The stub below has to agree with it, or `GET /auth/me` would
 * answer "signed out" and the page would empty itself out from under the assertion.
 */
const SNAPSHOT_KEY = "nn.auth.v1";

const b2bSession: User = {
  id: "usr-b2b-001",
  name: "Rakesh Anand",
  email: "b2b@demo.in",
  phone: "9845012345",
  role: "b2b",
  company: {
    companyName: "Anand Sweets & Namkeen",
    contactPerson: "Rakesh Anand",
    businessType: "Sweet shop",
    gstin: "29ABCDE1234F1Z5",
  },
  createdAt: "2025-06-18T05:40:00.000Z",
};

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

async function mountAt(path: string, authed: boolean) {
  if (authed) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(b2bSession));
  // Re-installed rather than stacked: the blog case mounts twice in one test, and a second
  // install would capture the first stub as the thing to restore.
  restoreFetch?.();
  restoreFetch = installAuthStub({ session: authed ? b2bSession : null });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <CartProvider>
          {/*
           * `WishlistProvider` is not decoration here. `ProductCard` calls `useWishlist()`, which
           * throws outside it, and the throw takes the whole tree down — so `/product/…`, whose
           * related-products grid renders cards, timed out at 5s with no `<h1>` at all. The routes
           * that render their heading before their products arrived kept passing while logging the
           * error, which is the worse half: a latent flake rather than a failure.
           */}
          <WishlistProvider>
            <RouterProvider router={router} />
          </WishlistProvider>
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.body.textContent).not.toBe(""), { timeout: 5000 });
}

/** [path, requiresAuth] — every route in spec §7 plus the two justified additions. */
const ROUTES: [string, boolean][] = [
  // Public
  ["/", false],
  ["/shop", false],
  ["/category/almonds", false],
  ["/product/w320-cashews", false],
  ["/combos", false],
  ["/gifting", false],
  ["/bulk-orders", false],
  ["/bulk/all", false],
  ["/about", false],
  ["/quality", false],
  ["/blog", false],
  ["/contact", false],
  ["/faq", false],
  ["/shipping", false],
  ["/returns", false],
  ["/privacy", false],
  ["/terms", false],
  // Customer
  ["/login", false],
  ["/register", false],
  ["/cart", false],
  ["/wishlist", false],
  ["/checkout", false],
  ["/account", true],
  ["/account/orders", true],
  ["/account/addresses", true],
  ["/account/profile", true],
  // Business
  ["/business", true],
  ["/business/profile", true],
  ["/business/orders", true],
  ["/business/rfqs", true],
  ["/business/rfqs/new", true],
  ["/business/bulk-cart", true],
];

describe("every route renders content", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.getElementById("route-jsonld")?.remove();
  });

  it.each(ROUTES)("%s renders a heading", async (path, authed) => {
    await mountAt(path, authed);
    const heading = await screen.findByRole("heading", { level: 1 }, { timeout: 5000 });
    // A blank child under a layout route still "resolves" — assert the heading has text.
    expect(heading.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  /**
   * The blog is the route most at risk from the layout trap — `blog/index.tsx` and
   * `blog/$slug.tsx` are siblings in a directory. Prove the detail page renders its own
   * article body, not an empty region inside the list shell.
   */
  it("renders a blog post's own article body", async () => {
    await mountAt("/blog", false);
    // Wait for the list itself, not just the page title — posts arrive through the
    // API seam, so the heading renders well before any post link exists.
    await screen.findByText(/How to Choose the Right Almonds/i, {}, { timeout: 5000 });

    const postHrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => /^\/blog\/.+/.test(href));
    expect(postHrefs.length).toBeGreaterThan(0);

    cleanup();
    await mountAt(postHrefs[0]!, false);
    const heading = await screen.findByRole("heading", { level: 1 }, { timeout: 5000 });
    expect(heading.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // Body content lives below the title; a blackholed child would have neither.
    expect(await screen.findByRole("article")).toBeInTheDocument();
  });
});
