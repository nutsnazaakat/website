import { toRupees, type AdminPricingTier } from '@nutwala/shared';
import type { PricingTier } from '../../../entities/catalog/pricing-tier.entity';
import type { Business } from '../../../entities/identity/business.entity';
import type { Product } from '../../../entities/catalog/product.entity';
import { toWireSegment } from '../../users/admin-customer.mapper';

/**
 * A tier plus the two rows that make it legible — the product it prices and, for a
 * customer-specific ladder, the business it belongs to.
 *
 * Gathered by the service so the mapper reads rather than queries: a page of rungs would otherwise
 * be two lookups per row.
 */
export interface AdminPricingTierRow {
  tier: PricingTier;
  product: Pick<Product, 'id' | 'slug' | 'name'>;
  business: Pick<Business, 'id' | 'companyName'> | null;
}

/**
 * `PricingTier` → `AdminPricingTier`, for every route on `/admin/pricing-tiers`.
 *
 * **Built field by field, never a spread**, for the reason every other mapper here states — but the
 * field that would leak is different in kind: `pricePerKgPaise` is a `bigint`, and a spread would
 * put it on the wire as paise beside the `pricePerKg` rupees this shape declares. Two money figures
 * for one price, disagreeing by a factor of a hundred, on a screen whose whole job is setting
 * prices.
 *
 * `minKg` and `maxKg` are `numeric(8,2)`, which `pg` hands back as strings, so `Number()` is doing
 * real work rather than satisfying a type — `'10.00'` on the wire would break every comparison a
 * console makes against it.
 *
 * A **null** `pricePerKg` means the slab requires a quote (brief §47), not that it is free and not
 * that nobody has filled it in: `CatalogService.quotePreview` answers `quoteRequired: true` for it.
 */
export function toAdminPricingTier(row: AdminPricingTierRow): AdminPricingTier {
  const { tier } = row;
  return {
    id: tier.id,
    productId: row.product.id,
    productSlug: row.product.slug,
    productName: row.product.name,
    minKg: Number(tier.minKg),
    maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
    pricePerKg: tier.pricePerKgPaise === null ? null : toRupees(tier.pricePerKgPaise),
    segment: toWireSegment(tier.segment),
    businessId: tier.businessId,
    companyName: row.business?.companyName ?? null,
    createdAt: tier.createdAt.toISOString(),
    updatedAt: tier.updatedAt.toISOString(),
  };
}
