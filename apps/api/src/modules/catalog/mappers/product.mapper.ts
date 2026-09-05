import { productSoldOut, toRupees, type Product as WireProduct } from '@nutwala/shared';
import type { Product } from '../../../entities/catalog/product.entity';
import { resolveTiers, type PricingViewer } from '../../pricing/pricing.resolver';
import { availableFor, toWireVariant } from './variant.mapper';

/**
 * Entity → wire `Product`.
 *
 * Two conversions the compiler forces and one it does not:
 *
 * - `gstRate`, `moqKg` and `ratingAvg` are Postgres `numeric`, which TypeORM hands back as
 *   **strings**. The wire type declares `number`, so `Number(...)` is required — and the frontend's
 *   cart maths multiplies by `gstRate`, so a string here is a real arithmetic bug, not a cosmetic one.
 * - Money is `bigint` paise and becomes rupees inside `toWireVariant`.
 * - Nothing forces `soldOut` to agree with `available`; the shared helper is what does.
 *
 * `viewer` is **required**, not optional-defaulting-to-`null`: an optional parameter is how a call
 * site silently prices a business at list rates, and `CatalogService` has enough call sites
 * (`listProducts`, `getProduct`, `listRelated`, `productsBySlugs`) that one being missed is a real
 * risk. `tsc` is what catches it — pass `null` explicitly for the public catalogue.
 */
export function toWireProduct(product: Product, viewer: PricingViewer | null): WireProduct {
  const variants = product.variants ?? [];
  const activeVariants = variants.filter((variant) => variant.isActive);

  return {
    slug: product.slug,
    name: product.name,
    // The Phase 1 contract is the category *slug*, not an id and not a nested object.
    category: product.category.slug,
    subtitle: product.subtitle,
    description: product.description,
    // Spread rather than `badge: product.badge ?? undefined`, because the wire type declares
    // `badge?: Badge` and an explicit `undefined` serialises as a present key with a null value.
    ...(product.badge ? { badge: product.badge as WireProduct['badge'] } : {}),
    rating: Number(product.ratingAvg),
    reviewCount: product.reviewCount,
    images: [...(product.images ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((image) => image.url),
    origin: product.origin,
    grade: product.grade,
    processing: product.processing,
    shelfLife: product.shelfLife,
    storage: product.storage,
    ingredients: product.ingredients,
    hsn: product.hsn,
    gstRate: Number(product.gstRate),
    variants: activeVariants.map(toWireVariant),
    /**
     * The viewer's own ladder, ordered by `minKg`.
     *
     * Populated here rather than by a separate bulk endpoint, because four existing call sites read
     * this field — `/bulk-orders`, `/bulk/$category`, the product page's bulk calculator, and
     * `cart-math.ts`'s `bulkTotal` — and `isQuoteRequired` in `frontend/src/features/bulk/pricing.ts`
     * returns true precisely when the resolved tier's rate is null. An empty array would make every
     * bulk weight look quote-required and take the bulk calculator down.
     *
     * `resolveTiers` (Milestone 7, Task 2) is what used to be a brute-force filter here:
     * `segment === DEFAULT && businessId === null`. That filter earned its keep — `segment` kept a
     * `RETAILER`/`DISTRIBUTOR`/`HORECA` rate out of the public catalogue, and `businessId === null`
     * kept one business's negotiated rate out of every other buyer's page, because a `DEFAULT`-segment
     * tier scoped to a business is a legitimate row and segment alone would leak it. `resolveTiers`
     * keeps both halves of that reasoning and adds the two rungs the brute-force filter had no way to
     * reach: a viewer's own business-specific ladder, and a viewer's segment ladder, each returned in
     * place of — never merged with — the `DEFAULT` rows. `viewer === null` (the public catalogue) and
     * a `DEFAULT`-segment business fall through to exactly the same third rung, which is what makes
     * this milestone change nobody's prices.
     */
    bulkTiers: resolveTiers(product, viewer).map((tier) => ({
      minKg: Number(tier.minKg),
      maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
      // Null is load-bearing: it is what routes a 50kg enquiry to the RFQ form.
      pricePerKg: tier.pricePerKgPaise === null ? null : toRupees(tier.pricePerKgPaise),
    })),
    moqKg: Number(product.moqKg),
    ...(product.quoteOnly ? { quoteOnly: true } : {}),
    /**
     * Every variant with its real `isActive`, not the pre-filtered list with `isActive: true`
     * hardcoded. Which variants count towards a product being sold out is part of the rule, and the
     * rule has one home — passing a list that has already been filtered makes the helper's own
     * filter a no-op and moves half the derivation back into this file.
     */
    soldOut: productSoldOut(
      variants.map((variant) => ({
        available: availableFor(variant),
        isActive: variant.isActive,
      })),
    ),
    seo: {
      title: product.seo.title ?? '',
      description: product.seo.description ?? '',
      ogImage: product.seo.ogImage ?? '',
    },
  };
}
