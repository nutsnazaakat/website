import { bulkTotal } from "@/features/bulk/pricing";
import type { Product } from "@/features/catalog/types";
import type { CartLine, CartTotals } from "./types";

const SHIPPING_FLAT = 79;

type FindProduct = (slug: string) => Product | undefined;

/**
 * Line total in rupees. Returns null when a bulk line falls in a quote-only tier,
 * which the UI renders as "Quote Required" rather than a number.
 */
export function lineTotal(line: CartLine, find: FindProduct): number | null {
  const p = find(line.slug);
  // `null`, not `0`. A product the catalogue does not have has no price — reporting zero made the
  // optimistic total count a withdrawn line as free, and made the cart page show a row it could not
  // price while claiming nothing was excluded.
  if (!p) return null;

  if (line.mode === "bulk") {
    const total = bulkTotal(p.bulkTiers, line.kg ?? 0);
    return total === null ? null : total * line.qty;
  }

  const variant = p.variants.find((v) => v.size === line.size) ?? p.variants[0];
  return (variant?.price ?? 0) * line.qty;
}

export function cartTotals(
  lines: CartLine[],
  find: FindProduct,
  freeShippingThreshold: number,
): CartTotals {
  let subtotal = 0;
  let gst = 0;
  // Two reasons a line contributes nothing, and they are **not** the same flag.
  //
  // A product the catalogue does not have is unpriceable and is *not* a quote line: it must not offer
  // Request a Quote or push the basket onto the business track. A quote-only bulk tier is both.
  //
  // An earlier version of this comment said only the server can report `hasUnpriceableLines` without
  // `hasQuoteLines`, "because only the server knows about stock". That is true of **stock** and was
  // overstated: a missing slug is something this side can see perfectly well, and it used to get it
  // wrong — `lineTotal` returned `0`, so the line counted as free and neither flag was set.
  let hasQuoteLines = false;
  let hasUnpriceableLines = false;

  for (const line of lines) {
    if (!find(line.slug)) {
      hasUnpriceableLines = true;
      continue;
    }

    const total = lineTotal(line, find);
    if (total === null) {
      hasQuoteLines = true;
      hasUnpriceableLines = true;
      continue;
    }
    subtotal += total;
    gst += (total * (find(line.slug)?.gstRate ?? 0)) / 100;
  }

  const shipping = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : SHIPPING_FLAT;
  const roundedGst = Math.round(gst);

  return {
    subtotal,
    gst: roundedGst,
    shipping,
    total: subtotal + roundedGst + shipping,
    hasQuoteLines,
    hasUnpriceableLines,
  };
}

/** Brief §46 — offer bulk pricing once a single retail line crosses the weight threshold. */
export function shouldPromptBulk(line: CartLine, thresholdGrams: number): boolean {
  if (line.mode !== "retail") return false;
  return (line.grams ?? 0) * line.qty >= thresholdGrams;
}
