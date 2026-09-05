import { describe, expect, it } from "vitest";
import type { BulkTier } from "@/features/catalog/types";
import { tierFor, bulkTotal, savingsAgainstBaseTier, isQuoteRequired } from "./pricing";

const tiers: BulkTier[] = [
  { minKg: 1, maxKg: 4, pricePerKg: 1000 },
  { minKg: 5, maxKg: 9, pricePerKg: 950 },
  { minKg: 10, maxKg: 24, pricePerKg: 900 },
  { minKg: 25, maxKg: 49, pricePerKg: 850 },
  { minKg: 50, maxKg: null, pricePerKg: null },
];

describe("tierFor", () => {
  it("resolves a quantity inside the first tier", () => {
    expect(tierFor(tiers, 3)?.pricePerKg).toBe(1000);
  });

  it("resolves the lower boundary of a tier", () => {
    expect(tierFor(tiers, 5)?.pricePerKg).toBe(950);
  });

  it("resolves the upper boundary of a tier", () => {
    expect(tierFor(tiers, 9)?.pricePerKg).toBe(950);
  });

  it("resolves the open-ended top tier", () => {
    expect(tierFor(tiers, 500)?.minKg).toBe(50);
  });

  it("falls back to the first tier below the minimum quantity", () => {
    expect(tierFor(tiers, 0)?.pricePerKg).toBe(1000);
  });

  it("returns null for an empty tier list", () => {
    expect(tierFor([], 10)).toBeNull();
  });
});

describe("isQuoteRequired", () => {
  it("is true when the resolved tier has no price", () => {
    expect(isQuoteRequired(tiers, 60)).toBe(true);
  });

  it("is false when the resolved tier is priced", () => {
    expect(isQuoteRequired(tiers, 10)).toBe(false);
  });

  it("is true when there are no tiers at all", () => {
    expect(isQuoteRequired([], 10)).toBe(true);
  });
});

describe("bulkTotal", () => {
  it("multiplies the resolved per-kg rate by quantity", () => {
    expect(bulkTotal(tiers, 10)).toBe(9000);
  });

  it("applies the cheaper rate once a higher tier is reached", () => {
    expect(bulkTotal(tiers, 25)).toBe(21250);
  });

  it("returns null when the quantity requires a quote", () => {
    expect(bulkTotal(tiers, 100)).toBeNull();
  });
});

describe("savingsAgainstBaseTier", () => {
  it("returns the rupee saving versus the first tier rate", () => {
    expect(savingsAgainstBaseTier(tiers, 10)).toBe(1000);
  });

  it("returns 0 while still inside the base tier", () => {
    expect(savingsAgainstBaseTier(tiers, 3)).toBe(0);
  });

  it("returns 0 when the quantity requires a quote", () => {
    expect(savingsAgainstBaseTier(tiers, 100)).toBe(0);
  });
});
