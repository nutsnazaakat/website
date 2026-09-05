# Nuts & Nazaakat Frontend (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete customer-facing frontend for Nuts & Nazaakat — 33 routes covering B2C retail and B2B bulk commerce — as a React SPA running on mock data behind a swappable API seam.

**Architecture:** Vite + React 19 + TanStack Router (file-based). Domain logic lives in `src/features/*`; route files only wire params to feature components and declare SEO meta. All data flows through `features/*/api/` modules wrapped in TanStack Query, which resolve from `src/mocks/` in this phase and swap to HTTP in Phase 2. Design tokens and 46 shadcn/ui primitives are ported verbatim from `LOVABLE REFERENCE /`.

**Tech Stack:** Vite 6, React 19, TypeScript (strict), TanStack Router, TanStack Query v5, Tailwind CSS v4, shadcn/ui, react-hook-form, zod, sonner, lucide-react, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-15-nuts-nazaakat-frontend-design.md`

---

## Testing philosophy for this plan

Not every task is TDD, and that is deliberate.

**TDD (test first, watch it fail, then implement)** — Tasks 7, 8, 14. These are pure
functions handling money and quantity: `inr()`, per-unit pricing, `tierFor()`, savings
calculation, cart line totals, the bulk-switch threshold. Bugs here are silent and
expensive. 41 tests total.

**Verification-only (build passes, route renders, journey works)** — presentational
components and route files. Assertions like `getByText('Add to Cart')` break on copy
changes and catch nothing real.

Every task still ends in a commit.

## A note on task granularity

Milestones 0–3 (Tasks 1–23) give complete code for every step. Milestones 4–6 (Tasks 24–35)
specify **what** to build with precision — exact files, exact brief sections, exact copy,
exact reference file to port from — but not every line of JSX. This is deliberate: those
tasks are largely composition of components already fully specified in Tasks 6–23, and
transcribing another 6,000 lines of predictable markup into the plan would make it harder to
follow, not easier.

An agent executing Tasks 24–35 has three binding constraints and should treat any conflict
between them as a stop-and-ask:

1. The design system and component vocabulary established in Milestones 0–3
2. The cited brief section (the client's exact requirements and copy)
3. The cited `LOVABLE REFERENCE /` file, where one exists

## Route count

Spec §7 enumerates 33 routes. This plan builds **34** — Task 23 adds
`/order-success/$id`, which spec §9 requires as a designed state but §7 omits from the
inventory. That is an intentional addition, not drift.

---

## Reference file map

`LOVABLE REFERENCE /` is flattened — all files sit in one directory. This maps each source
file to its destination. **The reference directory is read-only. Never modify it.**

| Reference file | Destination |
|---|---|
| `styles.css` | `src/styles/index.css` |
| `utils.ts` | `src/lib/utils.ts` |
| `use-mobile.tsx` | `src/hooks/use-mobile.tsx` |
| 46 primitives (`accordion.tsx` … `tooltip.tsx`) | `src/components/ui/` |
| `SiteHeader.tsx`, `SiteFooter.tsx`, `MobileTabBar.tsx`, `CartDrawer.tsx` | `src/components/layout/` |
| `ProductCard.tsx` | `src/features/catalog/components/ProductCard.tsx` |
| `cart.tsx` | `src/features/cart/CartProvider.tsx` |
| `catalog.ts` | split → `src/features/catalog/types.ts` + `src/mocks/products.ts` |
| `index.tsx`, `shop.tsx`, `product.$slug.tsx`, `category.$slug.tsx`, `bulk-orders.tsx`, `quality.tsx` | `src/routes/` |
| `hero-dryfruits.jpg`, `cat-almonds.jpg`, `cat-cashews.jpg`, `cat-pistachios.jpg` | `src/assets/` |
| `server.ts`, `start.ts`, `router.tsx`, `routeTree.gen.ts`, `__root.tsx` | **Do not port** — rewritten for SPA |
| `lovable-error-reporting.ts`, `error-capture.ts` | **Do not port** — Lovable-specific |
| `styles (1).css` | **Do not port** — byte-identical duplicate of `styles.css` |

The 46 primitives: accordion, alert-dialog, alert, aspect-ratio, avatar, badge, breadcrumb,
button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu,
dialog, drawer, dropdown-menu, form, hover-card, input-otp, input, label, menubar,
navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area,
select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea,
toggle-group, toggle, tooltip.

---

# MILESTONE 0 — Foundation

Goal: a running dev server showing a styled page with the correct fonts and colors.

## Task 1: Scaffold the Vite project

**Files:**
- Create: `frontend/` (whole project)

- [ ] **Step 1: Scaffold**

```bash
cd /Users/kunal/Desktop/nutwala
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

- [ ] **Step 2: Install runtime dependencies**

```bash
npm install @tanstack/react-router @tanstack/react-query \
  react-hook-form @hookform/resolvers zod sonner lucide-react \
  class-variance-authority clsx tailwind-merge tailwindcss-animate \
  tw-animate-css embla-carousel-react date-fns react-day-picker \
  input-otp cmdk vaul recharts next-themes react-resizable-panels
```

- [ ] **Step 3: Install Radix primitives**

The 46 shadcn components depend on these.

```bash
npm install @radix-ui/react-accordion @radix-ui/react-alert-dialog \
  @radix-ui/react-aspect-ratio @radix-ui/react-avatar @radix-ui/react-checkbox \
  @radix-ui/react-collapsible @radix-ui/react-context-menu @radix-ui/react-dialog \
  @radix-ui/react-dropdown-menu @radix-ui/react-hover-card @radix-ui/react-label \
  @radix-ui/react-menubar @radix-ui/react-navigation-menu @radix-ui/react-popover \
  @radix-ui/react-progress @radix-ui/react-radio-group @radix-ui/react-scroll-area \
  @radix-ui/react-select @radix-ui/react-separator @radix-ui/react-slider \
  @radix-ui/react-slot @radix-ui/react-switch @radix-ui/react-tabs \
  @radix-ui/react-toggle @radix-ui/react-toggle-group @radix-ui/react-tooltip
```

- [ ] **Step 4: Install dev dependencies**

```bash
npm install -D tailwindcss @tailwindcss/vite @tanstack/router-plugin \
  @tanstack/router-devtools vitest @vitest/ui jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  prettier prettier-plugin-tailwindcss @types/node
```

- [ ] **Step 5: Verify dev server starts**

Run: `npm run dev`
Expected: Vite serves on `http://localhost:5173` with the default React template.
Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
cd /Users/kunal/Desktop/nutwala
git add -A
git commit -m "chore: scaffold Vite + React + TypeScript frontend"
```

---

## Task 2: Configure Vite, TypeScript, and path aliases

**Files:**
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/tsconfig.app.json`

- [ ] **Step 1: Write `frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: { port: 5173 },
});
```

> **Corrected 2026-08-15 during execution.** Originally used `__dirname`, which Vite's
> native config loader warns about on every run and will stop supporting in a future major.
> `import.meta.dirname` is the supported replacement.

If `tanstackRouter` is not an exported member, the installed version uses the older name —
import `{ TanStackRouterVite as tanstackRouter }` from the same path instead. Verify with:
`node -e "console.log(Object.keys(require('@tanstack/router-plugin/vite')))"`

- [ ] **Step 2: Add the path alias to `frontend/tsconfig.app.json`**

Inside `compilerOptions`, add:

```json
"paths": { "@/*": ["./src/*"] }
```

Confirm `"strict": true` is already present. If not, add it.

> **Corrected 2026-08-15 during execution.** This originally also set `"baseUrl": "."`.
> TypeScript 6.x deprecates standalone `baseUrl` (error `TS5101`) and it breaks
> `tsc -b`. Modern TS resolves `paths` relative to the tsconfig directory, so `baseUrl` is
> unnecessary. Omit it.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc -b --force`
Expected: no errors. (Do **not** use bare `tsc --noEmit` — see the note in Task 5; it checks
nothing in this solution-style project and will pass regardless.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: configure Vite plugins and @ path alias"
```

---

## Task 3: Port the design system

**Files:**
- Create: `frontend/src/styles/index.css`
- Create: `frontend/src/lib/utils.ts`
- Create: `frontend/src/assets/` (4 JPGs)
- Modify: `frontend/index.html`
- Delete: `frontend/src/App.css`, `frontend/src/index.css`

- [ ] **Step 1: Copy the stylesheet and assets**

```bash
cd /Users/kunal/Desktop/nutwala
REF="LOVABLE REFERENCE "
mkdir -p frontend/src/styles frontend/src/lib frontend/src/assets
cp "$REF/styles.css" frontend/src/styles/index.css
cp "$REF/utils.ts" frontend/src/lib/utils.ts
cp "$REF"/*.jpg frontend/src/assets/
rm -f frontend/src/App.css frontend/src/index.css
```

- [ ] **Step 2: Fix the `@source` directive**

`src/styles/index.css` line 2 reads `@source "../src";`, which was correct when the file
lived at the project root. It now lives inside `src/`. Change it to:

```css
@source "../";
```

Leave every other line untouched — the token values are the design contract.

- [ ] **Step 3: Add fonts and update `frontend/index.html`**

Replace the contents of `<head>` (keeping `<meta charset>` and the viewport tag) with:

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap"
  rel="stylesheet"
/>
<title>Nuts & Nazaakat — Premium Dry Fruits for Home & Business</title>
```

- [ ] **Step 4: Verify the tokens load**

Temporarily replace `frontend/src/App.tsx` with:

```tsx
import "@/styles/index.css";

export default function App() {
  return (
    <div className="container-page py-20">
      <h1 className="font-display text-5xl">Nuts &amp; Nazaakat</h1>
      <p className="mt-4 text-muted-foreground">Design tokens loaded.</p>
      <div className="mt-6 flex gap-3">
        <div className="size-16 rounded-xl bg-primary" />
        <div className="size-16 rounded-xl bg-leaf" />
        <div className="size-16 rounded-xl bg-gold" />
        <div className="size-16 rounded-xl bg-sand" />
      </div>
    </div>
  );
}
```

Run: `npm run dev`
Expected: ivory background, Fraunces serif heading, Manrope body text, and four swatches —
walnut brown, muted green, gold, sand. If the heading renders in a system serif, the
Fraunces link failed; if the background is white, the stylesheet import failed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: port design tokens, fonts, and image assets"
```

---

## Task 4: Set up the linter and Prettier with the mocks-import guard

> **Corrected 2026-08-15 during execution.** This plan originally specified ESLint. The
> current Vite react-ts template (`create-vite@9.1.2`) ships **oxlint** instead and has no
> `eslint.config.js`. Do not install ESLint. oxlint 1.78 supports `no-restricted-imports`
> with identical pattern syntax; the override structure below was verified to error on a
> component import while exempting `features/*/api/`.

**Files:**
- Create: `frontend/.oxlintrc.json`
- Create: `frontend/.prettierrc`

- [ ] **Step 1: Create `frontend/.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": false,
  "printWidth": 100,
  "trailingComma": "all",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

- [ ] **Step 2: Create `frontend/.oxlintrc.json`**

This enforces spec §5.1 rule 1 — the API seam only works if nothing bypasses it. Keep the
scaffolded plugin rules; extend rather than replace. Later overrides win, which is what
exempts the `api/` modules.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  },
  "overrides": [
    {
      "files": ["src/**/*.ts", "src/**/*.tsx"],
      "rules": {
        "no-restricted-imports": ["error", {
          "patterns": [{
            "group": ["@/mocks/*", "**/mocks/*"],
            "message": "Import data through features/*/api/ instead. Only api modules may read mocks — this is the seam that lets Phase 2 swap in a real backend."
          }]
        }]
      }
    },
    {
      "files": ["src/mocks/**", "src/features/*/api/**"],
      "rules": { "no-restricted-imports": "off" }
    }
  ]
}
```

- [ ] **Step 3: Prove the guard fires**

A guard that does not fire is worse than no guard, because it will be trusted. Create two
probe files:

`src/components/__probe.tsx`:
```tsx
import { products } from "@/mocks/products";
export const probe = products;
```
`src/features/catalog/api/__probe.ts`:
```ts
import { products } from "@/mocks/products";
export const ok = products;
```

Run: `npm run lint`
Expected: exactly one error, on `src/components/__probe.tsx`, carrying the restriction
message. The `api/` probe must produce no error.

Delete both probes, re-run `npm run lint`, and confirm it is clean.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: add oxlint mocks-import boundary and Prettier config"
```

---

## Task 5: Set up Vitest

**Files:**
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/test/setup.ts`
- Modify: `frontend/package.json`

- [ ] **Step 1: Create `frontend/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Add the test block to `frontend/vite.config.ts`**

Add as a top-level key in the `defineConfig` object, and add
`/// <reference types="vitest/config" />` as the file's first line.

```ts
test: {
  globals: true,
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
},
```

- [ ] **Step 3: Add scripts to `frontend/package.json`**

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc -b --force"
```

> **Corrected 2026-08-15 during execution.** This originally read `tsc --noEmit`, which is a
> **silent no-op** here: the root `tsconfig.json` is solution-style (`"files": []` plus
> project references), so bare `tsc` checks nothing and exits 0 even on a blatant type
> error. Verified by planting `const bad: number = "str"` — `tsc --noEmit` passed, `tsc -b`
> caught it. Every "typecheck passes" gate in this plan depends on this script being real.
> After changing it, verify: plant that same error, confirm `npm run typecheck` exits 2,
> delete it, confirm exit 0.

- [ ] **Step 4: Verify the runner works**

Create `frontend/src/test/sanity.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("vitest", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm test`
Expected: `1 passed`. Then delete `src/test/sanity.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: set up Vitest with jsdom and Testing Library"
```

---

# MILESTONE 1 — Domain core

Goal: fully tested pricing and formatting logic, plus seed data behind the API seam.
This milestone is where TDD is mandatory.

## Task 6: Define domain types

**Files:**
- Create: `frontend/src/features/catalog/types.ts`

- [ ] **Step 1: Write `frontend/src/features/catalog/types.ts`**

Derived from spec §6. Note `grams` on every variant — it is what makes per-100g/per-kg
comparison and the bulk-switch threshold possible without parsing size strings.

```ts
export type Channel = "retail" | "bulk";
export type Badge = "BESTSELLER" | "NEW" | "PREMIUM";

export interface Variant {
  sku: string;
  size: string;
  grams: number;
  channel: Channel;
  price: number;
  mrp: number;
  stock: number;
  moq: number;
}

export interface BulkTier {
  minKg: number;
  maxKg: number | null;
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
  seo: Seo;
}

export interface Category {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
}

export interface ProductFilters {
  category?: string;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  origin?: string;
  grade?: string;
  bestsellerOnly?: boolean;
  inStockOnly?: boolean;
  sort?: ProductSort;
}

export type ProductSort =
  | "featured"
  | "best-selling"
  | "price-asc"
  | "price-desc"
  | "newest"
  | "rating";
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add catalog domain types"
```

---

## Task 7: Currency and unit formatting (TDD)

**Files:**
- Create: `frontend/src/lib/format.ts`
- Test: `frontend/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inr, pricePerKg, pricePer100g, discountPercent } from "./format";

describe("inr", () => {
  it("formats with the rupee symbol and no decimals", () => {
    expect(inr(999)).toBe("₹999");
  });

  it("uses the Indian digit grouping system", () => {
    expect(inr(100000)).toBe("₹1,00,000");
    expect(inr(1234567)).toBe("₹12,34,567");
  });

  it("rounds fractional values to whole rupees", () => {
    expect(inr(99.6)).toBe("₹100");
  });

  it("formats zero", () => {
    expect(inr(0)).toBe("₹0");
  });
});

describe("pricePerKg", () => {
  it("scales a sub-kilo pack up to a per-kg rate", () => {
    expect(pricePerKg(250, 250)).toBe(1000);
  });

  it("returns the price unchanged for a 1kg pack", () => {
    expect(pricePerKg(999, 1000)).toBe(999);
  });

  it("scales a multi-kilo pack down", () => {
    expect(pricePerKg(4500, 5000)).toBe(900);
  });

  it("returns 0 when grams is 0 rather than dividing by zero", () => {
    expect(pricePerKg(500, 0)).toBe(0);
  });
});

describe("pricePer100g", () => {
  it("scales a 250g pack to a per-100g rate", () => {
    expect(pricePer100g(250, 250)).toBe(100);
  });

  it("returns 0 when grams is 0", () => {
    expect(pricePer100g(500, 0)).toBe(0);
  });
});

describe("discountPercent", () => {
  it("computes the percentage off MRP", () => {
    expect(discountPercent(850, 1000)).toBe(15);
  });

  it("returns 0 when the price equals MRP", () => {
    expect(discountPercent(1000, 1000)).toBe(0);
  });

  it("returns 0 when MRP is 0 rather than dividing by zero", () => {
    expect(discountPercent(500, 0)).toBe(0);
  });

  it("never returns a negative discount when price exceeds MRP", () => {
    expect(discountPercent(1200, 1000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- format`
Expected: FAIL — `Failed to resolve import "./format"`.

- [ ] **Step 3: Write `frontend/src/lib/format.ts`**

```ts
/** Formats a rupee amount using Indian digit grouping (1,00,000 not 100,000). */
export const inr = (n: number): string =>
  "₹" + Math.round(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/** Normalises a pack price to a per-kilogram rate. Returns 0 for a zero-weight pack. */
export const pricePerKg = (price: number, grams: number): number =>
  grams === 0 ? 0 : Math.round((price / grams) * 1000);

/** Normalises a pack price to a per-100g rate. Returns 0 for a zero-weight pack. */
export const pricePer100g = (price: number, grams: number): number =>
  grams === 0 ? 0 : Math.round((price / grams) * 100);

/** Percentage off MRP, clamped at 0. Returns 0 when MRP is 0. */
export const discountPercent = (price: number, mrp: number): number =>
  mrp === 0 ? 0 : Math.max(0, Math.round(((mrp - price) / mrp) * 100));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- format`
Expected: 14 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add currency and per-unit price formatting"
```

---

## Task 8: Bulk tier pricing engine (TDD)

**Files:**
- Create: `frontend/src/features/bulk/pricing.ts`
- Test: `frontend/src/features/bulk/pricing.test.ts`

This is the core B2B logic from spec §6 and brief §16. Get it right.

- [ ] **Step 1: Write the failing tests**

`frontend/src/features/bulk/pricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BulkTier } from "@/features/catalog/types";
import { tierFor, bulkTotal, savingsAgainstBaseTier, isQuoteRequired } from "./pricing";

const tiers: BulkTier[] = [
  { minKg: 1, maxKg: 4, pricePerKg: 1000 },
  { minKg: 5, maxKg: 9, pricePerKg: 950 },
  { minKg: 10, maxKg: 24, pricePerKg: 900 },
  { minKg: 25, maxKg: 49, pricePerKg: 850 },
  { minKg: 50, maxKg: null, pricePerKg: null },
];

describe("tierFor", () => {
  it("resolves a quantity inside the first tier", () => {
    expect(tierFor(tiers, 3)?.pricePerKg).toBe(1000);
  });

  it("resolves the lower boundary of a tier", () => {
    expect(tierFor(tiers, 5)?.pricePerKg).toBe(950);
  });

  it("resolves the upper boundary of a tier", () => {
    expect(tierFor(tiers, 9)?.pricePerKg).toBe(950);
  });

  it("resolves the open-ended top tier", () => {
    expect(tierFor(tiers, 500)?.minKg).toBe(50);
  });

  it("falls back to the first tier below the minimum quantity", () => {
    expect(tierFor(tiers, 0)?.pricePerKg).toBe(1000);
  });

  it("returns null for an empty tier list", () => {
    expect(tierFor([], 10)).toBeNull();
  });
});

describe("isQuoteRequired", () => {
  it("is true when the resolved tier has no price", () => {
    expect(isQuoteRequired(tiers, 60)).toBe(true);
  });

  it("is false when the resolved tier is priced", () => {
    expect(isQuoteRequired(tiers, 10)).toBe(false);
  });

  it("is true when there are no tiers at all", () => {
    expect(isQuoteRequired([], 10)).toBe(true);
  });
});

describe("bulkTotal", () => {
  it("multiplies the resolved per-kg rate by quantity", () => {
    expect(bulkTotal(tiers, 10)).toBe(9000);
  });

  it("applies the cheaper rate once a higher tier is reached", () => {
    expect(bulkTotal(tiers, 25)).toBe(21250);
  });

  it("returns null when the quantity requires a quote", () => {
    expect(bulkTotal(tiers, 100)).toBeNull();
  });
});

describe("savingsAgainstBaseTier", () => {
  it("returns the rupee saving versus the first tier rate", () => {
    // 10kg at 900 = 9000; at base rate 1000 = 10000
    expect(savingsAgainstBaseTier(tiers, 10)).toBe(1000);
  });

  it("returns 0 while still inside the base tier", () => {
    expect(savingsAgainstBaseTier(tiers, 3)).toBe(0);
  });

  it("returns 0 when the quantity requires a quote", () => {
    expect(savingsAgainstBaseTier(tiers, 100)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pricing`
Expected: FAIL — `Failed to resolve import "./pricing"`.

- [ ] **Step 3: Write `frontend/src/features/bulk/pricing.ts`**

```ts
import type { BulkTier } from "@/features/catalog/types";

/**
 * Resolves which tier applies to a quantity in kg.
 * Quantities below the first tier's minimum fall back to the first tier, so a
 * sub-minimum input never produces a missing price.
 */
export function tierFor(tiers: BulkTier[], kg: number): BulkTier | null {
  if (tiers.length === 0) return null;
  const match = tiers.find((t) => kg >= t.minKg && (t.maxKg === null || kg <= t.maxKg));
  return match ?? tiers[0]!;
}

/** True when the applicable tier has no published price and must go through RFQ. */
export function isQuoteRequired(tiers: BulkTier[], kg: number): boolean {
  const tier = tierFor(tiers, kg);
  return tier === null || tier.pricePerKg === null;
}

/** Line total for a bulk quantity, or null when the tier requires a quote. */
export function bulkTotal(tiers: BulkTier[], kg: number): number | null {
  const tier = tierFor(tiers, kg);
  if (tier === null || tier.pricePerKg === null) return null;
  return tier.pricePerKg * kg;
}

/**
 * Rupees saved versus buying the same quantity at the first tier's rate.
 * Powers the "You save ₹X" message in brief §16. Returns 0 when a quote is
 * required or the base tier still applies.
 */
export function savingsAgainstBaseTier(tiers: BulkTier[], kg: number): number {
  const total = bulkTotal(tiers, kg);
  const base = tiers[0]?.pricePerKg;
  if (total === null || base == null) return 0;
  return Math.max(0, base * kg - total);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pricing`
Expected: 15 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add bulk tier pricing engine with savings calculation"
```

---

## Task 9: Configurable settings mock

**Files:**
- Create: `frontend/src/config/settings.ts`

Spec §9 requires that no contact detail, WhatsApp number, or certification claim is
hardcoded in a component. This is the single source for all of them.

- [ ] **Step 1: Write `frontend/src/config/settings.ts`**

```ts
/**
 * Values an admin will own in Phase 3. Nothing here may be hardcoded in a component.
 * Certification fields are intentionally empty — brief §25/§26 forbid unsupported claims,
 * so badges render only once real registration numbers are configured.
 */
export interface SiteSettings {
  brandName: string;
  tagline: string;
  whatsappNumber: string;
  supportEmail: string;
  supportPhone: string;
  freeShippingThreshold: number;
  bulkPromptThresholdGrams: number;
  gstin: string;
  fssaiLicence: string;
  certifications: string[];
  social: { label: string; url: string }[];
  addressLines: string[];
}

export const settings: SiteSettings = {
  brandName: "Nuts & Nazaakat",
  tagline: "Small packs for home. Bulk supply for business.",
  whatsappNumber: "",
  supportEmail: "",
  supportPhone: "",
  freeShippingThreshold: 999,
  bulkPromptThresholdGrams: 5000,
  gstin: "",
  fssaiLicence: "",
  certifications: [],
  social: [],
  addressLines: [],
};
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add configurable site settings mock"
```

---

## Task 10: Seed the product catalog

**Files:**
- Create: `frontend/src/mocks/categories.ts`
- Create: `frontend/src/mocks/products.ts`

- [ ] **Step 1: Write `frontend/src/mocks/categories.ts`**

Port the 12 categories from `LOVABLE REFERENCE /catalog.ts` lines 55–68, adding the
`description` field the `Category` type requires.

```ts
import heroImg from "@/assets/hero-dryfruits.jpg";
import almondsImg from "@/assets/cat-almonds.jpg";
import cashewsImg from "@/assets/cat-cashews.jpg";
import pistachiosImg from "@/assets/cat-pistachios.jpg";
import type { Category } from "@/features/catalog/types";

export const img = {
  almonds: almondsImg,
  cashews: cashewsImg,
  pistachios: pistachiosImg,
  mixed: heroImg,
  placeholder: "https://placehold.co/800x800",
};

export const categories: Category[] = [
  { slug: "almonds", name: "Almonds", image: img.almonds, blurb: "Badam, graded and crisp", description: "Graded almond kernels from California, Iran and Afghanistan." },
  { slug: "cashews", name: "Cashews", image: img.cashews, blurb: "W240 & W320 kaju", description: "Whole white cashew kernels in standard export grades." },
  { slug: "pistachios", name: "Pistachios", image: img.pistachios, blurb: "Roasted & salted pista", description: "In-shell and kernel pistachios for snacking and mithai." },
  { slug: "walnuts", name: "Walnuts", image: img.mixed, blurb: "Light halves, akhrot", description: "Light-coloured walnut halves and pieces." },
  { slug: "raisins", name: "Raisins", image: img.mixed, blurb: "Golden & black kishmish", description: "Seedless raisins in golden and black varieties." },
  { slug: "dates", name: "Dates", image: img.mixed, blurb: "Medjool, Kimia khajoor", description: "Soft dates from Jordan, the UAE and Iran." },
  { slug: "anjeer", name: "Anjeer", image: img.mixed, blurb: "Soft dried figs", description: "Hand-sorted dried figs." },
  { slug: "makhana", name: "Makhana", image: img.mixed, blurb: "Roasted fox nuts", description: "Roasted and flavoured fox nuts from Bihar." },
  { slug: "seeds", name: "Seeds", image: img.mixed, blurb: "Pumpkin, sunflower", description: "Shelled seeds for daily mixing and baking." },
  { slug: "trail-mixes", name: "Trail Mixes", image: img.mixed, blurb: "Everyday snacking", description: "House blends of nuts, seeds and berries." },
  { slug: "roasted-nuts", name: "Roasted Nuts", image: img.mixed, blurb: "Lightly roasted", description: "Lightly roasted and salted nuts." },
  { slug: "combos", name: "Combos", image: img.mixed, blurb: "Boxes & value packs", description: "Value packs and gift boxes." },
];
```

- [ ] **Step 2: Write `frontend/src/mocks/products.ts`**

Keep the reference's generator approach (`LOVABLE REFERENCE /catalog.ts` lines 70–146) —
deriving prices from a per-kg base is why the seed data is internally consistent. Extend it
to emit the full `Variant` shape with `grams`, `sku`, `channel`, `stock` and `moq`.

```ts
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
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: "retail" as const,
      price,
      mrp: Math.round(price / (1 - discount) / 10) * 10 - 1,
      stock: 120,
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
      channel: "bulk" as const,
      price: rate * kg,
      mrp: kgPrice * kg,
      stock: 40,
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
  { slug: "daily-dry-fruit-combo", name: "Daily Dry Fruit Combo", category: "combos", subtitle: "Almonds, cashews and raisins.", kg: 899, grade: "Combo", origin: "Multi-origin", image: img.placeholder, badge: "BESTSELLER" },
  { slug: "premium-family-combo", name: "Premium Family Combo", category: "combos", subtitle: "Four packs, one box.", kg: 1199, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "office-snack-combo", name: "Office Snack Combo", category: "combos", subtitle: "Makhana, trail mix and roasted nuts.", kg: 949, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "trail-mix-combo", name: "Trail Mix Combo", category: "combos", subtitle: "Three house blends in one box.", kg: 1049, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "festive-combo", name: "Festive Combo", category: "combos", subtitle: "Assorted nuts for the season.", kg: 1349, grade: "Combo", origin: "Multi-origin", image: img.placeholder },
  { slug: "corporate-gift-box", name: "Corporate Gift Box", category: "combos", subtitle: "Custom branding available.", kg: 1599, grade: "Gift", origin: "Multi-origin", image: img.placeholder, quoteOnly: true, moqKg: 25 },
  { slug: "festive-gift-box", name: "Festive Gift Box", category: "combos", subtitle: "Assorted nuts in a keepsake box.", kg: 1499, grade: "Gift", origin: "Multi-origin", image: img.placeholder, badge: "PREMIUM" },
];

export const products: Product[] = seeds.map((s) => ({
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
  variants: buildVariants(s.slug, s.kg),
  bulkTiers: buildTiers(s.kg),
  moqKg: s.moqKg ?? 10,
  ...(s.quoteOnly ? { quoteOnly: true } : {}),
  seo: {
    title: `${s.name} — Buy Online in 100g to 1kg | Nuts & Nazaakat`,
    description: `${s.subtitle} ${s.grade} grade from ${s.origin}. Retail packs and bulk per-kg pricing with GST invoice.`,
    ogImage: s.image,
  },
}));
```

- [ ] **Step 3: Verify the seed data is well-formed**

Run: `npm run typecheck`
Expected: no errors.

Then confirm the count — spec §10 requires 26 products:

```bash
node -e "console.log(require('fs').readFileSync('frontend/src/mocks/products.ts','utf8').match(/^  \{ slug:/gm).length)"
```
Expected: `26`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: seed 26 products across 12 categories"
```

---

## Task 11: Build the API seam

**Files:**
- Create: `frontend/src/lib/mock-client.ts`
- Create: `frontend/src/features/catalog/api/index.ts`
- Create: `frontend/src/features/catalog/hooks/useCatalog.ts`

This task establishes the pattern every later feature copies. Get the shape right here and
the rest is mechanical.

- [ ] **Step 1: Write `frontend/src/lib/mock-client.ts`**

```ts
/**
 * Simulates network latency so loading states are exercised during development.
 * Phase 2 deletes this file along with src/mocks/.
 */
const LATENCY_MS = 220;

export function mockFetch<T>(data: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(structuredClone(data)), ms));
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}
```

- [ ] **Step 2: Write `frontend/src/features/catalog/api/index.ts`**

This is the only place outside `src/mocks/` allowed to import mock data. Phase 2 replaces
each function body with a `fetch` call; signatures do not change.

```ts
import { mockFetch, NotFoundError } from "@/lib/mock-client";
import { categories } from "@/mocks/categories";
import { products } from "@/mocks/products";
import type { Category, Product, ProductFilters } from "../types";

function applyFilters(list: Product[], f: ProductFilters): Product[] {
  let out = list;

  if (f.category && f.category !== "all") out = out.filter((p) => p.category === f.category);
  if (f.origin) out = out.filter((p) => p.origin === f.origin);
  if (f.grade) out = out.filter((p) => p.grade === f.grade);
  if (f.bestsellerOnly) out = out.filter((p) => p.badge === "BESTSELLER");
  if (f.inStockOnly) out = out.filter((p) => p.variants.some((v) => v.stock > 0));

  if (f.q?.trim()) {
    const q = f.q.toLowerCase();
    out = out.filter((p) =>
      `${p.name} ${p.grade} ${p.category} ${p.origin}`.toLowerCase().includes(q),
    );
  }

  const kgPrice = (p: Product) =>
    p.variants.find((v) => v.grams === 1000)?.price ?? p.variants[0]?.price ?? 0;

  if (f.minPrice != null) out = out.filter((p) => kgPrice(p) >= f.minPrice!);
  if (f.maxPrice != null) out = out.filter((p) => kgPrice(p) <= f.maxPrice!);

  switch (f.sort) {
    case "price-asc":
      return [...out].sort((a, b) => kgPrice(a) - kgPrice(b));
    case "price-desc":
      return [...out].sort((a, b) => kgPrice(b) - kgPrice(a));
    case "rating":
      return [...out].sort((a, b) => b.rating - a.rating);
    case "best-selling":
      return [...out].sort((a, b) => b.reviewCount - a.reviewCount);
    default:
      return out;
  }
}

export const catalogApi = {
  listProducts: (filters: ProductFilters = {}) => mockFetch(applyFilters(products, filters)),

  getProduct: async (slug: string): Promise<Product> => {
    const found = products.find((p) => p.slug === slug);
    if (!found) throw new NotFoundError(`Product "${slug}"`);
    return mockFetch(found);
  },

  listCategories: (): Promise<Category[]> => mockFetch(categories),

  getCategory: async (slug: string): Promise<Category> => {
    const found = categories.find((c) => c.slug === slug);
    if (!found) throw new NotFoundError(`Category "${slug}"`);
    return mockFetch(found);
  },

  listBestsellers: (limit = 8) =>
    mockFetch(products.filter((p) => p.badge === "BESTSELLER").slice(0, limit)),

  listRelated: (slug: string, limit = 4) => {
    const base = products.find((p) => p.slug === slug);
    if (!base) return mockFetch([] as Product[]);
    return mockFetch(
      products.filter((p) => p.category === base.category && p.slug !== slug).slice(0, limit),
    );
  },
};
```

- [ ] **Step 3: Write `frontend/src/features/catalog/hooks/useCatalog.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { catalogApi } from "../api";
import type { ProductFilters } from "../types";

export const catalogKeys = {
  all: ["catalog"] as const,
  products: (f: ProductFilters) => [...catalogKeys.all, "products", f] as const,
  product: (slug: string) => [...catalogKeys.all, "product", slug] as const,
  categories: () => [...catalogKeys.all, "categories"] as const,
  category: (slug: string) => [...catalogKeys.all, "category", slug] as const,
  bestsellers: (n: number) => [...catalogKeys.all, "bestsellers", n] as const,
  related: (slug: string) => [...catalogKeys.all, "related", slug] as const,
};

export const useProducts = (filters: ProductFilters = {}) =>
  useQuery({ queryKey: catalogKeys.products(filters), queryFn: () => catalogApi.listProducts(filters) });

export const useProduct = (slug: string) =>
  useQuery({ queryKey: catalogKeys.product(slug), queryFn: () => catalogApi.getProduct(slug) });

export const useCategories = () =>
  useQuery({ queryKey: catalogKeys.categories(), queryFn: catalogApi.listCategories });

export const useCategory = (slug: string) =>
  useQuery({ queryKey: catalogKeys.category(slug), queryFn: () => catalogApi.getCategory(slug) });

export const useBestsellers = (limit = 8) =>
  useQuery({ queryKey: catalogKeys.bestsellers(limit), queryFn: () => catalogApi.listBestsellers(limit) });

export const useRelated = (slug: string) =>
  useQuery({ queryKey: catalogKeys.related(slug), queryFn: () => catalogApi.listRelated(slug) });
```

- [ ] **Step 4: Verify the lint boundary actually fires**

Temporarily add `import { products } from "@/mocks/products";` to the top of
`src/lib/format.ts`, then run:

Run: `npm run lint`
Expected: an error on that line reading "Import data through features/*/api/ instead."
Remove the import and re-run — lint should pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add API seam with catalog endpoints and query hooks"
```

---

# MILESTONE 2 — UI primitives and app shell

Goal: header, footer, cart drawer and mobile tab bar rendering inside a working router.

## Task 12: Port the 46 shadcn primitives

**Files:**
- Create: `frontend/src/components/ui/*.tsx` (46 files)
- Create: `frontend/src/hooks/use-mobile.tsx`

- [ ] **Step 1: Copy the files**

```bash
cd /Users/kunal/Desktop/nutwala
REF="LOVABLE REFERENCE "
mkdir -p frontend/src/components/ui frontend/src/hooks
for f in accordion alert-dialog alert aspect-ratio avatar badge breadcrumb button \
  calendar card carousel chart checkbox collapsible command context-menu dialog drawer \
  dropdown-menu form hover-card input-otp input label menubar navigation-menu pagination \
  popover progress radio-group resizable scroll-area select separator sheet sidebar \
  skeleton slider sonner switch table tabs textarea toggle-group toggle tooltip; do
  cp "$REF/$f.tsx" "frontend/src/components/ui/$f.tsx"
done
cp "$REF/use-mobile.tsx" frontend/src/hooks/use-mobile.tsx
ls frontend/src/components/ui | wc -l
```
Expected: `46`

- [ ] **Step 2: Typecheck and fix import paths**

Run: `npm run typecheck`

These files import from `@/lib/utils`, `@/hooks/use-mobile` and each other — all of which
now resolve. Any remaining error will be a missing npm package; install it and re-run until
clean.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: port 46 shadcn/ui primitives from reference"
```

---

## Task 13: Shared presentational components

**Files:**
- Create: `frontend/src/components/common/Price.tsx`
- Create: `frontend/src/components/common/Rating.tsx`
- Create: `frontend/src/components/common/EmptyState.tsx`
- Create: `frontend/src/components/common/SectionHeading.tsx`
- Create: `frontend/src/components/common/ProductGridSkeleton.tsx`

- [ ] **Step 1: Write `frontend/src/components/common/Price.tsx`**

```tsx
import { discountPercent, inr } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PriceProps {
  price: number;
  mrp?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { price: "text-base", mrp: "text-xs", off: "text-[11px]" },
  md: { price: "text-lg", mrp: "text-sm", off: "text-xs" },
  lg: { price: "text-3xl", mrp: "text-base", off: "text-sm" },
} as const;

export function Price({ price, mrp, size = "md", className }: PriceProps) {
  const s = sizes[size];
  const off = mrp ? discountPercent(price, mrp) : 0;

  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      <span className={cn("font-bold", s.price)}>{inr(price)}</span>
      {mrp && off > 0 && (
        <>
          <span className={cn("text-muted-foreground line-through", s.mrp)}>{inr(mrp)}</span>
          <span className={cn("font-semibold text-leaf", s.off)}>{off}% off</span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `frontend/src/components/common/Rating.tsx`**

```tsx
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface RatingProps {
  value: number;
  count?: number;
  showStars?: boolean;
  className?: string;
}

export function Rating({ value, count, showStars = false, className }: RatingProps) {
  return (
    <p className={cn("flex items-center gap-1 text-sm", className)}>
      {showStars ? (
        <span className="flex gap-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={cn("size-4", i < Math.round(value) ? "fill-gold text-gold" : "text-border")}
            />
          ))}
        </span>
      ) : (
        <Star className="size-3.5 fill-gold text-gold" />
      )}
      <span className="font-semibold text-foreground">{value.toFixed(1)}</span>
      {count != null && <span className="text-muted-foreground">({count})</span>}
    </p>
  );
}
```

- [ ] **Step 3: Write `frontend/src/components/common/EmptyState.tsx`**

Spec §9 requires a designed empty state on every list.

```tsx
import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, body, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-8 py-20 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="font-display text-2xl">{title}</p>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action}
    </div>
  );
}
```

- [ ] **Step 4: Write `frontend/src/components/common/SectionHeading.tsx`**

```tsx
import type { ReactNode } from "react";

interface SectionHeadingProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

export function SectionHeading({ title, body, action }: SectionHeadingProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-3xl">{title}</h2>
        {body && <p className="mt-2 text-sm text-muted-foreground">{body}</p>}
      </div>
      {action}
    </div>
  );
}
```

- [ ] **Step 5: Write `frontend/src/components/common/ProductGridSkeleton.tsx`**

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add -A && git commit -m "feat: add shared presentational components"
```

---

## Task 14: Cart provider with tested line math (TDD)

**Files:**
- Create: `frontend/src/features/cart/types.ts`
- Create: `frontend/src/features/cart/cart-math.ts`
- Test: `frontend/src/features/cart/cart-math.test.ts`
- Create: `frontend/src/features/cart/CartProvider.tsx`

Ported from `LOVABLE REFERENCE /cart.tsx`, with the pure math extracted so it can be tested
without React.

- [ ] **Step 1: Write `frontend/src/features/cart/types.ts`**

```ts
import type { Channel } from "@/features/catalog/types";

export interface CartLine {
  id: string;
  slug: string;
  mode: Channel;
  /** Retail lines carry a pack size. */
  size?: string;
  grams?: number;
  /** Bulk lines carry a kilogram quantity. */
  kg?: number;
  qty: number;
}

export interface CartTotals {
  subtotal: number;
  gst: number;
  shipping: number;
  total: number;
  hasQuoteLines: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

`frontend/src/features/cart/cart-math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Product } from "@/features/catalog/types";
import type { CartLine } from "./types";
import { lineTotal, cartTotals, shouldPromptBulk } from "./cart-math";

const product: Product = {
  slug: "w320-cashews",
  name: "W320 Cashews",
  category: "cashews",
  subtitle: "",
  description: "",
  rating: 4.7,
  reviewCount: 412,
  images: [],
  origin: "India",
  grade: "W320",
  processing: "",
  shelfLife: "",
  storage: "",
  ingredients: "",
  hsn: "0802",
  gstRate: 5,
  moqKg: 10,
  variants: [
    { sku: "A-250G", size: "250g", grams: 250, channel: "retail", price: 329, mrp: 379, stock: 10, moq: 1 },
    { sku: "A-1KG", size: "1kg", grams: 1000, channel: "retail", price: 1099, mrp: 1279, stock: 10, moq: 1 },
  ],
  bulkTiers: [
    { minKg: 1, maxKg: 9, pricePerKg: 1000 },
    { minKg: 10, maxKg: 49, pricePerKg: 900 },
    { minKg: 50, maxKg: null, pricePerKg: null },
  ],
  seo: { title: "", description: "", ogImage: "" },
};

const find = (slug: string) => (slug === product.slug ? product : undefined);

describe("lineTotal", () => {
  it("multiplies a retail variant price by quantity", () => {
    const line: CartLine = { id: "1", slug: "w320-cashews", mode: "retail", size: "250g", grams: 250, qty: 3 };
    expect(lineTotal(line, find)).toBe(987);
  });

  it("prices a bulk line at the resolved tier rate", () => {
    const line: CartLine = { id: "2", slug: "w320-cashews", mode: "bulk", kg: 10, qty: 1 };
    expect(lineTotal(line, find)).toBe(9000);
  });

  it("returns null for a bulk line whose tier requires a quote", () => {
    const line: CartLine = { id: "3", slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 };
    expect(lineTotal(line, find)).toBeNull();
  });

  it("returns 0 for an unknown product", () => {
    const line: CartLine = { id: "4", slug: "ghost", mode: "retail", size: "250g", qty: 1 };
    expect(lineTotal(line, find)).toBe(0);
  });
});

describe("cartTotals", () => {
  it("sums lines and applies GST", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 1 },
    ];
    const t = cartTotals(lines, find, 999);
    expect(t.subtotal).toBe(1099);
    expect(t.gst).toBe(55); // 5% of 1099, rounded
    expect(t.hasQuoteLines).toBe(false);
  });

  it("charges shipping below the free threshold", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "250g", grams: 250, qty: 1 },
    ];
    expect(cartTotals(lines, find, 999).shipping).toBe(79);
  });

  it("waives shipping at or above the free threshold", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 1 },
    ];
    expect(cartTotals(lines, find, 999).shipping).toBe(0);
  });

  it("flags quote lines and excludes them from the subtotal", () => {
    const lines: CartLine[] = [
      { id: "1", slug: "w320-cashews", mode: "bulk", kg: 60, qty: 1 },
    ];
    const t = cartTotals(lines, find, 999);
    expect(t.hasQuoteLines).toBe(true);
    expect(t.subtotal).toBe(0);
  });

  it("returns zeroes for an empty cart", () => {
    expect(cartTotals([], find, 999)).toEqual({
      subtotal: 0, gst: 0, shipping: 0, total: 0, hasQuoteLines: false,
    });
  });
});

describe("shouldPromptBulk", () => {
  it("is true once a retail line reaches the gram threshold", () => {
    const line: CartLine = { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 5 };
    expect(shouldPromptBulk(line, 5000)).toBe(true);
  });

  it("is false below the threshold", () => {
    const line: CartLine = { id: "1", slug: "w320-cashews", mode: "retail", size: "1kg", grams: 1000, qty: 4 };
    expect(shouldPromptBulk(line, 5000)).toBe(false);
  });

  it("is false for a line that is already bulk", () => {
    const line: CartLine = { id: "1", slug: "w320-cashews", mode: "bulk", kg: 25, qty: 1 };
    expect(shouldPromptBulk(line, 5000)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- cart-math`
Expected: FAIL — `Failed to resolve import "./cart-math"`.

- [ ] **Step 4: Write `frontend/src/features/cart/cart-math.ts`**

```ts
import { bulkTotal } from "@/features/bulk/pricing";
import type { Product } from "@/features/catalog/types";
import type { CartLine, CartTotals } from "./types";

const SHIPPING_FLAT = 79;

type FindProduct = (slug: string) => Product | undefined;

/**
 * Line total in rupees. Returns null when a bulk line falls in a quote-only tier,
 * which the UI renders as "Quote Required" rather than a number.
 */
export function lineTotal(line: CartLine, find: FindProduct): number | null {
  const p = find(line.slug);
  if (!p) return 0;

  if (line.mode === "bulk") {
    const total = bulkTotal(p.bulkTiers, line.kg ?? 0);
    return total === null ? null : total * line.qty;
  }

  const variant = p.variants.find((v) => v.size === line.size) ?? p.variants[0];
  return (variant?.price ?? 0) * line.qty;
}

export function cartTotals(
  lines: CartLine[],
  find: FindProduct,
  freeShippingThreshold: number,
): CartTotals {
  let subtotal = 0;
  let gst = 0;
  let hasQuoteLines = false;

  for (const line of lines) {
    const total = lineTotal(line, find);
    if (total === null) {
      hasQuoteLines = true;
      continue;
    }
    subtotal += total;
    gst += (total * (find(line.slug)?.gstRate ?? 0)) / 100;
  }

  const shipping = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : SHIPPING_FLAT;
  const roundedGst = Math.round(gst);

  return {
    subtotal,
    gst: roundedGst,
    shipping,
    total: subtotal + roundedGst + shipping,
    hasQuoteLines,
  };
}

/** Brief §46 — offer bulk pricing once a single retail line crosses the weight threshold. */
export function shouldPromptBulk(line: CartLine, thresholdGrams: number): boolean {
  if (line.mode !== "retail") return false;
  return (line.grams ?? 0) * line.qty >= thresholdGrams;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- cart-math`
Expected: 12 passed.

- [ ] **Step 6: Write `frontend/src/features/cart/CartProvider.tsx`**

Port `LOVABLE REFERENCE /cart.tsx`, applying these changes: rename the storage key, delegate
totals to `cart-math.ts`, add `switchLineToBulk`, and resolve products through the API
seam's cached data rather than importing mocks.

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { catalogApi } from "@/features/catalog/api";
import type { Channel, Product } from "@/features/catalog/types";
import { settings } from "@/config/settings";
import { cartTotals, lineTotal } from "./cart-math";
import type { CartLine, CartTotals } from "./types";

const KEY = "nn.cart.v1";

interface CartCtx {
  lines: CartLine[];
  mode: Channel;
  setMode: (m: Channel) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  addRetail: (slug: string, size: string, grams: number, qty?: number) => void;
  addBulk: (slug: string, kg: number) => void;
  switchLineToBulk: (id: string) => void;
  setQty: (id: string, qty: number) => void;
  remove: (id: string) => void;
  clear: () => void;
  count: number;
  totals: CartTotals;
  lineTotalFor: (line: CartLine) => number | null;
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [mode, setMode] = useState<Channel>("retail");
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Product[]>([]);

  useEffect(() => {
    catalogApi.listProducts().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setLines(JSON.parse(raw) as CartLine[]);
    } catch {
      /* corrupt storage — start empty */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
      /* quota exceeded — cart stays in memory */
    }
  }, [lines]);

  const find = useCallback((slug: string) => catalog.find((p) => p.slug === slug), [catalog]);

  const value = useMemo<CartCtx>(() => {
    const upsert = (line: CartLine) =>
      setLines((prev) => {
        const found = prev.find((l) => l.id === line.id);
        return found
          ? prev.map((l) => (l.id === line.id ? { ...l, qty: l.qty + line.qty } : l))
          : [...prev, line];
      });

    return {
      lines,
      mode,
      setMode,
      open,
      setOpen,
      addRetail: (slug, size, grams, qty = 1) => {
        upsert({ id: `r:${slug}:${size}`, slug, mode: "retail", size, grams, qty });
        setOpen(true);
      },
      addBulk: (slug, kg) => {
        upsert({ id: `b:${slug}:${kg}`, slug, mode: "bulk", kg, qty: 1 });
        setOpen(true);
      },
      switchLineToBulk: (id) =>
        setLines((prev) =>
          prev.flatMap((l) => {
            if (l.id !== id || l.mode !== "retail") return [l];
            const kg = Math.round(((l.grams ?? 0) * l.qty) / 1000);
            return [{ id: `b:${l.slug}:${kg}`, slug: l.slug, mode: "bulk" as const, kg, qty: 1 }];
          }),
        ),
      setQty: (id, qty) =>
        setLines((prev) =>
          qty <= 0 ? prev.filter((l) => l.id !== id) : prev.map((l) => (l.id === id ? { ...l, qty } : l)),
        ),
      remove: (id) => setLines((prev) => prev.filter((l) => l.id !== id)),
      clear: () => setLines([]),
      count: lines.reduce((a, l) => a + l.qty, 0),
      totals: cartTotals(lines, find, settings.freeShippingThreshold),
      lineTotalFor: (line: CartLine) => lineTotal(line, find),
    };
  }, [lines, mode, open, find]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCart must be used inside CartProvider");
  return c;
}
```

> **Corrected 2026-08-15 during execution.** This originally had `CartProvider` import
> `@/mocks/settings` and then added the file to the linter's exemption list. Settings live at
> `src/config/settings.ts` instead — it is configuration, not queryable mock data, and
> exemption lists only ever grow. Nothing needs exempting. In Phase 2 it becomes a settings
> endpoint.

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean, 41 tests passing (14 format + 15 pricing + 12 cart-math).

```bash
git add -A && git commit -m "feat: add cart provider with tested line math and bulk switching"
```

---

## Task 15: App shell — router, providers, root route

**Files:**
- Create: `frontend/src/providers/AppProviders.tsx`
- Create: `frontend/src/router.tsx`
- Create: `frontend/src/routes/__root.tsx`
- Rewrite: `frontend/src/main.tsx`
- Delete: `frontend/src/App.tsx`

- [ ] **Step 1: Write `frontend/src/providers/AppProviders.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CartProvider } from "@/features/cart/CartProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CartProvider>{children}</CartProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Write `frontend/src/routes/__root.tsx`**

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { CartDrawer } from "@/components/layout/CartDrawer";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { SiteHeader } from "@/components/layout/SiteHeader";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="flex-1 pb-16 md:pb-0">
        <Outlet />
      </main>
      <SiteFooter />
      <MobileTabBar />
      <CartDrawer />
      <Toaster position="top-center" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="container-page py-24 text-center">
      <p className="font-display text-5xl">404</p>
      <h1 className="mt-4 font-display text-2xl">This page has gone missing.</h1>
      <a href="/" className="mt-6 inline-block text-sm underline underline-offset-4">
        Back to home
      </a>
    </div>
  );
}
```

`pb-16 md:pb-0` on `<main>` reserves space for the fixed mobile tab bar so it never covers
page content.

- [ ] **Step 3: Write `frontend/src/router.tsx`**

```tsx
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

- [ ] **Step 4: Rewrite `frontend/src/main.tsx`**

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/providers/AppProviders";
import { router } from "@/router";
import "@/styles/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
```

```bash
rm frontend/src/App.tsx
```

- [ ] **Step 5: Create a placeholder home route so the tree generates**

`frontend/src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <div className="container-page py-20">Home</div>,
});
```

- [ ] **Step 6: Commit (layout components come next; the app will not build until Task 16)**

```bash
git add -A && git commit -m "feat: add app shell with router, providers, and root layout"
```

---

## Task 16: Layout components

**Files:**
- Create: `frontend/src/components/layout/SiteHeader.tsx`
- Create: `frontend/src/components/layout/SiteFooter.tsx`
- Create: `frontend/src/components/layout/MobileTabBar.tsx`
- Create: `frontend/src/components/layout/CartDrawer.tsx`

- [ ] **Step 1: Port `SiteHeader.tsx`**

Copy `LOVABLE REFERENCE /SiteHeader.tsx` to
`frontend/src/components/layout/SiteHeader.tsx` and apply exactly these changes:

1. Change the cart import to `import { useCart } from "@/features/cart/CartProvider";`
2. Replace the `nav` array (lines 9–14) with the full sitemap:

```tsx
const nav = [
  { to: "/shop", label: "Shop" },
  { to: "/combos", label: "Combos" },
  { to: "/bulk-orders", label: "Bulk Orders" },
  { to: "/gifting", label: "Gifting" },
  { to: "/about", label: "Our Story" },
] as const;
```

3. Replace the brand block (lines 52–57) with:

```tsx
<Link to="/" className="flex items-baseline gap-1.5">
  <span className="font-display text-2xl">Nuts &amp; Nazaakat</span>
  <span className="hidden text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground sm:inline">
    Dry Fruits
  </span>
</Link>
```

4. Point the account button at `/account` by wrapping it in
   `<Link to="/account" aria-label="Account">`, mirroring how the search button is wrapped.

Everything else — the sticky scroll shrink (`scrolled ? "py-1" : "py-3"`), the backdrop
blur, the cart badge, the `Buy in Bulk` CTA — stays byte-identical.

- [ ] **Step 2: Port `SiteFooter.tsx`**

Copy `LOVABLE REFERENCE /SiteFooter.tsx` and apply these changes:

1. Replace `Nutwala` (line 48) with `Nuts &amp; Nazaakat`.
2. Repoint every `to:` in the `cols` array at its real route — the reference points
   everything at `/shop` or `/about` because those pages did not exist yet:

```tsx
const cols = [
  {
    title: "Shop",
    links: [
      { label: "All Products", to: "/shop" },
      { label: "Almonds", to: "/category/almonds" },
      { label: "Cashews", to: "/category/cashews" },
      { label: "Pistachios", to: "/category/pistachios" },
      { label: "Walnuts", to: "/category/walnuts" },
      { label: "Raisins", to: "/category/raisins" },
      { label: "Makhana", to: "/category/makhana" },
      { label: "Combos", to: "/combos" },
    ],
  },
  {
    title: "Business",
    links: [
      { label: "Bulk Orders", to: "/bulk-orders" },
      { label: "Wholesale Pricing", to: "/bulk-orders" },
      { label: "Corporate Gifting", to: "/gifting" },
      { label: "Become a Partner", to: "/business" },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Contact", to: "/contact" },
      { label: "Shipping", to: "/shipping" },
      { label: "Returns", to: "/returns" },
      { label: "FAQs", to: "/faq" },
      { label: "Track Order", to: "/account/orders" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", to: "/about" },
      { label: "Quality", to: "/quality" },
      { label: "Blog", to: "/blog" },
    ],
  },
] as const;
```

3. Replace the hardcoded legal line (lines 72–75) with settings-driven content:

```tsx
<div className="container-page flex flex-col gap-2 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
  <p>
    {settings.gstin || settings.fssaiLicence
      ? [settings.gstin && `GSTIN ${settings.gstin}`, settings.fssaiLicence && `FSSAI ${settings.fssaiLicence}`]
          .filter(Boolean)
          .join(" · ")
      : `© ${new Date().getFullYear()} ${settings.brandName}`}
  </p>
  <p className="flex gap-3">
    <Link to="/privacy">Privacy Policy</Link>
    <Link to="/terms">Terms</Link>
    <Link to="/returns">Refund Policy</Link>
    <Link to="/shipping">Shipping Policy</Link>
  </p>
</div>
```

Add `import { settings } from "@/config/settings";`. No linter exemption is needed —
settings live outside `src/mocks/`.

- [ ] **Step 3: Port `MobileTabBar.tsx`**

Copy `LOVABLE REFERENCE /MobileTabBar.tsx` unchanged except: update the cart import to
`@/features/cart/CartProvider`, and change the Search tab's `to="/shop"` to
`to="/shop" search={{ focus: true }}` so it opens the shop page with search focused.

- [ ] **Step 4: Port `CartDrawer.tsx`**

Copy `LOVABLE REFERENCE /CartDrawer.tsx` and apply these changes:

1. Imports become `import { useCart } from "@/features/cart/CartProvider";` and
   `import { inr } from "@/lib/format";`
2. Delete the `const FREE_SHIPPING = 999;` line — read `totals` from the cart context, which
   already applies `settings.freeShippingThreshold`.
3. Replace `subtotal` destructuring with `totals`, and use `totals.subtotal` throughout.
4. Replace the direct `products.find(...)` lookup with the `useProducts()` hook — the drawer
   must not import mocks.
5. Replace the `lineTotal(l)` call with `lineTotalFor(l)` from context, and render
   `"Quote Required"` when it returns `null`.
6. Wrap the checkout button in `<Link to="/cart">`.
7. Replace the empty-state block with the shared `EmptyState` component, keeping the exact
   copy: *"Your cart is waiting for something delicious."* / **Explore Bestsellers**.

- [ ] **Step 5: Verify the shell renders**

Run: `npm run dev`
Expected: header with the Nuts & Nazaakat wordmark and 5 nav links, footer with 4 populated
columns, mobile tab bar visible below 768px, cart icon opens an empty drawer showing the
empty-state copy. No console errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add header, footer, mobile tab bar, and cart drawer"
```

---

# MILESTONE 3 — Core commerce routes

Goal: the complete B2C journey works end to end.

## Task 17: ProductCard

**Files:**
- Create: `frontend/src/features/catalog/components/ProductCard.tsx`

- [ ] **Step 1: Port and extend**

Copy `LOVABLE REFERENCE /ProductCard.tsx` and apply these changes:

1. Imports: `useCart` from `@/features/cart/CartProvider`; `Product` from `../types`;
   drop the `inr` import in favour of the shared `Price` component.
2. `useState<PackSize>("250g")` becomes `useState<string>("250g")` — sizes are open strings
   now (spec §3.3).
3. Filter the size chips to retail variants only, so 25kg does not appear on a retail card:

```tsx
const retailVariants = product.variants.filter((v) => v.channel === "retail");
const variant = retailVariants.find((v) => v.size === size) ?? retailVariants[0]!;
```

4. Replace the manual price block (lines 65–69) with `<Price price={variant.price} mrp={variant.mrp} />`.
5. Replace the manual rating block (lines 43–46) with `<Rating value={product.rating} count={product.reviewCount} />`.
6. Add a per-unit line under the price for spec §9 price transparency:

```tsx
<p className="mt-1 text-xs text-muted-foreground">
  {inr(pricePer100g(variant.price, variant.grams))} / 100g
</p>
```

7. `addRetail(product.slug, size)` becomes `addRetail(product.slug, size, variant.grams)`.
8. `product.short` becomes `product.subtitle`; `product.image` becomes `product.images[0]`.
9. Add a wishlist button — an absolutely positioned `Heart` icon button at
   `right-3 top-3` mirroring the badge's positioning, toggling local state. Brief §8
   requires it on the card; persistence arrives in Phase 2.

Keep the hover lift (`hover:-translate-y-1 hover:shadow-lift`) and image zoom
(`group-hover:scale-105`) exactly as written — they are part of the design.

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run lint`

```bash
git add -A && git commit -m "feat: add ProductCard with per-unit pricing and wishlist"
```

---

## Task 18: Home route

**Files:**
- Create: `frontend/src/routes/index.tsx` (replacing the Task 15 placeholder)
- Create: `frontend/src/lib/seo.ts`

- [ ] **Step 1: Write `frontend/src/lib/seo.ts`**

TanStack Router's SPA mode has no `head()`, so meta tags are applied imperatively.

```ts
interface SeoInput {
  title: string;
  description: string;
  ogImage?: string;
  canonical?: string;
  jsonLd?: Record<string, unknown>;
}

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

export function applySeo({ title, description, ogImage, canonical, jsonLd }: SeoInput) {
  document.title = title;
  upsertMeta("name", "description", description);
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  if (ogImage) upsertMeta("property", "og:image", ogImage);

  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = canonical ?? window.location.href;

  document.getElementById("route-jsonld")?.remove();
  if (jsonLd) {
    const script = document.createElement("script");
    script.id = "route-jsonld";
    script.type = "application/ld+json";
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
  }
}
```

Then create `frontend/src/hooks/useSeo.ts`:

```ts
import { useEffect } from "react";
import { applySeo } from "@/lib/seo";

type SeoInput = Parameters<typeof applySeo>[0];

export function useSeo(input: SeoInput) {
  useEffect(() => {
    applySeo(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.title, input.description]);
}
```

- [ ] **Step 2: Port the home route**

Copy `LOVABLE REFERENCE /index.tsx` to `frontend/src/routes/index.tsx` and apply:

1. Delete the `head: () => ({ meta: [...] })` block. Replace with a `useSeo()` call inside
   the `Home` component:

```tsx
useSeo({
  title: "Nuts & Nazaakat — Premium Dry Fruits for Home & Bulk Business Orders",
  description:
    "Shop premium almonds, cashews, pistachios, makhana and more in 100g to 1kg packs — or buy in bulk with tiered per-kg pricing, GST invoices and quotes.",
});
```

2. Replace the direct `products` / `categories` imports with `useBestsellers()`,
   `useProducts({ category: "combos" })` and `useCategories()`.
3. Render `<ProductGridSkeleton />` while `isLoading`.
4. Change the H1 to the brief's copy: **"Premium Dry Fruits, Made Simple."** with the
   subheading *"From your kitchen to your business — shop premium dry fruits in the quantity
   you actually need."* Keep the exact typographic classes
   (`font-display text-4xl leading-[1.05] sm:text-5xl lg:text-6xl`).
5. Change the fourth trust indicator from "B2B Bulk Pricing" to "Bulk Pricing" per brief §6.
6. Keep the B2B band, journey strip, and reviews sections structurally identical.

- [ ] **Step 3: Verify**

Run: `npm run dev`, open `/`.
Expected: hero, 12 category cards, bestseller grid, walnut-brown B2B band with the tier
table, 6-step journey strip, 3 review cards, combos grid. Skeletons flash briefly on load.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add home route with SEO helper"
```

---

## Task 19: Shop route with URL-driven filters

**Files:**
- Create: `frontend/src/routes/shop.tsx`
- Create: `frontend/src/features/catalog/components/ShopFilters.tsx`

Spec §5.3 requires filters in the URL, not component state — the reference uses `useState`,
which breaks sharing and the back button.

- [ ] **Step 1: Write the route with a validated search schema**

`frontend/src/routes/shop.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ShopPage } from "@/features/catalog/components/ShopPage";

const searchSchema = z.object({
  category: z.string().optional(),
  q: z.string().optional(),
  sort: z
    .enum(["featured", "best-selling", "price-asc", "price-desc", "newest", "rating"])
    .optional(),
  origin: z.string().optional(),
  grade: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  bestsellerOnly: z.boolean().optional(),
  inStockOnly: z.boolean().optional(),
  focus: z.boolean().optional(),
});

export const Route = createFileRoute("/shop")({
  validateSearch: searchSchema,
  component: ShopPage,
});
```

- [ ] **Step 2: Build `ShopPage` and `ShopFilters`**

Create `frontend/src/features/catalog/components/ShopPage.tsx`. Port the layout from
`LOVABLE REFERENCE /shop.tsx` — the H1, the category pill row, the search input, the sort
`Select`, the result count, and the `grid-cols-2 lg:grid-cols-4` product grid — with these
changes:

1. Read filters via `Route.useSearch()` and write them with `useNavigate()`:

```tsx
const search = Route.useSearch();
const navigate = useNavigate({ from: "/shop" });
const setFilter = (patch: Partial<typeof search>) =>
  navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
```

2. Pass `search` straight into `useProducts(search)`.
3. Debounce the search input by 300ms before calling `setFilter({ q })` so typing does not
   push a history entry per keystroke.
4. Add the remaining brief §9 filters in a `ShopFilters` sidebar — origin, grade, price
   range, bestseller, availability — collapsed into a `Sheet` below `md`, a sticky
   `aside` above it. Derive origin and grade option lists from the loaded products rather
   than hardcoding.
5. Add all six sort options from brief §9 (the reference has four).
6. Use `EmptyState` for no results, keeping the reference's copy: *"No matches for
   '{q}'."* / *"Try a broader term like 'almonds' or 'makhana'."*
7. Render `<ProductGridSkeleton />` while loading.
8. Add `useSeo()` with the shop title and description.

- [ ] **Step 3: Verify filter state survives a reload**

Run: `npm run dev`, visit `/shop`, set category to Cashews and sort to Price: Low to High.
Expected: URL reads `/shop?category=cashews&sort=price-asc`. Reload — filters persist.
Press back — the previous filter state restores.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add shop route with URL-driven filters and sorting"
```

---

## Task 20: Category route

**Files:**
- Create: `frontend/src/routes/category.$slug.tsx`

- [ ] **Step 1: Write the route**

Port `LOVABLE REFERENCE /category.$slug.tsx`, switching to the hooks and adding a category
header plus `BreadcrumbList` JSON-LD.

```tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { useCategory, useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/category/$slug")({ component: CategoryPage });

function CategoryPage() {
  const { slug } = Route.useParams();
  const { data: category } = useCategory(slug);
  const { data: products, isLoading } = useProducts({ category: slug });

  useSeo({
    title: `${category?.name ?? "Category"} — Buy Online | Nuts & Nazaakat`,
    description: category?.description ?? "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "/" },
        { "@type": "ListItem", position: 2, name: "Shop", item: "/shop" },
        { "@type": "ListItem", position: 3, name: category?.name ?? slug },
      ],
    },
  });

  return (
    <div className="container-page py-10">
      <nav className="text-xs text-muted-foreground">
        <Link to="/" className="hover:text-foreground">Home</Link> /{" "}
        <Link to="/shop" className="hover:text-foreground">Shop</Link> /{" "}
        <span className="text-foreground">{category?.name ?? slug}</span>
      </nav>

      <h1 className="mt-6 font-display text-4xl">{category?.name ?? slug}</h1>
      {category?.description && (
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{category.description}</p>
      )}

      {isLoading ? (
        <div className="mt-8"><ProductGridSkeleton /></div>
      ) : products && products.length > 0 ? (
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
          {products.map((p) => <ProductCard key={p.slug} product={p} />)}
        </div>
      ) : (
        <EmptyState
          title="Nothing here yet."
          body="This category has no products in stock right now."
          action={<Button asChild><Link to="/shop">Browse all products</Link></Button>}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify and commit**

Visit `/category/almonds` — expect 3 almond products and correct breadcrumbs.

```bash
git add -A && git commit -m "feat: add category route with breadcrumb structured data"
```

---

## Task 21: Product detail route

**Files:**
- Create: `frontend/src/routes/product.$slug.tsx`
- Create: `frontend/src/features/catalog/components/ProductGallery.tsx`
- Create: `frontend/src/features/catalog/components/PincodeChecker.tsx`
- Create: `frontend/src/features/bulk/components/TierTable.tsx`

The richest page in the app. Port `LOVABLE REFERENCE /product.$slug.tsx` as the base — its
retail/bulk `Tabs` structure is exactly right — then extend.

- [ ] **Step 1: Build `ProductGallery.tsx`**

Brief §10 requires a gallery, not the reference's single image. Main image plus a thumbnail
strip below, click to swap, `aspect-square`, `rounded-3xl border border-border bg-sand` on
the main frame to match the reference's framing.

- [ ] **Step 2: Build `TierTable.tsx`**

Extract the tier table from the reference (lines 157–173), preserving the
`t === tier && "bg-sand font-semibold"` active-row highlight, and add the savings line
below it:

```tsx
{savings > 0 && (
  <p className="mt-3 text-sm font-semibold text-leaf">You save {inr(savings)}</p>
)}
```

using `savingsAgainstBaseTier` from Task 8.

- [ ] **Step 3: Build `PincodeChecker.tsx`**

Brief §10 requires it. A 6-digit input with a Check button. Mock rule: pincodes starting
2–8 are serviceable with a 2–6 day estimate; others show "We don't deliver here yet."
Shipping charge shown as free above `settings.freeShippingThreshold`, else ₹79. Put the
mock resolution behind `features/checkout/api/` so Phase 2 swaps it for a real serviceability
call.

- [ ] **Step 4: Assemble the route**

Port the reference file with these changes:

1. Replace `getProduct` loader with `useProduct(slug)`; render a skeleton while loading and
   the not-found block on error.
2. `product.short` → `product.subtitle`; single image → `<ProductGallery images={product.images} />`.
3. Retail tab: filter to `channel === "retail"` variants; add a quantity stepper (brief §10);
   add per-100g and per-kg lines under the price; `Add to Cart` plus `Buy Now` (which adds
   then navigates to `/checkout`).
4. Bulk tab: keep the kg stepper and `TierTable`; when `isQuoteRequired(product.bulkTiers, kg)`
   render **Request a Quote** linking to `/business/rfqs?product={slug}&kg={kg}` instead of
   Add to Cart.
5. Replace the hardcoded trust list (lines 200–205) with entries derived from
   `settings.certifications`; render nothing when the array is empty (spec §2 — no
   unsupported claims).
6. Add the `PincodeChecker` below the buy box.
7. Expand the specifications accordion to all brief §10 fields: origin, grade, ingredients,
   processing, shelf life, storage, net weight, country of origin.
8. Add a reviews section below the fold (Task 30 fills it; render the heading and average
   rating now).
9. Add `useSeo()` with `Product` JSON-LD:

```tsx
jsonLd: {
  "@context": "https://schema.org",
  "@type": "Product",
  name: product.name,
  image: product.images,
  description: product.description,
  sku: product.variants[0]?.sku,
  brand: { "@type": "Brand", name: "Nuts & Nazaakat" },
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: product.rating,
    reviewCount: product.reviewCount,
  },
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "INR",
    lowPrice: Math.min(...product.variants.map((v) => v.price)),
    highPrice: Math.max(...product.variants.map((v) => v.price)),
  },
}
```

- [ ] **Step 5: Verify both purchase paths**

Visit `/product/w320-cashews`. Retail tab: change pack size, confirm price and per-100g
update. Bulk tab: set 10kg, confirm the 10–24kg row highlights and "You save ₹1,000" shows;
set 60kg, confirm the CTA becomes Request a Quote.
Visit `/product/corporate-gift-box` — `quoteOnly` means the bulk tab must always show
Request a Quote.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add product detail route with gallery, tiers, and pincode check"
```

---

## Task 22: Cart page

**Files:**
- Create: `frontend/src/routes/cart.tsx`
- Create: `frontend/src/features/cart/components/CartLineRow.tsx`
- Create: `frontend/src/features/cart/components/BulkUpsellPrompt.tsx`

- [ ] **Step 1: Build `BulkUpsellPrompt.tsx`**

Brief §46. Renders when `shouldPromptBulk(line, settings.bulkPromptThresholdGrams)` is true.

```tsx
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BulkUpsellPrompt({ onSwitch }: { onSwitch: () => void }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-accent px-4 py-3">
      <p className="text-sm text-accent-foreground">
        Buying in bulk? You may qualify for better pricing.
      </p>
      <Button size="sm" variant="secondary" className="ml-auto" onClick={onSwitch}>
        View Bulk Pricing <ArrowRight className="ml-1 size-3.5" />
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Build `CartLineRow.tsx`**

Image, name, size or kg label, quantity stepper, line total (or "Quote Required" when
`lineTotalFor` returns null), remove button, and the upsell prompt when applicable.

- [ ] **Step 3: Build the cart route**

Two columns above `lg`: lines on the left, an order summary card on the right showing
subtotal, GST, shipping, and total from `totals`. Free-shipping progress message reusing the
drawer's copy. A "Frequently Bought Together" strip below (brief §21) using
`useRelated(firstLine.slug)`. Empty state with the exact required copy. `Proceed to
Checkout` links to `/checkout`; when `totals.hasQuoteLines` is true, show a secondary
**Request Quote** action instead of blocking checkout entirely.

- [ ] **Step 4: Verify the mode switch**

Add 5 × 1kg of any product to the cart, open `/cart`.
Expected: the upsell prompt appears on that line. Click **View Bulk Pricing** — the line
becomes a 5kg bulk line priced at the 5–9kg tier rate.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add cart page with bulk upsell and order summary"
```

---

## Task 23: Checkout and order success

**Files:**
- Create: `frontend/src/routes/checkout.tsx`
- Create: `frontend/src/features/checkout/components/CheckoutForm.tsx`
- Create: `frontend/src/features/checkout/schema.ts`
- **Extend** (do not overwrite): `frontend/src/features/checkout/api/index.ts`
- Create: `frontend/src/routes/order-success.$id.tsx`

> **Corrected 2026-08-15 during execution.** Task 21 already creates
> `features/checkout/api/index.ts` for the pincode checker. This task must ADD `placeOrder`
> to the existing `checkoutApi` object, not recreate the file — recreating it silently
> deletes `checkPincode` and breaks the product page's delivery estimator.

- [ ] **Step 1: Write `frontend/src/features/checkout/schema.ts`**

```ts
import { z } from "zod";

export const addressSchema = z.object({
  fullName: z.string().min(2, "Enter your full name"),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number"),
  email: z.string().email("Enter a valid email address"),
  line1: z.string().min(4, "Enter your address"),
  line2: z.string().optional(),
  city: z.string().min(2, "Enter your city"),
  state: z.string().min(2, "Select your state"),
  pincode: z.string().regex(/^\d{6}$/, "Enter a valid 6-digit pincode"),
});

export const b2cCheckoutSchema = z.object({
  shipping: addressSchema,
  couponCode: z.string().optional(),
  paymentMethod: z.enum(["online", "cod"]),
});

export const b2bCheckoutSchema = b2cCheckoutSchema.extend({
  companyName: z.string().min(2, "Enter your company name"),
  gstin: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, "Enter a valid 15-character GSTIN"),
  poNumber: z.string().optional(),
  billingSameAsShipping: z.boolean(),
  billing: addressSchema.optional(),
  specialInstructions: z.string().optional(),
});

export type B2cCheckout = z.infer<typeof b2cCheckoutSchema>;
export type B2bCheckout = z.infer<typeof b2bCheckoutSchema>;
```

- [ ] **Step 2: Add `placeOrder` to the existing `frontend/src/features/checkout/api/index.ts`**

The file already exists from Task 21 and exports `checkoutApi` with `checkPincode`. **Add to
it; do not replace it.** Keep `checkPincode` exactly as Task 21 left it.

Add this interface:

```ts
export interface PlacedOrder {
  id: string;
  placedAt: string;
  estimatedDelivery: string;
}
```

And add this method to the existing `checkoutApi` object:

```ts
  placeOrder: (): Promise<PlacedOrder> => {
    const seq = String(Math.floor(Math.random() * 900000) + 100000);
    const eta = new Date(Date.now() + 4 * 86_400_000);
    return mockFetch({
      id: `NN-${new Date().getFullYear()}-${seq}`,
      placedAt: new Date().toISOString(),
      estimatedDelivery: eta.toISOString(),
    }, 600);
  },
```

After editing, confirm both methods are still exported and that the product page's pincode
checker still compiles.

- [ ] **Step 3: Build `CheckoutForm.tsx`**

react-hook-form with `zodResolver`. Sections in brief §20 order: Contact, Address, Order
Summary, Coupon, Shipping, Payment. When the cart contains bulk lines or the user's role is
`b2b`, switch to `b2bCheckoutSchema` and reveal the Company Name, GSTIN, PO Number, Billing
Address and Special Instructions fields. Payment methods render as radio cards; both are
mocked — selecting either and submitting calls `placeOrder()`.

- [ ] **Step 4: Build the order success route**

Brief §43. Heading **"Order Confirmed!"**, order ID, item list, amount, delivery address,
estimated delivery, a Track Order link to `/account/orders/{id}`, and a **Continue
Shopping** button. Clear the cart on mount.

- [ ] **Step 5: Verify the full B2C journey**

Shop → product → add to cart → cart → checkout → fill the form → place order.
Expected: validation errors appear for a bad pincode and a bad phone number; submitting
valid data navigates to `/order-success/NN-2026-XXXXXX` and the cart empties.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add checkout with B2C/B2B forms and order confirmation"
```

---

# MILESTONE 4 — B2B

Goal: the complete bulk journey including RFQ.

## Task 24: Bulk orders landing

**Files:**
- Create: `frontend/src/routes/bulk-orders.tsx`

- [ ] **Step 1: Port and restructure**

Port `LOVABLE REFERENCE /bulk-orders.tsx`, keeping the perks grid and the slab pricing
table, and apply:

1. Hero copy becomes brief §13: H1 **"Buy Better. Buy Bigger. Pay Smarter."**, body
   *"Reliable dry-fruit supply for retailers, sweet shops, bakeries, cafés, restaurants,
   hotels, cloud kitchens, distributors and growing food businesses."*, buttons
   **Explore Bulk Products** (→ `/bulk/all`) and **Get Bulk Pricing** (→ `/business/rfqs/new`).
2. Add the brief §14 business-type card grid — 11 cards linking to `/bulk/{slug}`.
3. Feed the slab table from `useProducts()` rather than the mocks import.
4. Replace the inline enquiry form with a link to the RFQ route — one RFQ implementation,
   not two.
5. Add a WhatsApp CTA reading **Talk to Bulk Sales**, rendered only when
   `settings.whatsappNumber` is non-empty.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add bulk orders landing with business type grid"
```

---

## Task 25: Bulk catalog

**Files:**
- Create: `frontend/src/routes/bulk.$category.tsx`
- Create: `frontend/src/features/bulk/components/BulkProductCard.tsx`

- [ ] **Step 1: Build `BulkProductCard.tsx`**

Brief §15. Shows name, grade, MOQ, live per-kg price for the entered quantity, a kg
stepper, and two actions: **Add to Bulk Cart** and **Request Quote**. When
`isQuoteRequired` is true, only Request Quote renders. Savings line shown via
`savingsAgainstBaseTier`.

- [ ] **Step 2: Build the route**

`$category` accepts `all` or any category slug. Filters per brief §15: product, category,
grade, origin, MOQ, price/kg, availability. Table-style dense layout above `lg`, cards
below — bulk buyers scan more rows than retail shoppers.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add bulk catalog with per-kg pricing cards"
```

---

## Task 26: RFQ system

**Files:**
- Create: `frontend/src/features/rfq/types.ts`
- Create: `frontend/src/features/rfq/schema.ts`
- Create: `frontend/src/features/rfq/api/index.ts`
- Create: `frontend/src/features/rfq/hooks/useRfqs.ts`
- Create: `frontend/src/routes/business/rfqs/index.tsx` (list)
- Create: `frontend/src/routes/business/rfqs/new.tsx` (form)
- Create: `frontend/src/routes/business/rfqs/$id.tsx` (detail)
- **Delete: `frontend/src/routes/business_.rfqs.tsx`** — see note below

> **Corrected 2026-08-15 during execution.** This originally specified
> `business/rfqs.tsx` + `business/rfqs.$id.tsx` — which walks straight into the same layout
> trap the note below warns about: `rfqs.tsx` becomes the parent of `rfqs.$id.tsx`, and with
> no `<Outlet />` the detail page renders blank. Use the directory form above: no layout
> file, so no Outlet needed. `new.tsx` is required because Task 24's **Get Bulk Pricing**
> button needs a route for the form, while `/business/rfqs` is the list.
- Create: `frontend/src/mocks/rfqs.ts`

> **Added 2026-08-15 during execution.** Task 21's product page links to `/business/rfqs`
> for quote-only products. Because TanStack's `to=` is type-checked against the generated
> route tree and casting is forbidden, Task 21 had to create a stub at
> `src/routes/business_.rfqs.tsx`. The `business_.` prefix is TanStack's non-nesting escape:
> a plain `business.rfqs.tsx` would have made the existing `business.tsx` a layout route, and
> without an `<Outlet />` that silently blackholes every child. **Delete the stub when you
> create the real route**, then confirm the product page's Request a Quote link still
> typechecks and still resolves.

- [ ] **Step 1: Write the RFQ number generator**

In `frontend/src/features/rfq/api/index.ts`. Brief §17 requires the format
`RFQ-2026-001245` — year plus a zero-padded 6-digit sequence.

```ts
import { mockFetch } from "@/lib/mock-client";
import { rfqs } from "@/mocks/rfqs";
import type { Rfq, RfqDraft } from "../types";

let sequence = rfqs.length;

export const rfqApi = {
  list: () => mockFetch(rfqs),

  get: (id: string) => mockFetch(rfqs.find((r) => r.id === id) ?? null),

  create: (draft: RfqDraft): Promise<Rfq> => {
    sequence += 1;
    const created: Rfq = {
      ...draft,
      id: `RFQ-${new Date().getFullYear()}-${String(sequence).padStart(6, "0")}`,
      status: "new",
      createdAt: new Date().toISOString(),
    };
    rfqs.unshift(created);
    return mockFetch(created, 500);
  },
};
```

- [ ] **Step 2: Write the RFQ schema**

All brief §17 fields: business name, contact person, mobile, email, GSTIN (optional at RFQ
stage), business type, delivery pincode, products, quantity, packaging preference, expected
frequency, additional requirements. Reuse the phone, pincode and GSTIN regexes from
`checkout/schema.ts` — import them rather than redefining.

- [ ] **Step 3: Build the RFQ form and list routes**

`/business/rfqs` lists existing RFQs with status badges and a **New Request** action.
The form supports multiple product line items (add/remove rows). On success, show the brief
§17 confirmation — **"Quote Request Submitted"** with the generated RFQ number displayed
prominently — and a link to `/business/rfqs/{id}`.

Prefill from search params when arriving from a product page
(`?product=w320-cashews&kg=60`).

- [ ] **Step 4: Verify**

From `/product/corporate-gift-box`, click Request a Quote. Expect the RFQ form prefilled
with that product. Submit — expect an ID matching `/^RFQ-2026-\d{6}$/` and the new RFQ
appearing at the top of `/business/rfqs`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add RFQ system with numbered quote requests"
```

---

## Task 27: Bulk cart and business area

**Files:**
- Create: `frontend/src/routes/business/route.tsx` (layout)
- Create: `frontend/src/routes/business/index.tsx`
- Create: `frontend/src/routes/business/profile.tsx`
- Create: `frontend/src/routes/business/orders.tsx`
- Create: `frontend/src/routes/business/bulk-cart.tsx`

- [ ] **Step 1: Build the business layout route**

Sidebar navigation: Dashboard, Profile, Orders, RFQs, Bulk Cart.

> **Corrected 2026-08-15 during execution.** This originally said "guards on `role === "b2b"`,
> redirecting to `/business` otherwise" — which is circular: `/business` is *inside* the
> guarded layout, so an unauthorised visitor redirects into the thing that rejected them.
> Milestone 4 built this area unguarded with a `TODO(milestone-5)` block comment at the top
> of `src/routes/business/route.tsx` naming the exact `beforeLoad` to add.
>
> **Task 28/29 must resolve this**, not paper over it. Redirect non-B2B users to a route
> *outside* the guarded layout — either `/login?redirect=…` when unauthenticated, or a
> "Register your business" upgrade page that lives outside `business/`. Decide which and say
> so in the commit message.

- [ ] **Step 2: Build the bulk cart**

Brief §18. Table columns: Product, Grade, Quantity, Price/kg, Subtotal. Below: GST,
shipping, total. Editable quantities, removable rows. Lines needing a quote show **Quote
Required** in place of a price, and the primary CTA becomes **Request Quote for these
items** which prefills an RFQ. Otherwise **Proceed to Bulk Checkout** → `/checkout`.

- [ ] **Step 3: Build the business profile and dashboard**

Brief §19. Profile stores company name, contact person, mobile, email, GSTIN, business type,
billing and shipping addresses. Dashboard tiles: Total Orders, Total Spend, Active RFQs,
Previous Quotes.

- [ ] **Step 4: Verify the full B2B journey**

`/bulk-orders` → `/bulk/cashews` → set 25kg → Add to Bulk Cart → `/business/bulk-cart` →
confirm the 25–49kg rate applied and GST calculated → Proceed to Bulk Checkout.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add business area with bulk cart, profile, and dashboard"
```

---

# MILESTONE 5 — Auth and account

## Task 28: Mock auth provider

**Files:**
- Create: `frontend/src/features/auth/types.ts`
- Create: `frontend/src/features/auth/AuthProvider.tsx`
- Create: `frontend/src/mocks/users.ts`
- Create: `frontend/src/routes/login.tsx`
- Create: `frontend/src/routes/register.tsx`

Spec §2 — one account serves both retail and bulk. There is no separate B2B login.

- [ ] **Step 1: Seed three fixture users**

`b2c@demo.in`, `b2b@demo.in`, `admin@demo.in` — any password is accepted in Phase 1.
The B2B user carries a populated company profile.

- [ ] **Step 2: Build `AuthProvider`**

Exposes `user`, `role`, `login`, `register`, `logout`, `isAuthenticated`. Persists to
`localStorage` under `nn.auth.v1`. Registration includes an "I'm buying for a business"
checkbox that sets `role: "b2b"` and reveals company fields — this is how a single account
gains bulk access.

- [ ] **Step 3: Build login and register routes**

Centred card layout on a `bg-sand` background. zod validation. On success, redirect to the
`redirect` search param or `/account`. Include a visible demo-credentials hint listing the
three fixture accounts — this is a mock, and hiding that wastes reviewer time.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add mock auth with unified retail/bulk accounts"
```

---

## Task 29: Account area

**Files:**
- Create: `frontend/src/routes/account/route.tsx` (layout)
- Create: `frontend/src/routes/account/index.tsx`
- Create: `frontend/src/routes/account/orders/index.tsx` (list)
- Create: `frontend/src/routes/account/orders/$id.tsx` (detail)
- Create: `frontend/src/routes/account/addresses.tsx`
- Create: `frontend/src/routes/account/profile.tsx`
- Create: `frontend/src/mocks/orders.ts`
- **Delete the stubs created by earlier milestones:** `frontend/src/routes/account.index.tsx`,
  `frontend/src/routes/account.orders.tsx`, `frontend/src/routes/account.orders_.$id.tsx`

> **Added 2026-08-15 during execution.** Milestones 2 and 3 had to create flat placeholder
> routes so type-safe `to=` links would compile before this task existed — the order-success
> page links to `/account/orders/$id`. They use TanStack's `_` non-nesting suffix
> (`account.orders_.$id.tsx`) deliberately: a plain `account.orders.$id.tsx` would turn
> `account.orders.tsx` into a layout route, and without an `<Outlet />` that silently
> blackholes the child. Replace all three with the nested `account/` directory form, then
> confirm the order-success Track Order link still resolves.

> ### The layout trap — read this before creating ANY nested route
>
> This plan walked into the same bug three separate times (Tasks 21, 26, and 29). State it
> once, plainly:
>
> **In TanStack file-based routing, a file named `x.tsx` becomes the layout route for any
> sibling `x.$id.tsx` or `x.child.tsx`.** If `x.tsx` does not render an `<Outlet />`, every
> child renders blank — no error, no console warning, and the route still "resolves". Route
> tests that only assert a route loads will pass against a blank page.
>
> **Rule: whenever a path has children, use a directory.**
>
> ```
> WRONG                          RIGHT
> account/orders.tsx             account/orders/index.tsx
> account/orders.$id.tsx         account/orders/$id.tsx
> ```
>
> The `x_.tsx` underscore suffix opts a file *out* of nesting, and is the right tool only
> when you must add a child route beside an existing flat file you cannot yet replace — as
> Milestones 2 and 3 did for their stubs. It is a stopgap, not the destination.
>
> Any test covering a nested route must assert **content inside the child**, not merely that
> the route resolved.

- [ ] **Step 1: Seed orders**

6 orders spanning every brief §33 status: pending, confirmed, processing, packed, shipped,
out-for-delivery, delivered, cancelled, refunded. Two are B2B orders carrying the B2B
status set.

- [ ] **Step 2: Build the account layout and pages**

Sidebar: Overview, Orders, Addresses, Profile, and a **Switch to Business** entry when
`role === "b2b"`. Guards on `isAuthenticated`, redirecting to `/login?redirect={path}`.

Order detail shows a status timeline, items, totals, delivery address, and a Download
Invoice button that is disabled with the tooltip "Available after Phase 2" — better an
honest disabled control than a button that does nothing.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add account area with orders, addresses, and profile"
```

---

# MILESTONE 6 — Content, search, reviews, polish

## Task 30: Reviews

**Files:**
- Create: `frontend/src/features/reviews/api/index.ts`
- Create: `frontend/src/features/reviews/components/ReviewList.tsx`
- Create: `frontend/src/features/reviews/components/ReviewForm.tsx`
- Create: `frontend/src/mocks/reviews.ts`
- Modify: `frontend/src/routes/product.$slug.tsx`

- [ ] **Step 1: Seed and build**

Brief §27. Rating distribution bars, verified-purchase badges, reviewer name, date, body,
optional image thumbnails. The form takes a star rating, text, and an image URL. Submitted
reviews enter `status: "pending"` and display an "awaiting approval" note rather than
appearing immediately — admin moderation lands in Phase 3.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add product reviews with moderation-aware submission"
```

---

## Task 31: Combos and gifting

**Files:**
- Create: `frontend/src/routes/combos.tsx`
- Create: `frontend/src/routes/gifting.tsx`
- Create: `frontend/src/features/gifting/components/CorporateGiftingForm.tsx`

- [ ] **Step 1: Build the combos route**

Brief §23. The six named combos, each showing component products and clear savings — MRP of
the parts versus the combo price.

- [ ] **Step 2: Build the gifting route**

Brief §24. Five sections: Corporate Gifts, Festive Gifts, Wedding Gifts, Premium Gift Boxes,
Custom Gift Hampers. Corporate enquiry form fields: number of boxes, budget per box,
branding required, delivery date, custom message. Submits through the RFQ API with
`type: "gifting"`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add combos and gifting routes"
```

---

## Task 32: Blog

**Files:**
- Create: `frontend/src/features/content/api/index.ts`
- Create: `frontend/src/routes/blog.tsx`
- Create: `frontend/src/routes/blog.$slug.tsx`
- Create: `frontend/src/mocks/posts.ts`

- [ ] **Step 1: Seed 8 posts**

Across the brief §28 categories, including all four named titles: "How to Choose the Right
Almonds", "W320 vs W240 Cashews: What's the Difference?", "How to Store Dry Fruits at Home",
"How Businesses Can Buy Dry Fruits in Bulk". Body content as markdown strings; render with
a small formatter — no markdown library for 8 posts.

- [ ] **Step 2: Build the routes**

List with category filter chips. Detail with `Article` JSON-LD, reading time, and related
posts.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add blog with 8 seeded posts"
```

---

## Task 33: Static and legal pages

**Files:**
- Create: `frontend/src/routes/about.tsx`
- Create: `frontend/src/routes/quality.tsx`
- Create: `frontend/src/routes/contact.tsx`
- Create: `frontend/src/routes/faq.tsx`
- Create: `frontend/src/routes/shipping.tsx`
- Create: `frontend/src/routes/returns.tsx`
- Create: `frontend/src/routes/privacy.tsx`
- Create: `frontend/src/routes/terms.tsx`
- Create: `frontend/src/components/common/LegalPage.tsx`

- [ ] **Step 1: Port `quality.tsx`**

Port `LOVABLE REFERENCE /quality.tsx` as-is, then verify against brief §25: the
Source → Quality Check → Sorting → Packing → Dispatch → Delivery journey must be present,
and any certification claim must read from `settings.certifications` — rendering nothing
when empty.

- [ ] **Step 2: Build the remaining pages**

`about` — brand story, no invented history or founding dates.
`contact` — form plus contact details from settings; renders "Contact details coming soon"
when settings are empty rather than a blank block.
`faq` — accordion, 12 questions spanning ordering, shipping, bulk, and returns.
The four legal pages share a `LegalPage` component: title, last-updated date, and prose
sections. Content is placeholder policy text clearly marked
*"Draft — to be reviewed before launch"*, since real policies need legal review.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add static content and legal pages"
```

---

## Task 34: Instant search

**Files:**
- Create: `frontend/src/features/catalog/components/SearchDialog.tsx`
- Modify: `frontend/src/components/layout/SiteHeader.tsx`

- [ ] **Step 1: Build the dialog**

Brief §22. Uses the already-ported `command.tsx` primitive. Opens on click and on ⌘K / Ctrl-K.
Three result groups: Products (with thumbnail and price), Categories, and Popular searches
(a static list: almonds, premium kaju, 1kg badam, bulk cashew, makhana). 200ms debounce.
Empty state when nothing matches.

- [ ] **Step 2: Wire it into the header**

Replace the header's search `Link` with a button that opens the dialog, and point the mobile
tab bar's Search tab at it too.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add instant search dialog with keyboard shortcut"
```

---

## Task 35: Final verification

**Files:** none — this task only verifies.

- [ ] **Step 1: Automated checks**

```bash
cd /Users/kunal/Desktop/nutwala/frontend
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: all tests pass, zero TypeScript errors, zero lint errors, successful production
build.

- [ ] **Step 2: Confirm the mocks boundary held**

```bash
grep -rn "from \"@/mocks" src --include="*.tsx" --include="*.ts" \
  | grep -v "src/mocks/" | grep -v "/api/"
```
Expected: no output. Any result is a leak through the API seam and must be routed through a
feature `api/` module before this task can be checked off.

- [ ] **Step 3: Route sweep**

Run `npm run dev` and visit all 33 routes from spec §7 **in a browser**. For each: no console
errors, header and footer render, no horizontal scroll.

> **Corrected 2026-08-15 during execution.** Do **not** substitute `curl` for this.
> Vite's dev server falls back to `index.html` for every unmatched path, so a nonsense URL
> returns HTTP 200 exactly like a real route — verified. Curl proves the server is up and
> nothing else. Earlier milestones in this build reported "all routes 200" as evidence; it
> was not.
>
> For an automated equivalent, mount the real router at each path and assert its heading —
> the pattern already used in `src/test/routes.smoke.test.tsx`:
>
> ```tsx
> const history = createMemoryHistory({ initialEntries: [path] });
> render(<RouterProvider router={createRouter({ routeTree, history })} />);
> await screen.findByRole("heading", { level: 1 });
> ```

- [ ] **Step 4: Journey verification**

B2C: Home → Shop → filter → Product → add to cart → Cart → Checkout → Order success.
B2B: Home → Bulk Orders → Bulk catalog → 25kg → Bulk Cart → tier price correct → Checkout.
RFQ: Product (quote-only) → Request a Quote → submit → RFQ number generated → appears in list.
Auth: Register as a business → land on `/account` → `/business` accessible.

- [ ] **Step 5: Responsive and theme sweep**

Every page at 375px, 768px, 1440px. Then toggle `.dark` on `<html>` via devtools and
re-check every page — spec §11 requires both themes, and the tokens define both.

- [ ] **Step 6: Accessibility sweep**

Spec §9 requires this and nothing earlier verifies it.

- Tab through the home page, shop page, and checkout form without touching the mouse. Every
  interactive element must be reachable and show a visible focus ring.
- Confirm the cart drawer and search dialog trap focus while open and return focus to the
  trigger on close (the ported Radix primitives handle this — verify it survived).
- Check that every icon-only button has an `aria-label`:

```bash
grep -rn -A2 "size=\"icon\"" src --include="*.tsx"
```

- Confirm every `<img>` has a meaningful `alt`:

```bash
grep -rn -A3 "<img" src --include="*.tsx"
```

> **Corrected 2026-08-15 during execution.** Both originally piped to `grep -v "aria-label"`
> / `grep -v "alt="` and expected empty output. That is unreliable: grep is line-based but
> these are multi-line JSX elements, so an attribute on the *following* line reads as a
> violation. In Milestone 3 every hit from the bare form was a false positive.
>
> Use the context form above and **read each hit**. This audit produces a list to review,
> not a pass/fail signal.
>
> Also check the inverse, which no grep here catches: a `<button>` nested inside an `<a>`
> is invalid HTML and gives one action two focusable stops. Milestone 3 found three in
> `SiteHeader.tsx`. The fix is `Button asChild` so the anchor *is* the styled button:
> `<Button asChild><Link to="/x" aria-label="X"><Icon /></Link></Button>`.

- [ ] **Step 7: Claims audit**

```bash
grep -rniE "fssai|iso |certified|lab.tested|organic|100% pure" src --include="*.tsx" \
  | grep -v "config/settings" | grep -v "settings\."
```
Expected: no output. Any hardcoded claim violates spec §2 and must move into settings.

> Note the `settings.` exclusion and the **quoted** `--include` glob. Unquoted, zsh expands
> the glob and the grep errors out — which prints nothing and looks exactly like a pass. The
> `settings.` filter is needed because legitimate settings-driven renders (e.g. SiteFooter's
> `settings.fssaiLicence &&  \`FSSAI ${settings.fssaiLicence}\``) contain the keyword but are
> the correct pattern, not violations.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: Phase 1 frontend verification complete"
```

---

## Definition of done

Phase 1 is complete when every checkbox above is ticked and spec §11's nine criteria hold.
At that point the frontend runs entirely on mock data, every journey is clickable, and
Phase 2 begins by rewriting the bodies of five `api/` modules — `catalog`, `checkout`,
`rfq`, `reviews`, `content` — plus `AuthProvider`. No component should need to change.
