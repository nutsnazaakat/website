/**
 * Route-level smoke tests: real router, real route components, real API seam.
 *
 * These assertions are deliberately coupled to the seed data in `src/mocks/products.ts`.
 * `w320-cashews` is seeded with `kg: 1099`, which is what produces the exact figures
 * asserted below — `₹132 / 100g` (250g pack), `₹989 / kg` (the 10–24kg tier at 0.9x base)
 * and `You save ₹1,100` (10kg at 989 versus 10kg at the 1099 base tier).
 *
 * If someone changes the seed prices these tests fail, and that is the intent: a pricing
 * change should force a human to confirm the tier maths and the quote-only override still
 * behave. Update the numbers here only after checking the new tiers are correct.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addDays, format } from "date-fns";
import { ORDER_NUMBER_PATTERN, type BusinessProfile, type RfqDetail } from "@/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "@/config/settings";
import { accountKeys } from "@/features/account/hooks/useAccount";
import { AuthProvider } from "@/features/auth/AuthProvider";
import type { User } from "@/features/auth/types";
import { CartProvider } from "@/features/cart/CartProvider";
import { WishlistProvider } from "@/features/wishlist/WishlistProvider";
import { inr } from "@/lib/format";
import { orders as SEEDED_ORDERS } from "@/mocks/orders";
import { routeTree } from "@/routeTree.gen";
import {
  addressReads,
  addressWrites,
  orderCancels,
  orderListQueries,
  orderReads,
  profileWrites,
  seedAddressId,
  seedAccountOrder,
} from "./account-api.stub";
import { installAuthStub, STUB_PASSWORD } from "./auth-api.stub";
import {
  businessUpdateRequests,
  failBusinessUpdate,
  seedBusinessProfile,
  statsReads,
} from "./business-api.stub";
import {
  cartWrites,
  failCartLoad,
  failCartWrite,
  lastCartWrite,
  seedCart as seedServerCart,
  storedCart,
  type SeedLine,
  holdCartLoad,
} from "./cart-api.stub";
import { drainPacks, failCatalogList } from "./catalog-api.stub";
import {
  allowPlacement,
  failPlacement,
  idempotencyKeys,
  issuedOrders,
  lastPlacement,
  pincodeChecks,
  placementRequests,
  seedCoupon,
  seedPincodeRule,
} from "./checkout-api.stub";
import { contactSubmissions, failNextContactSubmission } from "./contact-api.stub";
import { giftingCreateRequests, rfqCreateRequests, seedRfq as seedRfqRow } from "./rfq-api.stub";
import { freezeWishlistProducts, seedWishlist } from "./wishlist-api.stub";
import { FORBIDDEN_CLAIMS } from "./forbidden-claims";

/** jsdom has no ResizeObserver; Radix Slider and Select construct one on mount. */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;

/**
 * jsdom implements no scrolling, so `Element.scrollIntoView` is simply absent. cmdk calls
 * it whenever the highlighted item in the search dialog changes, which throws before any
 * assertion gets a chance to run.
 */
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/**
 * `features/auth/storage`'s key. It holds a **display snapshot** of the signed-in user, not a
 * credential: the real session is three cookies, two of them httpOnly. `/account/*` and
 * `/business/*` guard on the snapshot in `beforeLoad`, because a guard runs before any React
 * context exists, so a test that wants to land inside either area arranges it here — exactly as
 * it already arranges a cart.
 *
 * `renderAt` also hands the same account to the auth stub. The two must agree: if the snapshot
 * says "signed in" and `GET /auth/me` says otherwise, the provider corrects itself a tick after
 * mount and the page empties out under the assertion.
 */
const SNAPSHOT_KEY = "nn.auth.v1";

/**
 * The three fixture accounts, restated as plain `User` values. Tests may not import
 * `src/mocks/` — only a feature's api module may — and the session storage layer validates
 * whatever it reads, so these have to match the seeded users to be accepted.
 *
 * `admin` is here to prove a negative: the admin console is a separate application in its own
 * repository, so signing in as one must *not* land on the customer account area.
 */
const sessions: Record<"b2c" | "b2b" | "admin", User> = {
  b2c: {
    id: "usr-b2c-001",
    name: "Asha Rao",
    email: "b2c@demo.in",
    phone: "9876543210",
    role: "b2c",
    createdAt: "2025-11-04T09:12:00.000Z",
  },
  b2b: {
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
  },
  admin: {
    id: "usr-admin-001",
    name: "Nazaakat Admin",
    email: "admin@demo.in",
    phone: "9800000000",
    role: "admin",
    createdAt: "2025-11-04T09:12:00.000Z",
  },
};

let restoreFetch: (() => void) | undefined;

/**
 * The `QueryClient` the most recent `renderAt` mounted, so a case can read the cache directly.
 *
 * Needed for exactly one thing, and it is not an optimisation. `CheckoutForm` writes the placed order
 * into `accountKeys.order(id)` before navigating, because `/checkout` and `/order-success/$id` have
 * **no route guard** — a guest placing an order is the ordinary retail path, their order is written
 * with `userId: null`, and `GET /account/orders/:orderNumber` is session-scoped, so they could never
 * fetch their own confirmation. Task 23 reads that entry. Until it does, nothing renders it, so
 * nothing else can tell a correct key from a key that drifted by one element — which for a guest is a
 * 401 on their own order.
 */
let mountedQueryClient: QueryClient | undefined;

const renderedCache = (): QueryClient => {
  if (!mountedQueryClient) throw new Error("renderAt has not mounted a QueryClient yet");
  return mountedQueryClient;
};

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

/**
 * `seedStock` drains packs on the product the detail page is about to fetch. It has to be applied
 * *after* `installAuthStub`, not before: that installer calls `resetCatalogStub()`, which clears any
 * arrangement, so setting it first would silently be undone.
 */
async function renderAt(
  path: string,
  seedCart?: SeedLine[],
  seedAuth?: "b2c" | "b2b" | "admin" | User,
  seedStock?: { slug: string; sizes: readonly string[] | "*" },
  seedCartFailure?: { load?: string; write?: string },
  seedSaved?: string[],
  seedCatalogFailure?: string,
  seedRfqs?: { rfq: RfqDetail; owner: string | null }[],
  seedBusinessProfileOverride?: BusinessProfile,
) {
  // `seedAuth` also accepts a bare `User`, so a case can sign in as a business the fixture
  // accounts don't cover — a freshly "registered" one, with no address book of its own — rather
  // than only the three named fixtures.
  const user = typeof seedAuth === "string" ? sessions[seedAuth] : seedAuth;
  if (user) localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(user));
  // Every fixture can always sign in; `session` is what the cookies already carry, which is
  // what separates "arrive signed in" from "arrive at the sign-in form".
  restoreFetch?.();
  restoreFetch = installAuthStub({
    session: user ?? null,
    accounts: [sessions.b2c, sessions.b2b, sessions.admin, ...(user ? [user] : [])],
  });
  if (seedStock) drainPacks(seedStock.slug, seedStock.sizes);
  // Same ordering constraint again, same reason: `installAuthStub` calls `resetCatalogStub()`.
  if (seedCatalogFailure) failCatalogList(seedCatalogFailure);
  // Same ordering constraint as `seedStock`, and for the same reason: `installAuthStub` resets the
  // cart stub, so a basket arranged before it would silently be discarded.
  if (seedCart) seedServerCart(seedCart);
  if (seedCartFailure?.load) failCartLoad(seedCartFailure.load);
  if (seedCartFailure?.write) failCartWrite(seedCartFailure.write);
  // Third arrangement with the same ordering constraint: `installAuthStub` resets the wishlist stub
  // too, so a saved list arranged before it would silently be discarded.
  if (seedSaved) seedWishlist(seedSaved);
  // Same ordering constraint again: `installAuthStub` calls `resetRfqStub()`, so an enquiry seeded
  // before it would be discarded rather than waiting on screen for the caller who owns it.
  if (seedRfqs) for (const { rfq, owner } of seedRfqs) seedRfqRow(rfq, owner);
  // Same ordering constraint again: `installAuthStub` calls `resetBusinessStub()` too.
  if (seedBusinessProfileOverride && user) {
    seedBusinessProfile(user.email, seedBusinessProfileOverride);
  }
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, history });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mountedQueryClient = qc;
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <CartProvider>
          {/*
           * Required, not decorative: `ProductCard` calls `useWishlist()`, which throws outside this
           * provider and takes the whole tree with it. Twenty-three cases in this file failed on it.
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

const cartItems = () => within(screen.getByRole("region", { name: "Cart items" }));
const cartSummary = () => within(screen.getByRole("complementary", { name: "Order summary" }));

describe("route smoke", () => {
  it("renders the home route with bestsellers and page meta", async () => {
    await renderAt("/");
    await screen.findByText(/A little nazaakat/, {}, { timeout: 5000 });
    await screen.findByText("W320 Cashews", {}, { timeout: 5000 });
    expect(document.title).toContain("Nuts & Nazaakat");
  });

  it("applies shop filters from the URL", async () => {
    await renderAt("/shop?category=cashews&sort=price-asc");
    await screen.findByText("Shop dry fruits", {}, { timeout: 5000 });
    await screen.findByText("W320 Cashews", {}, { timeout: 5000 });
    expect(screen.queryByText("Premium California Almonds")).toBeNull();
  });

  /**
   * The count is the envelope's `total`, not the length of the page.
   *
   * 27 products are seeded and a page holds 24, so a shop that renders `items.length` tells the
   * customer the catalogue is smaller than it is — and does it silently, since 24 is a perfectly
   * plausible number. This is the one assertion that separates the two.
   */
  it("counts the whole catalogue while rendering one page of it", async () => {
    await renderAt("/shop");
    await screen.findByText("Shop dry fruits", {}, { timeout: 5000 });
    expect(await screen.findByText("27 products", {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("article").length).toBe(24));
  }, 20000);

  it("shows the rest of the catalogue on page two, with nothing repeated", async () => {
    await renderAt("/shop?page=2");
    await screen.findByText("Shop dry fruits", {}, { timeout: 5000 });
    // 27 products, 24 to a page: the second page holds the last three and no more.
    await screen.findByText("Festive Gift Box", {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getAllByRole("article").length).toBe(3));
    expect(screen.queryByText("Premium California Almonds")).toBeNull();
    expect(screen.queryByText("Trail Mix Combo")).toBeNull();
    expect(screen.getByText("27 products")).toBeTruthy();
  }, 20000);

  /**
   * Filtering from page two must land on page one of the result.
   *
   * `page` lives in the same search object as the filters, so a `setFilter` that spreads the
   * previous search carries it through: pick Almonds from page two and land on page two of a
   * three-product result, which renders the "nothing matches these filters" empty state. The
   * customer's filter appears to have deleted the catalogue.
   */
  it("returns to the first page when a category is chosen from page two", async () => {
    const user = userEvent.setup();
    await renderAt("/shop?page=2");
    await screen.findByText("Festive Gift Box", {}, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Almonds" }));

    await screen.findByText("Mamra Almonds", {}, { timeout: 5000 });
    expect(screen.getByText("3 products")).toBeTruthy();
    expect(screen.queryByText("Nothing matches these filters.")).toBeNull();
  }, 20000);

  it("renders a category route", async () => {
    await renderAt("/category/almonds");
    await screen.findByText("Almonds", {}, { timeout: 5000 });
    await screen.findByText("Mamra Almonds", {}, { timeout: 5000 });
  });

  it("resolves the right bulk tier at 10kg and falls back to a quote at 60kg", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });
    expect(document.getElementById("route-jsonld")?.textContent).toContain("AggregateOffer");
    expect(screen.getByText(/₹132 \/ 100g/)).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Buy in Bulk" }));

    // the stepper starts at moqKg = 10, which lands in the 10–24kg tier
    const activeRow = (await screen.findByText("10–24 kg")).parentElement!;
    expect(activeRow.className).toContain("bg-sand");
    expect(activeRow.className).toContain("font-semibold");
    expect(screen.getByText("₹989 / kg")).toBeTruthy();
    expect(screen.getByText("You save ₹1,100")).toBeTruthy();
    expect(screen.getByText("Add 10 kg to Cart")).toBeTruthy();

    // 60kg lands in the 50kg+ tier, which has no published rate
    const plus = screen.getByLabelText("Increase bulk quantity");
    for (let i = 0; i < 10; i++) await user.click(plus);
    expect(screen.getByText("60 kg")).toBeTruthy();
    expect(screen.getByText("Request a Quote")).toBeTruthy();
    expect(screen.queryByText(/Add 60 kg to Cart/)).toBeNull();
  });

  /**
   * **The refusal moved from Delhi to a `9` prefix, and it is a change rather than a fix.**
   *
   * This test used to type `110001` and assert *"We don't deliver here yet."*, which encoded
   * `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/` — a mock that refused every Delhi pincode.
   * `checkPincode` now calls `POST /checkout/pincode`, and `serviceable_pincodes` says prefix `1`
   * **is** serviceable at four days. Refusing to deliver to Delhi is not a behaviour worth
   * preserving, so the table wins and the assertion moves to `900001`: `0` and `9` are the two
   * prefixes India issues no civilian pincodes under and the two the seed stores as unserviceable, so
   * this is a pincode the *table* genuinely refuses rather than one an old regex happened to.
   *
   * The ETA regex widened from `\d` to `\d+` at the same time. Every seeded prefix carries
   * `etaDays: 4`, so a single digit still matches — but that column is per-destination and
   * admin-editable, which is the entire argument for its authority, and one edit to ten days would
   * have failed an assertion that has nothing to do with ETAs. Note also that the mock *derived* a
   * per-pincode ETA (`2 + digitSum % 5`, so 2–6 days) while the server has one flat number per
   * prefix: an expectation that told two pincodes apart by their ETA would now be pinning nothing.
   *
   * `pincodeChecks()` is asserted alongside the rendered text because `http.post` takes its body as
   * `unknown`, so nothing else can see a client that stops sending `{ pincode }` — or that sends the
   * pincode to the wrong endpoint, which the dispatcher would answer by rejecting loudly only if the
   * path were unhandled entirely.
   */
  it("checks pincode serviceability against the server table", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    const input = screen.getByLabelText("Delivery pincode");
    await user.type(input, "560001");
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Delivers to 560001 in \d+ working days\./)).toBeTruthy();

    await user.clear(input);
    await user.type(input, "900001");
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/We don't deliver here yet\./)).toBeTruthy();

    expect(pincodeChecks()).toEqual(["560001", "900001"]);
  });

  /**
   * **The ETA is the server's number, and this is the only case that can tell.**
   *
   * Every seeded prefix carries `etaDays: 4`, so the case above would pass just as happily against a
   * literal `4` beside the markup — measured: that mutation failed none of this file's cases. The
   * same bug is live one screen away, at `CheckoutForm.tsx:620`'s `addDays(new Date(), 4)`, so it is
   * not a hypothetical shape. Arranging a rule the seed does not contain is what separates "renders
   * the response" from "renders a constant that currently agrees with it".
   *
   * Nine days rather than a small number for the same reason the regex widened to `\d+`: a
   * single-digit expectation is a trap the next admin edit springs.
   */
  it("renders the ETA the server sent, not a constant that happens to match the seed", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });
    // Arranged *after* `renderAt` — the opposite of `seedCart` and `drainPacks`, and safe only
    // because of when it is read: `installAuthStub` resets this stub on install, and the row is not
    // consulted until the Check button fires a request.
    seedPincodeRule("700001", { serviceable: true, etaDays: 9, shipping: 149 });

    await user.type(screen.getByLabelText("Delivery pincode"), "700001");
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText(/Delivers to 700001 in 9 working days\./)).toBeTruthy();
  });

  /**
   * Disagreement 1, asserted from the customer's side: the pincode the mock refused is delivered to.
   *
   * Its own case rather than a third leg of the one above, because it is the *behaviour change* this
   * task makes and it should fail by name if the seam ever reverts to a `[2-8]` regex — where the
   * test above would still pass, `900001` being refused by both rules.
   */
  it("delivers to a Delhi pincode, which the Phase 1 mock refused", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Delivery pincode"), "110001");
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText(/Delivers to 110001 in \d+ working days\./)).toBeTruthy();
    expect(screen.queryByText(/We don't deliver here yet\./)).toBeNull();
  });

  it("shows approved reviews with their distribution and verified badges", async () => {
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    const list = within(
      await screen.findByRole("list", { name: "Customer reviews" }, { timeout: 5000 }),
    );
    // Five approved reviews are seeded against this product.
    expect(list.getAllByRole("listitem").length).toBe(5);
    expect(list.getByText("Meera S.")).toBeTruthy();
    // Four of the five are verified purchases.
    expect(list.getAllByText("Verified Purchase").length).toBe(4);

    // Brief §27's distribution bars: one meter per star band.
    const dist = within(screen.getByRole("list", { name: "Rating distribution" }));
    expect(dist.getAllByRole("meter").length).toBe(5);
    expect(dist.getByRole("meter", { name: "5 star reviews" }).getAttribute("aria-valuenow")).toBe(
      "60",
    );
  }, 20000);

  it("queues a submitted review for moderation instead of publishing it", async () => {
    const user = userEvent.setup();
    await renderAt("/product/roasted-makhana");
    await screen.findByRole("heading", { name: "Roasted Makhana", level: 1 }, { timeout: 5000 });

    const before = within(
      await screen.findByRole("list", { name: "Customer reviews" }, { timeout: 5000 }),
    ).getAllByRole("listitem").length;

    const body = "Crisp and clean, and the pouch reseals properly which I did not expect.";
    await user.click(screen.getByRole("button", { name: "Rate 5 out of 5" }));
    await user.type(screen.getByLabelText("Display name"), "Test Reviewer");
    await user.type(screen.getByLabelText("Your review"), body);
    await user.click(screen.getByRole("button", { name: "Submit Review" }));

    expect(
      await screen.findByText("Thanks — your review is awaiting approval", {}, { timeout: 5000 }),
    ).toBeTruthy();

    // The moderation queue is invisible to shoppers: neither the review nor the reviewer
    // may appear in the public list, and the list length must not move.
    const after = within(screen.getByRole("list", { name: "Customer reviews" }));
    expect(after.getAllByRole("listitem").length).toBe(before);
    expect(screen.queryByText(body)).toBeNull();
    expect(screen.queryByText("Test Reviewer")).toBeNull();
  }, 30000);

  it("keeps a quoteOnly product on Request a Quote even inside a priced tier", async () => {
    const user = userEvent.setup();
    await renderAt("/product/corporate-gift-box");
    await screen.findByRole("heading", { name: "Corporate Gift Box", level: 1 }, { timeout: 5000 });
    await user.click(screen.getByRole("tab", { name: "Buy in Bulk" }));
    // moqKg 25 sits in the priced 25–49kg tier — quoteOnly must override it
    expect((await screen.findAllByText("25 kg")).length).toBeGreaterThan(0);
    expect(screen.getByText("Request a Quote")).toBeTruthy();
    expect(screen.queryByText(/Add 25 kg to Cart/)).toBeNull();
  });

  /**
   * Sold-out rendering on the *detail page*. `ProductCard.test.tsx` covers the card; these cover the
   * route, which nothing did — the badge, the disabled chips and the two guarded buttons all shipped
   * without a test because arranging them needs this harness.
   *
   * The chip queries are scoped to the retail tabpanel on purpose. The related-products grid at the
   * foot of the page renders a `ProductCard` per sibling, each with its own `250g`/`1kg` chips, so an
   * unscoped `getByRole("button", { name: /1kg/ })` matches five buttons and throws.
   */
  const retailPanel = () => within(screen.getByRole("tabpanel"));

  it("offers the packs that are in stock when one retail pack is drained", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews", undefined, undefined, {
      slug: "w320-cashews",
      sizes: ["250g"],
    });
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    expect(retailPanel().getByRole("button", { name: /250g.*sold out/i })).toBeDisabled();

    // The page must not *open* on the drained pack. `sizeInput ?? openingRetailSize(...)` is what
    // stops the default state of a stocked product being a dead Add to Cart button — a lost sale
    // nobody clicked for. Asserted before the click, or the click hides it.
    expect(retailPanel().getByRole("button", { name: /250g.*sold out/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(retailPanel().getByRole("button", { name: "Add to Cart" })).toBeEnabled();

    const oneKg = retailPanel().getByRole("button", { name: /^1kg/ });
    expect(oneKg).toBeEnabled();
    await user.click(oneKg);
    expect(oneKg).toHaveAttribute("aria-pressed", "true");
    expect(retailPanel().getByRole("button", { name: "Add to Cart" })).toBeEnabled();

    // One empty pack is not a sold-out product, and saying so would stop the other three selling.
    expect(screen.queryByText("SOLD OUT")).toBeNull();
  }, 30000);

  it("marks the product sold out and refuses both buy actions when every pack is gone", async () => {
    await renderAt("/product/w320-cashews", undefined, undefined, {
      slug: "w320-cashews",
      sizes: "*",
    });
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    expect(screen.getByText("SOLD OUT")).toBeInTheDocument();
    expect(retailPanel().getByRole("button", { name: "Add to Cart" })).toBeDisabled();
    expect(retailPanel().getByRole("button", { name: "Buy Now" })).toBeDisabled();
    for (const size of ["100g", "250g", "500g", "1kg"]) {
      expect(
        retailPanel().getByRole("button", { name: new RegExp(`^${size}.*sold out`, "i") }),
      ).toBeDisabled();
    }
  }, 30000);

  /**
   * The arrangement `product.$slug.tsx:231` claims to handle and nothing measured: every retail pack
   * out while a 25kg bulk pack is stocked. `productSoldOut` reads *all* active variants, so
   * `product.soldOut` is false — the product is still buyable, just not in a retail pack. The badge
   * must stay away and both buttons must still refuse, because they only ever add a retail pack. A
   * guard written against `product.soldOut` would sell a 250g pack that does not exist.
   */
  it("refuses a retail buy when every retail pack is out but bulk is stocked", async () => {
    await renderAt("/product/w320-cashews", undefined, undefined, {
      slug: "w320-cashews",
      sizes: ["100g", "250g", "500g", "1kg"],
    });
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    expect(screen.queryByText("SOLD OUT")).toBeNull();
    expect(retailPanel().getByRole("button", { name: "Add to Cart" })).toBeDisabled();
    expect(retailPanel().getByRole("button", { name: "Buy Now" })).toBeDisabled();
  }, 30000);
});

/**
 * Content routes: combos, gifting, the blog, the static pages and the legal set.
 *
 * The combo figures are derived by `catalogApi.listCombos` from the same seed prices the
 * block above pins, so they move together: the Daily Nutrition Combo box is the 1 kg pack
 * of a `kg: 899` product (₹899) against four 250g packs whose MRPs total ₹1,396, which is
 * the ₹497 saving asserted below.
 */
describe("combos and gifting", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("renders the six named combos with their parts and a savings figure", async () => {
    await renderAt("/combos");
    const list = within(
      await screen.findByRole("list", { name: "Combo boxes" }, { timeout: 5000 }),
    );

    // Each card nests its own component list, so count the card headings rather than
    // every listitem in the subtree.
    expect(list.getAllByRole("heading", { level: 3 }).length).toBe(6);

    // Brief §23 names all six explicitly.
    for (const name of [
      "Daily Nutrition Combo",
      "Premium Nuts Combo",
      "Family Pack",
      "Office Snack Combo",
      "Trail Mix Combo",
      "Festive Combo",
    ]) {
      expect(list.getByRole("heading", { name, level: 3 })).toBeTruthy();
    }

    // Every combo shows a saving, and the first one's arithmetic is pinned to the seed.
    expect(list.getAllByText(/^You save ₹/).length).toBe(6);
    const daily = within(
      list.getByRole("heading", { name: "Daily Nutrition Combo" }).closest("li")!,
    );
    expect(daily.getByText("₹1,396")).toBeTruthy();
    expect(daily.getByText("₹899")).toBeTruthy();
    expect(daily.getByText("You save ₹497")).toBeTruthy();
    expect(daily.getByText("Premium California Almonds")).toBeTruthy();
  }, 20000);

  it("adds a combo box to the cart at the combo price, not the price of the parts", async () => {
    const user = userEvent.setup();
    await renderAt("/combos");
    const list = within(
      await screen.findByRole("list", { name: "Combo boxes" }, { timeout: 5000 }),
    );
    const daily = within(
      list.getByRole("heading", { name: "Daily Nutrition Combo" }).closest("li")!,
    );

    await user.click(daily.getByRole("button", { name: "Add to Cart" }));

    // Both halves, and neither is redundant. The **request** pins `toRequestLine`'s field list —
    // `id` and `grams` are on the `CartLine` the client holds and are refused by `CartLineDto`, so a
    // regression there is a 400 on every add-to-cart. The **stored basket** pins the composed line
    // identity `r:daily-dry-fruit-combo:1kg`, which is what `POST /cart/validate` joins its verdicts
    // on; it cannot be read off the request, because the server composes it from slug and size.
    await waitFor(() =>
      expect(lastCartWrite()).toEqual([
        { slug: "daily-dry-fruit-combo", mode: "retail", size: "1kg", qty: 1 },
      ]),
    );
    expect(storedCart()).toEqual([
      {
        id: "r:daily-dry-fruit-combo:1kg",
        slug: "daily-dry-fruit-combo",
        mode: "retail",
        size: "1kg",
        grams: 1000,
        qty: 1,
      },
    ]);
  }, 20000);

  it("renders the five gifting sections and files a corporate enquiry as a numbered RFQ", async () => {
    const user = userEvent.setup();
    await renderAt("/gifting");
    await screen.findByRole(
      "heading",
      { name: /A gift people finish/, level: 1 },
      { timeout: 5000 },
    );

    // Brief §24's five sections.
    for (const title of [
      "Corporate Gifts",
      "Festive Gifts",
      "Wedding Gifts",
      "Premium Gift Boxes",
      "Custom Gift Hampers",
    ]) {
      expect(screen.getByRole("heading", { name: title, level: 3 })).toBeTruthy();
    }

    const form = within(screen.getByRole("form", { name: "Corporate gifting enquiry" }));
    await screen.findByRole("option", { name: "Corporate Gift Box" }, { timeout: 5000 });

    await user.type(form.getByLabelText("Company name"), "Northwind Technologies");
    await user.type(form.getByLabelText("Contact person"), "Ira Sethi");
    await user.type(form.getByLabelText("Mobile number"), "9811122233");
    await user.type(form.getByLabelText("Work email"), "ira@northwind.example");
    // Deliberately not the default ("Corporate gifting"): picking a different one of the twelve
    // proves this is a real select the client reads and sends, not a hardcoded value that happens
    // to match what a corporate gifting enquiry usually is.
    await user.selectOptions(form.getByLabelText("Business type"), "Distributor");
    await user.type(form.getByLabelText("Delivery pincode"), "122001");
    await user.selectOptions(form.getByLabelText("Gift box"), "corporate-gift-box");
    await user.click(form.getByLabelText(/Branding required/));
    await user.type(form.getByLabelText("Custom message (optional)"), "Season's greetings.");

    // A past date must be refused before a valid one is accepted.
    const date = form.getByLabelText("Delivery date");
    await user.clear(date);
    await user.type(date, "2020-01-01");
    await user.click(form.getByRole("button", { name: "Request Gifting Quote" }));
    expect(
      await screen.findByText("Choose a delivery date that has not already passed"),
    ).toBeTruthy();

    await user.clear(date);
    await user.type(date, "2099-11-05");
    await user.click(form.getByRole("button", { name: "Request Gifting Quote" }));

    await screen.findByRole(
      "heading",
      { name: "Quote Request Submitted", level: 2 },
      { timeout: 5000 },
    );
    expect(screen.getByText(/^RFQ-\d{4}-\d{6}$/)).toBeTruthy();

    // `POST /rfqs/gifting`, not `/rfqs` — its own front door, carrying the business type the form
    // collected rather than the hardcoded "Corporate gifting" the old draft always sent.
    expect(giftingCreateRequests()).toEqual([
      {
        companyName: "Northwind Technologies",
        contactPerson: "Ira Sethi",
        mobile: "9811122233",
        email: "ira@northwind.example",
        businessType: "Distributor",
        pincode: "122001",
        occasion: "Diwali",
        giftBoxSlug: "corporate-gift-box",
        boxes: 25,
        budgetPerBox: 1500,
        brandingRequired: true,
        deliveryDate: "2099-11-05",
        message: "Season's greetings.",
      },
    ]);
    expect(rfqCreateRequests()).toEqual([]);
  }, 30000);
});

/**
 * The blog. `/blog` and `/blog/$slug` are separate files in a `routes/blog/` directory
 * rather than `blog.tsx` + `blog.$slug.tsx`, because the flat form makes `blog.tsx` a
 * layout route for its sibling and the detail page renders blank without an `<Outlet />`.
 * The detail assertions below deliberately reach inside the child's body so that mistake
 * cannot pass silently.
 */
describe("blog", () => {
  it("lists every post and narrows to one category from the URL", async () => {
    await renderAt("/blog");
    const all = within(await screen.findByRole("list", { name: "Blog posts" }, { timeout: 5000 }));
    expect(all.getAllByRole("listitem").length).toBe(8);

    // Brief §28 names these four titles verbatim.
    for (const title of [
      "How to Choose the Right Almonds",
      "W320 vs W240 Cashews: What's the Difference?",
      "How to Store Dry Fruits at Home",
      "How Businesses Can Buy Dry Fruits in Bulk",
    ]) {
      expect(all.getByRole("heading", { name: title, level: 2 })).toBeTruthy();
    }
  }, 20000);

  it("filters the list to a single category chip", async () => {
    const user = userEvent.setup();
    await renderAt("/blog");
    await screen.findByRole("list", { name: "Blog posts" }, { timeout: 5000 });

    await user.click(
      within(screen.getByRole("navigation", { name: "Filter by category" })).getByRole("link", {
        name: "Storage Tips",
      }),
    );

    await waitFor(
      () => {
        const list = within(screen.getByRole("list", { name: "Blog posts" }));
        expect(list.getAllByRole("listitem").length).toBe(1);
      },
      { timeout: 5000 },
    );
    const filtered = within(screen.getByRole("list", { name: "Blog posts" }));
    expect(filtered.getByRole("heading", { name: "How to Store Dry Fruits at Home" })).toBeTruthy();
    expect(filtered.queryByRole("heading", { name: "How to Choose the Right Almonds" })).toBeNull();
  }, 20000);

  it("renders a post body, its reading time and Article JSON-LD", async () => {
    await renderAt("/blog/w320-vs-w240-cashews");
    await screen.findByRole(
      "heading",
      { name: "W320 vs W240 Cashews: What's the Difference?", level: 1 },
      { timeout: 5000 },
    );

    // Content from inside the child route, not merely the route resolving.
    const body = within(screen.getByRole("article"));
    expect(body.getByRole("heading", { name: "What the number counts", level: 2 })).toBeTruthy();
    expect(body.getByText(/Fewer kernels per pound/)).toBeTruthy();
    expect(body.getByText(/^\d+ min read$/)).toBeTruthy();

    const jsonLd = document.getElementById("route-jsonld")?.textContent ?? "";
    expect(jsonLd).toContain('"@type":"Article"');
    expect(jsonLd).toContain("W320 vs W240 Cashews");
    expect(jsonLd).toContain('"articleSection":"Dry Fruit Guides"');

    const related = within(await screen.findByRole("list", { name: "Related posts" }));
    expect(related.getAllByRole("listitem").length).toBe(3);
  }, 20000);
});

/**
 * Brief §22's instant search. The dialog is mounted once in the root layout, so it is
 * reachable from any route — which is what makes the header button and the mobile tab
 * bar able to share it.
 */
describe("instant search", () => {
  it("opens from the header, finds a product, and lists categories and popular searches", async () => {
    const user = userEvent.setup();
    await renderAt("/");
    await screen.findByText(/A little nazaakat/, {}, { timeout: 5000 });

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Search products" }));

    const dialog = within(await screen.findByRole("dialog", {}, { timeout: 5000 }));
    // Brief §22 names these five popular searches.
    for (const s of ["almonds", "premium kaju", "1kg badam", "bulk cashew", "makhana"]) {
      expect(dialog.getByRole("option", { name: s })).toBeTruthy();
    }
    // The category group lands once the catalogue seam resolves.
    expect(await dialog.findByText("Categories", {}, { timeout: 5000 })).toBeTruthy();

    // "walnut" is deliberately not a bestseller, so a hit can only have come from the
    // typed query rather than from the default list shown before anyone types.
    await user.type(dialog.getByPlaceholderText(/Search almonds/), "walnut");

    // The 200ms debounce means every post-typing assertion has to be awaited.
    const hit = await dialog.findByRole(
      "option",
      { name: /California Walnut Kernels/ },
      { timeout: 5000 },
    );
    // The thumbnail is decorative (`alt=""`), so it is queried as an element rather than
    // by role — the product name beside it already carries the meaning.
    expect(hit.querySelector("img")).toBeTruthy();
    expect(hit.textContent).toMatch(/₹\d/);

    expect(await dialog.findByRole("option", { name: /See all results for/ })).toBeTruthy();
    // Popular searches give way to real results once there is a query.
    expect(dialog.queryByRole("option", { name: "premium kaju" })).toBeNull();
  }, 30000);

  it("shows an empty state for a query that matches nothing", async () => {
    const user = userEvent.setup();
    await renderAt("/");
    await screen.findByText(/A little nazaakat/, {}, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Search products" }));

    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.type(within(dialog).getByPlaceholderText(/Search almonds/), "zzzqqq");

    expect(await screen.findByText(/No results for/, {}, { timeout: 5000 })).toBeTruthy();
    expect(within(dialog).queryByRole("option", { name: "almonds" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Browse all products" })).toBeTruthy();
  }, 30000);

  it("opens on the Ctrl-K shortcut", async () => {
    const user = userEvent.setup();
    await renderAt("/shop");
    await screen.findByText("Shop dry fruits", {}, { timeout: 5000 });

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", {}, { timeout: 5000 })).toBeTruthy();
  }, 20000);
});

/**
 * Static content and the legal set.
 *
 * The certification case is the load-bearing one. Brief §25 and §26 say certification
 * information must come from Admin and must not be claimed otherwise, and
 * `settings.certifications` is empty. A badge appearing anywhere on the two pages most
 * likely to grow one is a real defect, not a cosmetic difference.
 */
describe("static and legal pages", () => {
  it("walks the quality page through all six journey steps", async () => {
    await renderAt("/quality");
    await screen.findByRole(
      "heading",
      { name: /Good dry fruit is a supply-chain problem/, level: 1 },
      { timeout: 5000 },
    );

    const journey = within(screen.getByRole("list", { name: "Source to delivery journey" }));
    const steps = journey.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    // Brief §25's order, exactly.
    expect(steps).toEqual([
      "Source",
      "Quality Check",
      "Sorting",
      "Packing",
      "Dispatch",
      "Delivery",
    ]);
  }, 20000);

  it("renders no certification badge while settings.certifications is empty", async () => {
    // `/quality` and `/about` are the two pages that carry the trust block, and the two
    // most likely to grow an invented badge.
    for (const path of ["/quality", "/about"]) {
      await renderAt(path);
      await screen.findByRole("region", { name: "Trust and assurance" }, { timeout: 5000 });

      // The strip only exists once an admin has configured something.
      expect(screen.queryByRole("list", { name: "Certifications" })).toBeNull();
      const rendered = document.body.textContent ?? "";
      for (const claim of FORBIDDEN_CLAIMS) {
        expect({ path, claim: String(claim), matched: claim.test(rendered) }).toEqual({
          path,
          claim: String(claim),
          matched: false,
        });
      }
      cleanup();
    }
  }, 20000);

  it("renders the about page without inventing a founding date", async () => {
    await renderAt("/about");
    await screen.findByRole(
      "heading",
      { name: "Small packs for home. Bulk supply for business.", level: 1 },
      { timeout: 5000 },
    );
    const main = within(screen.getByRole("main"));
    expect(main.getByText(/What we set out to fix/)).toBeTruthy();
    // No "Founded in", "Since 19xx" or "years of experience" anywhere on the page.
    expect(main.queryByText(/\b(founded|established|since 1\d{3}|since 20\d{2})\b/i)).toBeNull();
  }, 20000);

  it("offers a contact form and says so plainly when no contact details are configured", async () => {
    await renderAt("/contact");
    await screen.findByRole("heading", { name: "Talk to us", level: 1 }, { timeout: 5000 });

    expect(screen.getByRole("form", { name: "Contact form" })).toBeTruthy();
    // settings.supportEmail / supportPhone / whatsappNumber are all empty, so the panel
    // must explain itself rather than render an empty card.
    expect(screen.getByText("Contact details coming soon")).toBeTruthy();
  }, 20000);

  it("submits the contact form to the real endpoint and shows the ticket number back", async () => {
    await renderAt("/contact");
    await screen.findByRole("heading", { name: "Talk to us", level: 1 }, { timeout: 5000 });

    await userEvent.type(screen.getByLabelText("Your name"), "Asha Menon");
    await userEvent.type(screen.getByLabelText("Email"), "asha@demo.in");
    await userEvent.selectOptions(
      screen.getByLabelText("What is this about?"),
      "Bulk and wholesale pricing",
    );
    await userEvent.type(
      screen.getByLabelText("Message"),
      "We would like a bulk quote for 200kg of almonds a month.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send Message" }));

    await screen.findByRole("status", {}, { timeout: 5000 });
    expect(screen.getByText(/Quote it if you follow up/)).toBeTruthy();
    expect(contactSubmissions()).toEqual([
      {
        name: "Asha Menon",
        email: "asha@demo.in",
        topic: "Bulk and wholesale pricing",
        message: "We would like a bulk quote for 200kg of almonds a month.",
      },
    ]);
  }, 20000);

  /**
   * `POST /contact` is throttled at five per hour per IP, so a throttled submission is the failure
   * a real visitor is most likely to meet. Before this, `onSubmit` awaited `mutateAsync` with
   * nothing catching it: `handleSubmit` swallows the rejection and the form sits there silently.
   *
   * The two cases are asserted separately because they must not share copy. A 429 is the visitor's
   * own doing and recoverable by waiting; a 500 is ours. Note also that the typed message survives
   * — a form that cleared itself on failure would lose what they wrote.
   */
  it.each([
    [429, /several messages already/i],
    [500, /could not send that just now/i],
  ])(
    "surfaces a %i from the contact endpoint instead of failing silently",
    async (status, copy) => {
      await renderAt("/contact");
      await screen.findByRole("heading", { name: "Talk to us", level: 1 }, { timeout: 5000 });
      // Arranged *after* `renderAt`, not before: it calls `installAuthStub`, which calls
      // `resetContactStub()` and would clear this. Same ordering constraint the catalogue stub
      // carries, for the same reason.
      failNextContactSubmission(status, "nope");

      await userEvent.type(screen.getByLabelText("Your name"), "Asha Menon");
      await userEvent.type(screen.getByLabelText("Email"), "asha@demo.in");
      await userEvent.type(screen.getByLabelText("Message"), "Where is my order, please?");
      await userEvent.click(screen.getByRole("button", { name: "Send Message" }));

      const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
      expect(alert.textContent).toMatch(copy);
      // Not the success panel, and the message they typed is still there to retry with.
      expect(screen.queryByText(/Quote it if you follow up/)).toBeNull();
      expect(screen.getByLabelText("Message")).toHaveValue("Where is my order, please?");
    },
    20000,
  );

  it("renders twelve FAQ questions across the four areas", async () => {
    await renderAt("/faq");
    await screen.findByRole(
      "heading",
      { name: "Frequently asked questions", level: 1 },
      { timeout: 5000 },
    );

    for (const group of ["Ordering", "Shipping", "Bulk and business", "Returns and refunds"]) {
      expect(screen.getByRole("heading", { name: group, level: 2 })).toBeTruthy();
    }
    // Each question is an accordion trigger button.
    const main = within(screen.getByRole("main"));
    expect(main.getAllByRole("button", { expanded: false }).length).toBe(12);
    expect(document.getElementById("route-jsonld")?.textContent).toContain('"@type":"FAQPage"');
  }, 20000);

  it.each([
    ["/shipping", "Shipping Policy"],
    ["/returns", "Returns & Refunds"],
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
  ])(
    "renders %s as a draft-marked legal page",
    async (path, title) => {
      await renderAt(path);
      await screen.findByRole("heading", { name: title, level: 1 }, { timeout: 5000 });
      expect(screen.getByText("Draft — to be reviewed before launch")).toBeTruthy();
      expect(screen.getByText(/^Last updated: /)).toBeTruthy();
      // A draft policy must not be indexable.
      expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
        "noindex,nofollow",
      );
    },
    20000,
  );
});

/**
 * Cart and checkout. The rupee figures below are seed-derived in the same way as the
 * block above: `w320-cashews` is `kg: 1099`, so its 250g pack is ₹329, its 1kg pack is
 * ₹1,099, and the 5–9kg bulk tier resolves to ₹1,044/kg (5kg = ₹5,220). GST is the
 * seed's flat 5%, and shipping is ₹79 below the ₹999 free-shipping threshold.
 */
/**
 * The wishlist, end to end through the real router.
 *
 * `routes.coverage.test.tsx` asserts only that `/wishlist` renders an `<h1>` with text, which a page
 * showing nothing but its heading and an error banner would satisfy. These two pin the content.
 */
describe("the wishlist", () => {
  it("renders a saved product with its heart already filled", async () => {
    await renderAt("/wishlist", undefined, undefined, undefined, undefined, ["w320-cashews"]);

    expect(await screen.findByText("W320 Cashews")).toBeInTheDocument();
    const heart = await screen.findByRole("button", { name: /remove w320 cashews from wishlist/i });
    expect(heart).toHaveAttribute("aria-pressed", "true");
    // The header count, which is the only thing telling a customer the list is not empty before
    // they open it.
    expect(screen.getByRole("link", { name: /wishlist, 1 saved/i })).toBeInTheDocument();
  });

  /**
   * Unsaving from the wishlist page removes the card at once, on the membership set, rather than on
   * the next products read.
   *
   * The products list is frozen after the page has loaded, which is what makes this case able to
   * fail: with `GET /wishlist` and membership in step, the invalidation refetch drops the card either
   * way and the page's filter is invisible. Frozen, only a page that trusts `has()` stops showing a
   * product the customer has just discarded.
   */
  it("drops a product off the page when its heart is unpressed", async () => {
    const user = userEvent.setup();
    await renderAt("/wishlist", undefined, undefined, undefined, undefined, ["w320-cashews"]);
    const heart = await screen.findByRole("button", { name: /remove w320 cashews from wishlist/i });
    freezeWishlistProducts(["w320-cashews"]);

    await user.click(heart);

    await waitFor(() => expect(screen.queryByText("W320 Cashews")).toBeNull());
    expect(screen.getByText(/nothing saved yet/i)).toBeInTheDocument();
  });
});

/**
 * The eight address fields a placement needs, typed the way a customer would.
 *
 * Shared by every case that gets as far as Place Order, because filling the form is most of what
 * those cases cost and none of what they are about. `560001` is Bengaluru — serviceable at four days
 * in the seeded table, so the happy path is not accidentally testing a delivery refusal.
 */
async function fillDeliveryDetails(
  user: ReturnType<typeof userEvent.setup>,
  pincode = "560001",
): Promise<void> {
  await user.type(await screen.findByLabelText("Email"), "asha@example.com");
  await user.type(screen.getByLabelText("Mobile number"), "9876543210");
  await user.type(screen.getByLabelText("Full name"), "Asha Rao");
  await user.type(screen.getByLabelText("Address"), "12 Residency Road");
  await user.type(screen.getByLabelText("City"), "Bengaluru");
  await user.selectOptions(screen.getByLabelText("State"), "Karnataka");
  await user.type(screen.getByLabelText("Pincode"), pincode);
}

/** The header's basket count, which is the only place a customer sees the cart from another page. */
const cartBadge = () => within(screen.getByRole("button", { name: "Open cart" }));

describe("cart and checkout", () => {
  beforeEach(() => {
    // The basket itself lives on the server now and `installAuthStub` resets it; this clears the
    // auth snapshot and the checkout's saved order, which are still local.
    localStorage.clear();
    sessionStorage.clear();
  });

  /**
   * `settings` is a module-level object, so a case that turns a payment method off has to put it
   * back — otherwise the next case renders a checkout with no payment section for no visible reason.
   * The values restored here are the seeded ones: COD on, online off.
   */
  afterEach(() => {
    settings.codEnabled = true;
    settings.onlinePaymentEnabled = false;
  });

  it("carries a retail add-to-cart through to the cart page with the right line total", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    // Related products carry their own Add to Cart; the product's own button is first.
    await user.click(screen.getAllByRole("button", { name: "Add to Cart" })[0]!);
    await user.click(await screen.findByRole("link", { name: "Proceed to Checkout" }));

    await screen.findByRole("heading", { name: "Your Cart", level: 1 });
    const items = cartItems();
    expect(items.getByText("W320 Cashews")).toBeTruthy();
    expect(items.getByText("250g")).toBeTruthy();
    expect(items.getByText("₹329")).toBeTruthy();

    // 329 subtotal + 5% GST (16) + 79 shipping, since 329 is under the ₹999 threshold
    const summary = cartSummary();
    expect(summary.getByText("₹329")).toBeTruthy();
    expect(summary.getByText("₹16")).toBeTruthy();
    expect(summary.getByText("₹424")).toBeTruthy();
    expect(summary.getByText("Add ₹670 more to unlock free shipping.")).toBeTruthy();
  }, 20000);

  it("offers bulk pricing at 5kg and converts the line to the 5–9kg tier", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews");
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    // Related-product cards carry their own "1kg" chip; only the product's own
    // size button spells out the price.
    await user.click(screen.getByRole("button", { name: "1kg₹1,099" }));
    const plus = screen.getByLabelText("Increase quantity");
    for (let i = 0; i < 4; i++) await user.click(plus);

    await user.click(screen.getAllByRole("button", { name: "Add to Cart" })[0]!);
    await user.click(await screen.findByRole("link", { name: "Proceed to Checkout" }));
    await screen.findByRole("heading", { name: "Your Cart", level: 1 });

    // 5 × 1kg = 5000g, exactly the configured bulk prompt threshold
    expect(cartItems().getByText("₹5,495")).toBeTruthy();
    expect(screen.getByText("Buying in bulk? You may qualify for better pricing.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /View Bulk Pricing/ }));

    const items = cartItems();
    expect(items.getByText("Bulk · 5 kg")).toBeTruthy();
    expect(items.getByText("₹5,220")).toBeTruthy();
    expect(screen.queryByText("Buying in bulk? You may qualify for better pricing.")).toBeNull();
  }, 20000);

  it("renders Quote Required and a Request Quote action for a quote-only bulk line", async () => {
    await renderAt("/cart", [{ slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 }]);
    await screen.findByRole("heading", { name: "Your Cart", level: 1 });

    await screen.findByText("Bulk · 60 kg");
    const items = cartItems();
    expect(items.getByText("Quote Required")).toBeTruthy();

    // Checkout stays available — a quote line must not block the rest of the basket.
    expect(screen.getByRole("link", { name: /Proceed to Checkout/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request Quote" })).toBeTruthy();
  }, 20000);

  /**
   * A line whose product has left the catalogue has to be *removable*.
   *
   * The server keeps the row — `cart-read.service.ts` says so at length, and reports it `NOT_FOUND`
   * with no price rather than dropping it, because dropping it would empty every basket an admin's
   * withdrawal touched. So `GET /cart` still carries the line, `count` still counts it, and the cart
   * page used to `return null` on the failed catalogue lookup: the customer got a header badge and a
   * notice about an item they could not see, let alone delete. `3c56549` made that reachable in
   * production by treating an unpublished product as absent.
   *
   * Measured against the running service on `localhost:4400` — `POST /cart/validate` for a slug the
   * catalogue does not hold answers
   * `{"unavailable":true,"availableQty":null,"lineTotal":null,"code":"NOT_FOUND"}` with
   * `hasUnpriceableLines: true`.
   *
   * `kashmiri-walnut-kernels` is deliberately absent from `src/mocks/products.ts`, which is what
   * makes the catalogue lookup fail here the way it fails against a withdrawn product.
   */
  it("renders a removable row for a basket line whose product has left the catalogue", async () => {
    const user = userEvent.setup();
    await renderAt("/cart", [
      { slug: "kashmiri-walnut-kernels", mode: "retail", size: "250g", qty: 2 },
    ]);
    await screen.findByRole("heading", { name: "Your Cart", level: 1 });

    const row = within(await cartItems().findByRole("listitem"));
    expect(row.getByText("This item is no longer available.")).toBeTruthy();
    // Everything shown comes off the `CartLine`: the slug, the pack and the quantity. No name is
    // invented, no image is fabricated, and there is no price because the server has none to give.
    expect(row.getByText("kashmiri-walnut-kernels")).toBeTruthy();
    expect(row.getByText("250g")).toBeTruthy();
    expect(row.getByText("Qty 2")).toBeTruthy();
    expect(row.queryByText(/₹/)).toBeNull();

    await user.click(row.getByRole("button", { name: "Remove kashmiri-walnut-kernels" }));

    // Removable means removed — asserted as the write the client sent *and* the page that follows,
    // because a row that disappears locally while the basket still holds it is the same bug again.
    await waitFor(() => expect(lastCartWrite()).toEqual([]));
    expect(await screen.findByText("Your cart is waiting for something delicious.")).toBeTruthy();
  }, 20000);

  it("offers the same Remove in the cart drawer, which had the identical hole", async () => {
    const user = userEvent.setup();
    await renderAt("/", [{ slug: "kashmiri-walnut-kernels", mode: "bulk", kg: 12, qty: 1 }]);
    await screen.findByRole("button", { name: "Open cart" }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Open cart" }));
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByText("This item is no longer available.")).toBeTruthy();
    expect(drawer.getByText("Bulk · 12 kg")).toBeTruthy();

    await user.click(drawer.getByRole("button", { name: "Remove kashmiri-walnut-kernels" }));
    await waitFor(() => expect(lastCartWrite()).toEqual([]));
  }, 20000);

  /**
   * "No longer available" is a claim about the catalogue, so it may only be made once the catalogue
   * has answered.
   *
   * `products` is an empty array both for a listing that succeeded and for one that failed, and the
   * page reads the difference off the query rather than off the array. Without that distinction one
   * failed `GET /catalog/products?limit=60` would tell every customer that every line in their
   * basket had been withdrawn — a louder lie than the silence this task set out to fix.
   */
  it("claims nothing about a basket line while the catalogue has not answered", async () => {
    await renderAt(
      "/cart",
      [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }],
      undefined,
      undefined,
      undefined,
      undefined,
      "The catalogue is unavailable.",
    );
    await screen.findByRole("heading", { name: "Your Cart", level: 1 });

    // The basket loaded, so the page knows it holds a line; it just cannot name it yet.
    expect(screen.getByText("1 item in your cart")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/no longer available/)).toBeNull());
  }, 20000);

  /**
   * A failed load and a failed write both have to reach the page.
   *
   * Every cart mutator is fire-and-forget at the call site — `onClick={() => void addRetail(...)}` —
   * so a rejected write goes nowhere visible unless something renders `error`. A silent failure here
   * is a customer clicking Add to Cart, seeing nothing happen, and clicking again. And a failed
   * *load* is worse than silent: the page renders the empty-cart copy, so saying nothing tells the
   * customer their basket was lost.
   *
   * These two cases exist because deleting the error rendering outright failed no test — measured.
   */
  it("says so and offers a retry when the basket cannot be loaded", async () => {
    await renderAt("/cart", undefined, undefined, undefined, {
      load: "We could not load your basket.",
    });
    await screen.findByRole("heading", { name: "Your Cart", level: 1 });

    const alert = within(await screen.findByRole("alert"));
    expect(alert.getByText("We could not load your basket.")).toBeTruthy();
    expect(alert.getByRole("button", { name: "Try again" })).toBeTruthy();
  }, 20000);

  it("surfaces a refused add-to-cart on the product page instead of failing silently", async () => {
    const user = userEvent.setup();
    await renderAt("/product/w320-cashews", undefined, undefined, undefined, {
      write: "We no longer stock that.",
    });
    await screen.findByRole("heading", { name: "W320 Cashews", level: 1 }, { timeout: 5000 });

    await user.click(screen.getAllByRole("button", { name: "Add to Cart" })[0]!);

    /*
     * Both surfaces, and the message has to be on each. `addRetail` opens the drawer as well as
     * leaving the customer on the product page, so an unscoped `findByText` matches twice and
     * throws "found multiple elements" — which is how this was found. Partitioned by containment
     * rather than by landmark because Radix marks everything outside the open sheet `aria-hidden`,
     * so `getByRole("main")` cannot reach the page underneath it.
     */
    const matches = await screen.findAllByText("We no longer stock that.", {}, { timeout: 5000 });
    const drawer = screen.getByRole("dialog");
    expect(matches.some((el) => drawer.contains(el))).toBe(true);
    expect(matches.some((el) => !drawer.contains(el))).toBe(true);
  }, 20000);

  it("shows the required empty-cart copy", async () => {
    await renderAt("/cart");
    expect(await screen.findByText("Your cart is waiting for something delicious.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Explore Bestsellers" })).toBeTruthy();
  });

  /**
   * **A basket that has not loaded is not an empty basket**, and they are the same value.
   *
   * `CartProvider` starts at `lines: []` with `isLoading: true`. Keyed off the array alone, both
   * the page and the drawer told a signed-in customer holding a full basket "Your cart is waiting
   * for something delicious." on every visit, until `GET /cart` answered. Milestone 10's E2E suite
   * found it: the copy is indistinguishable from the real empty state, so the suite's basket
   * cleanup silently did nothing and carried a stranded line into the next journey's drawer.
   *
   * Measured before this test existed: removing the guard failed **none** of the 337 tests.
   */
  /**
   * Checkout had the same defect as the cart page and no error surface at all, so a failed
   * `GET /cart` told a customer with a full basket there was nothing to buy — **permanently**,
   * where the cart page's version cleared as soon as the read answered. Found by Milestone 10's
   * security review, which called it the highest-revenue instance of the pattern.
   */
  it("does not tell a checkout customer their basket is empty while it loads", async () => {
    const release = holdCartLoad();
    try {
      await renderAt("/checkout", [
        { slug: "premium-california-almonds", mode: "retail", size: "250g", qty: 1 },
      ]);
      await screen.findByRole("heading", { name: "Checkout", level: 1 }, { timeout: 5000 });

      expect(screen.queryByText("There is nothing to check out yet.")).toBeNull();
      expect(screen.getByRole("status", { name: "Loading your cart" })).toBeTruthy();
    } finally {
      release();
    }
  }, 20000);

  it("does not call a still-loading basket empty", async () => {
    // Arranged before `renderAt` on purpose: `installAuthStub` resets every stub, and this gate is
    // the one thing that deliberately survives that, because a hold set afterwards comes too late.
    const release = holdCartLoad();
    try {
      await renderAt("/cart", [
        { slug: "premium-california-almonds", mode: "retail", size: "250g", qty: 1 },
      ]);
      await screen.findByRole("heading", { name: "Your Cart", level: 1 }, { timeout: 5000 });

      // The read is parked, so this is exactly the state between mount and the first answer.
      expect(screen.queryByText("Your cart is waiting for something delicious.")).toBeNull();
      expect(screen.getByRole("status", { name: "Loading your cart" })).toBeTruthy();
    } finally {
      release();
    }

    // And it delays the verdict rather than suppressing it.
    expect(
      await screen.findByText("Premium California Almonds", {}, { timeout: 5000 }),
    ).toBeTruthy();
  }, 20000);

  /**
   * **Three assertions in here changed with the seam, and each one had been passing for a reason
   * that stopped being true.**
   *
   * *The order id.* This read `/^Order ID: NN-\d{4}-\d{6}$/` — a shape the deleted mock's
   * `Math.floor(Math.random() * 900000) + 100000` satisfied just as well as the server does, so it
   * could not tell a placed order from a client-side invention. It now asserts the id the stub
   * *issued*, and matches `ORDER_NUMBER_PATTERN` from `shared` rather than a hand-written `\d{6}`
   * that contradicted the pattern's deliberate `{6,}`.
   *
   * *The request body.* Nothing could see it before, and no type can: `PlaceOrderRequest`'s
   * optionals accept `string | undefined`, so a client posting `companyName: ""` on a retail order
   * typechecks perfectly and is refused **400** by the real server for a field the customer never
   * saw. `lastPlacement()` is the only thing that can tell, and the stub's own `@MinLength(2)` check
   * is what makes the failure loud rather than silent.
   *
   * *The emptied basket.* It asserted `lastCartWrite()` was `[]` — the client emptying the cart. The
   * server now empties it inside the placement transaction, so the honest claim is the opposite: the
   * client sends **no** basket write at all, and the basket is empty anyway. The header count is
   * asserted with it, because that is where a customer would see a basket that failed to clear.
   */
  it("rejects a bad phone and pincode, then places the order on valid input", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    const phone = await screen.findByLabelText("Mobile number");
    const pincode = screen.getByLabelText("Pincode");
    await user.type(phone, "1234567890");
    await user.type(pincode, "12345");
    await user.click(screen.getByRole("button", { name: "Place Order" }));

    expect(await screen.findByText("Enter a valid 10-digit Indian mobile number")).toBeTruthy();
    expect(screen.getByText("Enter a valid 6-digit pincode")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Order received" })).toBeNull();

    await user.clear(phone);
    await user.type(phone, "9876543210");
    await user.clear(pincode);
    await user.type(pincode, "560001");
    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Full name"), "Asha Rao");
    await user.type(screen.getByLabelText("Address"), "12 Residency Road");
    await user.type(screen.getByLabelText("City"), "Bengaluru");
    await user.selectOptions(screen.getByLabelText("State"), "Karnataka");
    // One line, quantity one — so the badge reads "1" until the order takes the basket away.
    expect(cartBadge().getByText("1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Place Order" }));

    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });
    const issued = issuedOrders();
    expect(issued.length).toBe(1);
    expect(issued[0]!.id).toMatch(ORDER_NUMBER_PATTERN);
    expect(screen.getByText(`Order ID: ${issued[0]!.id}`)).toBeTruthy();
    // The footer also links "Track Order", so scope the confirmation assertions.
    const page = within(screen.getByRole("main"));
    expect(page.getByText("Asha Rao")).toBeTruthy();
    expect(page.getByRole("link", { name: "Continue Shopping" })).toBeTruthy();
    expect(page.getByRole("link", { name: "Track Order" })).toBeTruthy();
    // The **placed order's** money, taken from the response rather than restated as a literal: the
    // confirmation used to render `totals.total`, the client's own arithmetic over its own basket.
    expect(page.getByText(inr(issued[0]!.total))).toBeTruthy();

    // What was actually posted. `cod`, because `"online"` — the old default — is a 422 the moment
    // the field is sent; and not one of the five optionals the B2C form never rendered.
    const sent = lastPlacement();
    expect(sent?.paymentMethod).toBe("cod");
    expect(sent?.shipping).toEqual({
      fullName: "Asha Rao",
      phone: "9876543210",
      email: "asha@example.com",
      line1: "12 Residency Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
    });
    expect(Object.keys(sent ?? {}).sort()).toEqual(["paymentMethod", "shipping"]);

    // Seeded under the key Task 23 will read, so a guest's confirmation survives at all.
    expect(renderedCache().getQueryData(accountKeys.order(issued[0]!.id))).toEqual(issued[0]);

    // The server emptied the basket; the client neither wrote it nor kept showing it.
    expect(lastCartWrite()).toBeUndefined();
    expect(storedCart()).toEqual([]);
    await waitFor(() => expect(cartBadge().queryByText("1")).toBeNull());
  }, 30000);

  /**
   * The business fields a bulk order collects, arriving at the server.
   *
   * They were all validated and then dropped — disagreement 2's other half — so a B2B customer typed
   * a GSTIN into a form that discarded it and got an invoice with no GST number on it. `billing` is
   * unticked deliberately: it is the one field pair the DTO makes conditional (`@ValidateIf`, not
   * `@IsOptional`), so "bill somewhere else" with no address is the one request that must be refused,
   * and the two therefore have to travel together.
   */
  it("sends the business fields a bulk order collects", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    await fillDeliveryDetails(user);
    await user.type(screen.getByLabelText("Company name"), "Anand Sweets");
    await user.type(screen.getByLabelText("GSTIN"), "29abcde1234f1z5");
    await user.type(screen.getByLabelText("PO number (optional)"), "PO-4417");
    await user.type(
      screen.getByLabelText("Special instructions (optional)"),
      "Label each sack with the PO number.",
    );
    await user.click(screen.getByLabelText("Billing address is the same"));
    await user.type(await screen.findByLabelText("Billing name"), "Anand Sweets Accounts");
    await user.type(screen.getByLabelText("Billing phone"), "9845012345");
    await user.type(screen.getByLabelText("Billing email"), "accounts@anand.example");
    await user.type(screen.getByLabelText("Billing address"), "4 Chickpet Main Road");
    await user.type(screen.getByLabelText("Billing city"), "Bengaluru");
    await user.selectOptions(screen.getByLabelText("Billing state"), "Karnataka");
    await user.type(screen.getByLabelText("Billing pincode"), "560053");

    await user.click(screen.getByRole("button", { name: "Place Order" }));

    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });
    const sent = lastPlacement();
    expect(sent?.companyName).toBe("Anand Sweets");
    // Upper-cased on the way into the input, so this is the GSTIN the invoice will carry.
    expect(sent?.gstin).toBe("29ABCDE1234F1Z5");
    expect(sent?.poNumber).toBe("PO-4417");
    expect(sent?.specialInstructions).toBe("Label each sack with the PO number.");
    expect(sent?.billingSameAsShipping).toBe(false);
    expect(sent?.billing?.pincode).toBe("560053");
    // The coupon input was never touched, so no `couponCode: ""` rides along with the rest.
    expect(sent?.couponCode).toBeUndefined();
    // Untouched landmark lines are absent, not empty: `toSnapshot` omits only `undefined`, so a `""`
    // would be *stored* on the invoice snapshot.
    expect(sent?.shipping.line2).toBeUndefined();
    expect(sent?.billing?.line2).toBeUndefined();
  }, 30000);

  /**
   * The other half of "sends what it validates": an optional the customer skipped is **absent**, not
   * an empty string.
   *
   * A bulk basket is what makes this reachable. `b2bCheckoutSchema` declares `poNumber`,
   * `specialInstructions` and `couponCode`, and zod's default `strip` mode therefore keeps them — so
   * a request spread from the parsed values carries `poNumber: ""` and `specialInstructions: ""`,
   * which `PlaceOrderDto` accepts (`@MaxLength` only) and `orders` then **stores**. Empty strings on
   * an invoice are not a 400; they are a row that says the customer supplied a PO number and left it
   * blank.
   *
   * The exact key set rather than a field-by-field check, because what is being asserted is an
   * absence: `expect(sent.poNumber).toBeUndefined()` passes just as happily against a request that
   * misspelt the field.
   */
  it("omits the business optionals a bulk order was not given", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    await fillDeliveryDetails(user);
    await user.type(screen.getByLabelText("Company name"), "Anand Sweets");
    await user.type(screen.getByLabelText("GSTIN"), "29ABCDE1234F1Z5");

    await user.click(screen.getByRole("button", { name: "Place Order" }));

    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });
    expect(Object.keys(lastPlacement() ?? {}).sort()).toEqual([
      "companyName",
      "gstin",
      "paymentMethod",
      "shipping",
    ]);
  }, 30000);

  /**
   * Disagreement 2, from the customer's side: the only card on offer is the one the server accepts.
   *
   * `onlinePaymentEnabled` is seeded `false` and §10.4 requires `POST /checkout/orders` to answer
   * **422 `PAYMENT_METHOD_UNAVAILABLE`** for `"online"` — which was also the form's *default*. While
   * the field was discarded that was harmless; sent, it 422s the happy path. Rendering the card at
   * all shows a customer a door that was never open.
   *
   * The padlock line is asserted here too, because "Payments are simulated in this preview build."
   * was a true statement about a mock and became a false promise about money the moment this button
   * placed a real COD order.
   */
  it("offers cash on delivery only, and says so under the padlock", async () => {
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    const cod = await screen.findByRole("radio", { name: /Cash on Delivery/ });
    expect(cod).toBeChecked();
    expect(screen.queryByText("Pay Online")).toBeNull();
    expect(screen.queryByRole("radio", { name: /Pay Online/ })).toBeNull();

    expect(screen.getByText("Cash on delivery. Nothing is charged online.")).toBeTruthy();
    expect(screen.queryByText(/simulated in this preview build/)).toBeNull();
  }, 20000);

  /**
   * Both methods off is a configuration an admin can reach, so it needs an answer rather than an
   * empty section with a button under it that could only 422.
   *
   * The flags are typed `boolean` on `SiteSettings` — never `true`/`false` literals — precisely so
   * this branch is reachable code a test can enter rather than something a reader has to trust.
   */
  it("says the shop is not taking orders when both payment methods are off", async () => {
    settings.codEnabled = false;
    settings.onlinePaymentEnabled = false;

    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    expect(
      await screen.findByText("We are not taking orders right now. Please try again shortly."),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Place Order" })).toBeDisabled();
  }, 20000);

  /**
   * Disagreement 3's third client-side ETA, which had no owner until this task.
   *
   * `CheckoutForm.tsx:620` was `format(addDays(new Date(), 4), "d MMM yyyy")` — a flat four days
   * with no reference to the customer's pincode. It agreed with the seed by coincidence, because
   * every seeded prefix carries `etaDays: 4`; the column is per-destination and admin-editable, which
   * is the whole argument for its authority, so the first admin to lengthen a remote prefix's ETA
   * would have made this page promise a date the confirmation screen contradicted.
   *
   * Nine days and ₹149 rather than small numbers, for the reason `seedPincodeRule` exists: an
   * expectation that only ever sees the seeded figure cannot tell a response from a constant. The
   * four-day date is asserted **absent** in the same breath, which is what makes the old literal fail
   * rather than merely stop being asserted.
   */
  it("takes the delivery date and charge from the pincode, not from a hardcoded four days", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });
    seedPincodeRule("700001", { serviceable: true, etaDays: 9, shipping: 149 });

    await user.type(screen.getByLabelText("Pincode"), "700001");

    const asDate = (days: number) => format(addDays(new Date(), days), "d MMM yyyy");
    expect(
      await screen.findByText(`Estimated arrival by ${asDate(9)}`, { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByText(`Estimated arrival by ${asDate(4)}`, { exact: false })).toBeNull();
    // ₹329 is under the ₹999 free-shipping threshold, so the per-destination charge is what is
    // billed — `shippingFor`'s rule, which keeps "free" free and otherwise bills the pincode row.
    expect(screen.getAllByText("₹149").length).toBeGreaterThan(0);
    expect(screen.queryByText("₹79")).toBeNull();
    expect(pincodeChecks()).toEqual(["700001"]);
  }, 20000);

  /**
   * The coupon Apply button used to be `onClick={() => setCouponNote(true)}` — pure local state
   * under the words *"We will validate this code against your order before it ships."* Reassuring,
   * and untrue: nothing validated anything, and the summary had no discount row to put an answer in.
   *
   * The total is asserted alongside the row because a discount that is displayed but not subtracted
   * leaves a total that does not equal its own parts: ₹329 − ₹100 + ₹16 GST + ₹79 shipping = ₹324.
   */
  it("applies a coupon against the server and shows the discount in the summary", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });
    // Arranged *after* `renderAt`, like `seedPincodeRule`: `installAuthStub` calls
    // `resetCheckoutStub()`, so a coupon seeded first is silently discarded.
    seedCoupon("SAVE100", {
      eligible: true,
      couponCode: "SAVE100",
      discount: 100,
      eligibleSubtotal: 329,
    });

    const summary = () => within(screen.getByRole("complementary", { name: "Order summary" }));
    expect(summary().queryByText("Discount (SAVE100)")).toBeNull();

    await user.type(screen.getByLabelText("Coupon code"), "save100");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("SAVE100 applied — ₹100 off.")).toBeTruthy();
    expect(summary().getByText("Discount (SAVE100)")).toBeTruthy();
    expect(summary().getByText("−₹100")).toBeTruthy();
    expect(summary().getByText("₹324")).toBeTruthy();
  }, 20000);

  /**
   * Six refusal codes, and only one of them can be answered with a constant sentence.
   *
   * A customer can act on `COUPON_MIN_ORDER_VALUE` — add ₹500 and it works — and cannot act on
   * `COUPON_INVALID`, which is the entire reason `CouponRefusalCode` is a union rather than a
   * boolean. So the minimum-order arm has to carry the *figure*, and both arms are asserted here
   * because a `Record` that mapped every code to one polite sentence would satisfy either alone.
   */
  it("explains why a coupon was refused, with the figure the customer has to reach", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });
    // After `renderAt`, for the reason above: `installAuthStub` resets this stub on install.
    seedCoupon("BIGBASKET", {
      eligible: false,
      reason: "COUPON_MIN_ORDER_VALUE",
      minOrderValue: 1500,
    });

    const code = screen.getByLabelText("Coupon code");
    await user.type(code, "bigbasket");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("That code needs an order of ₹1,500 or more.")).toBeTruthy();
    expect(screen.queryByText(/applied/)).toBeNull();

    // An unseeded code is `COUPON_INVALID`, which is what the real service answers when no row
    // matches — a different sentence, because there is nothing the customer can do about it.
    await user.clear(code);
    await user.type(code, "nosuchcode");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      await screen.findByText("We could not find that code. Check the spelling and try again."),
    ).toBeTruthy();
    expect(screen.queryByText(/needs an order of/)).toBeNull();
  }, 20000);

  /**
   * One `Idempotency-Key` per **attempt**, which is the only rule about it that can go wrong
   * silently.
   *
   * A key minted inside the submit handler gives every click a fresh one and defeats
   * `IdempotencyInterceptor` entirely — the double-clicked Place Order it exists to collapse arrives
   * as two unrelated requests and places two orders. Nothing rendered can tell the two apart, so
   * `idempotencyKeys()` is the only place the rule is observable, and a failed attempt followed by a
   * retry is the only way to observe it: a *successful* placement navigates away, so the form is
   * gone before a second attempt could be made from it.
   */
  it("re-sends the same Idempotency-Key when a refused placement is retried", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });
    // After `renderAt`, for the reason above: `installAuthStub` resets this stub on install.
    failPlacement("Only 0 left of W320 Cashews 250g.");
    await fillDeliveryDetails(user);

    await user.click(screen.getByRole("button", { name: "Place Order" }));
    expect(
      await screen.findByText("Only 0 left of W320 Cashews 250g.", {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(placementRequests()).toEqual([]);

    allowPlacement();
    await user.click(screen.getByRole("button", { name: "Place Order" }));
    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });

    const keys = idempotencyKeys();
    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  }, 30000);

  it("switches checkout to the B2B schema when the cart holds a bulk line", async () => {
    const user = userEvent.setup();
    await renderAt("/checkout", [{ slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 }]);
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    const gstin = await screen.findByLabelText("GSTIN");
    expect(screen.getByLabelText("Company name")).toBeTruthy();
    expect(screen.getByLabelText("PO number (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Special instructions (optional)")).toBeTruthy();

    // lowercase input is upper-cased on the way in, so this is a valid GSTIN
    await user.type(gstin, "29abcde1234f1z5");
    await user.click(screen.getByRole("button", { name: "Place Order" }));
    expect(await screen.findByText("Enter your company name")).toBeTruthy();
    expect(screen.queryByText("Enter a valid 15-character GSTIN")).toBeNull();

    await user.clear(gstin);
    await user.type(gstin, "29ABCDE1234F1Z");
    await user.click(screen.getByRole("button", { name: "Place Order" }));
    expect(await screen.findByText("Enter a valid 15-character GSTIN")).toBeTruthy();

    // unticking the billing checkbox must expose every field addressSchema requires
    await user.click(screen.getByLabelText("Billing address is the same"));
    expect(await screen.findByLabelText("Billing email")).toBeTruthy();
    expect(screen.getByLabelText("Billing state")).toBeTruthy();
  }, 30000);
});

/**
 * The B2B track: bulk catalogue, RFQ and the business bulk cart. The rupee figures are
 * seed-derived exactly as above — `w320-cashews` is `kg: 1099` with `moqKg: 10`, so the
 * opening quantity sits in the 10–24kg tier at 0.9x base (₹989/kg, ₹9,890 for 10kg,
 * ₹1,100 saved against the ₹1,099 base tier) and 50kg lands in the unpriced 50kg+ slab.
 */
describe("bulk catalogue, RFQ and business area", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("prices a bulk catalogue row at its tier and adds that quantity to the cart", async () => {
    const user = userEvent.setup();
    await renderAt("/bulk/cashews");

    const card = (await screen.findByRole("heading", { name: "W320 Cashews" })).closest("li")!;
    const row = within(card);
    expect(row.getByText("₹989 / kg")).toBeTruthy();
    expect(row.getByText("₹9,890 + GST")).toBeTruthy();
    expect(row.getByText("You save ₹1,100")).toBeTruthy();
    expect(row.getByLabelText("Quantity for W320 Cashews").textContent).toBe("10 kg");

    await user.click(row.getByRole("button", { name: "Add to Bulk Cart" }));

    // The request carries `kg` and no `id`; the stored line carries the identity the server
    // composes from it. `b:w320-cashews:10` is what a validation verdict is joined on.
    await waitFor(() =>
      expect(lastCartWrite()).toEqual([{ slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 }]),
    );
    expect(storedCart()).toEqual([
      { id: "b:w320-cashews:10", slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 },
    ]);
  }, 20000);

  it("drops a bulk catalogue row to Request Quote once the quantity clears the slabs", async () => {
    const user = userEvent.setup();
    await renderAt("/bulk/cashews");
    const card = (await screen.findByRole("heading", { name: "W320 Cashews" })).closest("li")!;
    const row = within(card);

    // 10kg → 50kg is eight 5kg steps, and 50kg+ is the tier with no published rate.
    const plus = row.getByLabelText("Increase quantity for W320 Cashews");
    for (let i = 0; i < 8; i++) await user.click(plus);

    expect(row.getByLabelText("Quantity for W320 Cashews").textContent).toBe("50 kg");
    expect(row.getByText("Custom quote")).toBeTruthy();
    expect(row.getByRole("link", { name: "Request Quote" })).toBeTruthy();
    expect(row.queryByRole("button", { name: "Add to Bulk Cart" })).toBeNull();
    // Nothing was added, so the client never wrote at all — the honest form of "the stored basket is
    // empty" now that the basket is the server's. `cartWrites()` empty is stronger than an empty
    // stored cart, which an unsent write and a rejected one would both satisfy.
    expect(cartWrites()).toEqual([]);
    expect(storedCart()).toEqual([]);
  }, 20000);

  it("prefills the RFQ form from the product and kg search params", async () => {
    await renderAt("/business/rfqs/new?product=w320-cashews&kg=60", undefined, "b2b");
    await screen.findByRole("heading", { name: "Request a Quote", level: 1 }, { timeout: 5000 });

    // The product options come from the catalogue seam, so wait for them to land.
    await screen.findByRole("option", { name: "W320 Cashews" }, { timeout: 5000 });
    const product = screen.getAllByLabelText("Product")[0] as HTMLSelectElement;
    const kg = screen.getAllByLabelText("Quantity (kg)")[0] as HTMLInputElement;
    expect(product.value).toBe("w320-cashews");
    expect(kg.value).toBe("60");
  }, 20000);

  it("submits an RFQ and returns a numbered confirmation", async () => {
    const user = userEvent.setup();
    await renderAt("/business/rfqs/new?product=w320-cashews&kg=60", undefined, "b2b");
    await screen.findByRole("option", { name: "W320 Cashews" }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Business name"), "Anand Sweets");
    await user.type(screen.getByLabelText("Contact person"), "Rakesh Anand");
    await user.type(screen.getByLabelText("Mobile number"), "9845012345");
    await user.type(screen.getByLabelText("Email"), "buyer@anandsweets.example");
    await user.selectOptions(screen.getByLabelText("Business type"), "Sweet shop");
    await user.type(screen.getByLabelText("Delivery pincode"), "560004");

    await user.click(screen.getByRole("button", { name: "Request Bulk Quote" }));

    await screen.findByRole(
      "heading",
      { name: "Quote Request Submitted", level: 1 },
      { timeout: 5000 },
    );
    // Not only the pattern — the exact number this stub minted, so a client that still sends the
    // request but overrides the response's own `id` on the way to the screen cannot pass by
    // rendering a value that merely *shapes* like a real one.
    expect(screen.getByText(`RFQ-${String(new Date().getFullYear())}-100001`)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View this request" })).toBeTruthy();

    // The number on screen is the one the stub minted, not one `rfqApi.create` invented itself —
    // provable only by checking a request actually reached `POST /rfqs`, carrying the fields the
    // form collected. A reverted seam renders the identical heading from a client-side object and
    // this array stays empty.
    expect(rfqCreateRequests()).toEqual([
      {
        businessName: "Anand Sweets",
        contactPerson: "Rakesh Anand",
        mobile: "9845012345",
        email: "buyer@anandsweets.example",
        businessType: "Sweet shop",
        pincode: "560004",
        lines: [{ productSlug: "w320-cashews", kg: 60 }],
        packaging: "No preference",
        frequency: "One-time",
      },
    ]);
  }, 30000);

  /**
   * `GET /rfqs`'s row shape carries all seven statuses `ck_rfqs_status` enforces — Task 7's
   * fix for the frontend's old four-value guess, under which `negotiation` had no label at all
   * and this list would have rendered nothing where the badge now sits. Also proves the read is
   * scoped to the caller: a prospect's enquiry, owned by nobody, must not appear.
   */
  it("lists the caller's own RFQs from the server, including a status the old union could not render", async () => {
    const mine: RfqDetail = {
      id: "RFQ-2026-100050",
      kind: "bulk",
      status: "negotiation",
      businessName: "Anand Sweets & Namkeen",
      createdAt: "2026-08-11T06:20:00.000Z",
      contactPerson: "Rakesh Anand",
      mobile: "9845012345",
      email: "purchase@anandsweets.example",
      businessType: "Sweet shop",
      pincode: "560004",
      packaging: "Bulk sacks (25 kg)",
      frequency: "Monthly",
      lines: [{ productSlug: "w320-cashews", kg: 120 }],
    };
    const stranger: RfqDetail = {
      id: "RFQ-2026-100051",
      kind: "gifting",
      status: "new",
      businessName: "Crumb & Co Bakery",
      createdAt: "2026-07-29T11:05:00.000Z",
      contactPerson: "Priya Menon",
      mobile: "9820098200",
      email: "priya@crumbandco.example",
      businessType: "Bakery",
      pincode: "400050",
      lines: [],
    };

    await renderAt("/business/rfqs", undefined, "b2b", undefined, undefined, undefined, undefined, [
      { rfq: mine, owner: "b2b@demo.in" },
      { rfq: stranger, owner: null },
    ]);

    await screen.findByRole("heading", { name: "Quote Requests", level: 1 }, { timeout: 5000 });
    const row = (await screen.findByText("RFQ-2026-100050")).closest("li")!;
    expect(within(row).getByText("In progress")).toBeTruthy();
    expect(within(row).getByText("Bulk quote request")).toBeTruthy();
    expect(screen.queryByText("RFQ-2026-100051")).toBeNull();
  }, 20000);

  it("marks a quote-required bulk cart line and switches the CTA to Request Quote", async () => {
    await renderAt(
      "/business/bulk-cart",
      [{ slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 }],
      "b2b",
    );
    await screen.findByRole("heading", { name: "Bulk Cart", level: 1 }, { timeout: 5000 });

    const table = within(screen.getByRole("region", { name: "Bulk cart lines" }));
    expect(await table.findByText("W320 Cashews")).toBeTruthy();
    expect(table.getByLabelText("Quantity of W320 Cashews").textContent).toBe("60 kg");
    // Price/kg and Subtotal both fall back to the quote wording.
    expect(table.getAllByText("Quote Required").length).toBe(2);

    const summary = within(screen.getByRole("complementary", { name: "Bulk order summary" }));
    expect(summary.getByRole("link", { name: /Request Quote for these items/ })).toBeTruthy();
    expect(summary.queryByRole("link", { name: /Proceed to Bulk Checkout/ })).toBeNull();
  }, 20000);

  it("prices a bulk cart line inside a published slab and offers bulk checkout", async () => {
    await renderAt(
      "/business/bulk-cart",
      [{ slug: "w320-cashews", mode: "bulk", kg: 25, qty: 1 }],
      "b2b",
    );
    await screen.findByRole("heading", { name: "Bulk Cart", level: 1 }, { timeout: 5000 });

    // 25kg sits in the 25–49kg tier at 0.85x the ₹1,099 base → ₹934/kg, ₹23,350.
    const table = within(screen.getByRole("region", { name: "Bulk cart lines" }));
    expect(await table.findByText("₹934")).toBeTruthy();
    expect(table.getByText("₹23,350")).toBeTruthy();

    const summary = within(screen.getByRole("complementary", { name: "Bulk order summary" }));
    expect(summary.getByText("₹23,350")).toBeTruthy();
    // flat 5% GST on the seed catalogue
    expect(summary.getByText("₹1,168")).toBeTruthy();
    expect(summary.getByRole("link", { name: /Proceed to Bulk Checkout/ })).toBeTruthy();
    // Task 19: no endpoint totals a subset of the basket, so this figure is labelled as such
    // rather than presented as though it were the order's own authoritative total.
    expect(summary.getByText(/Indicative/)).toBeTruthy();
  }, 20000);
});

/**
 * The business profile — Task 18's rewiring off `nn.business-profile.v1`, the last
 * `localStorage` overlay in the tree.
 */
describe("business profile", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  /** A newly "registered" business with no seeded address book — `mocks/addresses.ts`'s
   * `addressBook` has no entry for this email, so its book is genuinely empty rather than
   * merely unseeded. Not one of the three named fixture sessions, so passed to `renderAt` as a
   * bare `User` rather than a shorthand key. */
  const FRESH_BUSINESS: User = {
    id: "usr-b2b-fresh",
    name: "Nasreen Qureshi",
    email: "nasreen@freshbiz.example",
    phone: "9812345670",
    role: "b2b",
    company: {
      companyName: "Fresh Biz Traders",
      contactPerson: "Nasreen Qureshi",
      businessType: "Distributor",
    },
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  it("loads the seeded profile from the server, never from localStorage", async () => {
    await renderAt("/business/profile", undefined, "b2b");
    await screen.findByRole("heading", { name: "Business Profile", level: 1 }, { timeout: 5000 });

    expect(await screen.findByDisplayValue("Anand Sweets & Namkeen")).toBeTruthy();
    expect(screen.getByDisplayValue("Rakesh Anand")).toBeTruthy();
    expect(screen.getByDisplayValue("9845012345")).toBeTruthy();
    expect(screen.getByDisplayValue("29ABCDE1234F1Z5")).toBeTruthy();
    expect((screen.getByLabelText("Billing address") as HTMLSelectElement).value).toBe(
      seedAddressId("b2b@demo.in", "Warehouse"),
    );

    // The key this page used to read and write is gone — nothing here ever touches it.
    expect(localStorage.getItem("nn.business-profile.v1")).toBeNull();
  }, 20000);

  it("saves through PUT /business/me and renders what the server saved back", async () => {
    const user = userEvent.setup();
    await renderAt("/business/profile", undefined, "b2b");
    await screen.findByDisplayValue("Anand Sweets & Namkeen", {}, { timeout: 5000 });

    const companyName = screen.getByLabelText("Company name");
    await user.clear(companyName);
    await user.type(companyName, "Anand Sweets & Namkeen Pvt Ltd");
    await user.click(screen.getByRole("button", { name: "Save Profile" }));

    await screen.findByText("Business profile saved", {}, { timeout: 5000 });
    expect(businessUpdateRequests()).toEqual([
      {
        companyName: "Anand Sweets & Namkeen Pvt Ltd",
        contactPerson: "Rakesh Anand",
        mobile: "9845012345",
        gstin: "29ABCDE1234F1Z5",
        businessType: "Sweet shop",
        billingAddressId: seedAddressId("b2b@demo.in", "Warehouse"),
        shippingAddressId: seedAddressId("b2b@demo.in", "Warehouse"),
      },
    ]);
    expect(screen.getByDisplayValue("Anand Sweets & Namkeen Pvt Ltd")).toBeTruthy();
  }, 20000);

  it("shows a 400 as an error and keeps the customer's input, rather than losing it", async () => {
    const user = userEvent.setup();
    await renderAt("/business/profile", undefined, "b2b");
    await screen.findByDisplayValue("Anand Sweets & Namkeen", {}, { timeout: 5000 });
    // Arranged after `renderAt`, not before: `installAuthStub` (which it calls) resets the
    // business stub, which would otherwise discard this the moment the page mounted.
    failBusinessUpdate("That business type is not one we recognise.");

    const companyName = screen.getByLabelText("Company name");
    await user.clear(companyName);
    await user.type(companyName, "A Name The Save Will Fail On");
    await user.click(screen.getByRole("button", { name: "Save Profile" }));

    expect(
      await screen.findByText("That business type is not one we recognise.", {}, { timeout: 5000 }),
    ).toBeTruthy();
    // Still there — a failed save must not clear what the customer typed.
    expect(screen.getByDisplayValue("A Name The Save Will Fail On")).toBeTruthy();
  }, 20000);

  it("renders a link, not an empty select, for a business with no saved addresses", async () => {
    await renderAt("/business/profile", undefined, FRESH_BUSINESS);
    await screen.findByRole("heading", { name: "Business Profile", level: 1 }, { timeout: 5000 });
    await screen.findByDisplayValue("Fresh Biz Traders", {}, { timeout: 5000 });

    expect(screen.queryByLabelText("Billing address")).toBeNull();
    expect(screen.queryByLabelText("Shipping address")).toBeNull();
    expect(screen.getAllByText(/You have no saved addresses yet\./).length).toBe(2);
    expect(screen.getAllByRole("link", { name: "Add one" }).length).toBe(2);
  }, 20000);

  it("renders a placeholder, selected, when the book has addresses but neither is chosen", async () => {
    const unchosen: BusinessProfile = {
      companyName: "Fresh Biz Traders",
      contactPerson: "Nasreen Qureshi",
      mobile: "",
      businessType: "Distributor",
      billingAddress: null,
      shippingAddress: null,
    };
    // b2b@demo.in's own seeded book stands in for "a book with addresses" — only the profile's
    // own references are overridden to null, which is the one thing this test is about.
    await renderAt(
      "/business/profile",
      undefined,
      "b2b",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      unchosen,
    );
    await screen.findByRole("heading", { name: "Business Profile", level: 1 }, { timeout: 5000 });

    const billing = (await screen.findByLabelText(
      "Billing address",
      {},
      { timeout: 5000 },
    )) as HTMLSelectElement;
    expect(billing.value).toBe("");
    expect(within(billing).getByText("Not set")).toBeTruthy();
    const shipping = screen.getByLabelText("Shipping address") as HTMLSelectElement;
    expect(shipping.value).toBe("");
  }, 20000);
});

/**
 * Auth, the account area and the `/business` guard.
 *
 * Every case starts from a cleared localStorage: the session snapshot persists there, so
 * one signed-in test would otherwise authorise the next one.
 *
 * The rupee figures come from `src/mocks/orders.ts`, whose line totals are the seed
 * catalogue's own prices — ₹77,348 is the two seeded bulk orders added together
 * (₹40,572 + ₹36,776), which is what proves the business dashboard reads the orders API
 * rather than the zeros Milestone 4 left there.
 *
 * That API is `GET /account/orders` now, answered by `account-api.stub.ts` out of the very
 * same six-order fixture — so the figure did not move, and **disagreement 5's prediction
 * that it would was wrong, measured.** Every seeded line total is a whole number of rupees,
 * 5% of a whole rupee is exact to the paise, so per-line GST equals GST on the aggregate on
 * all six orders; and `inr()` rounds, so the server's paise and the mock's rupees render the
 * identical string. Do not "correct" ₹77,348 to ₹77,349.
 *
 * What *did* change is who decides whose orders these are. The mock filtered a client-side
 * array by an `email` argument; the endpoint scopes by `user_id` from the session and
 * `OrderFilters` has no email field at all (spec §13). So `NN-2026-005042` being absent from
 * a retail customer's list below is a server-side refusal now, not a client-side filter.
 */
describe("auth, account area and the business guard", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("sends an anonymous visitor from /account to sign-in, carrying the redirect", async () => {
    await renderAt("/account");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });
    expect(screen.getByText(/Sign in to continue to \/account/)).toBeTruthy();
    // Phase 1 published the fixture logins on this screen because auth was a mock. Auth is real
    // now, so the screen must not advertise credentials — assert their absence, not their presence.
    expect(screen.queryByText("b2c@demo.in")).toBeNull();
    expect(screen.queryByText(/Demo accounts/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Overview", level: 1 })).toBeNull();
  }, 20000);

  it("signs a retail customer in and shows their seeded orders", async () => {
    const user = userEvent.setup();
    await renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Email"), "b2c@demo.in");
    await user.type(screen.getByLabelText("Password"), STUB_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByRole("heading", { name: "Overview", level: 1 }, { timeout: 5000 });
    const recent = within(await screen.findByRole("region", { name: "Recent orders" }));
    expect(recent.getByText("NN-2026-005107")).toBeTruthy();
    expect(recent.getByText("Out for delivery")).toBeTruthy();
    // The welcome toast had no test until the admin branch was added directly above it — so
    // deleting it would have been silent. It greets by first name only.
    expect(await screen.findByText("Welcome back, Asha", {}, { timeout: 5000 })).toBeTruthy();
  }, 30000);

  /**
   * The admin console is a separate application in its own repository, so this app has nowhere to
   * send an admin *inside* itself. `requireAuth` only checks that a snapshot exists, so before this
   * an admin signing in passed the `/account` guard and landed on a customer dashboard offering to
   * track their orders and manage their delivery addresses.
   */
  it("does not drop an admin into the customer account area", async () => {
    // VITE_ADMIN_APP_URL is unset under Vitest, so the honest outcome is an explanation rather than a
    // navigation to a URL that is not listening. What must not happen is landing on /account.
    const user = userEvent.setup();
    await renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Email"), "admin@demo.in");
    await user.type(screen.getByLabelText("Password"), STUB_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert).toHaveTextContent(/admin console/i);
    // `/account` renders `<h1>Overview</h1>` — the suite already keys on it just above for the
    // successful b2c sign-in. Its *absence* is the assertion that the admin did not land there.
    // `window.location.pathname` would be worthless here: the router runs on `createMemoryHistory`,
    // so jsdom's URL never changes and `not.toBe("/account")` is true no matter what the code does.
    expect(screen.queryByRole("heading", { name: "Overview", level: 1 })).toBeNull();
  }, 30000);

  /**
   * The other half of the same defect, and the half the sign-in redirect does not reach.
   *
   * `requireAuth` (`features/auth/guards.ts`) checks that *someone* is signed in, not who — so an
   * admin who navigates to `/account` directly, or who arrives holding a snapshot from an earlier
   * session, was shown "Track orders, manage addresses and keep your details current": exactly the
   * screen the separate admin console exists to replace. Fixing `LoginForm` only closes the path
   * through the sign-in form.
   *
   * `seedAuth: "admin"` writes the snapshot and the session cookies before the route loads, which is
   * precisely the arrangement the guard has to refuse.
   */
  it("keeps an admin out of /account even when they arrive holding a session", async () => {
    await renderAt("/account", undefined, "admin");
    expect(screen.queryByRole("heading", { name: "Overview", level: 1 })).toBeNull();
    // Not merely "no Overview heading": the whole layout must be gone, chrome included.
    expect(screen.queryByRole("navigation", { name: "Account" })).toBeNull();
    expect(screen.queryByText(/Signed in as admin@demo.in/i)).toBeNull();
  }, 30000);

  /**
   * The guard must not become "reject everyone", which would pass the test above while breaking the
   * feature. A retail customer arriving the same way still reaches their account.
   */
  it("still admits a retail customer who arrives holding a session", async () => {
    await renderAt("/account", undefined, "b2c");
    expect(
      await screen.findByRole("heading", { name: "Overview", level: 1 }, { timeout: 5000 }),
    ).toBeTruthy();
  }, 30000);

  it("gives one message for a wrong password and for an unknown address alike", async () => {
    const user = userEvent.setup();
    await renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Email"), "b2c@demo.in");
    await user.type(screen.getByLabelText("Password"), "NotThePassword1!");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert).toHaveTextContent("Invalid email or password.");
    expect(screen.getByRole("heading", { name: "Sign in", level: 1 })).toBeTruthy();

    // Spec §13: an address that is not registered must be indistinguishable from a wrong
    // password, or the sign-in form becomes an account-existence oracle.
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "nobody@demo.in");
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toHaveTextContent(
      "Invalid email or password.",
    );
  }, 30000);

  it("signs a customer out and leaves nothing behind to hydrate from", async () => {
    const user = userEvent.setup();
    await renderAt("/account", undefined, "b2c");
    await screen.findByRole("heading", { name: "Overview", level: 1 }, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: "Log out" }));

    // Back on the storefront.
    await screen.findByText(/A little nazaakat/, {}, { timeout: 5000 });

    // The display snapshot is gone, so a reload has nothing to paint an account with.
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull();

    /**
     * And the request genuinely succeeded. This is the assertion that distinguishes a real
     * sign-out from a local one: the provider clears its snapshot in a `finally`, so a rejected
     * `POST /auth/logout` looks identical on screen. The stub only clears `nn_csrf` — mirroring
     * `CookieService.clear` — when the call passed the CSRF check, so an empty cookie is proof
     * the client echoed the token and the session row was revoked.
     */
    expect(document.cookie).not.toContain("nn_csrf=stub-csrf-token");
  }, 30000);

  it("lists every order on the account for a signed-in customer", async () => {
    await renderAt("/account/orders", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Orders", level: 1 }, { timeout: 5000 });

    const table = within(await screen.findByRole("region", { name: "Your orders" }));
    // The four retail orders belong to b2c@demo.in; the two bulk ones do not — and that is the
    // *server's* answer now rather than a client-side filter on an email the client supplied.
    expect(table.getByText("NN-2026-004821")).toBeTruthy();
    expect(table.getByText("NN-2026-004977")).toBeTruthy();
    expect(table.getByText("Refunded")).toBeTruthy();
    expect(table.queryByText("NN-2026-005042")).toBeNull();
    // No channel, and no email: `GET /account/orders` with an empty query string.
    expect(orderListQueries()).toEqual([{}]);
  }, 20000);

  it("renders an order's status timeline and disables Download Invoice", async () => {
    await renderAt("/account/orders/NN-2026-004821", undefined, "b2c");
    await screen.findByRole(
      "heading",
      { name: "Order NN-2026-004821", level: 1 },
      { timeout: 5000 },
    );

    const timeline = within(screen.getByRole("list", { name: "Status timeline" }));
    expect(timeline.getAllByRole("listitem").length).toBe(7);
    expect(timeline.getByText("Payment pending")).toBeTruthy();
    expect(timeline.getByText("Out for delivery")).toBeTruthy();
    expect(timeline.getByText("Delivered")).toBeTruthy();

    const items = within(screen.getByRole("region", { name: "Order items" }));
    expect(items.getByText("W320 Cashews")).toBeTruthy();
    // 2 × the seed's ₹599 500g pack
    expect(items.getByText("₹1,198")).toBeTruthy();

    expect(screen.getByText("12 Residency Road")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download Invoice/ })).toBeDisabled();
    /**
     * **And no Cancel Order button**, because this order is `delivered`.
     *
     * The gate is `nextStatuses(channel, status).includes("cancelled")` over `@/contract`'s own
     * map, which for `delivered` answers `["refunded"]` — a move only an admin may make. A button
     * rendered here would offer the customer a request the server answers 422 to, and one wired to a
     * status taken from `nextStatuses(...)` rather than to the literal `cancelled` would offer them a
     * **refund**.
     */
    expect(screen.queryByRole("button", { name: /Cancel Order/ })).toBeNull();
  }, 20000);

  it("renders the address book with its default entry", async () => {
    await renderAt("/account/addresses", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Addresses", level: 1 }, { timeout: 5000 });

    const book = within(await screen.findByRole("list", { name: "Saved addresses" }));
    expect(book.getByText("Home")).toBeTruthy();
    expect(book.getByText("Office")).toBeTruthy();
    expect(book.getByText("Default")).toBeTruthy();

    /**
     * **The read carries no email**, and this is the only assertion that can see it.
     *
     * `useAddresses(email)` used to key its query on the signed-in address and pass it to a mock that
     * filtered a client-side book by it. As a server route that argument is spec §13's IDOR hole — a
     * client naming the account it reads — and it is invisible on screen: the page renders identically
     * whether or not the parameter goes out, because the server ignores what it does not accept and
     * `forbidNonWhitelisted` would answer 400 to what it does. `/account/addresses` and nothing else.
     */
    expect(addressReads()).toEqual(["/account/addresses"]);
  }, 20000);

  /**
   * The eight fields the address form needs, plus its name — typed the way a customer would.
   *
   * `Landmark (optional)` is deliberately left untouched, which is the case that matters: the form's
   * `emptyValues` sets `line2: ""`, and `@IsOptional()` accepts an empty string because it is a
   * *present* value, so an untouched second line reaches the column unless the server normalises it.
   */
  async function fillAddressForm(
    user: ReturnType<typeof userEvent.setup>,
    label: string,
  ): Promise<void> {
    await user.type(await screen.findByLabelText("Address name"), label);
    await user.type(screen.getByLabelText("Full name"), "Asha Rao");
    await user.type(screen.getByLabelText("Mobile number"), "9876543210");
    await user.type(screen.getByLabelText("Email"), "b2c@demo.in");
    await user.type(screen.getByLabelText("Address"), "9 Langford Road");
    await user.type(screen.getByLabelText("City"), "Bengaluru");
    await user.selectOptions(screen.getByLabelText("State"), "Karnataka");
    await user.type(screen.getByLabelText("Pincode"), "560027");
  }

  /**
   * **A new address is a `POST` with no id in it.**
   *
   * The page used to mint `` `adr-${Date.now().toString(36)}` `` and send it, so that every save could
   * be an upsert against a client-side array. Two things were wrong with that and only one is visible
   * on screen: the value collides for two addresses saved in the same millisecond, and it is not a
   * uuid, so against the real `addresses.id` column it is a 400 from `ParseUUIDPipe` — or, without
   * that pipe, SQLSTATE `22P02` and a 500. The card appearing proves the round trip; `addressWrites()`
   * is what proves the request carried no id, which a page that patched its own cache would fake
   * perfectly.
   */
  it("saves a new address without minting an id for it", async () => {
    const user = userEvent.setup();
    await renderAt("/account/addresses", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Addresses", level: 1 }, { timeout: 5000 });

    await fillAddressForm(user, "Studio");
    await user.click(screen.getByRole("button", { name: "Add Address" }));

    const book = within(await screen.findByRole("list", { name: "Saved addresses" }));
    await waitFor(() => expect(book.getByText("Studio")).toBeTruthy());

    expect(addressWrites()).toHaveLength(1);
    const [write] = addressWrites();
    expect(write?.method).toBe("POST");
    expect(write?.path).toBe("/account/addresses");
    expect(write?.body).not.toHaveProperty("id");
    // The whole form, sent — the mock used to receive an object the page had assembled itself.
    expect(write?.body).toMatchObject({ label: "Studio", city: "Bengaluru", pincode: "560027" });
  }, 20000);

  /**
   * **An edit is a `PATCH` on the address's own id, not a second address.**
   *
   * The id is in the path and never in the body: two identifiers for one row is where they disagree,
   * and the server answers 400 to a body that carries one. The book staying at two entries is what
   * separates a patch from an upsert that failed to match.
   */
  it("edits an address in place rather than adding a second one", async () => {
    const user = userEvent.setup();
    await renderAt("/account/addresses", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Addresses", level: 1 }, { timeout: 5000 });
    // After `renderAt`, because `installAuthStub` resets the stub's book — a case that read an id
    // beforehand would be reading whatever the *previous* test left behind.
    const officeId = seedAddressId("b2c@demo.in", "Office");

    const book = within(await screen.findByRole("list", { name: "Saved addresses" }));
    await user.click(book.getAllByRole("button", { name: /Edit/ })[1]!);
    await user.clear(await screen.findByLabelText("Address name"));
    await user.type(screen.getByLabelText("Address name"), "Studio office");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => expect(book.getByText("Studio office")).toBeTruthy());
    expect(book.queryByText("Office")).toBeNull();
    expect(book.getAllByRole("listitem")).toHaveLength(2);

    expect(addressWrites()).toEqual([
      {
        method: "PATCH",
        path: `/account/addresses/${officeId}`,
        body: expect.objectContaining({ label: "Studio office" }),
      },
    ]);
    expect(addressWrites()[0]?.body).not.toHaveProperty("id");
  }, 20000);

  /**
   * **The badge moves because the server said so.**
   *
   * Every one of these mutations answers the *whole book* and the hook writes that answer straight into
   * the query cache, which is exactly why the recorded request matters: a page that flipped its own
   * copy of `isDefault` would look identical, and the next reload would show the badge back where it
   * started.
   */
  it("makes another address the default", async () => {
    const user = userEvent.setup();
    await renderAt("/account/addresses", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Addresses", level: 1 }, { timeout: 5000 });
    const officeId = seedAddressId("b2c@demo.in", "Office");

    const book = within(await screen.findByRole("list", { name: "Saved addresses" }));
    await user.click(book.getByRole("button", { name: /Make default/ }));

    // Default first, as the server orders the book, so the promoted address is now the first card.
    await waitFor(() =>
      expect(within(book.getAllByRole("listitem")[0]!).getByText("Office")).toBeTruthy(),
    );

    expect(addressWrites()).toEqual([
      { method: "POST", path: `/account/addresses/${officeId}/default`, body: undefined },
    ]);
  }, 20000);

  /**
   * A remove is a `DELETE`, and it is **soft** on the server — the row survives so a restore is
   * possible, and explicitly not to protect order history, which holds an `addressSnapshot` and never
   * references this table. From the page all that shows is the card going and not coming back.
   */
  it("removes an address", async () => {
    const user = userEvent.setup();
    await renderAt("/account/addresses", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Addresses", level: 1 }, { timeout: 5000 });
    const officeId = seedAddressId("b2c@demo.in", "Office");

    const book = within(await screen.findByRole("list", { name: "Saved addresses" }));
    await user.click(book.getByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(book.queryByText("Office")).toBeNull());
    expect(book.getAllByRole("listitem")).toHaveLength(1);

    expect(addressWrites()).toEqual([
      { method: "DELETE", path: `/account/addresses/${officeId}`, body: undefined },
    ]);
  }, 20000);

  /**
   * **Two of the three inputs open here, and the email’s staying shut is the assertion.**
   *
   * All three were `readOnly disabled` while there was no endpoint, so this case reads the opposite way
   * round from "the screen gains editable fields": what has to be pinned is which one did *not* open.
   * The email is different in kind rather than in readiness — it is the login identifier,
   * `uq_users_email` is a case-insensitive unique index on it, and changing it is an account-recovery
   * flow with verification. `UpdateProfileDto` declares no `email` at all, so a body carrying one is a
   * 400; the disabled input is the explanation, not the enforcement.
   */
  it("renders the profile with an editable name and phone and a locked sign-in email", async () => {
    await renderAt("/account/profile", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Profile", level: 1 }, { timeout: 5000 });

    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Asha Rao");
    expect(screen.getByLabelText("Full name")).toBeEnabled();
    expect((screen.getByLabelText("Mobile number") as HTMLInputElement).value).toBe("9876543210");
    expect(screen.getByLabelText("Mobile number")).toBeEnabled();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enable business buying" })).toBeTruthy();
  }, 20000);

  /**
   * The edit, end to end — and **the recorded request is the load-bearing assertion**, more so here
   * than on any other screen in this suite.
   *
   * This form renders its inputs from its own `useForm` state, so a *Save changes* wired to nothing at
   * all would leave the typed name on screen, fire the success toast and be indistinguishable from a
   * save that reached the server. `profileWrites()` is the only thing that can tell them apart. It also
   * shows the request’s *shape*: the body carries `name` and `phone` and **no `email`**, on a form
   * that renders an email input right below them.
   *
   * The snapshot is the second half. `AuthProvider.updateProfile` persists the server’s answer, which
   * is what `beforeLoad` guards read and what makes the next first paint right — a name changed only
   * in React state would revert on reload, which is precisely what the deleted Phase 1 form did in
   * reverse: it wrote localStorage and lost the change on the next `GET /auth/me`.
   */
  it("saves a new name and mobile number against the server", async () => {
    const user = userEvent.setup();
    await renderAt("/account/profile", undefined, "b2c");
    await screen.findByRole("heading", { name: "Your Profile", level: 1 }, { timeout: 5000 });

    await user.clear(screen.getByLabelText("Full name"));
    await user.type(screen.getByLabelText("Full name"), "Asha R Rao");
    await user.clear(screen.getByLabelText("Mobile number"));
    await user.type(screen.getByLabelText("Mobile number"), "9812345678");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Profile saved", {}, { timeout: 5000 })).toBeTruthy();

    expect(profileWrites()).toEqual([
      {
        method: "PATCH",
        path: "/account/profile",
        body: { name: "Asha R Rao", phone: "9812345678" },
      },
    ]);

    const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}") as User;
    expect(stored.name).toBe("Asha R Rao");
    expect(stored.phone).toBe("9812345678");
    // Unchanged, because nothing sent it: the email is the login identifier.
    expect(stored.email).toBe("b2c@demo.in");
  }, 30000);

  /**
   * **The two refusals that must never become a request**, because both would be answered 400 by a
   * server that has already been told something wrong about the customer.
   *
   * The blank name is the interesting one. `"   "` is a present three-character string, so a
   * `min(2)` applied before trimming accepts it — and `users.name` is `NOT NULL varchar(120)` with no
   * check constraint, so the row would then hold either padding or, once trimmed server-side, `''`: a
   * blank name on every future order and delivery note, arriving as a **200**. Three layers say no
   * (this schema, the DTO’s `@Transform`, and `profile.integration.spec.ts` over the wire) and this is
   * the one the customer sees.
   */
  it.each([
    ["Full name", "   ", "Enter your full name"],
    ["Mobile number", "12345", "Enter a valid 10-digit Indian mobile number"],
  ])(
    "refuses %s = %j in the browser, without sending it",
    async (label, value, message) => {
      const user = userEvent.setup();
      await renderAt("/account/profile", undefined, "b2c");
      await screen.findByRole("heading", { name: "Your Profile", level: 1 }, { timeout: 5000 });

      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), value);
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText(message, {}, { timeout: 5000 })).toBeTruthy();
      expect(profileWrites()).toEqual([]);
      expect(localStorage.getItem(SNAPSHOT_KEY)).toContain("Asha Rao");
    },
    30000,
  );

  it("turns a retail customer away from /business without looping back into it", async () => {
    await renderAt("/business/bulk-cart", undefined, "b2c");

    // Landed on /account — outside the business layout — with an explanation, not a loop.
    await screen.findByRole("heading", { name: "Overview", level: 1 }, { timeout: 5000 });
    expect(screen.getByText("Bulk buying is not switched on yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable business buying" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Bulk Cart", level: 1 })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Business area" })).toBeNull();
    // and not bounced to sign-in either: this visitor is authenticated
    expect(screen.queryByRole("heading", { name: "Sign in", level: 1 })).toBeNull();
  }, 20000);

  it("signs a business customer in and lands them on the business dashboard", async () => {
    const user = userEvent.setup();
    await renderAt("/login?redirect=/business");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Email"), "b2b@demo.in");
    await user.type(screen.getByLabelText("Password"), STUB_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByRole("heading", { name: "Dashboard", level: 1 }, { timeout: 5000 });
    // Task 19: the tiles read `GET /business/stats` now, not a client-side `reduce` over
    // `GET /account/orders?channel=bulk` — the endpoint answers the identical ₹77,348 because
    // both stubs total the same seeded rows, but the *source* is what changed.
    expect(await screen.findByText("₹77,348", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Bulk Cart/ })).toBeTruthy();
    // The figure alone cannot tell a real read apart from a reintroduced client-side `reduce`
    // landing on the identical ₹77,348 — this is what actually distinguishes them.
    expect(statsReads()).toContain("b2b@demo.in");
  }, 30000);

  /**
   * `GET /business/orders`'s own page — Task 19 pointed it at the dedicated endpoint rather
   * than `useOrders({ channel: "bulk" })`. Deep-equal to the account read on the wire (both
   * stubs total the identical `bulkOrdersFor` rows), so the only thing worth pinning here is
   * that this page renders *something real* rather than the two seeded bulk orders happening to
   * look right against a route this task did not touch.
   */
  it("renders the business's own bulk orders at /business/orders", async () => {
    await renderAt("/business/orders", undefined, "b2b");
    await screen.findByRole("heading", { name: "Orders", level: 1 }, { timeout: 5000 });

    const table = await screen.findByRole("table", {}, { timeout: 5000 });
    expect(within(table).getByText("NN-2026-005042")).toBeTruthy();
    expect(within(table).getByText("NN-2026-004488")).toBeTruthy();
  }, 20000);

  /**
   * Task 7's seven-status vocabulary, end to end on the one screen most likely to have kept the
   * old four-value guess alive by accident: `negotiation` is not `'new'`, so the dashboard's old
   * `status === 'new'` filter would have counted this enquiry as *closed* — the exact
   * regression `GET /business/stats`'s own `IS_OPEN` record exists to make a compile error
   * instead of a silent miscount.
   */
  it("counts a 'negotiation' RFQ as an open enquiry on the dashboard, not a closed one", async () => {
    const negotiating: RfqDetail = {
      id: "RFQ-2026-100060",
      kind: "bulk",
      status: "negotiation",
      businessName: "Anand Sweets & Namkeen",
      createdAt: "2026-08-11T06:20:00.000Z",
      contactPerson: "Rakesh Anand",
      mobile: "9845012345",
      email: "purchase@anandsweets.example",
      businessType: "Sweet shop",
      pincode: "560004",
      lines: [{ productSlug: "w320-cashews", kg: 60 }],
    };

    await renderAt("/business", undefined, "b2b", undefined, undefined, undefined, undefined, [
      { rfq: negotiating, owner: "b2b@demo.in" },
    ]);
    await screen.findByRole("heading", { name: "Dashboard", level: 1 }, { timeout: 5000 });

    const tile = (await screen.findByText("Active RFQs")).closest("div")!;
    expect(within(tile).getByText("1")).toBeTruthy();
    const previous = screen.getByText("Previous Quotes").closest("div")!;
    expect(within(previous).getByText("0")).toBeTruthy();
  }, 20000);

  /**
   * **State 3, and the one this screen most needs to get right.** A guest reloading their own
   * confirmation cannot be shown the order — it carries `userId: null` and the endpoint is
   * session-scoped — and must not be told it is missing either.
   *
   * The cache entry `CheckoutForm` seeds is removed, which is exactly what a reload or a second
   * device does, and no session is arranged. Three assertions, and the third is the one that makes
   * the other two mean anything: the honest wording is present, the "not found" wording is
   * **absent**, and **no request was made**. Both branches render *something*, so a test that only
   * asserted "a heading appeared" would pass against either — the trap Task 12 measured twice in the
   * pincode seam. `orderReads()` is what distinguishes "decided not to ask" from "asked and lost".
   */
  it("tells a signed-out visitor the order is only visible to its account, and asks nobody", async () => {
    const guestOrder = { ...SEEDED_ORDERS[0]!, id: "NN-2026-777123" };
    seedAccountOrder(guestOrder, null);

    await renderAt(`/order-success/${guestOrder.id}`);
    await screen.findByRole("heading", { name: `Order ${guestOrder.id}`, level: 1 });

    expect(screen.getByText(/only visible to the account that placed the order/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Order not found" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Order received" })).toBeNull();
    // The screen decided not to ask, rather than asking and being refused.
    expect(orderReads()).not.toContain(guestOrder.id);
  }, 30000);

  /**
   * **State 2's miss.** Signed in, nothing cached, and the server does not have this order for this
   * account — so *this* is where "not found" is the honest answer, and the request must actually have
   * been made. The order number is a well-formed one that no fixture owns, so the 404 is the
   * endpoint's own and not a validation refusal.
   */
  it("tells a signed-in customer an unknown order is not on their account, having asked", async () => {
    await renderAt("/order-success/NN-2026-000404", undefined, "b2c");
    await screen.findByRole("heading", { name: "Order not found" }, { timeout: 5000 });

    expect(screen.getByText(/is not on this account/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Order received" })).toBeNull();
    expect(orderReads()).toContain("NN-2026-000404");
  }, 30000);

  /**
   * **State 2's hit**, and the half of state 1 that a guest depends on: another customer's order is a
   * 404 rather than a 403, so this screen cannot become an existence oracle for sequential order
   * numbers either.
   */
  it("does not show a signed-in customer somebody else's order", async () => {
    const theirs = { ...SEEDED_ORDERS[0]!, id: "NN-2026-777456" };
    seedAccountOrder(theirs, "b2b@demo.in");

    await renderAt(`/order-success/${theirs.id}`, undefined, "b2c");
    await screen.findByRole("heading", { name: "Order not found" }, { timeout: 5000 });

    expect(screen.queryByRole("heading", { name: "Order received" })).toBeNull();
  }, 30000);

  /**
   * The case this replaces hand-wrote an `nn.order.NN-2026-777777` receipt into sessionStorage and
   * pinned `fromReceipt`'s reconstruction of it — ₹329 / ₹16 / ₹79 / ₹424, figures **no order row
   * produces**, because they came from the client's own arithmetic over a payload the client had just
   * written. It was trying to prove that Track Order is not a dead end and could not: there was no
   * server, so the only thing it could prove was that a function agreed with its own input.
   *
   * This is the same claim against the endpoint. The order is placed, the confirmation is reached,
   * **Track Order is clicked** rather than navigated to, and the detail page is read back out of
   * `GET /account/orders/:orderNumber`.
   *
   * Three things are asserted that the receipt could not express, and one that it got actively wrong:
   *
   * - **The discount row.** Task 13 added it to `account/orders/$id.tsx` and its mutation survived
   *   **0 of 221**, because `mocks/orders.ts` hardcodes `discount = 0` and `fromReceipt` set
   *   `discount: 0` — no fixture on either side of the seam could express a discounted order. A real
   *   placement carrying a coupon can, which is the point of replacing the seam. The total is asserted
   *   with it, because a discount displayed but not subtracted leaves an invoice whose total does not
   *   equal its own parts.
   * - **The order's own timeline.** One `pending` event, because that is what placement wrote.
   *   `fromReceipt` invented two, and its second carried the note **"Payment received."** on a COD
   *   order nobody has paid for — asserted absent, since a plausible lie is worse than a gap.
   * - **The recorded read.** `orderReads()` is the analogue of `pincodeChecks()`: a rendered figure
   *   cannot tell a live seam from a mock that happens to agree, and an outgoing request can.
   *
   * **The seeded cache entry is removed on purpose, and the case is worthless without it.**
   * `CheckoutForm` writes the placement response into `accountKeys.order(id)` so that a *guest* — who
   * has no session and therefore no readable order — still sees their confirmation. Left in place it
   * would answer this page too, and every assertion below would pass with the seam pointed back at the
   * deleted `fromReceipt`. This customer is signed in, so the server is the honest source.
   */
  it("opens a just-placed order from the server, discount and all, so Track Order is not a dead end", async () => {
    const user = userEvent.setup();
    await renderAt(
      "/checkout",
      [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }],
      "b2c",
    );
    await screen.findByRole("heading", { name: "Checkout", level: 1 });
    // After `renderAt`, like every other arrangement: `installAuthStub` resets the checkout stub.
    // `ALMOND15` rather than `WELCOME10` — that one is `firstOrderOnly`, and a seeded customer with
    // six orders behind them is exactly who it refuses.
    seedCoupon("ALMOND15", {
      eligible: true,
      couponCode: "ALMOND15",
      discount: 49,
      eligibleSubtotal: 329,
    });

    await fillDeliveryDetails(user);
    await user.type(screen.getByLabelText("Coupon code"), "almond15");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("ALMOND15 applied — ₹49 off.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Place Order" }));
    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });

    const placed = issuedOrders()[0]!;
    expect(placed.discount).toBe(49);
    renderedCache().removeQueries({ queryKey: accountKeys.order(placed.id) });

    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Track Order" }));
    await screen.findByRole("heading", { name: `Order ${placed.id}`, level: 1 }, { timeout: 5000 });

    // The page asked the server for this order by number, rather than reconstructing it locally.
    expect(orderReads()).toContain(placed.id);

    const totals = within(screen.getByRole("region", { name: "Order totals" }));
    expect(totals.getByText("Discount (ALMOND15)")).toBeTruthy();
    expect(totals.getByText("−₹49")).toBeTruthy();
    // ₹329 − ₹49 + ₹16 GST + ₹79 shipping.
    expect(totals.getByText("₹375")).toBeTruthy();

    const timeline = within(screen.getByRole("list", { name: "Status timeline" }));
    expect(timeline.getAllByRole("listitem").length).toBe(1);
    expect(timeline.getByText("Payment pending")).toBeTruthy();
    expect(screen.queryByText("Payment received.")).toBeNull();
  }, 40000);

  /**
   * **Cancel, end to end, and the button's own gate is half of what is being measured.**
   *
   * `account/orders/$id.tsx` decides whether to render Cancel Order with
   * `nextStatuses(order.channel, order.status).includes("cancelled")` — importing
   * `@/contract`'s transition map, which **nothing in the frontend imported before this task**.
   * That is the point of doing it that way: `RETAIL_TRANSITIONS` is the same table
   * `OrderStatusService` refuses transitions from, so the button cannot drift from the server's
   * answer. A local list of the four pre-dispatch statuses would agree today and be the second copy
   * that rots.
   *
   * **The order has to be placed rather than arranged, because no fixture order is cancellable.**
   * All six of `mocks/orders.ts`' rest in `out-for-delivery`, `shipped`, `cancelled`, `delivered`,
   * `refunded` and `delivered`, and `cancelled` is reachable only from `pending`, `confirmed`,
   * `processing` and `packed`. A fresh placement lands `pending`, which is the only way to see the
   * button at all — and it makes the case the customer's real journey: place, track, change your mind.
   *
   * Three things are asserted that nothing else in this suite can see:
   *
   * - **The dialog is a gate, not decoration.** `cancelled` is terminal, so there is no undo.
   *   Dismissing the confirmation must send nothing, and `orderCancels()` staying empty is the only
   *   way to know that — a trigger wired straight to the mutation looks identical up to the moment
   *   the order is gone.
   * - **The request was made.** `orderCancels()` is the analogue of `pincodeChecks()`: a "Cancelled"
   *   badge cannot tell a live seam from a page that patched its own cache, and an outgoing call can.
   * - **The button withdraws itself afterwards.** The gate is re-evaluated against the *server's*
   *   answer — `useCancelOrder` writes the response into `accountKeys.order(id)` — and
   *   `nextStatuses(channel, "cancelled")` is `[]`, so a page still offering Cancel on a cancelled
   *   order would be the gate not being applied at all.
   *
   * The seeded cache entry is removed for the reason the case above gives: `CheckoutForm` writes the
   * placement response into `accountKeys.order(id)` so a *guest* can see their confirmation, and left
   * in place it would answer this page too.
   */
  it("cancels a just-placed order from the detail page, and only after the confirmation", async () => {
    const user = userEvent.setup();
    await renderAt(
      "/checkout",
      [{ slug: "w320-cashews", mode: "retail", size: "250g", qty: 1 }],
      "b2c",
    );
    await screen.findByRole("heading", { name: "Checkout", level: 1 });

    await fillDeliveryDetails(user);
    await user.click(screen.getByRole("button", { name: "Place Order" }));
    await screen.findByRole("heading", { name: "Order received", level: 1 }, { timeout: 5000 });

    const placed = issuedOrders()[0]!;
    expect(placed.status).toBe("pending");
    renderedCache().removeQueries({ queryKey: accountKeys.order(placed.id) });

    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Track Order" }));
    await screen.findByRole("heading", { name: `Order ${placed.id}`, level: 1 }, { timeout: 5000 });

    // `pending` is one of the four, so the button is offered.
    const trigger = await screen.findByRole("button", { name: /Cancel Order/ });

    // Opened and dismissed: the customer changed their mind about changing their mind.
    await user.click(trigger);
    // Opening it sends nothing. Asserted here as well as after the dismissal, because a trigger
    // wired straight to the mutation destroys the order on this click and then unmounts itself — so
    // without this line the failure lands on a missing dialog heading rather than on the request that
    // should not have been made.
    expect(orderCancels()).toEqual([]);
    await screen.findByRole("heading", { name: `Cancel order ${placed.id}?` });
    await user.click(screen.getByRole("button", { name: "Keep my order" }));
    expect(orderCancels()).toEqual([]);
    // Still offered, because the order is still `pending` — the dismissal cost it nothing.
    expect(screen.getByRole("button", { name: /Cancel Order/ })).toBeTruthy();

    // And now for real.
    await user.click(await screen.findByRole("button", { name: /Cancel Order/ }));
    await user.click(await screen.findByRole("button", { name: "Yes, cancel it" }));

    await waitFor(() => {
      expect(orderCancels()).toEqual([placed.id]);
    });
    // The badge follows the server's answer, and the timeline gained the event the server appended:
    // two entries, `pending` then `cancelled`, and two "Cancelled" strings on the page — the badge
    // and the timeline's own last step. `OrderTimeline` renders the final entry as the current one,
    // so a timeline that did not gain the event would show `Payment pending` as current on a
    // cancelled order.
    const timeline = within(await screen.findByRole("list", { name: "Status timeline" }));
    await waitFor(() => {
      expect(timeline.getAllByRole("listitem").length).toBe(2);
    });
    expect(timeline.getByText("Cancelled")).toBeTruthy();
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    // Terminal, so the button withdraws itself rather than offering a second cancellation the
    // server would answer 422 to.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Cancel Order/ })).toBeNull();
    });
  }, 40000);

  /**
   * The other half of the seam, and the half the mock got actively wrong.
   *
   * `accountApi.getOrder` used to search the whole seeded array by id with no reference to the signed-in
   * account, so a retail customer opening `/account/orders/NN-2026-005042` was shown **another
   * company's bulk order** — its lines, its GSTIN, its purchase-order number and its delivery address.
   * Nothing failed, because the page renders whatever it is handed.
   *
   * The endpoint scopes by `user_id` and answers **404, never 403**: "no such order" and "not yours"
   * are deliberately one branch, because order numbers are sequential and a 403 would let a walk of the
   * range enumerate the shop's volume. So the honest screen is the not-found state, and the assertion
   * is that the business details are nowhere on the page.
   */
  it("does not show a retail customer an order that is not theirs", async () => {
    await renderAt("/account/orders/NN-2026-005042", undefined, "b2c");
    await screen.findByRole("heading", { name: "Order not found", level: 1 }, { timeout: 5000 });

    expect(orderReads()).toEqual(["NN-2026-005042"]);
    expect(screen.queryByRole("heading", { name: "Order NN-2026-005042", level: 1 })).toBeNull();
    expect(screen.queryByText("Anand Sweets & Namkeen")).toBeNull();
    expect(screen.queryByText("29ABCDE1234F1Z5")).toBeNull();
    expect(screen.queryByText("Unit 7, Peenya Industrial Area, Phase II")).toBeNull();
  }, 20000);

  it("registers a business account and lets that same login into /business", async () => {
    const user = userEvent.setup();
    await renderAt("/register?redirect=/business");
    await screen.findByRole(
      "heading",
      { name: "Create your account", level: 1 },
      { timeout: 5000 },
    );

    await user.type(screen.getByLabelText("Full name"), "Priya Menon");
    await user.type(screen.getByLabelText("Email"), "priya@crumbandco.example");
    await user.type(screen.getByLabelText("Mobile number"), "9820098200");
    await user.type(screen.getByLabelText("Password"), "sesame1234");

    // The company fields only exist once the business box is ticked.
    expect(screen.queryByLabelText("Company name")).toBeNull();
    await user.click(screen.getByLabelText("I'm buying for a business"));
    await user.type(await screen.findByLabelText("Company name"), "Crumb & Co Bakery");
    await user.selectOptions(screen.getByLabelText("Business type"), "Bakery");

    await user.click(screen.getByRole("button", { name: "Create Account" }));

    await screen.findByRole("heading", { name: "Dashboard", level: 1 }, { timeout: 5000 });
    const stored = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "{}") as User;
    expect(stored.role).toBe("b2b");
    expect(stored.company?.companyName).toBe("Crumb & Co Bakery");
  }, 30000);
});
