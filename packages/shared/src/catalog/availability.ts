/**
 * The single source of truth for whether something is sold out. Spec §10.1.
 *
 * Every place that assembles a wire `Variant` or `Product` — the listing endpoint, the detail
 * endpoint, the bulk catalogue, the admin list, the frontend mock — calls these two functions and
 * never reimplements the rule inline.
 *
 * The reason is that TypeScript enforces `soldOut` being *present*, not that its value agrees with
 * `available`. A second assembly site with a slightly different rule compiles cleanly and ships a
 * listing saying "in stock" beside a product page saying "sold out". `eslint.config.mjs` carries a
 * `no-restricted-syntax` rule that turns a second inline derivation into a lint failure, because a
 * comment asking people not to do it is not a control.
 */

/**
 * A variant is sold out when nothing is available to sell.
 *
 * `<= 0`, not `=== 0`. `ck_inventory_non_negative` does keep `onHand >= reserved` for every row
 * written through the `inventory` table, so `available` computed from that row cannot be negative
 * today. But this function's input is a plain `number`, not "a value that satisfied that
 * constraint" — it can arrive from a raw aggregate, a fixture, the frontend mock, or arithmetic
 * over two separate queries. Every number therefore has to map to a safe answer, and for
 * availability the safe direction is closed: a false "sold out" costs a sale, a false "in stock"
 * oversells and breaks the promise at checkout.
 */
export function variantSoldOut(available: number): boolean {
  return available <= 0;
}

/**
 * The shape `productSoldOut` needs. Structural rather than tied to a named type, because nothing in
 * the system carries both fields: the `ProductVariant` entity has `isActive` but no `available`
 * (stock lives on `Inventory`), and the wire `Variant` has `available` but no `isActive`. Callers
 * pair the two — which is what the variant mapper already does.
 */
export interface AvailabilityInput {
  available: number;
  isActive: boolean;
}

/**
 * A product is sold out when every *active* variant is sold out.
 *
 * A product with no active variants is sold out: there is nothing to buy. `Array.prototype.every`
 * is vacuously true on an empty array, so that answer falls out of this implementation rather than
 * being spelled out here — which is why the spec file pins it.
 */
export function productSoldOut(variants: readonly AvailabilityInput[]): boolean {
  return variants
    .filter((variant) => variant.isActive)
    .every((variant) => variantSoldOut(variant.available));
}
