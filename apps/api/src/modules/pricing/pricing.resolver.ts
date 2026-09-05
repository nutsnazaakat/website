import { CustomerSegment as CustomerSegmentEnum } from '../../entities/enums';
import type { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import type { Product } from '../../entities/catalog/product.entity';

/**
 * `CustomerSegment` is imported under this local name because it is not the only
 * `CustomerSegment` in this codebase: `@nutwala/shared` exports a lowercase wire tuple type of
 * the same name (`'default' | 'retailer' | 'distributor' | 'horeca'`), and this file's enum is
 * the backend's uppercase Postgres-enum counterpart (`entities/enums.ts`). Nothing here imports
 * the wire type, so there is no local collision to force the alias — it is kept anyway to match
 * `businesses.service.ts`, the one other file that has to say which `CustomerSegment` it means.
 */

/**
 * Who is being priced. `null` is the public catalogue and every retail customer.
 *
 * A `businessId` **and** its segment, resolved once by the caller, rather than a `userId` the
 * resolver would have to look up. Two reasons: a page of 24 products must not make 24 identical
 * lookups, and a resolver that queries is a resolver that cannot be unit-tested against a ladder
 * shape.
 */
export interface PricingViewer {
  businessId: string;
  segment: CustomerSegmentEnum;
}

/**
 * Ascending by `minKg`, on a copy.
 *
 * `[...tiers].sort(...)` and not `tiers.sort(...)`: the array is the loaded relation, and sorting
 * it in place mutates the entity every other consumer of that request is holding.
 * `product.mapper.ts` already spreads before sorting for this reason, and `Number()` is needed
 * because `minKg` is `numeric(8,2)`, which `pg` hands back as a string — `'10.00' - '2.00'`
 * coerces and happens to work, which is exactly how a comparison bug here would hide.
 */
function byMinKg(tiers: PricingTier[]): PricingTier[] {
  return [...tiers].sort((a, b) => Number(a.minKg) - Number(b.minKg));
}

/**
 * The tiers that apply to one viewer, ordered by `minKg`.
 *
 * **The key is the pair `(segment, businessId === null)`, never segment alone**, and
 * `product.mapper.ts`'s docblock already says why: a `DEFAULT`-segment tier scoped to a business
 * is a legitimate row — it means "this business also gets ordinary list pricing, no special
 * deal" — so segment alone would leak it to every other buyer in that segment. A sales desk that
 * agrees a bespoke rate without moving the customer into a segment produces exactly that row.
 *
 * Three rungs, and **the first non-empty one wins outright** rather than the rungs merging.
 * Merging is the tempting alternative and it is wrong: a business ladder that covers 1–20kg and a
 * `DEFAULT` ladder that covers 1–50kg would, merged, price a 30kg order at list while a 10kg
 * order gets the negotiated rate — so the customer's *larger* order costs more per kilo than
 * their smaller one, which is the one thing a bulk ladder must never do. A ladder is a whole
 * agreement, not a set of overrides, so a business's own tiers are returned exactly as they are
 * — including incomplete, if that is what the desk agreed — and never topped up from `DEFAULT`.
 *
 * `viewer === null` and `viewer === { segment: DEFAULT }` are deliberately the same answer: both
 * fall through to the third rung, which is what makes this milestone change nobody's prices —
 * every existing business is `DEFAULT` and every existing tier is `DEFAULT`/null, so the third
 * rung answers for everybody exactly as the old `product.mapper.ts` filter did.
 */
export function resolveTiers(
  product: Pick<Product, 'pricingTiers'>,
  viewer: PricingViewer | null,
): PricingTier[] {
  const all = product.pricingTiers ?? [];

  if (viewer !== null) {
    const mine = all.filter((tier) => tier.businessId === viewer.businessId);
    if (mine.length > 0) return byMinKg(mine);

    const segment = all.filter(
      (tier) => tier.businessId === null && tier.segment === viewer.segment,
    );
    if (segment.length > 0) return byMinKg(segment);
  }

  return byMinKg(
    all.filter((tier) => tier.businessId === null && tier.segment === CustomerSegmentEnum.DEFAULT),
  );
}

/**
 * A weight below the cheapest tier's minimum still counts as covered — the existing, deliberate
 * floor `frontend/src/features/bulk/pricing.ts`'s `tierFor` already applies, kept so a sub-minimum
 * quantity does not needlessly fall back to `DEFAULT`. Only a weight *above* every tier's range,
 * where the top tier's `maxKg` is a real number rather than open-ended, is genuinely uncovered.
 *
 * `tiers` is already sorted ascending by `byMinKg` inside `resolveTiers`, so the last element is
 * the top rung.
 */
function coversWeight(tiers: readonly PricingTier[], kg: number): boolean {
  if (tiers.length === 0) return false;
  const top = tiers[tiers.length - 1]!;
  return top.maxKg === null || kg <= Number(top.maxKg);
}

/**
 * The ladder that actually prices one weight for a viewer — the composition `resolveTiers` alone
 * cannot produce, because it takes no weight and returns one full ladder.
 *
 * A business's own ladder may legitimately stop short of `DEFAULT`'s range: a negotiated 1–20kg
 * deal says nothing about a 30kg order. That is not "no price" — it is "this weight was never
 * part of what was agreed" — and the honest answer is the one every other customer gets. Falling
 * through here is **not** the merge the ladder-integrity rule in `resolveTiers` forbids: it swaps
 * the *entire* ladder for the weight in question, so a 30kg order is priced end to end from one
 * ladder, never a stitch of two.
 *
 * Deliberately does **not** reuse `frontend/src/features/bulk/pricing.ts`'s `tierFor`, whose
 * out-of-range fallback is the business's own cheapest tier (`tiers[0]`) — measured, and it is
 * precisely the quiet widening this function exists to refuse: a viewer's own ladder cannot
 * silently "win" a weight it was never agreed to cover.
 *
 * `toProductRules` (cart) and the quote-preview (catalogue) both call this, never `resolveTiers`
 * directly, once a specific weight is in hand. The catalogue listing calls `resolveTiers` — it has
 * no weight, and correctly so; it renders a whole ladder, not one rung.
 */
export function resolveTiersForWeight(
  product: Pick<Product, 'pricingTiers'>,
  viewer: PricingViewer | null,
  kg: number,
): PricingTier[] {
  const own = resolveTiers(product, viewer);
  if (coversWeight(own, kg)) return own;
  return resolveTiers(product, null);
}
