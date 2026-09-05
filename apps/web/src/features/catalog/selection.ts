import type { Variant } from "./types";

/**
 * The pack a product opens on when it is in stock.
 *
 * 250g was the hardcoded default in both the card and the detail page before stock data existed,
 * and it is a merchandising choice rather than an accident: it is the mid-size pack, and the smoke
 * suite's asserted figures (`₹132 / 100g`, a `250g` cart line) are all pinned to it. "The first
 * retail pack" is **100g**, so opening on that would quietly halve the default order value of every
 * product in the catalogue — a change nobody asked for while fixing sold-out rendering.
 */
export const PREFERRED_RETAIL_SIZE = "250g";

/**
 * The size a retail size-picker should open on: the preferred pack if it is on the shelf, otherwise
 * the first pack that is, otherwise the first pack at all.
 *
 * The fallback exists because `useState("250g")` predates any stock data. A product whose 250g pack
 * has run out used to open with a disabled Add to Cart while its 500g and 1kg packs sat in stock —
 * a lost sale that was the page's default state rather than anything the customer did.
 *
 * The last fallback keeps a variant selected when every pack is out, so the price and the pack name
 * still render; the product-level SOLD OUT badge is what explains the dead button.
 *
 * `soldOut` is read, never recomputed. The server derived it with the shared helper, and
 * `productSoldOut` could not be reproduced here anyway: a wire `Variant` carries no `isActive`, so
 * a client-side recomputation would be measuring a different set of variants from the server's.
 *
 * One derivation, two call sites — `ProductCard` and `routes/product.$slug` — because two copies of
 * this rule is how the card and the detail page come to disagree about which pack is selected.
 */
export function openingRetailSize(retailVariants: readonly Variant[]): string | undefined {
  const opening =
    retailVariants.find((v) => v.size === PREFERRED_RETAIL_SIZE && !v.soldOut) ??
    retailVariants.find((v) => !v.soldOut) ??
    retailVariants[0];
  return opening?.size;
}
