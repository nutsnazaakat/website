/** Formats a rupee amount using Indian digit grouping (1,00,000 not 100,000). */
export const inr = (n: number): string =>
  "₹" + Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** Normalises a pack price to a per-kilogram rate. Returns 0 for a zero-weight pack. */
export const pricePerKg = (price: number, grams: number): number =>
  grams === 0 ? 0 : Math.round((price / grams) * 1000);

/** Normalises a pack price to a per-100g rate. Returns 0 for a zero-weight pack. */
export const pricePer100g = (price: number, grams: number): number =>
  grams === 0 ? 0 : Math.round((price / grams) * 100);

/** Percentage off MRP, clamped at 0. Returns 0 when MRP is 0. */
export const discountPercent = (price: number, mrp: number): number =>
  mrp === 0 ? 0 : Math.max(0, Math.round(((mrp - price) / mrp) * 100));
