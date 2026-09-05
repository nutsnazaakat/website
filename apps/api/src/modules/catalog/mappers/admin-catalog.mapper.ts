import type { AdminCategory, AdminProduct, AdminVariant } from '@nutwala/shared';
import type { Category } from '../../../entities/catalog/category.entity';
import type { Product } from '../../../entities/catalog/product.entity';
import type { ProductVariant } from '../../../entities/catalog/product-variant.entity';
import { toWireProduct } from './product.mapper';
import { toWireVariant } from './variant.mapper';
import { toWireCategory } from './category.mapper';

/**
 * Entity → the admin wire shapes.
 *
 * Every function here **delegates to the storefront mapper and adds to its result**, never
 * respells it. That is spec §10.1's requirement rather than a preference: `soldOut` is a derived
 * field, "the server must produce it identically at every site that assembles a `Product` or
 * `Variant` — the listing endpoint, the detail endpoint, the bulk catalogue, **the admin list**",
 * and a second assembly site that reimplemented the rule "compiles cleanly and ships a stale
 * flag". Writing `{ ...toWireProduct(...), ...extras }` makes that structural: there is no path by
 * which this file can compute availability, and `eslint.config.mjs`'s `no-restricted-syntax`
 * guard would refuse it if it tried.
 */

/**
 * One variant, with the two fields the storefront must never be told.
 *
 * `available` and `soldOut` come through `toWireVariant` untouched — see the file docblock. Stock's
 * fuller picture (on-hand, reserved, threshold) is `GET /admin/inventory`'s, which plan 9.2 owns.
 */
export function toAdminVariant(variant: ProductVariant): AdminVariant {
  return { ...toWireVariant(variant), id: variant.id, isActive: variant.isActive };
}

/**
 * One product, unpublished ones included, with **every** variant rather than only the active ones.
 *
 * That widening is the one substantive difference from the storefront shape and it is the point of
 * the admin view: deactivating a variant is how a pack is withdrawn without destroying its stock
 * ledger (`inventory-transaction.entity.ts` states this), so an admin list that inherited
 * `toWireProduct`'s active-only filter would give an operator no way to see — or reactivate — what
 * they had just switched off.
 *
 * `soldOut` is *not* affected by the widening, and that is deliberate: `toWireProduct` derives it
 * with `productSoldOut` over the variants' real `isActive` flags, so the product-level flag means
 * exactly the same thing on both sides of the wire. Overriding `variants` after the spread changes
 * what is listed, never what was derived.
 *
 * `viewer: null` — admin sees the `DEFAULT` bulk ladder, the same one an anonymous storefront
 * visitor resolves. A business's negotiated or segment ladder is `GET /admin/pricing-tiers`'s
 * (brief §31, plan 9.3); resolving one here would mean picking *whose* prices an operator sees,
 * which is a question this endpoint has no argument for.
 *
 * Variants are ordered by `grams` so an edit screen lists 100g before 50kg, then by `id` so the
 * order is stable — `Product.variants` arrives in whatever order the join produced.
 */
export function toAdminProduct(product: Product): AdminProduct {
  const variants = [...(product.variants ?? [])].sort(
    (a, b) => a.grams - b.grams || a.id.localeCompare(b.id),
  );

  return {
    ...toWireProduct(product, null),
    id: product.id,
    categoryId: product.categoryId,
    isPublished: product.isPublished,
    publishedAt: product.publishedAt?.toISOString() ?? null,
    variants: variants.map(toAdminVariant),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

/**
 * One category, unpublished ones included.
 *
 * `seo`'s three fields are normalised to `''` for an absent key, matching what `toWireProduct` does
 * with the identically-shaped column: the stored jsonb defaults to `{}`, and a wire type declaring
 * `title: string` must not hand a client `undefined` for it.
 */
export function toAdminCategory(category: Category): AdminCategory {
  return {
    ...toWireCategory(category),
    id: category.id,
    sortOrder: category.sortOrder,
    isPublished: category.isPublished,
    seo: {
      title: category.seo.title ?? '',
      description: category.seo.description ?? '',
      ogImage: category.seo.ogImage ?? '',
    },
  };
}
