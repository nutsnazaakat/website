import type {
  AdminBusinessSummary,
  AdminCategory,
  AdminInventoryRow,
  AdminInventoryTransaction,
  AdminPricingTier,
  AdminProduct,
} from "@/contract";

/**
 * Fixtures for plan 9.6b's catalogue and stock screens.
 *
 * A **separate file from `server.ts`**, whose shapes plan 9.6a measured against the running
 * backend. Two reasons, and the second is the operative one: 9.6b's two groups are built
 * concurrently in separate checkouts, so a fixture file each keeps the merge to new files rather
 * than to one file both sides appended to.
 *
 * **Money is rupees.** ₹449 for a 500g pack is `449`, not `44900` — spec §8 converts at the mapper
 * boundary and `types/admin.ts`'s own header says so. A fixture carrying paise would let every
 * money assertion below pass while the screen was wrong by a factor of a hundred, which is exactly
 * the failure the 9.6a fixtures were shaped to rule out. The figures here agree with `ORDER_DETAIL`
 * in `server.ts`, which was measured: two 500g almond packs came to ₹898.
 */

export const CATEGORY_NUTS: AdminCategory = {
  id: "5f7fe0ab-6a5b-4b1e-9b9d-91c1b0aa5f01",
  slug: "nuts",
  name: "Nuts",
  image: "https://images.example.com/nuts.jpg",
  blurb: "Badam, kaju, akhrot — graded and crisp",
  description: "Graded kernels from California, Iran and Afghanistan.",
  sortOrder: 0,
  isPublished: true,
  seo: { title: "Nuts", description: "Premium nuts", ogImage: "" },
};

/** Unpublished on purpose: the tile is hidden, the products underneath it are not. */
export const CATEGORY_GIFTING: AdminCategory = {
  id: "5f7fe0ab-6a5b-4b1e-9b9d-91c1b0aa5f02",
  slug: "gifting",
  name: "Gifting",
  image: "https://images.example.com/gifting.jpg",
  blurb: "Boxed for Diwali and beyond",
  description: "Ready-to-gift assortments.",
  sortOrder: 4,
  isPublished: false,
  seo: { title: "", description: "", ogImage: "" },
};

export const CATEGORIES: AdminCategory[] = [CATEGORY_NUTS, CATEGORY_GIFTING];

export const ALMONDS: AdminProduct = {
  id: "8a4b1f2c-1111-4c3a-9f11-2c9d5c7e1001",
  slug: "premium-california-almonds",
  name: "Premium California Almonds",
  category: "nuts",
  categoryId: CATEGORY_NUTS.id,
  subtitle: "Crunchy, uniform kernels for daily snacking.",
  description: "Independence grade almond kernels, cleaned and machine sorted.",
  badge: "BESTSELLER",
  rating: 4.6,
  reviewCount: 18,
  images: ["https://images.example.com/almonds-1.jpg"],
  origin: "California, USA",
  grade: "Independence",
  processing: "Cleaned, sorted and machine graded",
  shelfLife: "9 months from packing",
  storage: "Store in a cool, dry place. Refrigerate after opening.",
  ingredients: "Almonds",
  hsn: "0802",
  gstRate: 5,
  moqKg: 10,
  quoteOnly: false,
  soldOut: false,
  seo: {
    title: "Premium California Almonds",
    description: "Independence grade almonds, packed fresh.",
    ogImage: "",
  },
  bulkTiers: [
    { minKg: 10, maxKg: 24, pricePerKg: 720 },
    { minKg: 25, maxKg: null, pricePerKg: null },
  ],
  isPublished: true,
  publishedAt: "2026-02-11T05:30:00.000Z",
  createdAt: "2026-02-10T05:30:00.000Z",
  updatedAt: "2026-08-21T07:44:13.405Z",
  variants: [
    {
      id: "c1d2e3f4-2222-4a5b-8c9d-1e2f3a4b5c01",
      sku: "PCA-500G",
      size: "500 g",
      grams: 500,
      channel: "retail",
      price: 449,
      mrp: 525,
      moq: 1,
      available: 42,
      soldOut: false,
      isActive: true,
    },
    {
      // Withdrawn rather than deleted — the pack an operator must still be able to see and revive.
      id: "c1d2e3f4-2222-4a5b-8c9d-1e2f3a4b5c02",
      sku: "PCA-50KG",
      size: "50 kg",
      grams: 50_000,
      channel: "bulk",
      price: 34_500,
      mrp: 39_000,
      moq: 1,
      available: 0,
      soldOut: true,
      isActive: false,
    },
  ],
};

/** A draft: no publish date, and the reason the admin list exists at all. */
export const MAKHANA_DRAFT: AdminProduct = {
  ...ALMONDS,
  id: "8a4b1f2c-1111-4c3a-9f11-2c9d5c7e1002",
  slug: "roasted-makhana",
  name: "Roasted Makhana",
  subtitle: "Light, roasted fox nuts.",
  badge: "NEW",
  rating: 0,
  reviewCount: 0,
  isPublished: false,
  publishedAt: null,
  soldOut: true,
  variants: [],
};

export const INVENTORY_LOW: AdminInventoryRow = {
  variantId: ALMONDS.variants[0]?.id ?? "",
  sku: "PCA-500G",
  size: "500 g",
  isActive: true,
  productId: ALMONDS.id,
  productName: ALMONDS.name,
  onHand: 8,
  reserved: 0,
  available: 8,
  lowStockThreshold: 10,
  low: true,
  outOfStock: false,
  updatedAt: "2026-08-26T11:02:00.000Z",
};

export const INVENTORY_OUT: AdminInventoryRow = {
  variantId: ALMONDS.variants[1]?.id ?? "",
  sku: "PCA-50KG",
  size: "50 kg",
  // Listed even though the pack is withdrawn: stock does not stop existing because the pack
  // stopped being offered, and hiding it would strand real inventory.
  isActive: false,
  productId: ALMONDS.id,
  productName: ALMONDS.name,
  onHand: 0,
  reserved: 0,
  available: 0,
  lowStockThreshold: 2,
  low: true,
  outOfStock: true,
  updatedAt: "2026-08-20T09:15:00.000Z",
};

export const LEDGER: AdminInventoryTransaction[] = [
  {
    id: "aa11bb22-3333-4444-5555-666677778801",
    variantId: INVENTORY_LOW.variantId,
    delta: -2,
    type: "SALE",
    reason: "Order NN-2026-005107",
    balanceAfter: 8,
    orderId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    orderNumber: "NN-2026-005107",
    // A sale is written by checkout on a customer's behalf, so there is no admin to attribute it to.
    actorUserId: null,
    actorName: null,
    createdAt: "2026-08-21T07:44:13.405Z",
  },
  {
    id: "aa11bb22-3333-4444-5555-666677778802",
    variantId: INVENTORY_LOW.variantId,
    delta: 10,
    type: "RECEIPT",
    reason: "Opening stock from the Bengaluru warehouse",
    balanceAfter: 10,
    orderId: null,
    orderNumber: null,
    actorUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
    actorName: "Nazaakat Admin",
    createdAt: "2026-08-18T06:00:00.000Z",
  },
];

export const BUSINESS_ANAND: AdminBusinessSummary = {
  id: "b1c2d3e4-7777-4888-9999-aaaabbbbcc01",
  userId: "b1c2d3e4-7777-4888-9999-aaaabbbbcc99",
  companyName: "Anand Sweets & Namkeen",
  contactPerson: "Rakesh Anand",
  mobile: "9845012345",
  email: "b2b@demo.in",
  gstin: "29ABCDE1234F1Z5",
  businessType: "Sweet shop",
  segment: "distributor",
  orders: 2,
  totalSpend: 77_348.25,
  lastOrderAt: "2026-08-08T07:44:13.405Z",
  rfqs: 3,
  openRfqs: 1,
  assignedSalesperson: null,
  createdAt: "2025-11-02T05:30:00.000Z",
};

export const TIER_SEGMENT: AdminPricingTier = {
  id: "d4e5f6a7-8888-4999-aaaa-bbbbccccdd01",
  productId: ALMONDS.id,
  productSlug: ALMONDS.slug,
  productName: ALMONDS.name,
  minKg: 10,
  maxKg: 24,
  pricePerKg: 720,
  segment: "distributor",
  businessId: null,
  companyName: null,
  createdAt: "2026-03-01T05:30:00.000Z",
  updatedAt: "2026-03-01T05:30:00.000Z",
};

/** The open-ended top slab, quote-required: `maxKg` and `pricePerKg` are both meaningfully null. */
export const TIER_QUOTE_ONLY: AdminPricingTier = {
  ...TIER_SEGMENT,
  id: "d4e5f6a7-8888-4999-aaaa-bbbbccccdd02",
  minKg: 25,
  maxKg: null,
  pricePerKg: null,
};

/** Brief §31's customer-specific pricing: one business's own ladder. */
export const TIER_BUSINESS: AdminPricingTier = {
  ...TIER_SEGMENT,
  id: "d4e5f6a7-8888-4999-aaaa-bbbbccccdd03",
  minKg: 50,
  maxKg: 99,
  pricePerKg: 655,
  segment: "default",
  businessId: BUSINESS_ANAND.id,
  companyName: BUSINESS_ANAND.companyName,
};
