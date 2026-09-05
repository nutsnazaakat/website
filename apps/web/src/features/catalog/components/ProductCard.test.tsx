import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { Product, Variant } from "@/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { CartProvider } from "@/features/cart/CartProvider";
import { WishlistProvider } from "@/features/wishlist/WishlistProvider";
import { installAuthStub } from "@/test/auth-api.stub";
import { ProductCard } from "./ProductCard";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

const variant = (
  size: string,
  available: number,
  channel: Variant["channel"] = "retail",
): Variant => ({
  sku: `SKU-${size}`,
  size,
  grams: size === "1kg" ? 1000 : 250,
  channel,
  price: 299,
  mrp: 349,
  moq: 1,
  available,
  soldOut: available <= 0,
});

const product = (variants: Variant[]): Product =>
  ({
    slug: "premium-california-almonds",
    name: "Premium California Almonds",
    category: "almonds",
    subtitle: "Crunchy kernels.",
    description: "",
    rating: 4.8,
    reviewCount: 324,
    images: ["/a.jpg"],
    origin: "California, USA",
    grade: "Independence",
    processing: "",
    shelfLife: "",
    storage: "",
    ingredients: "",
    hsn: "0802",
    gstRate: 5,
    variants,
    bulkTiers: [],
    moqKg: 10,
    soldOut: variants.every((v) => v.available <= 0),
    seo: { title: "", description: "", ogImage: "" },
  }) as Product;

/**
 * The card is not renderable on its own, so this is the smallest harness that renders it:
 *
 * - `useCart` throws outside `CartProvider`, so the real provider wraps it — and `CartProvider` now
 *   calls `useAuth()` for its reload-on-identity-change effect and reads the catalogue through
 *   react-query for the optimistic total, so it needs both of those providers outside it. That is
 *   the real tree's order (`providers/AppProviders.tsx`), not a workaround. `installAuthStub`
 *   answers the four requests the mount fires — `/auth/me` 401, the catalogue, an empty `GET /cart`
 *   and an empty `GET /wishlist/slugs` — so nothing here reaches the network. Nothing asserted below
 *   reads a total.
 * - `useWishlist` throws outside `WishlistProvider` for the same reason, and the card calls it for
 *   the heart's state. A sibling of `CartProvider`, as in the real tree: nothing needs both at once.
 *   Adding it here was not optional — the moment `ProductCard` called `useWishlist()` every case in
 *   this file failed with "useWishlist must be used inside WishlistProvider", before reaching an
 *   assertion, exactly as this file's own first run died on `useCart`.
 * - The card links to `/product/$slug`, and TanStack Router refuses to build an href for a path
 *   absent from its tree, so the tree declares that one route.
 * - `RouterContextProvider`, not `RouterProvider`: the latter renders the *matched* route and does
 *   its first match in an effect, so a synchronous `render()` returns an empty body and every
 *   `queryBy*` assertion passes vacuously. The low-level provider puts the router in context and
 *   renders its children immediately, which is all `Link` needs.
 */
function renderCard(p: Product, { keepServerState = false } = {}) {
  const rootRoute = createRootRoute();
  const productRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/product/$slug",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([productRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  /**
   * `keepServerState` skips the re-install, and the remount case below needs it.
   * `installAuthStub` calls `resetWishlistStub()`, so a remount that reinstalled would find an empty
   * server and prove nothing: the heart would come back grey because the *server* forgot, which is
   * not the thing being tested.
   */
  if (!keepServerState) {
    restoreFetch?.();
    restoreFetch = installAuthStub();
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <CartProvider>
          <WishlistProvider>
            <RouterContextProvider router={router}>
              <ProductCard product={p} />
            </RouterContextProvider>
          </WishlistProvider>
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ProductCard sold-out states", () => {
  it("does not shout SOLD OUT when everything is in stock", () => {
    renderCard(product([variant("250g", 120), variant("1kg", 40)]));
    expect(screen.queryByText(/sold out/i)).toBeNull();
  });

  /**
   * Per-variant, per spec §10.1 and brief §11. The card must offer the size that is in stock rather
   * than refusing the whole product, or a product with one empty pack size stops selling entirely.
   */
  it("disables only the sold-out size and leaves its siblings selectable", () => {
    renderCard(product([variant("250g", 0), variant("1kg", 40)]));
    expect(screen.getByRole("button", { name: /250g/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /1kg/ })).toBeEnabled();
  });

  /**
   * A strikethrough and a dimmed colour are invisible to a screen reader, so the state has to reach
   * the accessible name too. Nothing in the plan's own test list covered this, which meant the
   * requirement could be dropped without a single test noticing.
   */
  it("says sold out in the accessible name, not only in the styling", () => {
    renderCard(product([variant("250g", 0), variant("1kg", 40)]));
    expect(screen.getByRole("button", { name: /250g.*sold out/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1kg.*sold out/i })).toBeNull();
  });

  it("marks the whole card sold out only when every variant is out", () => {
    renderCard(product([variant("250g", 0), variant("1kg", 0)]));
    expect(screen.getByText(/sold out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeDisabled();
  });

  /**
   * The card must **not** open on a sold-out size when a stocked one exists.
   *
   * `ProductCard.tsx:14` hardcodes `useState("250g")`, so with 250g out and 1kg in stock it would open
   * on the empty size with Add to Cart disabled — a customer looking at a product that is available,
   * being shown a button that refuses. That is a self-inflicted lost sale, and it is the default state
   * of the page rather than something they did.
   *
   * So the initial selection becomes the first **available** retail size, falling back to the first
   * retail size when every one is out (in which case the product-level SOLD OUT badge is what explains
   * the disabled button).
   */
  it("opens on an available size rather than a sold-out default", () => {
    renderCard(product([variant("250g", 0), variant("1kg", 40)]));
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /1kg/ })).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * PROBE, not a requirement: this documents why the plan's "still disables Add to Cart when the
   * customer picks a sold-out size" cannot pass. A sold-out chip carries the real `disabled`
   * attribute (the test above needs it — jest-dom's `toBeDisabled` ignores `aria-disabled`), and
   * neither a browser nor `userEvent` dispatches a click on a disabled control. So the click is a
   * no-op, the stocked size stays selected, and Add to Cart is correctly *enabled*.
   */
  /**
   * The opening pack is 250g **by preference**, not "the first retail pack". The seeded catalogue's
   * first retail pack is 100g, so opening on whichever pack comes first would quietly halve the
   * default order value of every product — a merchandising change smuggled in under a sold-out fix.
   * Two smoke tests caught it; this pins it here too.
   */
  it("opens on 250g when it is stocked, not merely on the first pack", () => {
    renderCard(product([variant("100g", 120), variant("250g", 120), variant("1kg", 40)]));
    expect(screen.getByRole("button", { name: /250g/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /100g/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("falls back to the first stocked pack when the preferred one is out", () => {
    renderCard(product([variant("100g", 120), variant("250g", 0), variant("1kg", 40)]));
    expect(screen.getByRole("button", { name: /100g/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("will not let the customer select a sold-out size at all", async () => {
    const user = userEvent.setup();
    renderCard(product([variant("250g", 0), variant("1kg", 40)]));
    await user.click(screen.getByRole("button", { name: /250g/ }));
    expect(screen.getByRole("button", { name: /1kg/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /250g/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeEnabled();
  });

  /**
   * The requirement the plan's fifth test was reaching for — "`disabled` on Add to Cart when the
   * **selected** variant is sold out, not merely when the product is" — in the one arrangement that
   * can actually reach it.
   *
   * Every retail pack is out but a 25kg bulk pack is stocked, so `productSoldOut` says the product
   * is *not* sold out: there is something to buy, just not here. The card must still refuse, because
   * this button only ever adds a retail pack. A guard written against `product.soldOut` would sell
   * a 250g pack that does not exist.
   */
  it("refuses a retail add when every retail pack is out but a bulk pack is stocked", () => {
    renderCard(product([variant("250g", 0), variant("1kg", 0), variant("25kg", 40, "bulk")]));
    expect(screen.queryByText(/sold out/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeDisabled();
  });

  /**
   * `available` is a stock level, not a marketing number. Publishing "3 left" invites the pressure
   * tactics brief §1 rules out, and it leaks inventory to competitors. The flag is what renders.
   */
  it("never prints the raw stock figure", () => {
    renderCard(product([variant("250g", 3), variant("1kg", 40)]));
    expect(screen.queryByText(/\b3\b\s*(left|remaining|in stock)/i)).toBeNull();
  });
});

/**
 * The heart, which until now forgot everything on every navigation.
 *
 * `ProductCard` held `const [wished, setWished] = useState(false)`, so a customer could save five
 * products, walk to `/cart` and back, and find five grey hearts and an empty wishlist. Nothing was
 * ever sent anywhere.
 *
 * The accessibility of the control was already right and is untouched: `aria-pressed` plus a
 * state-aware `Remove …/Save …` label, which is what makes it usable without seeing the fill colour.
 * Only the state source changed, and these cases assert through that label rather than the fill.
 */
describe("ProductCard wishlist heart", () => {
  const heart = () => screen.getByRole("button", { name: /wishlist/i });

  it("opens grey for a product nobody has saved", async () => {
    renderCard(product([variant("250g", 120)]));
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "false"));
    expect(heart()).toHaveAccessibleName(/save .* to wishlist/i);
  });

  /**
   * The bug this feature fixes, asserted the way a customer meets it: save, navigate away, come
   * back. A remount is what a navigation is, so the old `useState(false)` reset here every time.
   *
   * The second `renderCard` keeps the stubbed server's state — see the harness note — so the only
   * thing under test is whether the card asks the server what it has saved instead of assuming
   * nothing.
   */
  it("keeps the heart filled across a remount, which useState did not", async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard(product([variant("250g", 120)]));
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "false"));

    await user.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "true"));

    unmount();
    renderCard(product([variant("250g", 120)]), { keepServerState: true });

    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "true"));
    expect(heart()).toHaveAccessibleName(/remove .* from wishlist/i);
  });
});
