import { describe, expect, it } from "vitest";
import type { Product } from "@/features/catalog/types";
import type { CartLine } from "./types";
import { lineTotal, cartTotals, shouldPromptBulk } from "./cart-math";

const product: Product = {
  slug: "w320-cashews",
  name: "W320 Cashews",
  category: "cashews",
  subtitle: "",
  description: "",
  rating: 4.7,
  reviewCount: 412,
  images: [],
  origin: "India",
  grade: "W320",
  processing: "",
  shelfLife: "",
  storage: "",
  ingredients: "",
  hsn: "0802",
  gstRate: 5,
  moqKg: 10,
  variants: [
    {
      sku: "A-250G",
      size: "250g",
      grams: 250,
      channel: "retail",
      price: 329,
      mrp: 379,
      available: 10,
      soldOut: false,
      moq: 1,
    },
    {
      sku: "A-1KG",
      size: "1kg",
      grams: 1000,
      channel: "retail",
      price: 1099,
      mrp: 1279,
      available: 10,
      soldOut: false,
      moq: 1,
    },
  ],
  bulkTiers: [
    { minKg: 1, maxKg: 9, pricePerKg: 1000 },
    { minKg: 10, maxKg: 49, pricePerKg: 900 },
    { minKg: 50, maxKg: null, pricePerKg: null },
  ],
  soldOut: false,
  seo: { title: "", description: "", ogImage: "" },
};

const find = (slug: string) => (slug === product.slug ? product : undefined);

describe("lineTotal", () => {
  it("multiplies a retail variant price by quantity", () => {
    const line: CartLine = {
      id: "1",
      slug: "w320-cashews",
      mode: "retail",
      size: "250g",
      grams: 250,
      qty: 3,
    };
    expect(lineTotal(line, find)).toBe(987);
  });

  it("prices a bulk line at the resolved tier rate", () => {
    const line: CartLine = { id: "2", slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 };
    expect(lineTotal(line, find)).toBe(9000);
  });

  it("returns null for a bulk line whose tier requires a quote", () => {
    const line: CartLine = { id: "3", slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 };
    expect(lineTotal(line, find)).toBeNull();
  });

  /**
   * **`null`, not `0` — and the previous expectation here pinned a defect rather than a decision.**
   *
   * Returning zero made a withdrawn product read as free: the optimistic total counted it at ₹0 and
   * `cartTotals` left `hasUnpriceableLines` false, so the cart page rendered a row it could not price
   * while telling the customer nothing was excluded. Changed deliberately; this assertion is the old
   * one corrected, not relaxed.
   */
  it("returns null for an unknown product, which has no price rather than a zero one", () => {
    const line: CartLine = { id: "4", slug: "ghost", mode: "retail", size: "250g", qty: 1 };
    expect(lineTotal(line, find)).toBeNull();
  });
});

describe("cartTotals", () => {
  it("sums lines and applies GST", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 1 },
    ];
    const t = cartTotals(lines, find, 999);
    expect(t.subtotal).toBe(1099);
    expect(t.gst).toBe(55); // 5% of 1099, rounded
    expect(t.hasQuoteLines).toBe(false);
  });

  it("charges shipping below the free threshold", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "250g", grams: 250, qty: 1 },
    ];
    expect(cartTotals(lines, find, 999).shipping).toBe(79);
  });

  it("waives shipping at or above the free threshold", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 1 },
    ];
    expect(cartTotals(lines, find, 999).shipping).toBe(0);
  });

  it("flags quote lines and excludes them from the subtotal", () => {
    const lines: CartLine[] = [{ id: "1", slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 }];
    const t = cartTotals(lines, find, 999);
    expect(t.hasQuoteLines).toBe(true);
    // Both, on this side. `lineTotal` returns null only for a quote-only bulk tier and never for a
    // sold-out variant, so a client-side unpriceable line is always a quote line. The server is what
    // can report one without the other, because only the server knows about stock.
    expect(t.hasUnpriceableLines).toBe(true);
    expect(t.subtotal).toBe(0);
  });

  /**
   * A line whose product the catalogue does not have is **unpriceable, and not a quote line.**
   *
   * `lineTotal` used to return `0` for it, so the optimistic total counted it as free and
   * `hasUnpriceableLines` stayed false — the cart page then said nothing was excluded while showing a
   * row it could not price. That window is short (the server's reply overwrites it) but it is exactly
   * when the customer is looking, having just clicked something.
   *
   * This also corrects a claim in `cart-math.ts` that only the server can report
   * `hasUnpriceableLines` without `hasQuoteLines`, "because only the server knows about stock". True of
   * stock; a **missing slug** is something the client can see perfectly well.
   */
  it("treats a line the catalogue does not have as unpriceable, not as a quote", () => {
    const t = cartTotals(
      [{ id: "r:gone:250g", slug: "gone", mode: "retail", size: "250g", qty: 2 }],
      find,
      999,
    );

    expect(t.hasUnpriceableLines).toBe(true);
    expect(t.hasQuoteLines).toBe(false);
    // It contributes nothing rather than contributing zero-as-a-price.
    expect(t.subtotal).toBe(0);
    expect(t.gst).toBe(0);
  });

  it("returns zeroes for an empty cart", () => {
    expect(cartTotals([], find, 999)).toEqual({
      subtotal: 0,
      gst: 0,
      shipping: 0,
      total: 0,
      hasQuoteLines: false,
      hasUnpriceableLines: false,
    });
  });
});

describe("shouldPromptBulk", () => {
  it("is true once a retail line reaches the gram threshold", () => {
    const line: CartLine = {
      id: "1",
      slug: "w320-cashews",
      mode: "retail",
      size: "1kg",
      grams: 1000,
      qty: 5,
    };
    expect(shouldPromptBulk(line, 5000)).toBe(true);
  });

  it("is false below the threshold", () => {
    const line: CartLine = {
      id: "1",
      slug: "w320-cashews",
      mode: "retail",
      size: "1kg",
      grams: 1000,
      qty: 4,
    };
    expect(shouldPromptBulk(line, 5000)).toBe(false);
  });

  it("is false for a line that is already bulk", () => {
    const line: CartLine = { id: "1", slug: "w320-cashews", mode: "bulk", kg: 25, qty: 1 };
    expect(shouldPromptBulk(line, 5000)).toBe(false);
  });
});
