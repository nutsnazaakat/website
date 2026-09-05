# Nuts & Nazaakat — Frontend Design Spec (Phase 1)

**Date:** 2026-08-15
**Phase:** 1 of 3 (Frontend → Backend → Admin Portal)
**Status:** Approved

---

## 1. Purpose

Build the complete customer-facing frontend for **Nuts & Nazaakat**, a premium Indian
dry-fruits business selling to both individual consumers (B2C) and businesses (B2B:
retailers, sweet shops, bakeries, cafés, HORECA, cloud kitchens, distributors).

Phase 1 delivers every customer-facing page as a working React application running on
mock data behind a clean API seam. No database, no real authentication, no admin portal.

### Why frontend first

The design already exists as working code (see §3). Building the UI first validates every
user journey before the database schema is committed to, so the schema is derived from what
the interface actually needs rather than guessed upfront.

### Out of scope for Phase 1

- Database, ORM, migrations
- Real authentication, sessions, password hashing
- Payment gateway integration
- Admin portal (Phase 3)
- Email/WhatsApp notification delivery
- Server-side rendering

---

## 2. Non-negotiable constraints

| Constraint | Source |
|---|---|
| No generated images — placeholders only | Client brief |
| Mobile-first; mobile is not an afterthought | Brief §40 |
| No unsupported quality/certification claims | Brief §25, §26 |
| One account serves both retail and bulk — no separate B2B login | Brief §46 |
| Price transparency: MRP, selling price, discount, per-kg always visible | Brief §47 |
| No hardcoded WhatsApp number or contact details | Brief §37 |

---

## 3. Design source of truth

`LOVABLE REFERENCE /` contains working Lovable-generated code (TanStack Start + TanStack
Router + shadcn/ui + Tailwind v4), flattened into a single directory. It is the visual
contract. It is read-only and must not be modified.

### 3.1 Design tokens (ported verbatim from `styles.css`)

All colors in OKLCH. Light and dark palettes both fully defined.

```
--background      oklch(0.978 0.008 85)    ivory
--foreground      oklch(0.235 0.014 55)    charcoal
--primary         oklch(0.395 0.058 48)    walnut brown
--leaf            oklch(0.485 0.06 148)    muted green
--gold            oklch(0.79 0.09 82)      gold accent
--sand            oklch(0.955 0.018 82)    warm section background
--radius          0.875rem
```

Typography: **Manrope** (`--font-sans`), **Fraunces** (`--font-serif`, applied via the
`.font-display` utility). Headings carry `letter-spacing: -0.02em`.

Custom utilities: `container-page` (max-width 84rem, 1.25rem inline padding),
`font-display`, `reveal` (0.7s entrance animation).
Custom shadows: `--shadow-soft`, `--shadow-lift`.

### 3.2 Components inherited

- 46 shadcn/ui primitives → `components/ui/`, ported verbatim
- `SiteHeader`, `SiteFooter`, `ProductCard`, `CartDrawer`, `MobileTabBar` → ported,
  rebranded, extended
- `cart.tsx` context (retail/bulk modes, localStorage persistence) → ported and extended
- `catalog.ts` → split into types + mock data, expanded

### 3.3 Deliberate departures from the reference

| Reference | Change | Reason |
|---|---|---|
| Brand "Nutwala" | → **Nuts & Nazaakat** | Actual store name |
| `PackSize` fixed union (`100g\|250g\|500g\|1kg`) | Open variant array with `channel` flag | Brief §11 needs 8 sizes through 50kg; a union type blocks admin-added sizes |
| Hardcoded "Lab-tested", "Free shipping above ₹999" | Moved to `config/settings.ts` | Brief §25/§26 — no unsupported claims; must be admin-configurable |
| `server.ts`, `start.ts`, `lovable-error-reporting.ts`, `error-capture.ts` | Dropped | Lovable/SSR-specific infrastructure |
| Footer "FSSAI & GST details: to be configured" | Reads from settings | Same as above |

---

## 4. Technology

| Concern | Choice | Rationale |
|---|---|---|
| Build | Vite 8 | Fast, standard for React SPAs |
| UI | React 19 + TypeScript (strict) | Per brief |
| Routing | TanStack Router, file-based | Reference route files use its APIs (`createFileRoute`, `Link params`, `activeProps`) — ports near 1:1, and gives type-safe params |
| Server state | TanStack Query | Provides the swap seam for Phase 2 |
| Styling | Tailwind CSS v4 | Reference uses v4 `@theme` syntax |
| Components | shadcn/ui | Already present in reference |
| Forms | react-hook-form + zod | Reference ships `form.tsx` (RHF-based) |
| Notifications | sonner | Already used in reference |
| Icons | lucide-react | Already used in reference |

**Rejected:** Next.js (user specified React), React Router v7 (would require rewriting
every reference route file for no benefit), TanStack Start (adds a server layer during a
frontend-only phase).

**Known trade-off:** an SPA is client-rendered, so crawler-visible HTML is limited. Brief §39
SEO requirements are satisfied in Phase 1 at the tag level (per-route title, meta
description, canonical, OG tags, JSON-LD structured data) via TanStack Router's `head()`.
Full SSR/prerendering is deferred and re-evaluated in Phase 2.

---

## 5. Architecture

### 5.1 The API seam — central design decision

Every feature reads data through its own `api/` module. In Phase 1 those modules resolve
from `src/mocks/` with simulated latency, wrapped in TanStack Query. In Phase 2, only the
`queryFn` bodies change to real `fetch` calls.

```
component → feature hook (useProducts) → feature api (catalog/api/) → mocks/  [Phase 1]
                                                                    → HTTP   [Phase 2]
```

**Rules:**

1. No component imports from `src/mocks/` directly. Ever.
2. Every list/detail view handles three states: loading (skeleton), error, empty.
3. API modules return domain types from `features/*/types.ts`, never raw mock shapes.

This is what prevents Phase 2 from becoming a rewrite, and it forces loading and error
states to be built correctly now rather than retrofitted.

### 5.2 Folder structure

```
nutwala/
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── router.tsx
│   │   ├── routeTree.gen.ts          # generated by the router plugin
│   │   ├── routes/                   # THIN — params → feature component → SEO meta
│   │   ├── features/                 # domain modules; all logic lives here
│   │   │   ├── catalog/              #   components/ hooks/ api/ types.ts
│   │   │   ├── cart/
│   │   │   ├── bulk/
│   │   │   ├── rfq/
│   │   │   ├── checkout/
│   │   │   ├── account/
│   │   │   ├── reviews/
│   │   │   ├── gifting/
│   │   │   └── content/
│   │   ├── components/
│   │   │   ├── ui/                   # 46 shadcn primitives
│   │   │   ├── layout/               # SiteHeader, SiteFooter, MobileTabBar, CartDrawer
│   │   │   └── common/               # EmptyState, Price, Rating, SectionHeading, Skeletons
│   │   ├── providers/                # AppProviders: Query, Cart, Auth, Theme
│   │   ├── mocks/                    # seed data — the folder Phase 2 deletes
│   │   ├── config/                   # settings an admin will own in Phase 3
│   │   ├── lib/                      # utils.ts, format.ts, constants.ts, seo.ts
│   │   ├── hooks/                    # cross-cutting hooks
│   │   ├── styles/                   # styles.css (design tokens)
│   │   └── assets/
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── .oxlintrc.json
│   └── package.json
├── LOVABLE REFERENCE /               # read-only
└── docs/superpowers/specs/
```

**Boundary rule:** a route file wires URL params to a feature component and declares SEO
meta. Nothing else. If a route file grows past ~40 lines, its content belongs in a feature.

### 5.3 State ownership

| State | Owner | Persistence |
|---|---|---|
| Product/category/blog data | TanStack Query | Query cache |
| Cart lines + retail/bulk mode | `CartProvider` (React Context) | localStorage |
| Bulk cart | Same provider, `mode: "bulk"` lines | localStorage |
| Auth/role | `AuthProvider` (mocked) | localStorage |
| Theme | `ThemeProvider` | localStorage |
| Filters, sorting, search | URL search params | URL (shareable, back-button correct) |
| Form state | react-hook-form, local | None |

Filters live in the URL, not component state. The reference uses `useState` for shop
filters; that breaks sharing and the back button, so it changes here.

---

## 6. Domain model (frontend types)

```ts
type Channel = "retail" | "bulk";
type Role    = "guest" | "b2c" | "b2b" | "admin";

interface Variant {
  sku: string;
  size: string;          // "100g" … "50kg" — open string, not a union
  grams: number;         // canonical unit for per-100g/per-kg math
  channel: Channel;
  price: number;
  mrp: number;
  stock: number;
  moq: number;
}

interface BulkTier {
  minKg: number;
  maxKg: number | null;      // null = open-ended top tier
  pricePerKg: number | null; // null = quote required
}

interface Product {
  slug, name, category, subtitle, description;
  badge?: "BESTSELLER" | "NEW" | "PREMIUM";
  rating, reviewCount;
  images: string[];
  origin, grade, processing, shelfLife, storage, ingredients;
  hsn, gstRate;
  variants: Variant[];
  bulkTiers: BulkTier[];
  moqKg: number;
  quoteOnly?: boolean;
  seo: { title, description, ogImage };
}
```

`grams` on every variant is what makes brief §47's "price per 100g / per kg" comparison
possible without parsing size strings.

### Tier resolution

`tierFor(product, kg)` returns the tier where `kg >= minKg && (maxKg === null || kg <= maxKg)`.
When the resolved tier has `pricePerKg === null`, the UI shows **Quote Required** and routes
to the RFQ flow instead of checkout. Savings versus tier 1 are displayed as
"You save ₹X" when the resolved tier is cheaper.

---

## 7. Route inventory (33 routes)

### Public (18)
`/` · `/shop` · `/category/$slug` · `/product/$slug` · `/combos` · `/gifting` ·
`/bulk-orders` · `/bulk/$category` · `/about` · `/quality` · `/blog` · `/blog/$slug` ·
`/contact` · `/faq` · `/shipping` · `/returns` · `/privacy` · `/terms`

### Customer (9)
`/login` · `/register` · `/cart` · `/checkout` · `/account` · `/account/orders` ·
`/account/orders/$id` · `/account/addresses` · `/account/profile`

### Business (6)
`/business` · `/business/profile` · `/business/orders` · `/business/rfqs` ·
`/business/rfqs/$id` · `/business/bulk-cart`

`/account/*` and `/business/*` use TanStack Router layout routes with a shared sidebar.
`/business/*` additionally guards on `role === "b2b"`, redirecting to `/business` (the B2B
landing/upgrade page) otherwise.

---

## 8. Key user journeys

**B2C:** Home → Shop → Product → select pack size → Add to Cart → Cart drawer → Checkout → Order confirmed

**B2B:** Home → Bulk Orders → Bulk catalog → select kg → tier price resolves live → Bulk Cart → Bulk Checkout *or* RFQ

**Mode switch (§46):** A single account toggles between retail and bulk. When a single
retail cart line's total weight reaches a configurable threshold (default: 5000g, i.e.
`variant.grams × qty >= 5000`), an inline prompt appears — "Buying in bulk? You may qualify
for better pricing." — with a **View Bulk Pricing** action that converts that line to a bulk
line of the equivalent kg at the applicable tier. The threshold lives in
`config/settings.ts`.

---

## 9. Cross-cutting requirements

### Empty and error states (§42)
Every list has a designed empty state. Required copy:
- Empty cart: *"Your cart is waiting for something delicious."* → **Explore Bestsellers**
- No search results, out of stock, payment failed, RFQ submitted, order success, 404

### Loading
Skeleton components matching the shape of their loaded content. No spinners on page loads.

### Accessibility
Keyboard-navigable throughout, visible focus rings, ARIA labels on all icon-only buttons
(the reference already does this), semantic landmarks, alt text on every image, contrast
verified in both themes.

### Performance (§41)
Route-level code splitting, `loading="lazy"` and explicit `width`/`height` on all images,
skeleton loading, no layout shift.

### SEO (§39)
Per-route `head()` supplying title, meta description, canonical, and OG tags. JSON-LD
`Product` schema on product pages, `BreadcrumbList` on category and product pages,
`Article` on blog posts.

### Configurable settings (§26, §37)
`config/settings.ts` holds: WhatsApp number, contact details, social links, free-shipping
threshold, GST/FSSAI registration text, certification badges. Nothing in this list is
hardcoded in a component. All become admin-editable in Phase 3.

---

## 10. Seed data

The union of the reference's 23 seeded products and the 20 named in brief §44 — 26 distinct
products across 12 categories (the two lists overlap on 17). Also seeded: 6 combos, 5
gifting products, 8 blog posts, sample reviews, 3 fixture users (b2c, b2b, admin), sample
orders and RFQs.

Images: the three reference JPGs (`hero-dryfruits`, `cat-almonds`, `cat-cashews`,
`cat-pistachios`) plus `https://placehold.co/800x800` for everything else. No generated
images.

Prices are realistic demo values derived from a per-kg base, exactly as the reference does
it — all editable from admin in Phase 3.

---

## 11. Verification

Phase 1 is complete when:

1. `npm run build` passes with zero TypeScript errors under `strict`.
2. `npm run lint` passes.
3. All 32 routes render without console errors.
4. The B2C journey completes end to end.
5. The B2B journey completes end to end, including tier price recalculation and RFQ
   submission producing an RFQ number (`RFQ-2026-NNNNNN`).
6. Every page verified at 375px, 768px, and 1440px.
7. Light and dark themes verified on every page.
8. No component imports from `src/mocks/` directly (enforced by an ESLint
   `no-restricted-imports` rule).
9. No hardcoded WhatsApp number, contact detail, or certification claim outside
   `config/settings.ts`.

---

## 12. Phase 2 and 3 preview

**Phase 2 (Backend):** PostgreSQL + Prisma, real auth with role-based access, the 24 models
listed in brief §45, REST or tRPC API, payment integration. The frontend changes only inside
`features/*/api/`.

**Phase 3 (Admin portal):** Separate route group or separate app against the same backend.
Products, pricing tiers, inventory, orders, RFQs, customers, coupons, reviews, blog, and the
settings that Phase 1 stubs in `config/settings.ts`.
