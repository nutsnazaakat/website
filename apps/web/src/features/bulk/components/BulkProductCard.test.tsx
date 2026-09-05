import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { Product, Variant } from "@/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { CartProvider } from "@/features/cart/CartProvider";
import { installAuthStub } from "@/test/auth-api.stub";
import { BulkProductCard } from "./BulkProductCard";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

const bulkVariant = (available: number): Variant => ({
  sku: "SKU-25KG",
  size: "25kg",
  grams: 25_000,
  channel: "bulk",
  price: 24_000,
  mrp: 26_000,
  moq: 1,
  available,
  soldOut: available <= 0,
});

const product = (available: number): Product => ({
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
  variants: [bulkVariant(available)],
  bulkTiers: [{ minKg: 10, maxKg: null, pricePerKg: 960 }],
  moqKg: 10,
  soldOut: available <= 0,
  seo: { title: "", description: "", ogImage: "" },
});

/**
 * Same harness as `ProductCard.test.tsx`, and for the same reasons: `useCart` and `Link`, plus the
 * `AuthProvider`, `QueryClientProvider` and api stub that `CartProvider` needs now that the basket
 * lives on the server.
 */
function renderRow(p: Product) {
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/product/$slug" }),
      createRoute({ getParentRoute: () => rootRoute, path: "/business/rfqs/new" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  restoreFetch?.();
  restoreFetch = installAuthStub();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <CartProvider>
          <RouterContextProvider router={router}>
            <ul>
              <BulkProductCard product={p} />
            </ul>
          </RouterContextProvider>
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/**
 * The bulk row takes the product-level pair only. It has no size buttons — a kg stepper priced off
 * `bulkTiers[].pricePerKg` — so there is no per-variant control to disable and no selected variant
 * to read.
 */
describe("BulkProductCard sold-out states", () => {
  it("says nothing about stock while the product is stocked", () => {
    renderRow(product(40));
    expect(screen.queryByText(/sold out/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add to bulk cart/i })).toBeEnabled();
  });

  it("badges the row and refuses the add when the product is sold out", () => {
    renderRow(product(0));
    expect(screen.getByText(/sold out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to bulk cart/i })).toBeDisabled();
  });

  /**
   * Request Quote stays live, deliberately. An RFQ for something out of stock is a legitimate order
   * to place — that is what a lead time is for — and it is a link, not a cart action.
   */
  it("leaves Request Quote reachable while sold out", () => {
    renderRow(product(0));
    expect(screen.getByRole("link", { name: /request quote/i })).toBeInTheDocument();
  });
});
