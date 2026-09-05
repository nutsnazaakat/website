import type { BulkTier } from "@/features/catalog/types";

/**
 * Resolves which tier applies to a quantity in kg.
 * Quantities below the first tier's minimum fall back to the first tier, so a
 * sub-minimum input never produces a missing price.
 */
export function tierFor(tiers: BulkTier[], kg: number): BulkTier | null {
  if (tiers.length === 0) return null;
  const match = tiers.find((t) => kg >= t.minKg && (t.maxKg === null || kg <= t.maxKg));
  return match ?? tiers[0]!;
}

/** True when the applicable tier has no published price and must go through RFQ. */
export function isQuoteRequired(tiers: BulkTier[], kg: number): boolean {
  const tier = tierFor(tiers, kg);
  return tier === null || tier.pricePerKg === null;
}

/** Line total for a bulk quantity, or null when the tier requires a quote. */
export function bulkTotal(tiers: BulkTier[], kg: number): number | null {
  const tier = tierFor(tiers, kg);
  if (tier === null || tier.pricePerKg === null) return null;
  return tier.pricePerKg * kg;
}

/**
 * Rupees saved versus buying the same quantity at the first tier's rate.
 * Powers the "You save ₹X" message. Returns 0 when a quote is required or the
 * base tier still applies.
 */
export function savingsAgainstBaseTier(tiers: BulkTier[], kg: number): number {
  const total = bulkTotal(tiers, kg);
  const base = tiers[0]?.pricePerKg;
  if (total === null || base == null) return 0;
  return Math.max(0, base * kg - total);
}
