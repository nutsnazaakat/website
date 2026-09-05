import { CustomerSegment, VariantChannel } from '../../../entities/enums';
import type { Inventory } from '../../../entities/catalog/inventory.entity';
import type { Product } from '../../../entities/catalog/product.entity';
import type { ProductVariant } from '../../../entities/catalog/product-variant.entity';
import { toWireProduct } from './product.mapper';
import { toWireVariant } from './variant.mapper';

function variantFixture(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: 'var-1',
    productId: 'prod-1',
    sku: 'PCA-250G',
    size: '250g',
    grams: 250,
    channel: VariantChannel.RETAIL,
    pricePaise: 29900n,
    mrpPaise: 34900n,
    moq: 1,
    isActive: true,
    inventory: { onHand: 120, reserved: 0 } as Inventory,
    ...overrides,
  } as ProductVariant;
}

function productFixture(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1',
    slug: 'premium-california-almonds',
    name: 'Premium California Almonds',
    categoryId: 'cat-1',
    category: { slug: 'almonds' },
    subtitle: 'Crunchy, uniform kernels.',
    description: 'Long description.',
    badge: 'BESTSELLER',
    origin: 'California, USA',
    grade: 'Independence',
    processing: 'Cleaned, sorted and machine graded',
    shelfLife: '9 months from packing',
    storage: 'Store in a cool, dry place.',
    ingredients: 'Almonds',
    hsn: '0802',
    gstRate: '5.00',
    moqKg: '10.00',
    quoteOnly: false,
    isPublished: true,
    publishedAt: null,
    ratingAvg: '4.80',
    reviewCount: 324,
    seo: { title: 'T', description: 'D', ogImage: '/a.jpg' },
    variants: [variantFixture()],
    images: [{ url: '/a.jpg', alt: 'Almonds', sortOrder: 0 }],
    pricingTiers: [],
    ...overrides,
  } as unknown as Product;
}

describe('toWireVariant', () => {
  it('converts paise to rupees', () => {
    const wire = toWireVariant(variantFixture());
    expect(wire.price).toBe(299);
    expect(wire.mrp).toBe(349);
  });

  it('lowercases the channel onto the wire vocabulary', () => {
    expect(toWireVariant(variantFixture()).channel).toBe('retail');
    expect(toWireVariant(variantFixture({ channel: VariantChannel.BULK })).channel).toBe('bulk');
  });

  it('computes available as onHand minus reserved', () => {
    const wire = toWireVariant(
      variantFixture({ inventory: { onHand: 120, reserved: 20 } as Inventory }),
    );
    expect(wire.available).toBe(100);
    expect(wire.soldOut).toBe(false);
  });

  /**
   * A variant with no inventory row has nothing to sell. Mapping it to `available: 0` rather than
   * letting `undefined` propagate is what stops a missing row rendering as an orderable product.
   */
  it('treats a missing inventory row as nothing available', () => {
    const wire = toWireVariant(variantFixture({ inventory: null }));
    expect(wire.available).toBe(0);
    expect(wire.soldOut).toBe(true);
  });

  it('marks a variant sold out when reserved has consumed the whole shelf', () => {
    const wire = toWireVariant(
      variantFixture({ inventory: { onHand: 5, reserved: 5 } as Inventory }),
    );
    expect(wire.available).toBe(0);
    expect(wire.soldOut).toBe(true);
  });
});

describe('toWireProduct', () => {
  it('converts the numeric columns Postgres returns as strings', () => {
    const wire = toWireProduct(productFixture(), null);
    // `gstRate: '5.00'` would sail through as a string without this conversion, and the frontend's
    // cart maths multiplies by it.
    expect(wire.gstRate).toBe(5);
    expect(typeof wire.gstRate).toBe('number');
    expect(wire.moqKg).toBe(10);
    expect(wire.rating).toBe(4.8);
    expect(typeof wire.rating).toBe('number');
  });

  it('exposes the category as its slug, matching the Phase 1 contract', () => {
    expect(toWireProduct(productFixture(), null).category).toBe('almonds');
  });

  it('omits the badge entirely when there is none, rather than sending null', () => {
    const wire = toWireProduct(productFixture({ badge: null }), null);
    expect('badge' in wire).toBe(false);
  });

  /**
   * `quoteOnly` is optional on the wire and `BulkProductCard` tests it with `=== true`, so a
   * `null` or a string would read as false there. Same omit-rather-than-send rule as `badge`.
   */
  it('omits quoteOnly unless the product is quote-only', () => {
    expect('quoteOnly' in toWireProduct(productFixture(), null)).toBe(false);
    expect(toWireProduct(productFixture({ quoteOnly: true }), null).quoteOnly).toBe(true);
  });

  /**
   * `seo` is a jsonb column defaulting to `{}`, so a product saved without SEO copy is the normal
   * state rather than an edge case. The wire `Seo` declares three required strings, and an
   * `undefined` reaching a meta tag renders the word "undefined" to a crawler.
   */
  it('fills the seo fields a product was saved without', () => {
    const wire = toWireProduct(productFixture({ seo: {} }), null);
    expect(wire.seo).toEqual({ title: '', description: '', ogImage: '' });
  });

  it('derives product soldOut from its active variants', () => {
    const allOut = productFixture({
      variants: [
        variantFixture({ inventory: { onHand: 0, reserved: 0 } as Inventory }),
        variantFixture({ id: 'var-2', inventory: { onHand: 0, reserved: 0 } as Inventory }),
      ],
    });
    expect(toWireProduct(allOut, null).soldOut).toBe(true);

    const oneLeft = productFixture({
      variants: [
        variantFixture({ inventory: { onHand: 0, reserved: 0 } as Inventory }),
        variantFixture({ id: 'var-2', inventory: { onHand: 3, reserved: 0 } as Inventory }),
      ],
    });
    expect(toWireProduct(oneLeft, null).soldOut).toBe(false);
  });

  /**
   * An inactive variant is not for sale, so it must not keep a product looking in stock. This is
   * the case a naive `variants.every(...)` over all variants gets wrong.
   */
  it('ignores an inactive variant when deriving product soldOut', () => {
    const wire = toWireProduct(
      productFixture({
        variants: [
          variantFixture({ inventory: { onHand: 0, reserved: 0 } as Inventory }),
          variantFixture({
            id: 'var-2',
            isActive: false,
            inventory: { onHand: 99, reserved: 0 } as Inventory,
          }),
        ],
      }),
      null,
    );
    expect(wire.soldOut).toBe(true);
  });

  it('exposes the default-segment bulk tiers in rupees, ordered by minKg', () => {
    const wire = toWireProduct(
      productFixture({
        pricingTiers: [
          {
            minKg: '25',
            maxKg: '49',
            pricePerKgPaise: 84900n,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
          {
            minKg: '1',
            maxKg: '4',
            pricePerKgPaise: 99900n,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
          {
            minKg: '50',
            maxKg: null,
            pricePerKgPaise: null,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
        ],
      } as unknown as Partial<Product>),
      null,
    );

    expect(wire.bulkTiers.map((tier) => tier.minKg)).toEqual([1, 25, 50]);
    expect(wire.bulkTiers.map((tier) => tier.maxKg)).toEqual([4, 49, null]);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(999);
    // Null is what `isQuoteRequired` reads to route a 50kg enquiry to the RFQ form. Emitting 0 here
    // would silently offer a free tonne of almonds.
    expect(wire.bulkTiers[2]?.pricePerKg).toBeNull();
  });

  it('ignores tiers for another segment or a specific business', () => {
    const wire = toWireProduct(
      productFixture({
        pricingTiers: [
          {
            minKg: '1',
            maxKg: '4',
            pricePerKgPaise: 99900n,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
          {
            minKg: '1',
            maxKg: '4',
            pricePerKgPaise: 80000n,
            segment: CustomerSegment.DISTRIBUTOR,
            businessId: null,
          },
          {
            minKg: '1',
            maxKg: '4',
            pricePerKgPaise: 70000n,
            segment: CustomerSegment.DEFAULT,
            businessId: 'biz-1',
          },
        ],
      } as unknown as Partial<Product>),
      null,
    );
    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(999);
  });

  it('drops inactive variants from the wire list entirely', () => {
    const wire = toWireProduct(
      productFixture({
        variants: [variantFixture(), variantFixture({ id: 'var-2', isActive: false })],
      }),
      null,
    );
    expect(wire.variants).toHaveLength(1);
  });

  it('orders images by sortOrder and emits only their urls', () => {
    const wire = toWireProduct(
      productFixture({
        images: [
          { url: '/c.jpg', alt: 'c', sortOrder: 2 },
          { url: '/a.jpg', alt: 'a', sortOrder: 0 },
          { url: '/b.jpg', alt: 'b', sortOrder: 1 },
        ],
      } as unknown as Partial<Product>),
      null,
    );
    expect(wire.images).toEqual(['/a.jpg', '/b.jpg', '/c.jpg']);
  });

  /**
   * The guard for constraint 1 of this plan. Every money field on the wire is rupees, and paise
   * that escape a mapper render through `inr()` as a figure a hundred times too large on every
   * price in the shop.
   *
   * The assertion is the *exact* rupee figure each paise literal in the fixture implies, on every
   * money field the wire `Product` has, not an upper bound: a bound like `price < 100_000` also
   * passes a value wrong by a factor of ten, or one divided twice, and those are live failure
   * modes here — `toRupees` applied in both the mapper and a service is precisely the "never
   * twice" the constraint warns about.
   */
  it('emits every money field as the exact rupee figure its paise imply', () => {
    const wire = toWireProduct(
      productFixture({
        variants: [
          variantFixture(),
          variantFixture({
            id: 'var-2',
            sku: 'PCA-1KG',
            size: '1kg',
            grams: 1000,
            pricePaise: 109900n,
            mrpPaise: 129900n,
          }),
        ],
        pricingTiers: [
          {
            minKg: '1',
            maxKg: '4',
            pricePerKgPaise: 99900n,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
          {
            minKg: '25',
            maxKg: '49',
            pricePerKgPaise: 84950n,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
          {
            minKg: '50',
            maxKg: null,
            pricePerKgPaise: null,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
        ],
      } as unknown as Partial<Product>),
      null,
    );

    expect(wire.variants.map((variant) => [variant.sku, variant.price, variant.mrp])).toEqual([
      ['PCA-250G', 299, 349],
      ['PCA-1KG', 1099, 1299],
    ]);
    // 84950 paise is ₹849.50 — a fractional rupee, so a mapper that rounded or truncated on the
    // way out would fail here too.
    expect(wire.bulkTiers.map((tier) => tier.pricePerKg)).toEqual([999, 849.5, null]);
  });
});
