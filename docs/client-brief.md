# Client Brief — Nuts & Nazaakat

Source of truth for requirements. Where this document and the plan or spec disagree, **this
document wins** — raise the conflict rather than silently following the plan.

Store name: **Nuts & Nazaakat**.

---

## 1. Scope

A complete B2C + B2B dry-fruits e-commerce website serving:

1. **B2C customers** — individual / small quantity purchases
2. **B2B customers** — retailers, wholesalers, restaurants, hotels, bakeries, sweet shops,
   distributors and other businesses buying in bulk

Build the functional website, UI, frontend, backend architecture, database structure and
user flows. **Do not generate images.** Where an image is required use a remote placeholder
such as `https://placehold.co/800x800`.

## 2. Brand and design direction

An original premium Indian dry-fruits brand, combining a premium modern D2C food brand,
modern Shopify-style ecommerce, and a professional B2B wholesale marketplace. Must not look
like a traditional dry-fruit shop.

**Use:** warm off-white / ivory background; dark charcoal typography; natural brown / walnut
accents; subtle muted green; small premium gold/beige accents; large product photography
areas using placeholders; generous whitespace; rounded cards; clean modern typography;
subtle animations; premium editorial sections. A modern font — Inter, Manrope or Plus Jakarta
Sans.

**Avoid:** loud colours, excessive gradients, excessive shadows, clutter, over-animation,
generic AI-looking layouts.

## 3. Roles

- **B2C customer** — browse, search, filter, select pack size, cart, checkout, track orders,
  review products, manage addresses and profile.
- **B2B customer** — everything B2C can do, plus bulk pricing, larger quantities, request
  quotations, company details, GSTIN, submit RFQs, quotation history, B2B order history,
  reorder previous bulk orders.
- **Admin** — manage products, categories, pricing, B2B pricing tiers, inventory, orders,
  customers, businesses, RFQs, coupons, reviews, blog, homepage content, website settings.

## 4. Pages

**Public:** `/` `/shop` `/category/[slug]` `/product/[slug]` `/combos` `/gifting`
`/bulk-orders` `/bulk/[category]` `/about` `/quality` `/blog` `/blog/[slug]` `/contact`
`/faq` `/shipping` `/returns` `/privacy` `/terms`

**Customer:** `/login` `/register` `/account` `/account/orders` `/account/orders/[id]`
`/account/addresses` `/account/profile` `/cart` `/checkout`

**B2B:** `/business` `/business/profile` `/business/orders` `/business/rfqs`
`/business/rfqs/[id]` `/business/bulk-cart`

**Admin:** `/admin` `/admin/products` `/admin/products/new` `/admin/categories`
`/admin/inventory` `/admin/orders` `/admin/customers` `/admin/businesses` `/admin/rfqs`
`/admin/pricing` `/admin/coupons` `/admin/reviews` `/admin/blog` `/admin/settings`

## 5. Header

Sticky, responsive. Desktop: Logo | Shop | Categories | Combos | Bulk Orders | Gifting |
Our Story | Search | Account | Cart. **Buy in Bulk** is a prominent CTA. Mobile: Logo |
Search | Cart | Menu. Header shrinks slightly on scroll.

## 6. Homepage

Hero with a large placeholder visual.

- Headline: **Premium Dry Fruits, Made Simple.**
- Subheading: **From your kitchen to your business — shop premium dry fruits in the quantity
  you actually need.**
- Buttons: **Shop Dry Fruits**, **Buy in Bulk**

Trust indicators below hero: Quality Checked · Hygienically Packed · Pan-India Delivery ·
Bulk Pricing

## 7. Categories

Almonds, Cashews, Pistachios, Walnuts, Raisins, Dates, Anjeer, Makhana, Seeds, Trail Mixes,
Roasted Nuts, Combos.

## 8. Bestsellers

Product card shows: image, name, rating, reviews, pack-size selector, MRP, selling price,
discount, Add to Cart, Wishlist. Example: **Premium California Almonds** — 100g | 250g |
500g | 1kg. Do not hardcode real business claims.

## 9. Shop page

Filters: category, price, weight, origin, grade, raw/roasted, flavoured, bestseller,
availability. Sorting: Featured, Best Selling, Price Low to High, Price High to Low, Newest,
Highest Rated. Desktop 4-column grid; mobile 2-column.

## 10. Product page

Left: large image gallery (placeholders). Right: name, rating, reviews, price, MRP, discount,
pack-size selector, quantity, Add to Cart, Buy Now.

**Product details:** origin, grade, ingredients, processing, shelf life, storage
instructions, net weight, country of origin.

**Delivery:** pincode checker showing delivery availability, estimated delivery date,
shipping charges.

**Reviews:** rating, verified purchase, customer review, review image.

## 11. Product variants

Sizes: 100g, 250g, 500g, 1kg, 5kg, 10kg, 25kg, 50kg. Each variant supports SKU, price, MRP,
stock, MOQ, B2B price, B2B pricing tiers.

## 12. B2C shopping

Product → select size → quantity → cart → checkout → payment → order. Keep it extremely
simple.

## 13. Bulk orders page

- Hero: **Buy Better. Buy Bigger. Pay Smarter.**
- Description: Reliable dry-fruit supply for retailers, sweet shops, bakeries, cafés,
  restaurants, hotels, cloud kitchens, distributors and growing food businesses.
- Buttons: **Explore Bulk Products**, **Get Bulk Pricing**

## 14. B2B categories

Retailers, Sweet Shops, Bakeries, Cafés, Restaurants, Hotels / HORECA, Cloud Kitchens,
Food Manufacturers, Distributors, Resellers, Corporate Buyers.

## 15. B2B product listing

Separate bulk catalog. Filters: product, category, grade, origin, MOQ, price/kg,
availability, packaging. Card shows e.g. **Premium Cashews W320** — Grade W320, MOQ 10kg,
₹X/kg, quantity selector, **Add to Bulk Cart**, **Request Quote**.

## 16. B2B quantity pricing

Dynamic quantity-based pricing, e.g. 1–4 kg / 5–9 kg / 10–24 kg / 25–49 kg / 50kg+.
Editable by admin. Price tier recalculates as quantity changes. Show **You save ₹X** when
applicable.

## 17. RFQ

Fields: business name, contact person, mobile, email, GSTIN, business type, delivery
pincode, products, quantity, packaging preference, expected frequency, additional
requirements. Button **Request Bulk Quote**. On submit show **Quote Request Submitted** and
generate an RFQ number, e.g. `RFQ-2026-001245`.

## 18. B2B cart

Separate bulk-cart experience showing product, grade, quantity, price/kg, subtotal, GST,
shipping, total. Editable quantities, removable products. CTA **Proceed to Bulk Checkout**.
Products requiring quotation show **Quote Required** instead of normal checkout.

## 19. Business profile

Stores company name, contact person, mobile, email, GSTIN, business type, billing address,
shipping address. Shows Total Orders, Total Spend, Active RFQs, Previous Quotes.

## 20. Checkout

**B2C:** Contact, Address, Order Summary, Coupon, Shipping, Payment.

**B2B adds:** Company Name, GSTIN, Purchase Order Number, Billing Address, Shipping Address,
Special Instructions.

Configurable: online payment, manual approval, quote-based order, credit terms.

## 21. Cart

Modern cart drawer showing product, size, quantity, price, remove. Also
**Add ₹XXX more to unlock free shipping** and **Frequently Bought Together**.

## 22. Search

Instant search over products, categories and popular searches. Examples: almonds, premium
kaju, 1kg badam, bulk cashew, makhana.

## 23. Combos

Daily Nutrition Combo, Premium Nuts Combo, Family Pack, Office Snack Combo, Trail Mix Combo,
Festive Combo. Show clear savings.

## 24. Gifting

Corporate Gifts, Festive Gifts, Wedding Gifts, Premium Gift Boxes, Custom Gift Hampers.
Corporate gifting enquiry: number of boxes, budget per box, branding required, delivery date,
custom message.

## 25. Quality page

Visual story: **Source → Quality Check → Sorting → Packing → Dispatch → Delivery**. Explain
sourcing, quality checking, sorting, packaging, storage. **Do NOT make unsupported claims.
Do not claim certifications unless configured by Admin.**

## 26. Trust section

Quality Checked, Hygienically Packed, Secure Payments, Pan-India Delivery, Bulk Supply, GST
Invoices. **Certification information must be editable from Admin.**

## 27. Reviews

Users can give a rating, write a review, upload an image. Admin can approve/reject. Show
Verified Purchase.

## 28. Blog

SEO-friendly. Categories: Dry Fruit Guides, Buying Guides, Recipes, Storage Tips, B2B,
Nutrition Education. Sample titles: *How to Choose the Right Almonds*; *W320 vs W240
Cashews: What's the Difference?*; *How to Store Dry Fruits at Home*; *How Businesses Can Buy
Dry Fruits in Bulk*.

## 29. Admin dashboard

Cards: Total Sales, B2C Sales, B2B Sales, Orders, Pending Orders, Pending RFQs, Customers,
B2B Customers, Low Stock. Charts: sales over time, B2C vs B2B, top products, top categories.

## 30. Product management

Create, edit, delete, publish/unpublish. Fields: name, slug, description, category, SKU, HSN,
GST, origin, grade, ingredients, shelf life, storage instructions. Variants: weight, SKU,
price, MRP, stock, MOQ, B2B price, pricing tiers.

## 31. B2B pricing admin

Configure MOQ, price/kg, quantity tiers, retailer pricing, distributor pricing, HORECA
pricing, customer-specific pricing.

## 32. Inventory

Current stock, reserved stock, available stock, low stock, out of stock. History: stock
added, stock sold, stock adjusted, reason, date, admin.

## 33. Order management

Admin sees: Order ID, Customer, B2C/B2B, Amount, Payment, Status, Date.

**Retail statuses:**
Pending · Confirmed · Processing · Packed · Shipped · Out for Delivery · Delivered ·
Cancelled · Refunded

**B2B statuses:**
Quote Requested · Quote Sent · Quote Accepted · Awaiting Payment · Approved · Processing ·
Shipped · Delivered

## 34. RFQ management

RFQ ID, business, contact, products, quantity, expected value, status, assigned salesperson.
Statuses: New · Contacted · Quote Sent · Negotiation · Approved · Rejected · Converted to
Order. Allow internal notes.

## 35. Customer management

Separate B2C and B2B customers. B2B profile: company, GSTIN, business type, orders, total
spend, RFQs, last order, assigned salesperson.

## 36. Coupons

Percentage discount, flat discount, minimum order value, category-specific, B2C-only,
B2B-only, first-order, expiry, usage limit.

## 37. WhatsApp

WhatsApp CTAs. B2B: **Talk to Bulk Sales**. Product: **Ask About Bulk Pricing**.
**Do not hardcode a fake number** — make it configurable from Admin Settings.

## 38. Notifications

Architecture supports: order confirmation, payment confirmation, order shipped, order
delivered, RFQ received, quote sent, abandoned cart, low stock. Email / WhatsApp
integrations configurable.

## 39. SEO

Every product, category and blog post supports SEO title, meta description, slug, OG image.
Add structured data where appropriate. Clean URLs.

## 40. Mobile

Mobile-first is mandatory. Mobile bottom navigation: Home, Shop, Search, Bulk, Cart. Add to
Cart and Buy Now easy to reach. B2B enquiry easy on mobile.

## 41. Performance

Lazy loading, responsive images, optimized assets, skeleton loading, code splitting, fast
page navigation. Prioritise performance over visual effects.

## 42. Error / empty states

Polished states for empty cart, no search results, out of stock, payment failed, RFQ
submitted, order success.

Empty cart: **Your cart is waiting for something delicious.** Button: **Explore Bestsellers**

## 43. Order success

**Order Confirmed!** — order ID, items, amount, delivery address, estimated delivery, Track
Order. Button **Continue Shopping**.

## 44. Sample products

At least 20 realistic demo products:

1. Premium California Almonds · 2. Mamra Almonds · 3. W320 Cashews · 4. W240 Cashews ·
5. Premium Pistachios · 6. California Walnuts · 7. Afghani Black Raisins · 8. Golden Raisins ·
9. Premium Anjeer · 10. Medjool Dates · 11. Kimia Dates · 12. Roasted Makhana ·
13. Peri Peri Makhana · 14. Pumpkin Seeds · 15. Sunflower Seeds · 16. Trail Mix ·
17. Daily Dry Fruit Combo · 18. Premium Family Combo · 19. Corporate Gift Box ·
20. Festive Gift Box

Realistic demo prices, all editable from Admin.

## 45. Database models

Users, Businesses, Addresses, Products, Categories, ProductVariants, ProductImages,
PricingTiers, Inventory, InventoryTransactions, Orders, OrderItems, RFQs, RFQItems, Coupons,
Reviews, Payments, Shipments, Notifications, BlogPosts, GiftOrders, AdminUsers, AuditLogs,
Settings. With proper relationships.

## 46. Unified account (important)

**A user should NOT need separate accounts for B2C and B2B.** A customer can switch between
**Retail Shopping** and **Bulk Shopping**. If a customer adds a large quantity, show
**Buying in bulk? You may qualify for better pricing.** with a **View Bulk Pricing** button.
Example: selecting 10 × 1kg packs offers a switch to the bulk pricing tier.

## 47. Price transparency

Clearly show MRP, selling price, discount, price per 100g / kg. For B2B: price/kg, MOQ, GST
information, shipping information. Do not hide basic pricing unnecessarily. Products marked
"Quote Required" use the RFQ flow.

## 48. Content style

Concise premium copy. Examples: **Premium Dry Fruits, Made Simple.** · **Small pack for home.
Bulk supply for business.** · **Choose your quantity. We'll handle the rest.** Avoid
exaggerated claims and excessive exclamation marks.

## 49. Footer

**Shop:** All Products, Almonds, Cashews, Pistachios, Walnuts, Raisins, Makhana, Combos
**Business:** Bulk Orders, Wholesale, Corporate Gifting, Become a Partner
**Help:** Contact, Shipping, Returns, FAQs, Track Order
**Company:** About, Quality, Blog

Also: Privacy Policy, Terms, Refund Policy, Shipping Policy. Social links configurable.

## 50. Final requirement

Build a real ecommerce application, not a static landing page.

**B2C:** Home → Shop → Product → Add to Cart → Checkout → Order
**B2B:** Home → Bulk Orders → Bulk Product → Quantity → Tier Pricing → Bulk Cart → RFQ / Checkout
**Admin:** Login → Dashboard → Products → Pricing → Inventory → Orders → RFQs → Customers

Every major button and navigation item must be functional. Placeholder images only.
