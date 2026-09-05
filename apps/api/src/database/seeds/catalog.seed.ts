import { toPaise } from '@nutwala/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { Category } from '../../entities/catalog/category.entity';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductImage } from '../../entities/catalog/product-image.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { CustomerSegment, InventoryTransactionType, VariantChannel } from '../../entities/enums';
import { IMAGES, requireValue } from './seed-context';

/**
 * Ported from `frontend/src/mocks/categories.ts` and `frontend/src/mocks/products.ts`.
 *
 * The mock derives all 27 products, 216 variants and 135 pricing tiers from a compact seed
 * array through two functions. Those functions are ported rather than their output: the
 * derivation is the source of truth, and hand-copying 216 expanded variants would be both
 * huge and immediately stale.
 *
 * Keep the arithmetic identical. The seeded prices are what the Phase 1 screenshots, the
 * seeded orders and the combo savings figures all assume, so changing a formula would
 * silently invalidate all three.
 */

const RETAIL_PACKS = [
  { size: '100g', grams: 100, frac: 0.13 },
  { size: '250g', grams: 250, frac: 0.3 },
  { size: '500g', grams: 500, frac: 0.55 },
  { size: '1kg', grams: 1000, frac: 1 },
] as const;

const BULK_PACKS = [
  { size: '5kg', grams: 5000 },
  { size: '10kg', grams: 10000 },
  { size: '25kg', grams: 25000 },
  { size: '50kg', grams: 50000 },
] as const;

const DISCOUNT = 0.14;

/**
 * Opening stock per channel, and the ledger row that accounts for it.
 *
 * These are the mock's own figures — `available: 120` on a retail pack, `available: 40` on a
 * bulk one. Bulk consignments really are scarcer than 250g pouches, and the seeded catalogue
 * should say so.
 *
 * The one hard requirement is that a variant's opening ledger row carries the *same* figure as
 * its `Inventory.onHand`, because `SUM(inventory_transactions.delta) = inventory.onHand` per
 * variant is what stops the denormalised column drifting from the ledger, and it has to hold
 * from the first row. That constrains the pair to agree. It does not constrain every variant to
 * share one number, so nothing is gained by flattening the two channels together.
 *
 * Known limitation, stated rather than hidden: a re-run resets `onHand` to the opening figure
 * but leaves the append-only ledger alone. So reseeding a database that has since recorded real
 * stock movements will break that invariant. Reseed a database the seed still owns, which is the
 * only situation the developer-refresh workflow covers.
 */
const OPENING_STOCK: Record<VariantChannel, number> = {
  [VariantChannel.RETAIL]: 120,
  [VariantChannel.BULK]: 40,
};
const LOW_STOCK_THRESHOLD = 10;
export const OPENING_STOCK_REASON = 'Opening stock (seed)';

const slugToSku = (slug: string): string =>
  slug
    .split('-')
    .map((word) => word.slice(0, 3).toUpperCase())
    .join('');

interface CategorySeed {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
}

/** All 12 categories from `frontend/src/mocks/categories.ts`, in the mock's own order. */
const CATEGORY_SEEDS: CategorySeed[] = [
  {
    slug: 'almonds',
    name: 'Almonds',
    image: IMAGES.almonds,
    blurb: 'Badam, graded and crisp',
    description: 'Graded almond kernels from California, Iran and Afghanistan.',
  },
  {
    slug: 'cashews',
    name: 'Cashews',
    image: IMAGES.cashews,
    blurb: 'W240 & W320 kaju',
    description: 'Whole white cashew kernels in standard export grades.',
  },
  {
    slug: 'pistachios',
    name: 'Pistachios',
    image: IMAGES.pistachios,
    blurb: 'Roasted & salted pista',
    description: 'In-shell and kernel pistachios for snacking and mithai.',
  },
  {
    slug: 'walnuts',
    name: 'Walnuts',
    image: IMAGES.mixed,
    blurb: 'Light halves, akhrot',
    description: 'Light-coloured walnut halves and pieces.',
  },
  {
    slug: 'raisins',
    name: 'Raisins',
    image: IMAGES.mixed,
    blurb: 'Golden & black kishmish',
    description: 'Seedless raisins in golden and black varieties.',
  },
  {
    slug: 'dates',
    name: 'Dates',
    image: IMAGES.mixed,
    blurb: 'Medjool, Kimia khajoor',
    description: 'Soft dates from Jordan, the UAE and Iran.',
  },
  {
    slug: 'anjeer',
    name: 'Anjeer',
    image: IMAGES.mixed,
    blurb: 'Soft dried figs',
    description: 'Hand-sorted dried figs.',
  },
  {
    slug: 'makhana',
    name: 'Makhana',
    image: IMAGES.mixed,
    blurb: 'Roasted fox nuts',
    description: 'Roasted and flavoured fox nuts from Bihar.',
  },
  {
    slug: 'seeds',
    name: 'Seeds',
    image: IMAGES.mixed,
    blurb: 'Pumpkin, sunflower',
    description: 'Shelled seeds for daily mixing and baking.',
  },
  {
    slug: 'trail-mixes',
    name: 'Trail Mixes',
    image: IMAGES.mixed,
    blurb: 'Everyday snacking',
    description: 'House blends of nuts, seeds and berries.',
  },
  {
    slug: 'roasted-nuts',
    name: 'Roasted Nuts',
    image: IMAGES.mixed,
    blurb: 'Lightly roasted',
    description: 'Lightly roasted and salted nuts.',
  },
  {
    slug: 'combos',
    name: 'Combos',
    image: IMAGES.mixed,
    blurb: 'Boxes & value packs',
    description: 'Value packs and gift boxes.',
  },
];

interface ProductSeed {
  slug: string;
  name: string;
  category: string;
  subtitle: string;
  /** Base rate per kilogram, in rupees. Everything else about the product derives from it. */
  kg: number;
  grade: string;
  origin: string;
  image: string;
  badge?: 'BESTSELLER' | 'NEW' | 'PREMIUM';
  moqKg?: number;
  quoteOnly?: boolean;
}

/**
 * All 27 products from the `seeds` array in `frontend/src/mocks/products.ts`.
 *
 * The mock's `rating` and `reviewCount` are deliberately **not** carried across. They are a
 * Phase 1 display device — the mock's own comment in `reviews.ts` says they "represent the
 * full historical count rather than the handful of written reviews seeded here". Here they
 * would land in `Product.ratingAvg` and `Product.reviewCount`, which are denormalised
 * aggregates of the `reviews` table, so storing 324 reviews' worth of rating against five
 * actual rows would put the database in permanent disagreement with itself. `content.seed.ts`
 * recomputes both columns from the seeded APPROVED reviews instead.
 */
const PRODUCT_SEEDS: ProductSeed[] = [
  {
    slug: 'premium-california-almonds',
    name: 'Premium California Almonds',
    category: 'almonds',
    subtitle: 'Crunchy, uniform kernels for daily snacking.',
    kg: 999,
    grade: 'Independence',
    origin: 'California, USA',
    image: IMAGES.almonds,
    badge: 'BESTSELLER',
  },
  {
    slug: 'mamra-almonds',
    name: 'Mamra Almonds',
    category: 'almonds',
    subtitle: 'Dense, sweet kernels. Small batch.',
    kg: 3499,
    grade: 'Mamra A',
    origin: 'Iran / Afghanistan',
    image: IMAGES.almonds,
    badge: 'PREMIUM',
  },
  {
    slug: 'gurbandi-almonds',
    name: 'Gurbandi Almonds',
    category: 'almonds',
    subtitle: 'Smaller kernel, richer flavour.',
    kg: 1499,
    grade: 'Gurbandi',
    origin: 'Afghanistan',
    image: IMAGES.almonds,
  },
  {
    slug: 'w320-cashews',
    name: 'W320 Cashews',
    category: 'cashews',
    subtitle: 'The everyday kaju standard.',
    kg: 1099,
    grade: 'W320',
    origin: 'India / Vietnam',
    image: IMAGES.cashews,
    badge: 'BESTSELLER',
  },
  {
    slug: 'w240-cashews',
    name: 'W240 Cashews',
    category: 'cashews',
    subtitle: 'Larger, whiter, premium grade.',
    kg: 1399,
    grade: 'W240',
    origin: 'India',
    image: IMAGES.cashews,
    badge: 'PREMIUM',
  },
  {
    slug: 'roasted-salted-cashews',
    name: 'Roasted & Salted Cashews',
    category: 'roasted-nuts',
    subtitle: 'Lightly roasted, lightly salted.',
    kg: 1199,
    grade: 'W320 Roasted',
    origin: 'India',
    image: IMAGES.cashews,
  },
  {
    slug: 'premium-pistachios',
    name: 'Premium Pistachios',
    category: 'pistachios',
    subtitle: 'Roasted and salted in shell.',
    kg: 1699,
    grade: 'Jumbo',
    origin: 'Iran / USA',
    image: IMAGES.pistachios,
    badge: 'BESTSELLER',
  },
  {
    slug: 'pistachio-kernels',
    name: 'Pistachio Kernels',
    category: 'pistachios',
    subtitle: 'Shelled kernels for baking and mithai.',
    kg: 2699,
    grade: 'Kernel A',
    origin: 'Iran',
    image: IMAGES.pistachios,
    moqKg: 5,
  },
  {
    slug: 'california-walnuts',
    name: 'California Walnut Kernels',
    category: 'walnuts',
    subtitle: 'Light halves and pieces.',
    kg: 1299,
    grade: 'Light Halves',
    origin: 'Chile / USA',
    image: IMAGES.placeholder,
  },
  {
    slug: 'afghani-black-raisins',
    name: 'Afghani Black Raisins',
    category: 'raisins',
    subtitle: 'Seedless, deep sweetness.',
    kg: 649,
    grade: 'Seedless',
    origin: 'Afghanistan',
    image: IMAGES.placeholder,
  },
  {
    slug: 'golden-raisins',
    name: 'Golden Raisins',
    category: 'raisins',
    subtitle: 'Plump, mild and juicy.',
    kg: 499,
    grade: 'Long Golden',
    origin: 'India',
    image: IMAGES.placeholder,
    badge: 'NEW',
  },
  {
    slug: 'premium-anjeer',
    name: 'Premium Anjeer',
    category: 'anjeer',
    subtitle: 'Soft dried figs, hand sorted.',
    kg: 1299,
    grade: 'Grade A',
    origin: 'Afghanistan / Turkey',
    image: IMAGES.placeholder,
  },
  {
    slug: 'medjool-dates',
    name: 'Medjool Dates',
    category: 'dates',
    subtitle: 'Large, caramel-soft dates.',
    kg: 1199,
    grade: 'Jumbo',
    origin: 'Jordan / UAE',
    image: IMAGES.placeholder,
    badge: 'PREMIUM',
  },
  {
    slug: 'kimia-dates',
    name: 'Kimia Dates',
    category: 'dates',
    subtitle: 'Soft, dark and everyday.',
    kg: 549,
    grade: 'Standard',
    origin: 'Iran',
    image: IMAGES.placeholder,
  },
  {
    slug: 'roasted-makhana',
    name: 'Roasted Makhana',
    category: 'makhana',
    subtitle: 'Light, crisp fox nuts.',
    kg: 999,
    grade: '5 Suta',
    origin: 'Bihar, India',
    image: IMAGES.placeholder,
    badge: 'BESTSELLER',
  },
  {
    slug: 'peri-peri-makhana',
    name: 'Peri Peri Makhana',
    category: 'makhana',
    subtitle: 'Roasted with a peri peri coat.',
    kg: 1099,
    grade: '5 Suta',
    origin: 'Bihar, India',
    image: IMAGES.placeholder,
    badge: 'NEW',
  },
  {
    slug: 'pumpkin-seeds',
    name: 'Pumpkin Seeds',
    category: 'seeds',
    subtitle: 'Raw, shelled and clean.',
    kg: 699,
    grade: 'AA',
    origin: 'China / India',
    image: IMAGES.placeholder,
  },
  {
    slug: 'sunflower-seeds',
    name: 'Sunflower Seeds',
    category: 'seeds',
    subtitle: 'Everyday mixing seeds.',
    kg: 449,
    grade: 'Shelled',
    origin: 'India',
    image: IMAGES.placeholder,
  },
  {
    slug: 'everyday-trail-mix',
    name: 'Everyday Trail Mix',
    category: 'trail-mixes',
    subtitle: 'Nuts, seeds and berries.',
    kg: 1099,
    grade: 'House Blend',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
  },
  // Brief §23 names the six combos the /combos page must carry. §44's sample-product list
  // spells two of them differently ("Daily Dry Fruit Combo", "Premium Family Combo"); the
  // §23 names win because a combo whose card and cart line disagree with its product page
  // is worse than a sample list that reads loosely. Slugs are left alone so existing links
  // and seeded orders keep resolving.
  {
    slug: 'daily-dry-fruit-combo',
    name: 'Daily Nutrition Combo',
    category: 'combos',
    subtitle: 'Almonds, cashews, raisins and anjeer.',
    kg: 899,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
    badge: 'BESTSELLER',
  },
  {
    slug: 'premium-nuts-combo',
    name: 'Premium Nuts Combo',
    category: 'combos',
    subtitle: 'Four premium-grade kernels in one box.',
    kg: 1599,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
    badge: 'PREMIUM',
  },
  {
    slug: 'premium-family-combo',
    name: 'Family Pack',
    category: 'combos',
    subtitle: 'Four packs, one box.',
    kg: 1199,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
  },
  {
    slug: 'office-snack-combo',
    name: 'Office Snack Combo',
    category: 'combos',
    subtitle: 'Makhana, trail mix and roasted nuts.',
    kg: 949,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
  },
  {
    slug: 'trail-mix-combo',
    name: 'Trail Mix Combo',
    category: 'combos',
    subtitle: 'Three house blends in one box.',
    kg: 1049,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
  },
  {
    slug: 'festive-combo',
    name: 'Festive Combo',
    category: 'combos',
    subtitle: 'Assorted nuts for the season.',
    kg: 1349,
    grade: 'Combo',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
  },
  {
    slug: 'corporate-gift-box',
    name: 'Corporate Gift Box',
    category: 'combos',
    subtitle: 'Custom branding available.',
    kg: 1599,
    grade: 'Gift',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
    quoteOnly: true,
    moqKg: 25,
  },
  {
    slug: 'festive-gift-box',
    name: 'Festive Gift Box',
    category: 'combos',
    subtitle: 'Assorted nuts in a keepsake box.',
    kg: 1499,
    grade: 'Gift',
    origin: 'Multi-origin',
    image: IMAGES.placeholder,
    badge: 'PREMIUM',
  },
];

interface VariantSeed {
  sku: string;
  size: string;
  grams: number;
  channel: VariantChannel;
  pricePaise: bigint;
  mrpPaise: bigint;
  moq: number;
}

/** Ported from `buildVariants` in `frontend/src/mocks/products.ts`. */
function buildVariants(slug: string, kgPrice: number): VariantSeed[] {
  const retail = RETAIL_PACKS.map(({ size, grams, frac }) => {
    const price = Math.round((kgPrice * frac) / 10) * 10 - 1;
    const mrp = Math.round(price / (1 - DISCOUNT) / 10) * 10 - 1;
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: VariantChannel.RETAIL,
      pricePaise: toPaise(price),
      mrpPaise: toPaise(mrp),
      moq: 1,
    };
  });

  const bulk = BULK_PACKS.map(({ size, grams }) => {
    const kg = grams / 1000;
    const rate = Math.round(kgPrice * (kg >= 50 ? 0.82 : kg >= 25 ? 0.85 : kg >= 10 ? 0.9 : 0.95));
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: VariantChannel.BULK,
      pricePaise: toPaise(rate * kg),
      mrpPaise: toPaise(kgPrice * kg),
      moq: 1,
    };
  });

  return [...retail, ...bulk];
}

interface TierSeed {
  minKg: number;
  maxKg: number | null;
  pricePerKg: number | null;
}

/**
 * Brief §16's five slabs. Ported from `buildTiers` in `frontend/src/mocks/products.ts`.
 *
 * The open-ended 50kg+ slab carries **no** price, for every product. That is the mock's own
 * value, and it is load-bearing rather than an omission: `isQuoteRequired` in
 * `frontend/src/features/bulk/pricing.ts` returns true precisely when the resolved slab has a
 * null rate, so this null is what routes a 50kg+ enquiry to the RFQ form. Publishing a
 * computed rate here instead would change Phase 1's visible behaviour on every product page's
 * bulk calculator, which the binding constraint above forbids.
 *
 * It also subsumes the `quoteOnly` case: `corporate-gift-box` needs its top slab null, and
 * gets it here along with everything else.
 */
function buildTiers(kgPrice: number): TierSeed[] {
  return [
    { minKg: 1, maxKg: 4, pricePerKg: kgPrice },
    { minKg: 5, maxKg: 9, pricePerKg: Math.round(kgPrice * 0.95) },
    { minKg: 10, maxKg: 24, pricePerKg: Math.round(kgPrice * 0.9) },
    { minKg: 25, maxKg: 49, pricePerKg: Math.round(kgPrice * 0.85) },
    { minKg: 50, maxKg: null, pricePerKg: null },
  ];
}

async function seedCategories(manager: EntityManager): Promise<number> {
  const repository = manager.getRepository(Category);

  await repository.upsert(
    CATEGORY_SEEDS.map((category, index) => ({
      ...category,
      sortOrder: index,
      isPublished: true,
      seo: {},
    })),
    ['slug'],
  );

  return CATEGORY_SEEDS.length;
}

export async function seedCatalog(dataSource: DataSource): Promise<number> {
  return dataSource.transaction(async (manager) => {
    let rows = await seedCategories(manager);

    const categories = await manager
      .getRepository(Category)
      .find({ select: { id: true, slug: true } });
    const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

    // The stock ledger is append-only, so the opening row is inserted only where one is not
    // already present rather than deleted and rewritten. `(variantId, reason)` is its natural
    // key: exactly one opening row per variant, forever.
    const openingRows = await manager
      .getRepository(InventoryTransaction)
      .createQueryBuilder('transaction')
      .select('transaction.variantId', 'variantId')
      .where('transaction.reason = :reason', { reason: OPENING_STOCK_REASON })
      .getRawMany<{ variantId: string }>();
    const variantsWithOpeningRow = new Set(openingRows.map((row) => row.variantId));

    for (const seed of PRODUCT_SEEDS) {
      const categoryId = requireValue(
        categoryIdBySlug.get(seed.category),
        `category "${seed.category}" for product "${seed.slug}"`,
      );

      await manager.getRepository(Product).upsert(
        {
          slug: seed.slug,
          name: seed.name,
          categoryId,
          subtitle: seed.subtitle,
          description: `${seed.name} — ${seed.grade} grade, sourced from ${seed.origin}. Cleaned, sorted and machine graded, then packed to order.`,
          badge: seed.badge ?? null,
          origin: seed.origin,
          grade: seed.grade,
          processing: 'Cleaned, sorted and machine graded',
          shelfLife: '9 months from packing',
          storage: 'Store in a cool, dry place. Refrigerate after opening.',
          ingredients: seed.name,
          hsn: '0802',
          gstRate: '5',
          moqKg: String(seed.moqKg ?? 10),
          quoteOnly: seed.quoteOnly ?? false,
          isPublished: true,
          // The mock carries no publication date for a product. `publishedAt` stays null
          // rather than inventing one; `isPublished` is what the catalogue reads.
          publishedAt: null,
          seo: {
            title: `${seed.name} — Buy Online in 100g to 1kg | Nuts & Nazaakat`,
            description: `${seed.subtitle} ${seed.grade} grade from ${seed.origin}. Retail packs and bulk per-kg pricing with GST invoice.`,
            ogImage: seed.image,
          },
        },
        ['slug'],
      );
      rows += 1;

      const product = requireValue(
        (await manager.getRepository(Product).findOne({
          where: { slug: seed.slug },
          select: { id: true },
        })) ?? undefined,
        `product "${seed.slug}" immediately after upserting it`,
      );

      // Images and pricing tiers have no natural key of their own, so they are replaced
      // wholesale. Both are owned entirely by this seeder today, so nothing else can lose a row.
      //
      // That ownership expires the moment admin product-editing ships: `npm run seed -- catalog`
      // would then silently destroy hand-edited images and tiers, exactly as it would destroy
      // real stock movements (see `OPENING_STOCK`). Unlike the ledger there is no fallback —
      // neither `ProductImage` nor `PricingTier` has any unique index, so a real upsert is not
      // even expressible yet. Whoever adds that admin screen has to pick one: add natural unique
      // keys — `(product_id, sort_order)` and `(product_id, min_kg, segment, business_id)` — so
      // seeding becomes non-destructive, or make this seeder refuse to run when it finds rows it
      // did not write.
      await manager.getRepository(ProductImage).delete({ productId: product.id });
      const imageUrls = [seed.image, IMAGES.placeholder, IMAGES.placeholder];
      await manager.getRepository(ProductImage).insert(
        imageUrls.map((url, index) => ({
          productId: product.id,
          url,
          alt: seed.name,
          sortOrder: index,
        })),
      );
      rows += imageUrls.length;

      await manager.getRepository(PricingTier).delete({ productId: product.id });
      const tiers = buildTiers(seed.kg);
      await manager.getRepository(PricingTier).insert(
        tiers.map((tier) => ({
          productId: product.id,
          minKg: String(tier.minKg),
          maxKg: tier.maxKg === null ? null : String(tier.maxKg),
          pricePerKgPaise: tier.pricePerKg === null ? null : toPaise(tier.pricePerKg),
          segment: CustomerSegment.DEFAULT,
          businessId: null,
        })),
      );
      rows += tiers.length;

      const variantSeeds = buildVariants(seed.slug, seed.kg);
      await manager.getRepository(ProductVariant).upsert(
        variantSeeds.map((variant) => ({ ...variant, productId: product.id, isActive: true })),
        ['sku'],
      );
      rows += variantSeeds.length;

      const variants = await manager.getRepository(ProductVariant).find({
        where: { productId: product.id },
        select: { id: true, channel: true },
      });

      await manager.getRepository(Inventory).upsert(
        variants.map((variant) => ({
          variantId: variant.id,
          onHand: OPENING_STOCK[variant.channel],
          reserved: 0,
          lowStockThreshold: LOW_STOCK_THRESHOLD,
        })),
        ['variantId'],
      );
      rows += variants.length;

      const missingOpeningRows = variants.filter(
        (variant) => !variantsWithOpeningRow.has(variant.id),
      );
      if (missingOpeningRows.length > 0) {
        await manager.getRepository(InventoryTransaction).insert(
          missingOpeningRows.map((variant) => ({
            variantId: variant.id,
            delta: OPENING_STOCK[variant.channel],
            type: InventoryTransactionType.RECEIPT,
            reason: OPENING_STOCK_REASON,
            balanceAfter: OPENING_STOCK[variant.channel],
            orderId: null,
            actorUserId: null,
          })),
        );
        rows += missingOpeningRows.length;
      }
    }

    return rows;
  });
}
