import { productSoldOut, variantSoldOut } from "@/contract";
import type { BulkTier, Product, Variant } from "@/features/catalog/types";
import { img } from "./categories";

const RETAIL_PACKS: { size: string; grams: number; frac: number }[] = [
  { size: "100g", grams: 100, frac: 0.13 },
  { size: "250g", grams: 250, frac: 0.3 },
  { size: "500g", grams: 500, frac: 0.55 },
  { size: "1kg", grams: 1000, frac: 1 },
];

const BULK_PACKS: { size: string; grams: number }[] = [
  { size: "5kg", grams: 5000 },
  { size: "10kg", grams: 10000 },
  { size: "25kg", grams: 25000 },
  { size: "50kg", grams: 50000 },
];

const slugToSku = (slug: string) =>
  slug.split("-").map((w) => w.slice(0, 3).toUpperCase()).join("");

function buildVariants(slug: string, kgPrice: number, discount = 0.14): Variant[] {
  const retail = RETAIL_PACKS.map(({ size, grams, frac }) => {
    const price = Math.round((kgPrice * frac) / 10) * 10 - 1;
    const available = 120;
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: "retail" as const,
      price,
      mrp: Math.round(price / (1 - discount) / 10) * 10 - 1,
      available,
      soldOut: variantSoldOut(available),
      moq: 1,
    };
  });

  const bulk = BULK_PACKS.map(({ size, grams }) => {
    const kg = grams / 1000;
    const rate = Math.round(kgPrice * (kg >= 50 ? 0.82 : kg >= 25 ? 0.85 : kg >= 10 ? 0.9 : 0.95));
    const available = 40;
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: "bulk" as const,
      price: rate * kg,
      mrp: kgPrice * kg,
      available,
      soldOut: variantSoldOut(available),
      moq: 1,
    };
  });

  return [...retail, ...bulk];
}

const buildTiers = (base: number): BulkTier[] => [
  { minKg: 1, maxKg: 4, pricePerKg: base },
  { minKg: 5, maxKg: 9, pricePerKg: Math.round(base * 0.95) },
  { minKg: 10, maxKg: 24, pricePerKg: Math.round(base * 0.9) },
  { minKg: 25, maxKg: 49, pricePerKg: Math.round(base * 0.85) },
  { minKg: 50, maxKg: null, pricePerKg: null },
];

interface Seed {
  slug: string;
  name: string;
  category: string;
  subtitle: string;
  kg: number;
  grade: string;
  origin: string;
  image: string;
  badge?: Product["badge"];
  moqKg?: number;
  quoteOnly?: boolean;
  rating?: number;
  reviewCount?: number;
}

const seeds: Seed[] = [
  { slug: "premium-california-almonds", name: "Premium California Almonds", category: "almonds", subtitle: "Crunchy, uniform kernels for daily snacking.", kg: 999, grade: "Independence", origin: "California, USA", image: img.almonds, badge: "BESTSELLER", rating: 4.8, reviewCount: 324 },
  { slug: "mamra-almonds", name: "Mamra Almonds", category: "almonds", subtitle: "Dense, sweet kernels. Small batch.", kg: 3499, grade: "Mamra A", origin: "Iran / Afghanistan", image: img.almonds, badge: "PREMIUM", rating: 4.9, reviewCount: 86 },
  { slug: "gurbandi-almonds", name: "Gurbandi Almonds", category: "almonds", subtitle: "Smaller kernel, richer flavour.", kg: 1499, grade: "Gurbandi", origin: "Afghanistan", image: img.almonds },
  { slug: "w320-cashews", name: "W320 Cashews", category: "cashews", subtitle: "The everyday kaju standard.", kg: 1099, grade: "W320", origin: "India / Vietnam", image: img.cashews, badge: "BESTSELLER", rating: 4.7, reviewCount: 412 },
  { slug: "w240-cashews", name: "W240 Cashews", category: "cashews", subtitle: "Larger, whiter, premium grade.", kg: 1399, grade: "W240", origin: "India", image: img.cashews, badge: "PREMIUM" },
  { slug: "roasted-salted-cashews", name: "Roasted & Salted Cashews", category: "roasted-nuts", subtitle: "Lightly roasted, lightly salted.", kg: 1199, grade: "W320 Roasted", origin: "India", image: img.cashews },
  { slug: "premium-pistachios", name: "Premium Pistachios", category: "pistachios", subtitle: "Roasted and salted in shell.", kg: 1699, grade: "Jumbo", origin: "Iran / USA", image: img.pistachios, badge: "BESTSELLER", rating: 4.6, reviewCount: 208 },
  { slug: "pistachio-kernels", name: "Pistachio Kernels", category: "pistachios", subtitle: "Shelled kernels for baking and mithai.", kg: 2699, grade: "Kernel A", origin: "Iran", image: img.pistachios, moqKg: 5 },
  { slug: "california-walnuts", name: "California Walnut Kernels", category: "walnuts", subtitle: "Light halves and pieces.", kg: 1299, grade: "Light Halves", origin: "Chile / USA", image: img.placeholder },
  { slug: "afghani-black-raisins", name: "Afghani Black Raisins", category: "raisins", subtitle: "Seedless, deep sweetness.", kg: 649, grade: "Seedless", origin: "Afghanistan", image: img.placeholder },
  { slug: "golden-raisins", name: "Golden Raisins", category: "raisins", subtitle: "Plump, mild and juicy.", kg: 499, grade: "Long Golden", origin: "India", image: img.placeholder, badge: "NEW" },
  { slug: "premium-anjeer", name: "Premium Anjeer", category: "anjeer", subtitle: "Soft dried figs, hand sorted.", kg: 1299, grade: "Grade A", origin: "Afghanistan / Turkey", image: img.placeholder },
  { slug: "medjool-dates", name: "Medjool Dates", category: "dates", subtitle: "Large, caramel-soft dates.", kg: 1199, grade: "Jumbo", origin: "Jordan / UAE", image: img.placeholder, badge: "PREMIUM" },
  { slug: "kimia-dates", name: "Kimia Dates", category: "dates", subtitle: "Soft, dark and everyday.", kg: 549, grade: "Standard", origin: "Iran", image: img.placeholder },
  { slug: "roasted-makhana", name: "Roasted Makhana", category: "makhana", subtitle: "Light, crisp fox nuts.", kg: 999, grade: "5 Suta", origin: "Bihar, India", image: img.placeholder, badge: "BESTSELLER" },
  { slug: "peri-peri-makhana", name: "Peri Peri Makhana", category: "makhana", subtitle: "Roasted with a peri peri coat.", kg: 1099, grade: "5 Suta", origin: "Bihar, India", image: img.placeholder, badge: "NEW" },
  { slug: "pumpkin-seeds", name: "Pumpkin Seeds", category: "seeds", subtitle: "Raw, shelled and clean.", kg: 699, grade: "AA", origin: "China / India", image: img.placeholder },
  { slug: "sunflower-seeds", name: "Sunflower Seeds", category: "seeds", subtitle: "Everyday mixing seeds.", kg: 449, grade: "Shelled", origin: "India", image: img.placeholder },
  { slug: "everyday-trail-mix", name: "Everyday Trail Mix", category: "trail-mixes", subtitle: "Nuts, seeds and berries.", kg: 1099, grade: "House Blend", origin: "Multi-origin", image: img.placeholder },
  // Brief §23 names the six combos the /combos page must carry. §44's sample-product list
  // spells two of them differently ("Daily Dry Fruit Combo", "Premium Family Combo"); the
  // §23 names win because a combo whose card and cart line disagree with its product page
  // is worse than a sample list that reads loosely. Slugs are left alone so existing links
  // and seeded orders keep resolving.
  { slug: "daily-dry-fruit-combo", name: "Daily Nutrition Combo", category: "combos", subtitle: "Almonds, cashews, raisins and anjeer.", kg: 899, grade: "Combo", origin: "Multi-origin", image: img.placeholder, badge: "BESTSELLER" },
  { slug: "premium-nuts-combo", name: "Premium Nuts Combo", category: "combos", subtitle: "Four premium-grade kernels in one box.", kg: 1599, grade: "Combo", origin: "Multi-origin", image: img.placeholder, badge: "PREMIUM" },
  { slug: "premium-family-combo", name: "Family Pack", category: "combos", subtitle: "Four packs, one box.", kg: 1199, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "office-snack-combo", name: "Office Snack Combo", category: "combos", subtitle: "Makhana, trail mix and roasted nuts.", kg: 949, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "trail-mix-combo", name: "Trail Mix Combo", category: "combos", subtitle: "Three house blends in one box.", kg: 1049, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "festive-combo", name: "Festive Combo", category: "combos", subtitle: "Assorted nuts for the season.", kg: 1349, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "corporate-gift-box", name: "Corporate Gift Box", category: "combos", subtitle: "Custom branding available.", kg: 1599, grade: "Gift", origin: "Multi-origin", image: img.placeholder, quoteOnly: true, moqKg: 25 },
  { slug: "festive-gift-box", name: "Festive Gift Box", category: "combos", subtitle: "Assorted nuts in a keepsake box.", kg: 1499, grade: "Gift", origin: "Multi-origin", image: img.placeholder, badge: "PREMIUM" },
];

export const products: Product[] = seeds.map((s) => {
  const variants = buildVariants(s.slug, s.kg);
  return {
    slug: s.slug,
    name: s.name,
    category: s.category,
    subtitle: s.subtitle,
    description: `${s.name} — ${s.grade} grade, sourced from ${s.origin}. Cleaned, sorted and machine graded, then packed to order.`,
    ...(s.badge ? { badge: s.badge } : {}),
    rating: s.rating ?? 4.5,
    reviewCount: s.reviewCount ?? 60,
    images: [s.image, img.placeholder, img.placeholder],
    origin: s.origin,
    grade: s.grade,
    processing: "Cleaned, sorted and machine graded",
    shelfLife: "9 months from packing",
    storage: "Store in a cool, dry place. Refrigerate after opening.",
    ingredients: s.name,
    hsn: "0802",
    gstRate: 5,
    variants,
    /**
     * Product-level sold-out means every *active* variant is out, per spec §10.1. Through the
     * shared helper, not inline: this fixture plays the server, and a fixture whose rule differs
     * from production's — `=== 0` where the helper is `<= 0` — is how a false green happens.
     *
     * `isActive: true` is honest here. The mock has no inactive variants, and the server filters
     * them out before anything reaches this shape.
     */
    soldOut: productSoldOut(variants.map((v) => ({ available: v.available, isActive: true }))),
    bulkTiers: buildTiers(s.kg),
    moqKg: s.moqKg ?? 10,
    ...(s.quoteOnly ? { quoteOnly: true } : {}),
    seo: {
      title: `${s.name} — Buy Online in 100g to 1kg | Nuts & Nazaakat`,
      description: `${s.subtitle} ${s.grade} grade from ${s.origin}. Retail packs and bulk per-kg pricing with GST invoice.`,
      ogImage: s.image,
    },
  };
});
