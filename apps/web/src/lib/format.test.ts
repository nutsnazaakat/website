import { describe, expect, it } from "vitest";
import { inr, pricePerKg, pricePer100g, discountPercent } from "./format";

describe("inr", () => {
  it("formats with the rupee symbol and no decimals", () => {
    expect(inr(999)).toBe("₹999");
  });

  it("uses the Indian digit grouping system", () => {
    expect(inr(100000)).toBe("₹1,00,000");
    expect(inr(1234567)).toBe("₹12,34,567");
  });

  it("rounds fractional values to whole rupees", () => {
    expect(inr(99.6)).toBe("₹100");
  });

  it("formats zero", () => {
    expect(inr(0)).toBe("₹0");
  });
});

describe("pricePerKg", () => {
  it("scales a sub-kilo pack up to a per-kg rate", () => {
    expect(pricePerKg(250, 250)).toBe(1000);
  });

  it("returns the price unchanged for a 1kg pack", () => {
    expect(pricePerKg(999, 1000)).toBe(999);
  });

  it("scales a multi-kilo pack down", () => {
    expect(pricePerKg(4500, 5000)).toBe(900);
  });

  it("returns 0 when grams is 0 rather than dividing by zero", () => {
    expect(pricePerKg(500, 0)).toBe(0);
  });
});

describe("pricePer100g", () => {
  it("scales a 250g pack to a per-100g rate", () => {
    expect(pricePer100g(250, 250)).toBe(100);
  });

  it("returns 0 when grams is 0", () => {
    expect(pricePer100g(500, 0)).toBe(0);
  });
});

describe("discountPercent", () => {
  it("computes the percentage off MRP", () => {
    expect(discountPercent(850, 1000)).toBe(15);
  });

  it("returns 0 when the price equals MRP", () => {
    expect(discountPercent(1000, 1000)).toBe(0);
  });

  it("returns 0 when MRP is 0 rather than dividing by zero", () => {
    expect(discountPercent(500, 0)).toBe(0);
  });

  it("never returns a negative discount when price exceeds MRP", () => {
    expect(discountPercent(1200, 1000)).toBe(0);
  });
});
