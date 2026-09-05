import type { PageQuery } from './api';

export type Channel = 'retail' | 'bulk';
export type Badge = 'BESTSELLER' | 'NEW' | 'PREMIUM';

export interface Variant {
  sku: string;
  size: string;
  /** Canonical unit for per-100g and per-kg comparison (brief §47). */
  grams: number;
  channel: Channel;
  price: number;
  mrp: number;
  moq: number;
  /**
   * `onHand - reserved`, per spec §10.1. Replaces Phase 1's `stock`, which was declared but
   * never read by any component.
   */
  available: number;
  /**
   * `available === 0`, derived server-side so every client agrees on the rule.
   *
   * Must come from one shared derivation helper reused at every assembly site — listing,
   * detail, bulk catalogue, admin. TypeScript enforces that this field is present, not that
   * its value agrees with `available`, so a second mapper that reimplements the rule compiles
   * cleanly and ships a stale flag: the listing says in stock while the product page says
   * sold out.
   */
  soldOut: boolean;
}

export interface BulkTier {
  minKg: number;
  maxKg: number | null;
  /** Null means the tier requires a quote and routes to the RFQ flow. */
  pricePerKg: number | null;
}

export interface Seo {
  title: string;
  description: string;
  ogImage: string;
}

export interface Product {
  slug: string;
  name: string;
  category: string;
  subtitle: string;
  description: string;
  badge?: Badge;
  rating: number;
  reviewCount: number;
  images: string[];
  origin: string;
  grade: string;
  processing: string;
  shelfLife: string;
  storage: string;
  ingredients: string;
  hsn: string;
  gstRate: number;
  variants: Variant[];
  bulkTiers: BulkTier[];
  moqKg: number;
  quoteOnly?: boolean;
  /**
   * True only when every active variant is sold out. Spec §10.1.
   *
   * Same obligation as `Variant.soldOut`: one derivation helper, reused everywhere.
   */
  soldOut: boolean;
  seo: Seo;
}

/**
 * `POST /catalog/bulk/quote-preview`'s response — spec §6.1's bulk calculator, priced server-side
 * from the caller's own viewer rather than the client's copy of the ladder.
 *
 * `quoteRequired: true` is a normal answer, not an error — spec §13 requires the server to
 * recompute rather than trust a client's bulk total, and a quote-only product or an unpriced slab
 * both route the enquiry to the RFQ form instead of failing the request. `pricePerKg` and `total`
 * are both null exactly when `quoteRequired` is true — there is no rate to show.
 *
 * `tier` is the matched rung's bounds (`maxKg: null` is the open-ended top slab), for the
 * calculator to render "you're in the 25-49kg band" even when that band turns out to need a
 * quote. It is null only when the requested weight matched no rung in the resolved ladder at all.
 */
export interface QuotePreviewResponse {
  slug: string;
  kg: number;
  pricePerKg: number | null;
  total: number | null;
  quoteRequired: boolean;
  tier: { minKg: number; maxKg: number | null } | null;
}

export interface Category {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
}

export interface ComboComponent {
  slug: string;
  name: string;
  size: string;
  grams: number;
  price: number;
  mrp: number;
}

export interface Combo {
  slug: string;
  name: string;
  subtitle: string;
  blurb: string;
  occasion: string;
  image: string;
  price: number;
  partsMrp: number;
  partsPrice: number;
  savings: number;
  savingsPercent: number;
  totalGrams: number;
  components: ComboComponent[];
}

export type ProductSort =
  | 'featured'
  | 'best-selling'
  | 'price-asc'
  | 'price-desc'
  | 'newest'
  | 'rating';

/**
 * The shop's filter set. Phase 1's fields verbatim, plus the three the server needs.
 *
 * `page` and `limit` are inherited from `PageQuery` rather than redeclared, so the request half
 * of pagination has one definition and stays aligned with `Paginated<T>`'s response half. They
 * are optional, so an existing call site that omits them keeps working against the server's
 * defaults.
 *
 * `channel` exists because `/bulk/$category` reuses this type and the same `ShopFilters`
 * component, and previously had to filter bulk products client-side after fetching everything.
 * `inStockOnly` was also not channel-aware, so a product whose retail packs were all at zero but
 * whose 50kg pack had stock still appeared on `/shop` as "in stock".
 */
export interface ProductFilters extends PageQuery {
  category?: string;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  origin?: string;
  grade?: string;
  bestsellerOnly?: boolean;
  inStockOnly?: boolean;
  channel?: Channel;
  /**
   * Hides anything whose minimum order quantity exceeds what the buyer can commit to.
   *
   * `/bulk/$category` renders this as a row of buttons and used to apply it client-side, which
   * filtered whatever page had been fetched: under pagination the rows and the count would describe
   * page one rather than the category. Harmless only because the largest category holds eight
   * products today, which is exactly how it would have broken silently later.
   */
  maxMoq?: number;
  sort?: ProductSort;
}

/**
 * The filter sidebar's option lists and bounds, computed over the whole published catalogue.
 *
 * Served by its own endpoint rather than derived from a product list, because once lists
 * paginate a list-derived facet set describes one page. `ShopPage` previously fired a second
 * unfiltered `useProducts()` for exactly this and would have started lying silently.
 */
export interface CatalogFacets {
  origins: string[];
  grades: string[];
  minPrice: number;
  maxPrice: number;
  categories: { slug: string; name: string; productCount: number }[];
}
