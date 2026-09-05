import { productSoldOut, variantSoldOut } from '@nutwala/shared';
import type { Category } from '../../../entities/catalog/category.entity';
import type { Product } from '../../../entities/catalog/product.entity';
import type { ProductVariant } from '../../../entities/catalog/product-variant.entity';
import { VariantChannel } from '../../../entities/enums';
import { toAdminCategory, toAdminProduct, toAdminVariant } from './admin-catalog.mapper';

/**
 * The admin mappers.
 *
 * Everything worth asserting here is about the **relationship** between these mappers and the
 * storefront ones, because that relationship is what spec §10.1 makes a requirement: `soldOut` has
 * one derivation, reused at "the listing endpoint, the detail endpoint, the bulk catalogue, the
 * admin list", and a second assembly site that reimplemented it "compiles cleanly and ships a stale
 * flag". So the cases below pin the one substantive difference (every variant, not only the active
 * ones) and then pin that the difference did *not* leak into the derived flags.
 */

const CATEGORY = { id: 'cat-1', slug: 'almonds', name: 'Almonds' } as Category;

interface VariantSeed {
  id: string;
  size: string;
  grams: number;
  onHand: number;
  isActive: boolean;
}

const variantOf = (seed: VariantSeed): ProductVariant =>
  ({
    id: seed.id,
    productId: 'prod-1',
    sku: `SKU-${seed.id}`,
    size: seed.size,
    grams: seed.grams,
    channel: VariantChannel.RETAIL,
    pricePaise: 89900n,
    mrpPaise: 104500n,
    moq: 1,
    isActive: seed.isActive,
    inventory: { variantId: seed.id, onHand: seed.onHand, reserved: 0, lowStockThreshold: 10 },
  }) as ProductVariant;

const productOf = (variants: ProductVariant[], overrides: Partial<Product> = {}): Product => ({
  id: 'prod-1',
  slug: 'premium-california-almonds',
  name: 'Premium California Almonds',
  categoryId: CATEGORY.id,
  category: CATEGORY,
  subtitle: 'Crunchy, uniform kernels.',
  description: 'Graded almond kernels.',
  badge: null,
  origin: 'California, USA',
  grade: 'Independence',
  processing: 'Cleaned, sorted and machine graded',
  shelfLife: '9 months from packing',
  storage: 'Store in a cool, dry place.',
  ingredients: 'Almonds',
  hsn: '0802',
  gstRate: '5',
  moqKg: '10',
  quoteOnly: false,
  isPublished: false,
  publishedAt: null,
  ratingAvg: '4.50',
  reviewCount: 12,
  seo: {},
  variants,
  images: [],
  pricingTiers: [],
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  updatedAt: new Date('2026-08-02T11:00:00.000Z'),
  ...overrides,
});

describe('toAdminVariant', () => {
  it('adds the id and isActive to the storefront shape and changes nothing else', () => {
    const variant = toAdminVariant(
      variantOf({ id: 'v1', size: '1kg', grams: 1000, onHand: 7, isActive: true }),
    );

    expect(variant).toEqual({
      id: 'v1',
      isActive: true,
      sku: 'SKU-v1',
      size: '1kg',
      grams: 1000,
      channel: 'retail',
      price: 899,
      mrp: 1045,
      moq: 1,
      available: 7,
      soldOut: false,
    });
  });

  it('derives soldOut through the shared helper, so it agrees with available', () => {
    const variant = toAdminVariant(
      variantOf({ id: 'v1', size: '1kg', grams: 1000, onHand: 0, isActive: true }),
    );

    expect(variant.available).toBe(0);
    expect(variant.soldOut).toBe(variantSoldOut(variant.available));
    expect(variant.soldOut).toBe(true);
  });
});

describe('toAdminProduct', () => {
  /**
   * The widening, and the whole point of the admin view. `toWireProduct` filters to active variants,
   * so an operator reading the storefront shape could not see — or reactivate — a pack they had just
   * switched off. Deactivating is how a pack is withdrawn without destroying its stock ledger
   * (`inventory-transaction.entity.ts`), which makes an invisible inactive variant a dead end.
   */
  it('lists every variant, including a deactivated one', () => {
    const product = productOf([
      variantOf({ id: 'v1', size: '1kg', grams: 1000, onHand: 5, isActive: true }),
      variantOf({ id: 'v2', size: '250g', grams: 250, onHand: 5, isActive: false }),
    ]);

    expect(toAdminProduct(product).variants.map((variant) => variant.id)).toEqual(['v2', 'v1']);
  });

  it('orders variants by grams, so an edit screen reads 100g before 50kg', () => {
    const product = productOf([
      variantOf({ id: 'v3', size: '50kg', grams: 50_000, onHand: 5, isActive: true }),
      variantOf({ id: 'v1', size: '100g', grams: 100, onHand: 5, isActive: true }),
      variantOf({ id: 'v2', size: '1kg', grams: 1000, onHand: 5, isActive: true }),
    ]);

    expect(toAdminProduct(product).variants.map((variant) => variant.grams)).toEqual([
      100, 1000, 50_000,
    ]);
  });

  /**
   * **The widening must not reach `soldOut`.** `productSoldOut` is documented as "true only when
   * every *active* variant is at zero", so a product whose only stocked pack has been deactivated is
   * sold out — and listing that inactive pack in `variants` must not change the answer. If this
   * mapper had derived the flag itself over the widened list, the admin list would say in stock
   * while the product page said sold out, which is the exact drift spec §10.1 exists to prevent.
   */
  it('keeps the product-level soldOut derived over active variants only, despite listing all of them', () => {
    const product = productOf([
      variantOf({ id: 'v1', size: '1kg', grams: 1000, onHand: 0, isActive: true }),
      variantOf({ id: 'v2', size: '250g', grams: 250, onHand: 40, isActive: false }),
    ]);

    const mapped = toAdminProduct(product);

    expect(mapped.variants).toHaveLength(2);
    expect(mapped.soldOut).toBe(true);
    expect(mapped.soldOut).toBe(
      productSoldOut(
        product.variants.map((variant) => ({
          available: variant.inventory?.onHand ?? 0,
          isActive: variant.isActive,
        })),
      ),
    );
  });

  it('carries the admin-only fields, with publishedAt as ISO-8601 or null', () => {
    const draft = toAdminProduct(productOf([]));
    expect(draft.id).toBe('prod-1');
    expect(draft.categoryId).toBe('cat-1');
    expect(draft.isPublished).toBe(false);
    expect(draft.publishedAt).toBeNull();
    expect(draft.createdAt).toBe('2026-08-01T10:00:00.000Z');
    expect(draft.updatedAt).toBe('2026-08-02T11:00:00.000Z');

    const live = toAdminProduct(
      productOf([], { isPublished: true, publishedAt: new Date('2026-08-03T09:30:00.000Z') }),
    );
    expect(live.isPublished).toBe(true);
    expect(live.publishedAt).toBe('2026-08-03T09:30:00.000Z');
  });

  /** Inherited unchanged from `toWireProduct`: the Phase 1 contract is the category *slug*. */
  it('keeps category as the slug and adds categoryId beside it', () => {
    const mapped = toAdminProduct(productOf([]));

    expect(mapped.category).toBe('almonds');
    expect(mapped.categoryId).toBe('cat-1');
  });
});

describe('toAdminCategory', () => {
  const category = {
    id: 'cat-1',
    slug: 'almonds',
    name: 'Almonds',
    image: 'https://images.example.com/almonds.jpg',
    blurb: 'Badam, graded and crisp',
    description: 'Graded almond kernels.',
    sortOrder: 3,
    isPublished: false,
    seo: { title: 'Almonds' },
  } as Category;

  it('adds sortOrder, isPublished and seo to the storefront shape', () => {
    expect(toAdminCategory(category)).toEqual({
      id: 'cat-1',
      slug: 'almonds',
      name: 'Almonds',
      image: 'https://images.example.com/almonds.jpg',
      blurb: 'Badam, graded and crisp',
      description: 'Graded almond kernels.',
      sortOrder: 3,
      isPublished: false,
      // `''` for an absent key, never `undefined`: the column defaults to `{}` and the wire type
      // declares `title: string`. `toWireProduct` normalises the identically-shaped column the
      // same way.
      seo: { title: 'Almonds', description: '', ogImage: '' },
    });
  });
});
