# Catalogue and Cart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend's mock catalogue and localStorage cart with a real API, so the shop renders live products from Postgres and **SOLD OUT** appears wherever stock has run out.

**Architecture:** Read-only catalogue endpoints assemble `Product`/`Variant` wire objects through a single set of mappers that convert paise to rupees at the boundary and derive `soldOut` from one shared helper. Lists gain the `Paginated<T>` envelope the spec requires, which forces a facets endpoint so the shop's filter sidebar stops depending on fetching the entire catalogue. The cart moves server-side with a guest cart keyed on a cookie, merged into the user's cart on sign-in, and `POST /cart/validate` re-checks stock and reprices every line so a stale basket shows its problem before checkout rather than at it.

**Tech Stack:** NestJS 11 + TypeORM 0.3.31 + Postgres 15 on the server; React 19 + TanStack Router/Query + Vite on the client; `@nutwala/shared` for the wire types and every money and availability derivation. Jest ×3 on the backend (unit / integration against testcontainers / e2e), Vitest on the frontend.

---

## Scope

This plan covers **Milestone 3 (Catalog read)** and **Milestone 4 (Cart & inventory)** from spec §16.

**Delivered when this plan is done:**

- Every catalogue surface reads Postgres: `/`, `/shop`, `/category/$slug`, `/product/$slug`, `/combos`, `/bulk-orders`, `/bulk/$category`, `/gifting`, and the search dialog.
- **SOLD OUT renders**, per variant and per product, and Add to Cart is disabled for a sold-out variant. The `inStockOnly` shop filter starts filtering real data instead of doing nothing.
- Public reviews come from the database, and a submitted review lands as `PENDING` for later moderation.
- The cart lives on the server. A guest builds a basket, signs in, and finds it merged rather than lost.
- `POST /cart/validate` reports per-line `availableQty` and live prices.
- Admin stock adjustment writes a ledger row, so `SUM(delta) == onHand` still holds after an adjustment.
- **The wishlist heart actually saves something**, survives navigation and sign-in, and shows SOLD OUT
  on a saved product that has since run out.

**Deliberately left for the next plan (Milestones 5–6):** COD checkout, order placement with the race-safe decrement, coupons, pincode serviceability, order history, tracking timeline, cancellation, and the address book. Nothing in this plan writes an `Order`.

**Left for later plans:** B2B pricing-tier resolution by segment (Milestone 7), blog/support/settings endpoints (8), the admin panel (9), Playwright journeys (10).

---

## Binding constraints

These are not style preferences. Each one was learned the expensive way during Plan 1, and every one of them cost a wasted implementation cycle or shipped a defect that a green test suite failed to catch.

### 1. Money crosses the boundary as rupees, and only at the boundary

Every money column in Postgres is `bigint` paise. **Every money field the frontend consumes is a rupee `number`** — `Variant.price`, `Variant.mrp`, `BulkTier.pricePerKg`, `CartTotals.*`, and the rest. `frontend/src/lib/format.ts`'s `inr()` does `Math.round(n)`, so a paise integer that reaches it renders as a figure a hundred times too large, silently and on every price on the page.

Convert with `toRupees` from `@nutwala/shared`, in the mapper, once. Never in a controller, never in a service that also does arithmetic, and never twice. Task 4 adds a test that fails if any mapper emits a value that looks like paise.

### 2. `soldOut` has exactly one derivation

Spec §10.1 is explicit and the reason is worth restating: TypeScript enforces that `soldOut` is *present*, not that its value agrees with `available`. A second assembly site that reimplements the rule compiles cleanly and ships a listing that says "in stock" next to a product page that says "sold out".

So one exported helper, in `shared/`, called by every mapper and by the mock. **No inline `available === 0` anywhere.** Task 2 adds an eslint rule that makes a second inline derivation a lint failure, because a comment asking people not to do it is not a control.

### 3. Assertions on a `DomainError` never use `toThrow(/CODE/)`

`DomainError extends HttpException`, whose `initMessage()` copies only `response.message` into `Error.message`; `code` stays a separate own property. Jest's `toThrow(regex)` tests `message` alone, so a regex for an error code **can never match**. This was written into three tasks of Plan 1 before anyone ran them.

Verified forms:

| Form | Jest | `tsc` | `eslint` |
| --- | --- | --- | --- |
| `toThrow(/CODE/)` | **fails** | ✓ | ✓ |
| `await expect(p).rejects.toMatchObject({ code: ErrorCodes.X })` | ✓ | ✓ | ✓ |
| `toThrow(expect.objectContaining({ code }))` | ✓ | ✓ | **fails** — `objectContaining` returns `any`, and `toThrow` declares a real parameter type, so `no-unsafe-argument` rejects it |
| catch-and-read helper (`rejectionFrom`, in `csrf.guard.spec.ts`) | ✓ | ✓ | ✓ |

Async rejections use `.rejects.toMatchObject({ code })`. Synchronous throws use the catch-and-read helper, which must throw its own error when the call was *allowed* — a bare `try`/`catch` passes silently when a guard wrongly lets a request through, which is the one failure a guard suite exists to catch. `expect.objectContaining` is fine inside `toHaveBeenCalledWith`, which is typed `...params: any[]`; only `toThrow` trips the rule.

`ErrorCodes` lives in `backend/src/common/errors/domain-error.ts`, not a separate file. Use `ErrorCodes.X`, never a bare string literal.

### 4. Integration tests use the existing harness and nothing else

`backend/test/integration/helpers/` already owns the lifecycle:

- `useIntegrationApp(metadata?)` — connects the DataSource, boots the app, cleans the database after **every** test, closes both. Call it once inside a `describe`.
- **Never import `startTestDatabase`.** It is deliberately not exported to specs: the container starts once in `globalSetup`, and a spec that starts its own replays the entire migration chain.
- `request(app)` for a single call; **`agent(app)`** when a flow spans requests, because it persists cookies.
- `expectSuccess<T>(response)` / `expectError(response)` cross the untyped supertest boundary. Reaching into `response.body` raises `no-unsafe-member-access` on every assertion.
- `response.get('Set-Cookie')` — **not** `response.headers['set-cookie']`, which is typed `string` under `noUncheckedIndexedAccess` and fails TS2352.

### 5. A test that cannot fail is worse than a missing test

Plan 1 shipped five tests that would have stayed green against a broken implementation. Every one tested a *proxy* for the property rather than the property:

- The `revoke` test passed against a `revoke` with no `WHERE` filter at all, because the hand-written repository fake ignored the `id` criterion.
- Nothing asserted the 401 status, so changing four throw sites to 422 left ten tests green.
- A CSRF stub answered `true` to *any* metadata key, so the guard could read the wrong key and still pass.
- The logout test called `/logout` then `/me` on the same agent — but logout clears the cookie jar, so the follow-up 401'd for the wrong reason and passed against a logout that never touched the database.
- The timing bound tolerated a 4× difference in either direction.

**So: prove your important tests are load-bearing.** Break the behaviour, watch the specific test fail, restore byte-identically, confirm with `diff`. Do the apply-run-revert in a single command so the tree is never left dirty. Quote the failure in your report.

### 6. `eslint.config.mjs` is not covered by `format:check`

`npm run format:check` globs only `src/**/*.ts` and `test/**/*.ts`, so a prettier-dirty config file
passes CI. If you edit a config file, run `npx prettier --write` on it yourself.

Related, and accepted rather than fixed: the existing `paise.transformer.ts` override sets
`'no-restricted-syntax': 'off'`, which now disables the availability selectors in that file too. A money
transformer has no business deriving availability, and re-listing the selectors there would duplicate
them.

### 7. Process rules

- **Never stop, remove or restart a process or container this session did not start.** `nutwala-postgres` (5442) and `nutwala-postgres-test` (5443) are the user's. `docker ps` is fine. If a port is taken, change what you use or report it.
- **`git commit` with explicit paths.** Never `git add -A`, never `git add .`, never a pathspec-less commit.
- **Commit messages via a quoted heredoc** (`git commit -F - <<'MSG' … MSG`). A backtick inside `-m "..."` gets executed by zsh and has silently deleted words from a message in this repo.
- Scratch files go in the session scratchpad, never inside `backend/` or `frontend/`, where a stray `.ts` breaks `eslint .` for everyone.
- **Anchor every command to the repo root with an absolute path.** Working-directory drift has cost time repeatedly.
- `DB_PORT=… npm run …` **silently targets the wrong database.** `load-env.ts` applies dotenv with `override: true`, so `.env` beats the shell. Add `NODE_ENV=test` to make dotenv a no-op against the deliberately absent `.env.test`.

---

## The three breaking changes this plan makes, and why

Each is unavoidable, so each is planned rather than discovered.

### A. Lists gain a `Paginated<T>` envelope

Spec §6 requires `{ items, total, page, limit }` in `data` for every list. Today every seam returns a bare array — `Promise<Product[]>`, `Promise<Review[]>` — and roughly fifteen call sites treat the result as an array, including `ShopPage.tsx:171` rendering `{products?.length ?? 0} products`.

`Paginated<T>` and `PageQuery` already exist in `shared/src/types/api.ts` with **zero** usages anywhere. This plan adopts them and updates every consumer. `ProductFilters` gains `page` and `limit`.

`PageQuery` is exactly `{ page?: number; limit?: number }` — verified, so there is nothing unwanted to inherit. `Paginated<T>` carries no `totalPages` or `hasNext`, so a client computes `Math.ceil(total / limit)` itself; if a second call site ends up deriving that, it belongs in a shared helper for the same reason `soldOut` does.

### B. The shop's filter facets move to their own endpoint

`ShopPage.tsx:54` and `bulk.$category.tsx:80` each fire a **second, unfiltered** `useProducts()` purely to compute the sidebar's origin list, grade list and price range from the whole catalogue. Once lists paginate, that call returns page 1 and the facets quietly describe twenty products instead of twenty-seven.

So `GET /catalog/products/facets` returns the origins, grades, price bounds and per-category counts computed over the whole published catalogue in SQL. This removes a full-catalogue fetch from two pages and makes the numbers correct rather than accidentally correct.

### C. The cart context becomes asynchronous

`CartProvider`'s mutators are synchronous and return `void`, writing straight to `localStorage` under `nn.cart.v1`. A server cart cannot be synchronous. Every mutator becomes `Promise<void>`, and the provider keeps an optimistic local copy so the UI stays instant while the server call is in flight.

The guest cart is the subtle part. A visitor with no session gets a `guestToken` in a cookie, and their cart rows hang off that key. On sign-in, `POST /cart/merge` folds the guest cart into the user's cart and deletes the guest one. Without this, every guest who signs in at checkout loses their basket — which is the single most expensive bug this plan can avoid.

---

## File structure

### `shared/` — the wire contract both sides compile against

| File | Responsibility |
| --- | --- |
| `shared/src/catalog/availability.ts` | **New.** The single `soldOut` derivation: `variantSoldOut`, `productSoldOut`. Imported by every backend mapper, by the mock, and by the frontend where it renders. |
| `shared/src/catalog/availability.test.ts` | **New.** Behaviour of the derivation, including the boundary cases (`available` negative, no active variants). |
| `shared/src/types/catalog.ts` | **Modify.** `ProductFilters` gains `page`, `limit`, `channel`. `Variant` gains nothing — `available` and `soldOut` already exist and are already required. |
| `shared/src/types/cart.ts` | **New.** `CartLine`, `CartTotals`, `CartValidationLine`, `CartValidationResult` — moved out of the frontend so the server can produce them. |
| `shared/src/types/review.ts` | **New.** `Review`, `ReviewSummary`, `RatingBucket`, `ReviewDraft`, `ReviewStatus` — moved out of `frontend/src/features/reviews/types.ts` for the same reason. |
| `shared/src/index.ts` | **Modify.** Re-export the three new modules. |

### `backend/` — read models, cart, and inventory

| File | Responsibility |
| --- | --- |
| `backend/src/modules/catalog/catalog.module.ts` | Wires the catalogue read stack. |
| `backend/src/modules/catalog/catalog.controller.ts` | The nine public `GET`s plus the facets endpoint. `@Public()` on every route. |
| `backend/src/modules/catalog/catalog.service.ts` | Query building: filters, sort, pagination. No mapping. |
| `backend/src/modules/catalog/catalog.facets.service.ts` | The single aggregate query behind `/catalog/products/facets`. |
| `backend/src/modules/catalog/combos.service.ts` | Combo assembly — the one place a combo's component list and savings are computed. |
| `backend/src/modules/catalog/mappers/product.mapper.ts` | Entity → wire `Product`. The only place paise becomes rupees for a product. |
| `backend/src/modules/catalog/mappers/variant.mapper.ts` | Entity + `Inventory` → wire `Variant`, calling the shared availability helper. |
| `backend/src/modules/catalog/mappers/category.mapper.ts` | Entity → wire `Category`. |
| `backend/src/modules/catalog/dto/product-query.dto.ts` | class-validator DTO for the listing query, mirroring `ProductFilters`. |
| `backend/src/modules/reviews/reviews.module.ts` | Public review reads plus authenticated creation. |
| `backend/src/modules/reviews/reviews.controller.ts` | `GET …/reviews`, `GET …/reviews/summary`, `POST …/reviews`. |
| `backend/src/modules/reviews/reviews.service.ts` | Approved-only reads, summary aggregation, `PENDING` creation, aggregate recompute. |
| `backend/src/modules/reviews/dto/create-review.dto.ts` | class-validator DTO. |
| `backend/src/modules/cart/cart.module.ts` | Wires the cart stack. |
| `backend/src/modules/cart/cart.controller.ts` | `GET /cart`, `PUT /cart`, `POST /cart/merge`, `POST /cart/validate`. |
| `backend/src/modules/cart/cart.service.ts` | Cart resolution (user or guest), replacement, merge. |
| `backend/src/modules/cart/cart-pricing.service.ts` | Live repricing and totals — the server-side counterpart of `cart-math.ts`. |
| `backend/src/modules/cart/guest-token.ts` | Issues and reads the guest cart cookie. Named `guest_token`, not `guest_key`, so the log redactor scrubs it — see Task 16. |
| `backend/src/modules/cart/cart.constants.ts` | `MAX_LINE_QTY`. Its own module because `cart.service.ts` and `dto/replace-cart.dto.ts` both need it and already import each other. |
| `backend/src/modules/cart/dto/*.dto.ts` | `ReplaceCartDto`, `MergeCartDto`, `ValidateCartDto`. |
| `backend/src/common/http/cookie-options.ts` | **New.** `baseCookieOptions` — the attributes every cookie shares. Three callers: `CookieService.base()`, `issueGuestToken`, `csrfBootstrap`. |
| `backend/src/common/auth/csrf-bootstrap.middleware.ts` | **New.** Issues `nn_csrf` to anonymous visitors, without which every guest write 403s. Never rotates an existing token. |
| `backend/src/modules/inventory/inventory.module.ts` | Stock reads and the admin adjustment. |
| `backend/src/modules/inventory/inventory.service.ts` | `availabilityFor`, and `adjust` writing a ledger row in one transaction. |

### `frontend/` — seams swapped, contracts unchanged where possible

| File | Responsibility |
| --- | --- |
| `frontend/src/lib/query-string.ts` | **New.** One `toQueryString(params)` helper. `http.ts` has no query-string support and paths are opaque strings, so without this every list call hand-rolls one. |
| `frontend/src/features/catalog/api/index.ts` | **Rewrite.** Same `catalogApi` surface, now over `http`. Returns `Paginated<Product>` for lists. |
| `frontend/src/features/catalog/hooks/useCatalog.ts` | **Modify.** Adds `useProductFacets`; list hooks return the envelope. |
| `frontend/src/features/catalog/components/ShopPage.tsx` | **Modify.** Reads `data.items`/`data.total`; facets come from the new hook, and the second full-catalogue fetch goes. |
| `frontend/src/features/catalog/components/ProductCard.tsx` | **Modify.** Renders SOLD OUT and disables Add to Cart per variant. |
| `frontend/src/features/catalog/selection.ts` | **New.** `openingRetailSize` — which pack a product opens on. Shared by the card and the detail page so the two cannot disagree; prefers 250g when stocked, because "first available" opens the shop on 100g. |
| `frontend/src/features/bulk/components/BulkProductCard.tsx` | **Modify.** Product-level SOLD OUT badge and a disabled Add to Bulk Cart. It has no size buttons — it prices by the kilo off `bulkTiers` — so it takes no per-variant changes. |
| `frontend/src/features/wishlist/WishlistProvider.tsx` | **New.** Replaces `ProductCard`'s `useState(false)` heart, which forgot on every navigation. |
| `frontend/src/features/reviews/api/index.ts` | **Rewrite** over `http`. |
| `frontend/src/features/reviews/types.ts` | **Modify** to a re-export shim over `@nutwala/shared`, matching how catalog and account types already work. |
| `frontend/src/features/cart/CartProvider.tsx` | **Rewrite.** Server-backed, optimistic, async mutators. |
| `frontend/src/features/cart/api/index.ts` | **New.** `cartApi` over `http`. |
| `frontend/src/features/cart/cart-math.ts` | **Keep**, and keep its tests. Still used for the optimistic local total between a mutation and the server's reply. |

---

## Task list

Twenty-nine tasks. Milestone 3 is Tasks 1–15; Milestone 4 is Tasks 16–25; Milestone 4b, the wishlist, is Tasks 26–29.

</content>
# MILESTONE 3 — Catalogue read

Goal: every catalogue surface reads Postgres, and SOLD OUT is live.

Read spec §6.1, §10.1 and §14 before starting. §10.1's "one derivation, reused everywhere" is the
constraint that shapes Tasks 1, 2 and 4.

## Task 1: The single `soldOut` derivation (TDD)

Spec §10.1. This is first because every mapper depends on it, and because writing it once is the
whole point — a second inline `available === 0` is how a listing and a product page come to disagree.

**Files:**
- Create: `shared/src/catalog/availability.ts`
- Test: `shared/src/catalog/availability.test.ts`
- Modify: `shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// shared/src/catalog/availability.test.ts
import { describe, expect, it } from 'vitest';
import { productSoldOut, variantSoldOut } from './availability';

/** The minimum a variant needs for an availability decision. */
const v = (available: number, isActive = true): { available: number; isActive: boolean } => ({
  available,
  isActive,
});

describe('variantSoldOut', () => {
  it('is sold out at zero and in stock above it', () => {
    expect(variantSoldOut(0)).toBe(true);
    expect(variantSoldOut(1)).toBe(false);
    expect(variantSoldOut(120)).toBe(false);
  });

  /**
   * `<= 0`, not `=== 0`.
   *
   * Note that `ck_inventory_non_negative` **does** enforce `onHand >= reserved`, so `available`
   * computed from a real `inventory` row cannot be negative — an earlier version of this plan claimed
   * the opposite and was wrong. The reason to accept negatives anyway is that this function's input is
   * a plain `number`, not "a value that satisfied that constraint": it can arrive from a raw aggregate,
   * a fixture, the frontend mock, or arithmetic across two queries. Availability must fail closed — a
   * false "sold out" costs a sale, a false "in stock" oversells and breaks the promise at checkout.
   *
   * Residual, and out of scope here: `NaN <= 0` and `NaN === 0` are both `false`, so a `NaN` reads as
   * in stock under either rule.
   */
  it('treats a negative figure as sold out', () => {
    expect(variantSoldOut(-1)).toBe(true);
    expect(variantSoldOut(-100)).toBe(true);
  });
});

describe('productSoldOut', () => {
  it('is sold out only when every active variant is', () => {
    expect(productSoldOut([v(0), v(0)])).toBe(true);
    expect(productSoldOut([v(0), v(5)])).toBe(false);
    expect(productSoldOut([v(5), v(5)])).toBe(false);
  });

  /**
   * Spec §10.1 says "every *active* variant". An inactive variant is not for sale, so it must not
   * vote. Counting it would let a discontinued 50kg pack keep a product looking in stock forever.
   */
  it('ignores inactive variants', () => {
    expect(productSoldOut([v(0), v(99, false)])).toBe(true);
    expect(productSoldOut([v(3), v(0, false)])).toBe(false);
  });

  /**
   * A product with no sellable variant at all cannot be bought, so it is sold out. Returning
   * `false` here — which `[].every(...)` does, since every() is vacuously true and would give
   * `true`... — is the trap: `[].every()` returns `true`, so the naive implementation accidentally
   * gets this right for the wrong reason. Pinned so a later refactor to `.some()` cannot silently
   * invert it.
   */
  it('treats a product with no active variants as sold out', () => {
    expect(productSoldOut([])).toBe(true);
    expect(productSoldOut([v(120, false)])).toBe(true);
  });

  /**
   * Separates delegation from a re-implemented `available === 0` inside `productSoldOut` — which is
   * exactly the duplication this module exists to prevent, and which a test using only 0 and positive
   * figures cannot detect.
   */
  it('delegates the per-variant rule instead of re-testing available === 0', () => {
    expect(productSoldOut([v(-2)])).toBe(true);
    expect(productSoldOut([v(-2), v(0)])).toBe(true);
    expect(productSoldOut([v(-2), v(7)])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @nutwala/shared -- availability`
Expected: FAIL — `Failed to resolve import "./availability"`.

- [ ] **Step 3: Implement the derivation**

```ts
// shared/src/catalog/availability.ts

/**
 * The single source of truth for whether something is sold out. Spec §10.1.
 *
 * Every place that assembles a wire `Variant` or `Product` — the listing endpoint, the detail
 * endpoint, the bulk catalogue, the admin list, the frontend mock — calls these two functions and
 * never reimplements the rule inline.
 *
 * The reason is that TypeScript enforces `soldOut` being *present*, not that its value agrees with
 * `available`. A second assembly site with a slightly different rule compiles cleanly and ships a
 * listing saying "in stock" beside a product page saying "sold out". `eslint.config.mjs` carries a
 * `no-restricted-syntax` rule that turns a second inline derivation into a lint failure, because a
 * comment asking people not to do it is not a control.
 */

/** A variant is sold out when nothing is available to sell. */
export function variantSoldOut(available: number): boolean {
  return available <= 0;
}

/**
 * The shape `productSoldOut` needs. Structural rather than tied to a named type, because **nothing in
 * the system carries both fields**: the `ProductVariant` entity has `isActive` but no `available`
 * (stock lives on `Inventory`), and the wire `Variant` has `available` but no `isActive`. Callers pair
 * the two, which is what Task 4's variant mapper does.
 */
export interface AvailabilityInput {
  available: number;
  isActive: boolean;
}

/**
 * A product is sold out when every *active* variant is sold out.
 *
 * A product with no active variants is sold out: there is nothing to buy. `Array.every` returns
 * `true` for an empty array, so this falls out naturally — but it is asserted in the spec file
 * rather than left to that coincidence.
 */
export function productSoldOut(variants: readonly AvailabilityInput[]): boolean {
  return variants.filter((variant) => variant.isActive).every((variant) => variantSoldOut(variant.available));
}
```

- [ ] **Step 4: Re-export it**

Add to `shared/src/index.ts`. The existing list is grouped by directory and is **not** alphabetical
within a group (`identifiers` precedes `geography`), so place this after `./money` and before the
`constants/` group to keep the directory groups in order:

```ts
export * from './catalog/availability';
```

- [ ] **Step 5: Run the test and the whole shared suite**

Run: `npm run test -w @nutwala/shared`
Expected: PASS — 55 existing tests plus 6 new, 61 total across 4 files.

- [ ] **Step 6: Commit**

```bash
git add shared/src/catalog/availability.ts shared/src/catalog/availability.test.ts shared/src/index.ts
git commit -F - <<'MSG'
feat(shared): add the single soldOut derivation every mapper must use
MSG
```

## Task 2: Make a second inline derivation a lint failure

Spec §10.1 asks for one derivation. Task 1 provides it; this task is what stops the next person
writing `available === 0` inline in a new mapper and shipping a flag that disagrees with the one
beside it. The repo already uses this technique — `eslint.config.mjs` carries a `no-restricted-syntax`
rule rejecting a bare `@Column({ type: 'bigint' })` so that money columns cannot skip the paise
transformer. This is the same shape of control for the same reason.

**Files:**
- Modify: `backend/eslint.config.mjs`
- Test: no spec file; the control is verified by running eslint against a deliberate violation.

- [ ] **Step 1: Read the existing rule to match its style**

Run: `grep -n "no-restricted-syntax" -A 20 backend/eslint.config.mjs`
Expected: the existing bigint-column rule, with a `selector` and a `message`.

- [x] **Step 2: Add the availability rule beside it** — **DONE in `52bb933`; the committed
`backend/eslint.config.mjs` is authoritative.** Read it there rather than from this plan, which had the
selector wrong in three ways. Recorded here because the reasoning outlives the syntax:

**The selector must anchor the non-`available` operand to a literal 0 or 1.** An earlier version fired on
`available` compared to *anything*, so it flagged `inv.available >= qty` and `line.qty > avail.available`
— stock-**sufficiency** checks that Tasks 21 and 22 both need. The rule would have been suppressed on
first contact and then deleted, which is how a control dies. Comparing `available` to zero asks *"is this
sold out?"*, which has one right answer; comparing it to a quantity asks *"can this order be filled?"*,
which is a different question. The literal is what tells them apart, and it correctly leaves
`available < lowStockThreshold` alone too.

**Optional chaining hides the member expression.** `variant.inventory?.available === 0` parses as a
`ChainExpression`, so `left.property.name` is `undefined` and the original selector missed it silently.
Given that `variant.inventory` is nullable, that is the *likeliest* spelling a mapper would use — the
rule would have looked like it worked while missing the real case. `left.expression.property.name`
catches it.

**The bare-local gap was closed, not accepted.** `const available = onHand - reserved; if (available <= 0)`
is the natural shape of `availabilityFor`, so the gap sat directly in front of the next author. With the
literal anchor doing the discrimination, `[left.name='available']` costs no false positives.

**A second selector catches `!available`**, because that is not merely duplicate logic but *wrong* logic:
`!(-1)` is `false`, so it reads negative stock as in stock — precisely the fail-open that
`variantSoldOut`'s `<= 0` exists to prevent.

Two residual gaps are documented in the config rather than chased: computed access
`variant['available'] === 0`, and arithmetic on the compared side (`inv.onHand - inv.reserved > 0`).
Catching the latter would mean flagging every `> 0` in the file.

**Do not split the rule into a second `no-restricted-syntax` entry.** Verified rather than assumed: with
two config objects each setting it, only the later one's selectors fire and the earlier ones vanish
silently — which would disable the bigint guard. One entry, several objects in its array.

- [x] **Step 3: Prove the rule fires** — done, and worth knowing *how*, because the obvious check is a
weak signal. A passing lint proves almost nothing here: `grep -rn "available"` across
`backend/src` and `backend/test` returns **7 hits, every one a comment or a string literal**. The backend
has no availability code yet, so this rule is a tripwire for code Tasks 4, 21 and 22 have not written.

It was therefore verified against a 21-case fixture matrix simulating that code: **11/11 must-flag
caught, 0/10 must-not-flag flagged.** The ten deliberately protected cases include
`variantSoldOut(v.available)` — Task 4's own mapper call, which the rule must never flag — plus
`inv.available >= qty`, `available < requestedQty`, `inv.available < inv.lowStockThreshold` and
`{ available: inv.onHand - inv.reserved }`.

The original probe, for reference:

Write a deliberate violation to the scratchpad, copy it in, lint it, and delete it — one command, so
the tree is never left dirty:

```bash
cd /Users/kunal/Desktop/nutwala/backend
cat > src/modules/nn-lint-probe.ts <<'TS'
export function bad(variant: { available: number }): boolean {
  return variant.available === 0;
}
TS
npx eslint src/modules/nn-lint-probe.ts; echo "exit=$?"
rm -f src/modules/nn-lint-probe.ts
```

Expected: exit 1, with the message from Step 2. If it exits 0 the selector is wrong — fix the
selector, not the test.

- [ ] **Step 4: Prove the rule does not fire on the helper itself**

`availability.ts` lives in `shared/`, which the backend's eslint config does not cover, so no
exemption is needed. Confirm the backend still lints clean:

Run: `npm run lint -w backend` from the repo root. **Not `npx eslint .`** — see the note at the end
of this task.
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/eslint.config.mjs
git commit -F - <<'MSG'
build(backend): make a second inline soldOut derivation a lint failure
MSG
```

## Task 3: Extend the shared wire contract

Three changes, all in `shared/`, all consumed by both sides. Doing them together keeps the contract
in one commit rather than letting the backend and frontend disagree for several tasks.

**Files:**
- Modify: `shared/src/types/catalog.ts`
- Create: `shared/src/types/cart.ts`
- Create: `shared/src/types/review.ts`
- Modify: `shared/src/index.ts`

- [ ] **Step 1: Add pagination and channel to `ProductFilters`**

In `shared/src/types/catalog.ts`, replace the `ProductFilters` interface with:

```ts
/**
 * The shop's filter set. Phase 1's fields verbatim, plus the three the server needs.
 *
 * `page` and `limit` arrive because spec §6 paginates every list. They are optional so an existing
 * call site that omits them keeps working against the server's defaults.
 *
 * `channel` exists because `/bulk/$category` reuses this type and the same `ShopFilters` component,
 * and previously had to filter bulk products client-side after fetching everything. `inStockOnly`
 * was also not channel-aware, so a product whose retail packs were all at zero but whose 50kg pack
 * had stock still appeared on `/shop` as "in stock".
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
  sort?: ProductSort;
}

/**
 * The filter sidebar's option lists and bounds, computed over the whole published catalogue.
 *
 * Served by its own endpoint rather than derived from a product list, because once lists paginate a
 * list-derived facet set describes one page. `ShopPage` previously fired a second unfiltered
 * `useProducts()` for exactly this and would have started lying silently.
 */
export interface CatalogFacets {
  origins: string[];
  grades: string[];
  minPrice: number;
  maxPrice: number;
  categories: { slug: string; name: string; productCount: number }[];
}
```

`PageQuery` is already exported from `shared/src/types/api.ts`. Add the import at the top of
`catalog.ts`:

```ts
import type { PageQuery } from './api';
```

- [ ] **Step 2: Move the cart types into shared**

```ts
// shared/src/types/cart.ts
import type { Channel } from './catalog';

/**
 * One basket line. Moved out of `frontend/src/features/cart/types.ts` because the server now owns
 * the cart and has to produce this shape.
 *
 * Deliberately carries **no price, name or image**. Prices are resolved live on every read, so a
 * basket built before a price change bills the new price — which is what the customer sees on the
 * product page at the moment they check out. A cached price on the line is how a cart comes to
 * disagree with the catalogue.
 */
export interface CartLine {
  id: string;
  slug: string;
  mode: Channel;
  /** Retail only. */
  size?: string;
  /** Retail only. */
  grams?: number;
  /** Bulk only. */
  kg?: number;
  qty: number;
}

/** Money totals for a basket, in rupees, matching the frontend's existing contract. */
export interface CartTotals {
  subtotal: number;
  gst: number;
  shipping: number;
  total: number;
  /** True when any line resolves to a quote-required bulk tier, which blocks checkout. */
  hasQuoteLines: boolean;
}

/** One line's verdict from `POST /cart/validate`. */
export interface CartValidationLine {
  id: string;
  slug: string;
  /** Present when the product or variant no longer exists, so the line cannot be priced. */
  unavailable: boolean;
  /** `onHand - reserved` for the resolved variant. Null for a bulk line, which is not variant-bound. */
  availableQty: number | null;
  /** The quantity requested by the line, echoed so a caller need not re-read the cart. */
  requestedQty: number;
  /** The live line total in rupees, or null when the line needs a quote. */
  lineTotal: number | null;
  /** Machine-readable reason, when there is a problem. */
  code?: 'OUT_OF_STOCK' | 'BELOW_MOQ' | 'QUOTE_REQUIRED' | 'NOT_FOUND';
}

/** The whole verdict. `ok` is true only when no line has a `code`. */
export interface CartValidationResult {
  ok: boolean;
  lines: CartValidationLine[];
  totals: CartTotals;
}
```

- [ ] **Step 3: Move the review types into shared**

```ts
// shared/src/types/review.ts

export type ReviewStatus = 'approved' | 'pending' | 'rejected';

/**
 * A customer review. Moved out of `frontend/src/features/reviews/types.ts` because the server now
 * produces it. The wire form keeps the frontend's lowercase status values rather than the database
 * enum's uppercase ones — the mapper translates, exactly as `user.mapper.ts` does for roles.
 */
export interface Review {
  id: string;
  productSlug: string;
  author: string;
  /** Whole stars, 1–5. */
  rating: number;
  body: string;
  imageUrl?: string;
  verifiedPurchase: boolean;
  status: ReviewStatus;
  /** ISO 8601. */
  createdAt: string;
}

/** What a visitor submits. `productSlug` comes from the route, not the form. */
export interface ReviewDraft {
  productSlug: string;
  author: string;
  rating: number;
  body: string;
  imageUrl?: string;
}

export interface RatingBucket {
  stars: number;
  count: number;
  percent: number;
}

export interface ReviewSummary {
  average: number;
  total: number;
  verifiedCount: number;
  /** Five buckets, five stars down to one, always present even at zero count. */
  distribution: RatingBucket[];
}
```

- [ ] **Step 4: Re-export both**

Add to `shared/src/index.ts`:

```ts
export * from './types/cart';
export * from './types/review';
```

- [ ] **Step 5: Build shared and confirm both workspaces still typecheck**

The frontend's `features/cart/types.ts` and `features/reviews/types.ts` still declare their own
copies at this point, so a duplicate-identifier error here is expected only if a file imports both.
Confirm the state you are in rather than assuming:

```bash
cd /Users/kunal/Desktop/nutwala
npm run build -w @nutwala/shared
npm run test -w @nutwala/shared
npm run typecheck -w backend
npm run typecheck -w frontend
```

Expected: shared builds, 61 tests pass, both typechecks clean.

The frontend's local duplicates coexist harmlessly until they become re-export shims — the **reviews**
one in **Task 11 Step 4**, the **cart** one in **Task 24 Step 1**. (An earlier version of this line said
Task 12, which touches no type files.) There is no duplicate-identifier error in between, because
nothing imports the shared cart or review types yet and TypeScript only conflicts on `export *`
collisions inside a barrel — which was checked and is clean.

- [ ] **Step 6: Commit**

```bash
git add shared/src/types/catalog.ts shared/src/types/cart.ts shared/src/types/review.ts shared/src/index.ts
git commit -F - <<'MSG'
feat(shared): paginate ProductFilters, and move cart and review types into the contract
MSG
```

## Task 4: The catalogue mappers (TDD)

The single boundary where a database row becomes a wire object. Everything the two constraints at the
top of this plan protect happens here: paise become rupees exactly once, and `soldOut` comes from the
shared helper rather than an inline comparison.

Three entity details that the mappers must handle and that the compiler will not let you ignore:

- `gstRate`, `moqKg` and `ratingAvg` are Postgres `numeric` columns, which **TypeORM returns as
  `string`**. The wire type declares `number`. Convert with `Number(...)`.
- `pricePaise` and `mrpPaise` are `bigint` through `@PaiseColumn()`. Convert with `toRupees`.
- `Inventory` is a separate row and `variant.inventory` is `Inventory | null`. A variant with no
  inventory row has nothing to sell, so it maps to `available: 0` — not to a crash, and not to
  "unlimited".

**Files:**
- Create: `backend/src/modules/catalog/mappers/variant.mapper.ts`
- Create: `backend/src/modules/catalog/mappers/product.mapper.ts`
- Create: `backend/src/modules/catalog/mappers/category.mapper.ts`
- Test: `backend/src/modules/catalog/mappers/product.mapper.spec.ts`

`category.mapper.ts` ships with **no unit test**, deliberately: it is a five-field pass-through with no
derivation, and Task 9 covers it end to end (`returns the twelve seeded categories in display order`).
Recorded rather than hidden, so nobody assumes it was forgotten.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/catalog/mappers/product.mapper.spec.ts
import { VariantChannel } from '../../../entities/enums';
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
    // `...overrides` is not optional. An earlier version of this plan omitted it, so every override in
    // the suite below was silently discarded and four tests could not fail: `channel: BULK` asserted
    // 'bulk' against a RETAIL fixture, `inventory: null` against a 120-unit shelf, and
    // `isActive: false` against an active variant. Exactly the defect class constraint 5 describes,
    // inside the task that enforces it.
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
    expect(
      toWireVariant(variantFixture({ channel: VariantChannel.BULK })).channel,
    ).toBe('bulk');
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
    const wire = toWireProduct(productFixture());
    // `gstRate: '5.00'` would sail through as a string without this conversion, and the frontend's
    // cart maths multiplies by it.
    expect(wire.gstRate).toBe(5);
    expect(typeof wire.gstRate).toBe('number');
    expect(wire.moqKg).toBe(10);
    expect(wire.rating).toBe(4.8);
    expect(typeof wire.rating).toBe('number');
  });

  it('exposes the category as its slug, matching the Phase 1 contract', () => {
    expect(toWireProduct(productFixture()).category).toBe('almonds');
  });

  it('omits the badge entirely when there is none, rather than sending null', () => {
    const wire = toWireProduct(productFixture({ badge: null }));
    expect('badge' in wire).toBe(false);
  });

  it('derives product soldOut from its active variants', () => {
    const allOut = productFixture({
      variants: [
        variantFixture({ inventory: { onHand: 0, reserved: 0 } as Inventory }),
        variantFixture({ id: 'var-2', inventory: { onHand: 0, reserved: 0 } as Inventory }),
      ],
    });
    expect(toWireProduct(allOut).soldOut).toBe(true);

    const oneLeft = productFixture({
      variants: [
        variantFixture({ inventory: { onHand: 0, reserved: 0 } as Inventory }),
        variantFixture({ id: 'var-2', inventory: { onHand: 3, reserved: 0 } as Inventory }),
      ],
    });
    expect(toWireProduct(oneLeft).soldOut).toBe(false);
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
          variantFixture({ id: 'var-2', isActive: false, inventory: { onHand: 99, reserved: 0 } as Inventory }),
        ],
      }),
    );
    expect(wire.soldOut).toBe(true);
  });

  it('exposes the default-segment bulk tiers in rupees, ordered by minKg', () => {
    const wire = toWireProduct(
      productFixture({
        pricingTiers: [
          { minKg: '25', maxKg: '49', pricePerKgPaise: 84900n, segment: 'DEFAULT', businessId: null },
          { minKg: '1', maxKg: '4', pricePerKgPaise: 99900n, segment: 'DEFAULT', businessId: null },
          { minKg: '50', maxKg: null, pricePerKgPaise: null, segment: 'DEFAULT', businessId: null },
        ],
      } as unknown as Partial<Product>),
    );

    expect(wire.bulkTiers.map((tier) => tier.minKg)).toEqual([1, 25, 50]);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(999);
    // Null is what `isQuoteRequired` reads to route a 50kg enquiry to the RFQ form. Emitting 0 here
    // would silently offer a free tonne of almonds.
    expect(wire.bulkTiers[2]?.pricePerKg).toBeNull();
  });

  it('ignores tiers for another segment or a specific business', () => {
    const wire = toWireProduct(
      productFixture({
        pricingTiers: [
          { minKg: '1', maxKg: '4', pricePerKgPaise: 99900n, segment: 'DEFAULT', businessId: null },
          { minKg: '1', maxKg: '4', pricePerKgPaise: 80000n, segment: 'DISTRIBUTOR', businessId: null },
          { minKg: '1', maxKg: '4', pricePerKgPaise: 70000n, segment: 'DEFAULT', businessId: 'biz-1' },
        ],
      } as unknown as Partial<Product>),
    );
    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(999);
  });

  it('drops inactive variants from the wire list entirely', () => {
    const wire = toWireProduct(
      productFixture({
        variants: [variantFixture(), variantFixture({ id: 'var-2', isActive: false })],
      }),
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
    );
    expect(wire.images).toEqual(['/a.jpg', '/b.jpg', '/c.jpg']);
  });

  /**
   * The guard for constraint 1 of this plan. Every money field on the wire is rupees, and a
   * seeded 250g pack is a few hundred rupees — never tens of thousands. A paise value that escapes
   * a mapper renders through `inr()` as a figure a hundred times too large on every price in the
   * shop, so it is worth one assertion that cannot be argued with.
   */
  it('emits no field that looks like paise', () => {
    const wire = toWireProduct(productFixture());
    for (const variant of wire.variants) {
      expect(variant.price).toBeLessThan(100_000);
      expect(variant.mrp).toBeLessThan(100_000);
      expect(Number.isInteger(variant.price * 100)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w backend -- product.mapper`
Expected: FAIL — `Cannot find module './product.mapper'`.

- [ ] **Step 3: Implement the variant mapper**

```ts
// backend/src/modules/catalog/mappers/variant.mapper.ts
import { toRupees, variantSoldOut, type Channel, type Variant } from '@nutwala/shared';
import { VariantChannel } from '../../../entities/enums';
import type { ProductVariant } from '../../../entities/catalog/product-variant.entity';

/**
 * The database enum is uppercase; the wire vocabulary is lowercase. Same translation shape as
 * `user.mapper.ts` does for roles, and for the same reason: the two vocabularies are both correct
 * and the mapper is the single place they meet.
 */
const TO_WIRE_CHANNEL: Record<VariantChannel, Channel> = {
  [VariantChannel.RETAIL]: 'retail',
  [VariantChannel.BULK]: 'bulk',
};

/**
 * `available` is `onHand - reserved` (spec §10.1). `Inventory` is a separate row so stock writes
 * never contend with catalogue reads, which means the relation can legitimately be absent — a
 * variant created without one has nothing to sell, so it maps to zero rather than to `NaN`.
 */
export function availableFor(variant: ProductVariant): number {
  const inventory = variant.inventory;
  if (!inventory) return 0;
  return inventory.onHand - inventory.reserved;
}

export function toWireVariant(variant: ProductVariant): Variant {
  const available = availableFor(variant);
  return {
    sku: variant.sku,
    size: variant.size,
    grams: variant.grams,
    channel: TO_WIRE_CHANNEL[variant.channel],
    price: toRupees(variant.pricePaise),
    mrp: toRupees(variant.mrpPaise),
    moq: variant.moq,
    available,
    // The shared helper, never an inline comparison. `eslint.config.mjs` enforces this.
    soldOut: variantSoldOut(available),
  };
}
```

- [ ] **Step 4: Implement the product and category mappers**

```ts
// backend/src/modules/catalog/mappers/product.mapper.ts
import { productSoldOut, toRupees, type Product as WireProduct } from '@nutwala/shared';
import { CustomerSegment } from '../../../entities/enums';
import type { Product } from '../../../entities/catalog/product.entity';
import { availableFor, toWireVariant } from './variant.mapper';

/**
 * Entity → wire `Product`.
 *
 * Two conversions the compiler forces and one it does not:
 *
 * - `gstRate`, `moqKg` and `ratingAvg` are Postgres `numeric`, which TypeORM hands back as
 *   **strings**. The wire type declares `number`, so `Number(...)` is required — and the frontend's
 *   cart maths multiplies by `gstRate`, so a string here is a real arithmetic bug, not a cosmetic one.
 * - Money is `bigint` paise and becomes rupees inside `toWireVariant`.
 * - Nothing forces `soldOut` to agree with `available`; the shared helper is what does.
 */
export function toWireProduct(product: Product): WireProduct {
  const activeVariants = (product.variants ?? []).filter((variant) => variant.isActive);

  return {
    slug: product.slug,
    name: product.name,
    // The Phase 1 contract is the category *slug*, not an id and not a nested object.
    category: product.category.slug,
    subtitle: product.subtitle,
    description: product.description,
    // Spread rather than `badge: product.badge ?? undefined`, because the wire type declares
    // `badge?: Badge` and an explicit `undefined` serialises as a present key with a null value.
    ...(product.badge ? { badge: product.badge as WireProduct['badge'] } : {}),
    rating: Number(product.ratingAvg),
    reviewCount: product.reviewCount,
    images: [...(product.images ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((image) => image.url),
    origin: product.origin,
    grade: product.grade,
    processing: product.processing,
    shelfLife: product.shelfLife,
    storage: product.storage,
    ingredients: product.ingredients,
    hsn: product.hsn,
    gstRate: Number(product.gstRate),
    variants: activeVariants.map(toWireVariant),
    /**
     * The `DEFAULT` segment's tiers, ordered by `minKg`.
     *
     * Populated here rather than by a separate bulk endpoint, because three existing pages read this
     * field — `/bulk-orders`, `/bulk/$category` and the product page's bulk calculator — and
     * `isQuoteRequired` in `frontend/src/features/bulk/pricing.ts` returns true precisely when the
     * resolved tier's rate is null. An empty array would make every bulk weight look quote-required
     * and take the bulk calculator down.
     *
     * Segment and business-specific resolution (`RETAILER`/`DISTRIBUTOR`/`HORECA`, and per-business
     * overrides) is Milestone 7. Filtering to `DEFAULT` here means a B2B customer sees list pricing
     * until then, which is the honest behaviour rather than a wrong discount.
     */
    bulkTiers: [...(product.pricingTiers ?? [])]
      .filter((tier) => tier.segment === CustomerSegment.DEFAULT && tier.businessId === null)
      .sort((a, b) => Number(a.minKg) - Number(b.minKg))
      .map((tier) => ({
        minKg: Number(tier.minKg),
        maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
        // Null is load-bearing: it is what routes a 50kg enquiry to the RFQ form.
        pricePerKg: tier.pricePerKgPaise === null ? null : toRupees(tier.pricePerKgPaise),
      })),
    moqKg: Number(product.moqKg),
    ...(product.quoteOnly ? { quoteOnly: true } : {}),
    /**
     * Every variant with its **real** `isActive`, not the pre-filtered set with `isActive: true`.
     *
     * Passing `true` for all of them makes the helper's own filter a no-op and moves half the
     * derivation — *which variants count* — back into this mapper, which is what constraint 2 exists to
     * prevent. It would also mean the "ignores an inactive variant" test was really testing this
     * mapper's pre-filter rather than the shared rule. Behaviour is identical either way; the
     * difference is where the rule lives.
     */
    soldOut: productSoldOut(
      (product.variants ?? []).map((variant) => ({
        available: availableFor(variant),
        isActive: variant.isActive,
      })),
    ),
    seo: {
      title: product.seo.title ?? '',
      description: product.seo.description ?? '',
      ogImage: product.seo.ogImage ?? '',
    },
  };
}
```

```ts
// backend/src/modules/catalog/mappers/category.mapper.ts
import type { Category as WireCategory } from '@nutwala/shared';
import type { Category } from '../../../entities/catalog/category.entity';

export function toWireCategory(category: Category): WireCategory {
  return {
    slug: category.slug,
    name: category.name,
    image: category.image,
    blurb: category.blurb,
    description: category.description,
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npm run test -w backend -- product.mapper`
Expected: PASS. The suite below is 15 `it` blocks; two more are worth adding and were, so the committed
figure is **17** — `quoteOnly` omission (`BulkProductCard.tsx:34` tests it with `=== true`, so a `null`
or a string reads false) and empty-`seo` filling (the column defaults to `'{}'::jsonb`, so a product
saved without SEO copy is the normal case while the wire `Seo` declares three required strings).

- [ ] **Step 6: Prove the sold-out tests are load-bearing**

The whole point of Tasks 1, 2 and 4 is that `soldOut` cannot drift from `available`. Verify the test
would catch a drift, in one command so the tree is never dirty:

```bash
cd /Users/kunal/Desktop/nutwala/backend
cp src/modules/catalog/mappers/variant.mapper.ts "$SCRATCH/vm.bak"
python3 - <<'PY'
import pathlib
p = pathlib.Path('src/modules/catalog/mappers/variant.mapper.ts')
p.write_text(p.read_text().replace('soldOut: variantSoldOut(available),', 'soldOut: false,'))
PY
npx jest src/modules/catalog/mappers/product.mapper 2>&1 | grep -E "✕|Tests:"
cp "$SCRATCH/vm.bak" src/modules/catalog/mappers/variant.mapper.ts
diff -q "$SCRATCH/vm.bak" src/modules/catalog/mappers/variant.mapper.ts && echo RESTORED
```

Expected: **exactly two** failures — the two variant-level cases. `variant.mapper`'s `soldOut` field is
read only by those; product `soldOut` goes through `availableFor` + `productSoldOut` and is untouched by
this edit. An earlier version of this step expected "at least three", which under a two-failure result
would have invited someone to go and edit correct tests.

Run two more breaks so all three sold-out paths are covered: count inactive variants as active in
`product.mapper` (fails the "ignores an inactive variant" case), and hardcode product `soldOut` to
`false` (fails two). Then `RESTORED` after each.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/catalog/mappers
git commit -F - <<'MSG'
feat(catalog): map entities to the wire contract, converting paise and numerics once
MSG
```

## Task 5: The product query — filters, sort, pagination

The one place SQL is built for the catalogue. Read this whole task before writing any of it, because
the sort and price semantics are **not** what you would guess, and getting them wrong silently
changes what customers see on `/shop`.

### Inherited from Task 4, and it will take the bulk calculator down if you get it wrong

`product.mapper.ts` builds `bulkTiers` from `product.pricingTiers`, filtered to
`segment === CustomerSegment.DEFAULT && businessId === null`. **Your query must therefore hydrate
`pricingTiers` with its `segment` and `business_id` columns.** `leftJoinAndSelect('product.pricingTiers', …)`
does. A narrowed `.select([...])` that omits either one leaves them `undefined`, `businessId === null` is
false, **every tier is dropped, and `bulkTiers` silently becomes `[]`**.

Fail-closed is the right direction — the alternative would leak one business's negotiated rate onto every
buyer's page — but the failure is silent, and it reaches **four** consumers, not the three this plan
originally listed: `/bulk-orders`, `/bulk/$category`, the product page's bulk calculator, and
`frontend/src/features/cart/cart-math.ts:18`, which calls `bulkTotal(p.bulkTiers, …)` — so an empty array
also makes every bulk **cart line** total `null`.

Task 9's integration test is what would catch it. Do not consider this settled by a unit test.

### A failure to expect, so it does not cost you an hour

`listProducts` combines four things that interact badly in TypeORM, and the combination is untested
because this is the first paginated joined query in the repo:

- `leftJoinAndSelect` on two one-to-many relations (`variants`, `images`)
- `skip`/`take` rather than `limit`/`offset` — correct, and required: with joins, `limit` would truncate
  *rows* mid-product and hand the mapper a product with three of its eight variants
- `getManyAndCount()`
- **`orderBy` given a multi-line raw subquery**

The last one is the risk, and **all four candidate shapes were measured against Postgres before this
was written** — an earlier version of this section predicted the wrong error and offered two resolutions,
one of which is impossible and the other insufficient:

| Shape | Result |
| --- | --- |
| raw correlated subquery straight into `orderBy` | **fails** — `"( SELECT v" alias was not found. Maybe you forgot to join it?` |
| `addSelect(SUBQUERY, 'kg_price')` + `orderBy('kg_price')` | works **for the sort only** |
| a select alias referenced from `WHERE` | **fails** — `column "kg_price" does not exist` |
| `DISTINCT ON` derived table, joined, qualified in `WHERE` | works for sort **and** filters |

Three things to take from that:

- **Postgres never sees the bad query.** TypeORM's `createOrderByCombinedWithSelectExpression` splits the
  criteria on its first `.` and resolves the head as an alias, so the failure is a TypeORM error, not the
  `for SELECT DISTINCT, ORDER BY expressions must appear in select list` this plan used to predict. Same
  remedy, different string to grep for.
- **`addSelect` fixes the sort and not the filters.** Postgres will not let a `SELECT` alias be
  referenced from `WHERE`, so `minPrice`/`maxPrice` would each need the derivation spelled out again —
  three copies of the rule this section exists to keep in one place.
- **`LEFT JOIN LATERAL` is not reachable through TypeORM's `leftJoin`.** It treats a raw string as a
  subquery only when it both starts with `(` and ends with `)`, so `LATERAL (…)` is taken for a table
  path and escaped as an identifier. (Task 7 is unaffected — its facets service uses raw
  `repository.query()`, where `LATERAL` is fine.)

So: a **`DISTINCT ON` derived table**, left-joined on `product_id` and selected as `kg_price`. One
evaluation per product, a plain column for both the sort and the filters, and no correlation for TypeORM
to mangle.

**Do not** work around any of this by dropping the join and lazy-loading variants — that turns one query
into an N+1 across a page of 24 products with 8 variants each. Task 9's integration test is what proves
the resulting order against real rows; the unit test cannot.

### The semantics you must preserve

Phase 1's `applyFilters` in `frontend/src/features/catalog/api/index.ts` sorts and price-filters on a
derived **per-kilogram** figure, not on a pack price:

```ts
const kgPrice = (p: Product) =>
  p.variants.find((v) => v.grams === 1000)?.price ?? p.variants[0]?.price ?? 0;
```

So `minPrice`, `maxPrice`, `price-asc` and `price-desc` all operate on the 1kg retail variant's
price, falling back to the first variant when there is no 1kg pack. Reimplementing this as
`MIN(price)` across variants would reorder the entire shop and change which products a price filter
returns — a visible behaviour change with no ticket behind it. Replicate it.

**The fallback is unreachable, measured.** Against the seeded data:

```
products without an active 1kg variant = 0
lowest-grams active variant is always 100g = true
```

Every product has a 1kg pack, so `(v.grams = 1000) DESC` always matches and the `v.grams ASC` tiebreak
never decides anything — it cannot be a source of behaviour change. And where it *would* decide, it
agrees with the mock anyway: `buildVariants` returns `[...retail, ...bulk]` with retail ordered
`100g, 250g, 500g, 1kg`, so the mock's `p.variants[0]` is always the 100g pack, which is also the lowest
grams. Choosing lowest-grams over array order is future-proofing rather than a fidelity question —
seed-array order is insertion order and means nothing to a database.

Two more Phase 1 facts worth carrying across rather than rediscovering:

- `category === 'all'` means no category filter.
- `sort: 'featured'` and `sort: 'newest'` both fall through to no explicit ordering. **They cannot mean
  seed order, and an earlier version of this plan claimed they did.** Measured:
  `COUNT(DISTINCT "createdAt")` over `products` is **1** — `seedCatalog` runs in one transaction and
  Postgres's `now()` is transaction-start, so every product shares a timestamp. `createdAt ASC` is
  therefore a no-op today and the effective order is the `product.id` UUID tiebreak: deterministic,
  which is the property that matters, but arbitrary rather than the mock's array order. Keep
  `createdAt ASC` — it is correct for data inserted over time — and keep the `p.id` tiebreak, because an
  unordered `LIMIT`/`OFFSET` in Postgres may return the same row on two pages. Reproducing the mock's
  order would need a `sortOrder` column on `products`, which no task in this plan adds.

**Files:**
- Create: `backend/src/modules/catalog/catalog.service.ts`
- Test: `backend/src/modules/catalog/catalog.service.spec.ts`

- [ ] **Step 1: Write the failing test**

The service builds SQL, so the unit test asserts the *query it constructs*, not rows. Row behaviour
is Task 9's integration test against real Postgres, where it belongs — a fake that answers queries
would only prove the fake agrees with itself.

```ts
// backend/src/modules/catalog/catalog.service.spec.ts
import { CatalogService } from './catalog.service';

/**
 * A recording stand-in for TypeORM's `SelectQueryBuilder`. Every chainable method returns `this` and
 * appends to a log, so a test can assert which clauses were added and with which parameters.
 *
 * This double is honest about what it is: it proves the service asks for the right thing. It cannot
 * prove Postgres answers correctly, which is why Task 9 exists. Do not extend it into a query
 * engine — Plan 1's session-rotation race was invisible to exactly that kind of fake.
 */
function recordingBuilder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  // `addSelect` and `leftJoin` are in the list because the query needs them — omitting them made the
  // double throw `builder.addSelect is not a function`, which blocked even this plan's own first
  // suggested resolution.
  for (const method of [
    'leftJoinAndSelect',
    'leftJoin',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'setParameters',
  ]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.getManyAndCount = () => Promise.resolve([[], 0]);
  // `getOne` and `getMany` too — same gap as `addSelect`/`leftJoin`. `getProduct` would otherwise throw
  // "builder.getOne is not a function", and the two category methods need a plain repository double for
  // `find`/`findOne` rather than a query builder.
  builder.getOne = () => Promise.resolve(null);
  builder.getMany = () => Promise.resolve([]);
  return { builder, calls };
}

function build() {
  const { builder, calls } = recordingBuilder();
  const repository = { createQueryBuilder: jest.fn(() => builder) };
  const service = new CatalogService(repository as never);
  return { service, calls };
}

const clauses = (calls: { method: string; args: unknown[] }[]): string =>
  calls
    .filter((call) => call.method === 'where' || call.method === 'andWhere')
    .map((call) => String(call.args[0]))
    .join(' | ');

describe('CatalogService.listProducts', () => {
  it('only ever returns published products', async () => {
    const { service, calls } = build();
    await service.listProducts({});
    expect(clauses(calls)).toContain('product.isPublished = true');
  });

  it('ignores the category filter when it is the sentinel "all"', async () => {
    const { service, calls } = build();
    await service.listProducts({ category: 'all' });
    expect(clauses(calls)).not.toContain('category.slug');
  });

  it('applies a real category slug', async () => {
    const { service, calls } = build();
    await service.listProducts({ category: 'almonds' });
    expect(clauses(calls)).toContain('category.slug = :category');
  });

  it('searches name, subtitle and origin for the q term', async () => {
    const { service, calls } = build();
    await service.listProducts({ q: 'badam' });
    const where = clauses(calls);
    expect(where).toContain('product.name');
    expect(where).toContain('product.subtitle');
    expect(where).toContain('product.origin');
  });

  /**
   * The per-kg figure, not a pack price. Asserted on the SQL because getting this wrong reorders
   * the whole shop and no row-level test would obviously flag it.
   */
  it('filters price against the derived per-kg price', async () => {
    const { service, calls } = build();
    await service.listProducts({ minPrice: 500, maxPrice: 1500 });
    const where = clauses(calls);
    // Qualified by the derived table's alias. An earlier version asserted a bare `kg_price >= :minPrice`,
    // which the implementation could not emit *and* which Postgres rejects — a `SELECT` alias cannot be
    // referenced from `WHERE`. The assertion was green against SQL that cannot run.
    expect(where).toContain('kgp.kg_price >= :minPrice');
    expect(where).toContain('kgp.kg_price <= :maxPrice');
  });

  /**
   * The `bulkTiers` trap, as a unit assertion. Verified load-bearing: removing the join fails this and
   * empties `bulkTiers` on every product in the real-database run.
   */
  it('hydrates pricingTiers, without which bulkTiers silently empties', async () => {
    const { service, calls } = build();
    await service.listProducts({});
    const joined = calls
      .filter((call) => call.method === 'leftJoinAndSelect')
      .map((call) => String(call.args[0]));
    expect(joined).toContain('product.pricingTiers');
  });

  it('sorts by the same per-kg figure', async () => {
    const { service, calls } = build();
    await service.listProducts({ sort: 'price-asc' });
    const order = calls.find((call) => call.method === 'orderBy');
    expect(String(order?.args[0])).toContain('kg_price');
    expect(order?.args[1]).toBe('ASC');
  });

  it('gives every sort a deterministic tiebreak so pages cannot repeat a row', async () => {
    for (const sort of ['featured', 'newest', 'rating', 'best-selling', 'price-asc', 'price-desc'] as const) {
      const { service, calls } = build();
      await service.listProducts({ sort });
      const tiebreak = calls.find(
        (call) => call.method === 'addOrderBy' && String(call.args[0]).includes('product.id'),
      );
      expect(tiebreak).toBeDefined();
    }
  });

  /**
   * `inStockOnly` was a no-op in Phase 1 — the mock hardcoded stock on every variant, so the box
   * changed the URL and nothing else. It also read `available` across *all* variants including bulk,
   * so a product whose retail packs were empty but whose 50kg pack had stock still appeared on
   * `/shop` as in stock. Both are fixed here: the filter is real, and it respects `channel`.
   */
  it('filters to products with stock in the requested channel', async () => {
    const { service, calls } = build();
    await service.listProducts({ inStockOnly: true, channel: 'retail' });
    const where = clauses(calls);
    expect(where).toContain('EXISTS');
    expect(where).toContain('inventory');
    const params = calls.find((call) => call.method === 'setParameters');
    expect(params?.args[0]).toMatchObject({ channel: 'RETAIL' });
  });

  it('caps the page size so a client cannot ask for the whole table', async () => {
    const { service, calls } = build();
    await service.listProducts({ limit: 5000 });
    const take = calls.find((call) => call.method === 'take');
    expect(take?.args[0]).toBe(60);
  });

  it('defaults to page 1 with a sane limit', async () => {
    const { service, calls } = build();
    await service.listProducts({});
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(0);
    expect(calls.find((call) => call.method === 'take')?.args[0]).toBe(24);
  });

  it('translates page 3 into the right offset', async () => {
    const { service, calls } = build();
    await service.listProducts({ page: 3, limit: 12 });
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(24);
  });

  it('clamps a nonsensical page to the first one', async () => {
    const { service, calls } = build();
    await service.listProducts({ page: 0 });
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w backend -- catalog.service`
Expected: FAIL — `Cannot find module './catalog.service'`.

- [ ] **Step 3: Implement the service**

```ts
// backend/src/modules/catalog/catalog.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Paginated, ProductFilters, Product as WireProduct } from '@nutwala/shared';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { toWireProduct } from './mappers/product.mapper';

/** Page size defaults. The cap exists so a client cannot turn a list endpoint into a table dump. */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The per-kilogram price Phase 1 sorts and filters on.
 *
 * `frontend/src/features/catalog/api/index.ts` derives it as "the 1kg retail variant's price, else
 * the first variant's". This subquery reproduces that: prefer `grams = 1000`, fall back to the
 * lowest `grams`, and coalesce to 0 for a product with no variants at all. Anything simpler — a
 * `MIN(price)` across variants, say — reorders the entire shop and changes which products a price
 * filter returns, which is a visible change nobody asked for.
 */
const KG_PRICE_SUBQUERY = `(
  SELECT v."pricePaise"
    FROM product_variants v
   WHERE v.product_id = product.id
     AND v."isActive" = true
   ORDER BY (v.grams = 1000) DESC, v.grams ASC
   LIMIT 1
)`;

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
  ) {}

  async listProducts(filters: ProductFilters): Promise<Paginated<WireProduct>> {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(filters.limit ?? DEFAULT_LIMIT)));

    const query = this.baseQuery();
    this.applyFilters(query, filters);
    this.applySort(query, filters.sort);

    query.skip((page - 1) * limit).take(limit);

    const [rows, total] = await query.getManyAndCount();
    return { items: rows.map(toWireProduct), total, page, limit };
  }

  /**
   * The relation set every catalogue response needs. `inventory` is joined because `soldOut` cannot
   * be derived without it, and joining here rather than lazy-loading avoids an N+1 across a page of
   * products with eight variants each.
   */
  private baseQuery(): SelectQueryBuilder<Product> {
    return this.products
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.variants', 'variant')
      .leftJoinAndSelect('variant.inventory', 'inventory')
      .leftJoinAndSelect('product.images', 'image')
      // Required, and an earlier version of this plan omitted it while its own preamble demanded it.
      // `product.mapper.ts` filters tiers on `segment === DEFAULT && businessId === null`; without this
      // join both are `undefined`, every tier is dropped, and `bulkTiers` silently becomes `[]` —
      // taking down four consumers including every bulk cart line total. Proved by removing it: all 24
      // returned products came back with an empty array.
      .leftJoinAndSelect('product.pricingTiers', 'pricingTier')
      .where('product.isPublished = true');
  }

  private applyFilters(query: SelectQueryBuilder<Product>, filters: ProductFilters): void {
    const parameters: Record<string, unknown> = {};

    // `all` is Phase 1's sentinel for "no category filter", emitted by the shop's category chips.
    if (filters.category && filters.category !== 'all') {
      query.andWhere('category.slug = :category');
      parameters.category = filters.category;
    }

    /**
     * Phase 1 matched `${p.name} ${p.grade} ${p.category} ${p.origin}`. An earlier version of this plan
     * specified name, subtitle and origin — dropping **grade and category** — so a search for
     * `Independence`, `House Blend` or `Shelled` would silently have stopped matching in the live
     * `SearchDialog` and the shop's search box. No seeded subtitle contains a grade, so nothing would
     * have covered for it.
     *
     * All four of Phase 1's fields are here, plus `subtitle` as a deliberate widening: it is what a
     * customer typing "crunchy" or "seedless" would expect to hit.
     */
    if (filters.q) {
      query.andWhere(
        `(product.name ILIKE :q OR product.subtitle ILIKE :q OR product.origin ILIKE :q
           OR product.grade ILIKE :q OR category.slug ILIKE :q)`,
      );
      parameters.q = `%${filters.q}%`;
    }

    if (filters.origin) {
      query.andWhere('product.origin = :origin');
      parameters.origin = filters.origin;
    }

    if (filters.grade) {
      query.andWhere('product.grade = :grade');
      parameters.grade = filters.grade;
    }

    if (filters.bestsellerOnly) {
      query.andWhere("product.badge = 'BESTSELLER'");
    }

    // Rupees in, paise compared: the column is paise, the filter arrives as rupees.
    if (filters.minPrice !== undefined) {
      query.andWhere(`${KG_PRICE_SUBQUERY} >= :minPrice`);
      parameters.minPrice = Math.round(filters.minPrice * 100);
    }

    if (filters.maxPrice !== undefined) {
      query.andWhere(`${KG_PRICE_SUBQUERY} <= :maxPrice`);
      parameters.maxPrice = Math.round(filters.maxPrice * 100);
    }

    /**
     * Channel-aware, unlike Phase 1's version. `EXISTS` rather than a join condition because the
     * base query already `leftJoinAndSelect`s every variant for the mapper — adding stock predicates
     * to that join would drop the sold-out variants from the response and make the product page
     * hide the very rows it needs to show as SOLD OUT.
     */
    if (filters.inStockOnly) {
      query.andWhere(`EXISTS (
        SELECT 1
          FROM product_variants sv
          JOIN inventory si ON si.variant_id = sv.id
         WHERE sv.product_id = product.id
           AND sv."isActive" = true
           AND si."onHand" - si.reserved > 0
           ${filters.channel ? 'AND sv.channel = :channel' : ''}
      )`);
    }

    if (filters.channel) {
      // Exhaustive record, not a ternary. `channel === 'retail' ? 'RETAIL' : 'BULK'` maps *any*
      // non-`retail` value to BULK, so a future third channel would silently become bulk. Mirrors
      // `TO_WIRE_CHANNEL` in `variant.mapper.ts`.
      parameters.channel = TO_DB_CHANNEL[filters.channel];
    }

    query.setParameters(parameters);
  }

  /**
   * `featured` and `newest` are Phase 1's fall-through cases — they mean seed order today. Every
   * branch adds `product.id` as a tiebreak, because an unordered `LIMIT`/`OFFSET` in Postgres may
   * return the same row on two different pages.
   */
  private applySort(query: SelectQueryBuilder<Product>, sort: ProductFilters['sort']): void {
    switch (sort) {
      case 'price-asc':
        query.orderBy(KG_PRICE_SUBQUERY, 'ASC');
        break;
      case 'price-desc':
        query.orderBy(KG_PRICE_SUBQUERY, 'DESC');
        break;
      case 'rating':
        query.orderBy('product.ratingAvg', 'DESC');
        break;
      case 'best-selling':
        query.orderBy('product.reviewCount', 'DESC');
        break;
      case 'featured':
      case 'newest':
      default:
        query.orderBy('product.createdAt', 'ASC');
        break;
    }
    query.addOrderBy('product.id', 'ASC');
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npm run test -w backend -- catalog.service`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/catalog/catalog.service.ts backend/src/modules/catalog/catalog.service.spec.ts
git commit -F - <<'MSG'
feat(catalog): build the product query, preserving Phase 1 sort and price semantics
MSG
```

## Task 6: The query DTO and the catalogue controller

**Files:**
- Create: `backend/src/modules/catalog/dto/product-query.dto.ts`
- Create: `backend/src/modules/catalog/catalog.controller.ts`
- Create: `backend/src/modules/catalog/catalog.controller.spec.ts`
- Create: `backend/src/modules/catalog/catalog.module.ts`
- Modify: `backend/src/app.module.ts`

**The facets and combos routes are deferred to Tasks 7 and 8, not stubbed.** A stub answers 200 and lies:
an empty facet set is a price slider whose ends match nothing, and `CombosService.list()` returning `[]`
is a combos page that renders nothing — both of which Task 9's spec or the Task 11 frontend could bind to
as though correct. A 404 on a route that does not exist yet is honest. Stubbing `CombosService` would also
mean inventing Task 8's DI surface (`productsBySlugs`, the composition token, the logger) and then
deleting it.

Cost, so it is paid deliberately: **Tasks 7 and 8 each add their own route to the controller and their own
provider to the module.** There is a comment at the insertion point, and the ordering test below covers
`products/facets` automatically the moment it appears.

`catalog.controller.spec.ts` is the durable control for route ordering, and the ordering test is written
as an **invariant over the whole route list** — no literal path under `products/` may appear below
`products/:slug` — rather than as an assertion about the routes that exist today. Task 7's
`products/facets` was therefore covered the moment it appeared, confirmed by experiment: moved below
`products/:slug` it fails with `shadowed: ["products/facets"]`.

**But only that one test is an invariant.** The first test in the file *enumerates* the exact route list,
so it fails on any addition — which means **Tasks 7 and 8 must each edit this spec file**, not merely add
a route. Add it to their file lists. One test is a control; the other is an inventory, and the difference
is worth a comment in the file. It reads `PATH_METADATA` off
the controller prototype in declaration order, which is the order Nest registers and Express matches.
A second test asserts every route carries `@Public()`.

`ProductVariant` is **not** in `TypeOrmModule.forFeature`: nothing injects that repository, because
variants, images, inventory and pricing tiers all arrive through joins off `Product`.

- [ ] **Step 1: Create the DTO**

Write it **one decorator per line.** The compact form below exceeds prettier's `printWidth: 100` on five
fields — the `channel` line is 121 characters — so `format:check` fails on the block as printed here.

**The decorator pairings below were run before this task was written**, because the transform-then-validate
order makes them easy to get wrong in a way nothing catches until a request 400s:

| Field shape | Result |
| --- | --- |
| `@toBoolean() @IsBooleanString()` | **fails on every value** — `'true'` and `'false'` both error |
| `@toBoolean() @IsBoolean()` | `'true'`→`true`, `'false'`→`false`, absent→`undefined`, no errors |
| `@toNumber() @IsInt() @Min(1) @Max(60)` | `'24'`→24 ok; `''`→undefined ok; `'5000'` rejected; `'1.5'` rejected; `'abc'` rejected |


Query strings are all strings, so every numeric and boolean field needs an explicit transform. The
global `ValidationPipe` runs with `whitelist: true` and `forbidNonWhitelisted: true`, so an unknown
query parameter is a 400 — which is the behaviour you want, and also means every field the frontend
sends must be declared here or the shop breaks with a validation error.

```ts
// backend/src/modules/catalog/dto/product-query.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

const SORTS = ['featured', 'best-selling', 'price-asc', 'price-desc', 'newest', 'rating'] as const;

/**
 * `@Transform` rather than `@Type`, because a query string's `"true"` is truthy under
 * `@Type(() => Boolean)` and so is `"false"` — every checkbox would read as ticked.
 *
 * Pair it with **`@IsBoolean()`, never `@IsBooleanString()`.** class-transformer runs before
 * class-validator, so by validation time the value is a real boolean and `@IsBooleanString` rejects it:
 * measured, and both `inStockOnly=true` and `inStockOnly=false` fail with "must be a boolean string".
 * An earlier version of this plan had `@IsBooleanString()`, which would have made every request carrying
 * the shop's in-stock filter a 400.
 */
const toBoolean = (): PropertyDecorator =>
  Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value));

/**
 * Returns the original value when it is not numeric, rather than `NaN`.
 *
 * **Not for the reason an earlier version of this plan gave.** That comment claimed `NaN` fails `@Max`
 * before `@IsInt`, so the customer sees only "must not be greater than 60" for a value that was never a
 * number. Measured, both spellings side by side: class-validator collects **every** failing constraint,
 * so `limit=abc` returns all three messages either way —
 * `["limit must not be greater than 60", "limit must not be less than 1", "limit must be an integer number"]`.
 * The transform changes nothing about the error.
 *
 * It is kept for a smaller, true reason: it leaves the rejected input visible in the response instead of
 * a `NaN` that JSON-serialises to `null`, which is easier to debug from a log line.
 */
const toNumber = (): PropertyDecorator =>
  Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  });

export class ProductQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @toNumber() @IsNumber() @Min(0) minPrice?: number;
  @ApiPropertyOptional() @IsOptional() @toNumber() @IsNumber() @Min(0) maxPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() origin?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() grade?: string;
  @ApiPropertyOptional() @IsOptional() @toBoolean() @IsBoolean() bestsellerOnly?: boolean;
  @ApiPropertyOptional() @IsOptional() @toBoolean() @IsBoolean() inStockOnly?: boolean;
  @ApiPropertyOptional({ enum: ['retail', 'bulk'] }) @IsOptional() @IsIn(['retail', 'bulk']) channel?: 'retail' | 'bulk';
  @ApiPropertyOptional({ enum: SORTS }) @IsOptional() @IsIn(SORTS) sort?: (typeof SORTS)[number];
  @ApiPropertyOptional() @IsOptional() @toNumber() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @toNumber() @IsInt() @Min(1) @Max(60) limit?: number;
}
```

- [ ] **Step 2: Create the controller**

```ts
// backend/src/modules/catalog/catalog.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CatalogFacets, Category, Combo, Paginated, Product } from '@nutwala/shared';
import { Public } from '../../common/auth/decorators/public.decorator';
import { CatalogFacetsService } from './catalog.facets.service';
import { CatalogService } from './catalog.service';
import { CombosService } from './combos.service';
import { ProductQueryDto } from './dto/product-query.dto';

/**
 * Every route here is `@Public()`. `JwtAuthGuard` is global, so without it the shop would 401 for
 * anyone not signed in — which is most visitors.
 *
 * `CsrfGuard` is also global but exempts safe methods, so these GETs need no CSRF token.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly facets: CatalogFacetsService,
    private readonly combos: CombosService,
  ) {}

  @Public()
  @Get('products')
  @ApiOperation({ summary: 'List published products with filters, sort and pagination' })
  listProducts(@Query() query: ProductQueryDto): Promise<Paginated<Product>> {
    return this.catalog.listProducts(query);
  }

  /**
   * Declared before `products/:slug`, or Nest matches `facets` as a slug and every facets request
   * becomes a 404 for a product called "facets". Route order is the fix; there is no decorator for it.
   */
  @Public()
  @Get('products/facets')
  @ApiOperation({ summary: 'Filter options and price bounds across the whole published catalogue' })
  productFacets(): Promise<CatalogFacets> {
    return this.facets.facets();
  }

  @Public()
  @Get('products/bestsellers')
  @ApiOperation({ summary: 'Products badged BESTSELLER' })
  bestsellers(@Query() query: ProductQueryDto): Promise<Paginated<Product>> {
    return this.catalog.listProducts({ ...query, bestsellerOnly: true });
  }

  @Public()
  @Get('products/:slug')
  @ApiOperation({ summary: 'One product by slug' })
  product(@Param('slug') slug: string): Promise<Product> {
    return this.catalog.getProduct(slug);
  }

  @Public()
  @Get('products/:slug/related')
  @ApiOperation({ summary: 'Products in the same category, excluding this one' })
  related(@Param('slug') slug: string): Promise<Paginated<Product>> {
    return this.catalog.listRelated(slug);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Published categories in display order' })
  categories(): Promise<Category[]> {
    return this.catalog.listCategories();
  }

  @Public()
  @Get('categories/:slug')
  @ApiOperation({ summary: 'One category by slug' })
  category(@Param('slug') slug: string): Promise<Category> {
    return this.catalog.getCategory(slug);
  }

  @Public()
  @Get('combos')
  @ApiOperation({ summary: 'Assembled combo boxes with their savings' })
  listCombos(): Promise<Combo[]> {
    return this.combos.list();
  }
}
```

- [ ] **Step 3: Add the four service methods the controller calls**

Append to `backend/src/modules/catalog/catalog.service.ts`:

```ts
  async getProduct(slug: string): Promise<WireProduct> {
    const product = await this.baseQuery().andWhere('product.slug = :slug', { slug }).getOne();
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toWireProduct(product);
  }

  /**
   * Same category, excluding the product itself. Returns an empty page rather than throwing for an
   * unknown slug, matching Phase 1's `listRelated`, which returned `[]` — a related-products rail is
   * decoration, and a 404 there would break a product page that otherwise rendered fine.
   */
  async listRelated(slug: string, limit = 4): Promise<Paginated<WireProduct>> {
    // `isPublished` matters here: without it an unpublished slug returns its published siblings through
    // a rail whose own product page 404s. Unpublished should behave like unknown.
    const product = await this.products.findOne({
      where: { slug, isPublished: true },
      select: { id: true, categoryId: true },
    });
    if (!product) return { items: [], total: 0, page: 1, limit };

    const [rows, total] = await this.baseQuery()
      .andWhere('product.categoryId = :categoryId', { categoryId: product.categoryId })
      .andWhere('product.id != :id', { id: product.id })
      .orderBy('product.reviewCount', 'DESC')
      .addOrderBy('product.id', 'ASC')
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toWireProduct), total, page: 1, limit };
  }

  async listCategories(): Promise<WireCategory[]> {
    const rows = await this.categories.find({
      where: { isPublished: true },
      order: { sortOrder: 'ASC' },
    });
    return rows.map(toWireCategory);
  }

  async getCategory(slug: string): Promise<WireCategory> {
    const category = await this.categories.findOne({ where: { slug, isPublished: true } });
    if (!category) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That category does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toWireCategory(category);
  }
```

Add the imports and the second repository to the constructor:

```ts
import { HttpStatus } from '@nestjs/common';
import type { Category as WireCategory } from '@nutwala/shared';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Category } from '../../entities/catalog/category.entity';
import { toWireCategory } from './mappers/category.mapper';
```

```ts
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Category) private readonly categories: Repository<Category>,
  ) {}
```

The existing spec constructs `new CatalogService(repository as never)` with one argument, so it will
now fail to compile. Update those `build()` calls to pass a second recording double — that is a real
signal, not noise: the spec is telling you the constructor changed.

- [ ] **Step 4: Wire the module**

```ts
// backend/src/modules/catalog/catalog.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from '../../entities/catalog/category.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { CatalogController } from './catalog.controller';
import { CatalogFacetsService } from './catalog.facets.service';
import { CatalogService } from './catalog.service';
import { CombosService } from './combos.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, Category, ProductVariant])],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogFacetsService, CombosService],
  exports: [CatalogService],
})
export class CatalogModule {}
```

Add `CatalogModule` to `app.module.ts`'s `imports`, beside `AuthModule`.

- [ ] **Step 5: Verify the routes are mapped and public**

**An earlier version of this step was dangerous in three ways, all of them worth knowing:**

1. It ended with `pkill -f "nest start --watch"`, which kills whatever dev server is already running —
   including one this session did not start. Straight through process rule 1.
2. It began with `npm run build -w backend`, and `nest-cli.json` sets `deleteOutDir: true`, so that
   `rm -rf`s the `dist/` a running watch server is serving from.
3. **`PORT=4401 npm run dev` does not move the port.** `load-env.ts` applies dotenv with
   `override: true`, so `.env`'s `PORT=4400` wins over the shell — the same mechanism this plan's
   constraint 7 documents for `DB_PORT`, tripping its own verification step. The new server would have
   collided with the existing one instead of moving.

So: never assume 4400 is yours, and get the port the same way the database override works — with
`NODE_ENV=test`, which makes dotenv a no-op against the deliberately absent `.env.test`:

```bash
cd /Users/kunal/Desktop/nutwala/backend
set -a; . ./.env; set +a
export NODE_ENV=test PORT=4401 DB_MIGRATIONS_RUN=false
(npx ts-node -r tsconfig-paths/register src/main.ts > "$SCRATCH/be-4401.log" 2>&1 &)
ready=no; for i in $(seq 1 60); do curl -fsS http://localhost:4401/api/v1/health >/dev/null 2>&1 && { ready=yes; break; }; sleep 1; done
echo "ready=$ready"
curl -s "http://localhost:4401/api/v1/catalog/products?limit=2" | head -c 300; echo
curl -s -o /dev/null -w 'categories:%{http_code}\n' http://localhost:4401/api/v1/catalog/categories
# Stop only the server you started, then confirm the port is free.
pkill -f "ts-node -r tsconfig-paths/register src/main.ts"
lsof -nP -iTCP:4401 -sTCP:LISTEN >/dev/null 2>&1 && echo "STILL LISTENING" || echo "4401 free"
```

`ts-node` rather than `dist/` keeps you off the built output entirely, and `DB_MIGRATIONS_RUN=false`
keeps the run read-only against the dev database.

Expected: the product list returns `{"success":true,"data":{"items":[…],"total":27,"page":1,"limit":2}}`
with **no** authentication, `facets:200` and `categories:200`. A 401 anywhere means a missing
`@Public()`. A 404 on facets means the route is declared after `products/:slug` — reorder it.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/catalog backend/src/app.module.ts
git commit -F - <<'MSG'
feat(catalog): expose the public catalogue read endpoints
MSG
```

## Task 7: The facets endpoint

Breaking change B from the top of this plan. `ShopPage.tsx:54` and `bulk.$category.tsx:80` each fetch
the **entire catalogue** a second time purely to build the sidebar's origin list, grade list and price
slider bounds. Once lists paginate, that call returns one page and the facets silently describe 24
products instead of 27 — a bug that looks like a UI glitch and is actually a data-scope error.

One aggregate query replaces both fetches.

**Files:**
- Create: `backend/src/modules/catalog/catalog.facets.service.ts`
- Test: covered by Task 9's integration spec, because the value of this code is entirely in what
  Postgres returns. A unit test over a query-builder double would assert that the service asks for
  what the service asks for.

**Two driver behaviours checked through the real stack, not reasoned about**, because both are classic traps:

- `array_agg(DISTINCT p.origin ORDER BY p.origin)` comes back as a **real JS array** — 13 strings, first
  `"Afghanistan"` — not a Postgres array literal. So `row?.origins ?? []` is right as written.
- `MIN(kg.price)` over a `bigint` column comes back as the **string** `"44900"`, not a number, and
  `FacetRow` declaring `min_price: string | null` is correct.

  **But an earlier version of this plan attached a false consequence to that true observation**, claiming
  that dropping the `BigInt()` would render ₹449 as ₹4.49. It would not: `toRupees` is
  `Number(paise) / 100`, and `Number('44900')` is `44900`, so `toRupees('44900')` and `toRupees(44900n)`
  both give **449**. Measured.

  Keep the `BigInt()` for the two reasons that are actually true. `toRupees` declares `Paise = bigint`,
  so removing the conversion does not compile without a cast — **the compiler is the control here, not
  the arithmetic**. And `BigInt('oops')` throws where `Number('oops')` yields `NaN`, which is the
  NaN-ended slider the next bullet warns about.

**Both queries were run against the seeded database before this task was written**, so the figures the
tests assert are measured rather than remembered:

| Query | Result |
| --- | --- |
| origins / grades | **13** distinct origins, **19** distinct grades |
| per-kg price bounds | `44900`–`349900` paise, i.e. **₹449 – ₹3499** |
| category counts | almonds 3, cashews 2, pistachios 2, walnuts 1, raisins 2, dates 2, anjeer 1, makhana 2, seeds 2, trail-mixes 1, roasted-nuts 1, **combos 8** — twelve rows summing to **27** |

The combos count is worth noticing: eight, not the six the brief names, because `corporate-gift-box` and
`festive-gift-box` are also in that category. If a later task asserts "six combos" it is asserting the
brief rather than the data.

- [ ] **Step 1: Implement the service**

```ts
// backend/src/modules/catalog/catalog.facets.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { toRupees, type CatalogFacets } from '@nutwala/shared';
import { Repository } from 'typeorm';
import { Product } from '../../entities/catalog/product.entity';

/** The raw shape the aggregate query returns. Every count comes back as a string from `pg`. */
interface FacetRow {
  origins: string[] | null;
  grades: string[] | null;
  min_price: string | null;
  max_price: string | null;
}

interface CategoryCountRow {
  slug: string;
  name: string;
  product_count: string;
}

@Injectable()
export class CatalogFacetsService {
  constructor(@InjectRepository(Product) private readonly products: Repository<Product>) {}

  /**
   * Filter options across the whole **published** catalogue, in two queries rather than by fetching
   * every product.
   *
   * The price bounds use the same per-kg figure `CatalogService` sorts on, so the slider's ends
   * always correspond to products the price filter can actually return. Deriving them from a
   * different figure is how a slider comes to have a range that matches nothing.
   */
  async facets(): Promise<CatalogFacets> {
    const [row] = await this.products.query<FacetRow[]>(`
      SELECT array_agg(DISTINCT p.origin ORDER BY p.origin)             AS origins,
             array_agg(DISTINCT p.grade  ORDER BY p.grade)              AS grades,
             MIN(kg.price)                                              AS min_price,
             MAX(kg.price)                                              AS max_price
        FROM products p
        LEFT JOIN LATERAL (
          SELECT v."pricePaise" AS price
            FROM product_variants v
           WHERE v.product_id = p.id AND v."isActive" = true
           ORDER BY (v.grams = 1000) DESC, v.grams ASC
           LIMIT 1
        ) kg ON true
       WHERE p."isPublished" = true
    `);

    const categories = await this.products.query<CategoryCountRow[]>(`
      SELECT c.slug, c.name, count(p.id)::text AS product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p."isPublished" = true
       WHERE c."isPublished" = true
       GROUP BY c.slug, c.name, c."sortOrder"
       ORDER BY c."sortOrder" ASC
    `);

    return {
      origins: row?.origins ?? [],
      grades: row?.grades ?? [],
      // An empty catalogue yields nulls, which must not become NaN — a slider with NaN ends renders
      // as an unusable control rather than an empty one.
      minPrice: row?.min_price ? toRupees(BigInt(row.min_price)) : 0,
      maxPrice: row?.max_price ? toRupees(BigInt(row.max_price)) : 0,
      categories: categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        productCount: Number(category.product_count),
      })),
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/modules/catalog/catalog.facets.service.ts
git commit -F - <<'MSG'
feat(catalog): compute filter facets in SQL instead of fetching the whole catalogue
MSG
```

## Task 8: Combos

**A gap in the spec that this task has to resolve, so resolve it deliberately.**

`GET /catalog/combos` must return each combo's `components` — the retail packs inside the box. But
spec §5's thirty-three entities contain **no combo-composition table**. The composition exists only
in `frontend/src/mocks/combos.ts` as `comboSeeds`: a slug for the box, an occasion, a blurb, and a
list of `{ slug, size }` pairs. The seeder ported the combo *boxes* (they are ordinary products in the
`combos` category) but not their contents, because there was nowhere to put them.

Three options, and the choice matters:

1. **Add a `ComboComponent` entity plus a migration and seeder rows.** Correct eventually, wrong now:
   it invents schema the spec did not design, in a plan whose scope is catalogue *reads*, and the
   shape it should take depends on an admin editing UI that does not exist yet.
2. **Store the composition in a `Setting` row.** Puts editorial content in a key-value table and
   makes it invisible to a foreign key, so a deleted product leaves a dangling slug silently.
3. **Port `comboSeeds` to a backend constant, and record the schema decision for the admin plan.**

Take option 3. The composition is editorial data for six boxes that changes when someone launches a
new combo, not per order. Porting it verbatim preserves Phase 1's behaviour exactly, lets the frontend
stop importing the mock, and defers the schema question to the plan that will actually have an admin
screen to justify a shape. Write the deferral down where the constant lives, so the next person sees a
decision rather than an oversight.

Every rupee figure stays derived from the catalogue at read time, exactly as the mock's own comment
insists: *"a price edit can never leave a stale savings claim behind."*

**Files:**
- Create: `backend/src/modules/catalog/combo-composition.ts`
- Create: `backend/src/modules/catalog/combos.service.ts`
- Test: `backend/src/modules/catalog/combos.service.spec.ts`

- [ ] **Step 1: Port the composition**

Copy all **six** entries from `frontend/src/mocks/combos.ts` verbatim — slugs, occasions, blurbs and
component lists. Do not retype them from memory or abbreviate a blurb.

Checked so you can tell a port error from a data problem: `comboSeeds` has exactly **6** entries, and all
six box products (`daily-dry-fruit-combo`, `premium-nuts-combo`, `premium-family-combo`,
`office-snack-combo`, `trail-mix-combo`, `festive-combo`) exist and are published in the seeded database.
So `GET /catalog/combos` should return **6**.

Do not confuse that with the **8** products in the `combos` *category* — `corporate-gift-box` and
`festive-gift-box` are also in that category but are not combos. A test asserting the category count and
a test asserting the combo count are asserting different things, and 6 versus 8 is exactly the kind of
discrepancy that reads as a bug in the assembly.

```ts
// backend/src/modules/catalog/combo-composition.ts

/**
 * What goes inside each combo box.
 *
 * **Why this is a constant and not a table.** Spec §5 designs no combo-composition entity, and
 * `GET /catalog/combos` needs one. Rather than invent schema in a read-only plan, the six editorial
 * rows live here, ported verbatim from `frontend/src/mocks/combos.ts`.
 *
 * **Deferred decision, owned by the admin plan:** when admin can create a combo, this needs a real
 * entity — `ComboComponent(comboProductId, componentProductId, size, sortOrder)` — with foreign keys,
 * so deleting a product cannot leave a dangling slug that renders as a missing component. Until then
 * a bad slug here surfaces as an omitted component, which `combos.service.ts` logs rather than hides.
 *
 * Only slugs and pack sizes are stored. Every price, MRP and savings figure is derived from the live
 * catalogue on each read, so a price edit can never leave a stale savings claim on the combos page.
 */
export interface ComboComposition {
  /** Slug of the catalogue product that *is* the box. */
  slug: string;
  occasion: string;
  blurb: string;
  components: { slug: string; size: string }[];
}

export const COMBO_COMPOSITIONS: ComboComposition[] = [
  // ... all six entries from frontend/src/mocks/combos.ts, copied verbatim
];
```

- [ ] **Step 2: Write the failing test**

```ts
// backend/src/modules/catalog/combos.service.spec.ts
import { CombosService } from './combos.service';

const box = (slug: string, price: number, mrp: number) => ({
  slug,
  name: `Box ${slug}`,
  subtitle: 'A box',
  images: ['/box.jpg'],
  variants: [
    { size: '1kg', grams: 1000, channel: 'retail', price, mrp, available: 10, soldOut: false, sku: 'X', moq: 1 },
  ],
});

const pack = (slug: string, price: number, mrp: number) => ({
  slug,
  name: `Pack ${slug}`,
  subtitle: 'A pack',
  images: ['/pack.jpg'],
  variants: [
    { size: '250g', grams: 250, channel: 'retail', price, mrp, available: 10, soldOut: false, sku: 'Y', moq: 1 },
  ],
});

/** Records what was warned, so the omission tests can assert the promise the doc comment makes. */
function fakeLogger() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() };
}

function build(products: unknown[], compositions: unknown[]) {
  const catalog = { productsBySlugs: jest.fn().mockResolvedValue(products) };
  const logger = fakeLogger();
  // Three arguments, not two. An earlier version passed only the first two, which is TS2554 and takes
  // the whole suite down — and had it compiled, every omission test would have died on
  // `this.logger.warn` of `undefined`.
  return { service: new CombosService(catalog as never, compositions as never, logger as never), logger };
}

describe('CombosService.list', () => {
  const composition = [
    { slug: 'gift-box', occasion: 'Diwali', blurb: 'A blurb', components: [
      { slug: 'almonds', size: '250g' },
      { slug: 'cashews', size: '250g' },
    ] },
  ];

  it('prices the combo from the box product, not from the sum of its parts', async () => {
    const service = build(
      [box('gift-box', 899, 999), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    const [combo] = await service.list();
    expect(combo?.price).toBe(899);
  });

  it('derives the parts figures and the savings from the live catalogue', async () => {
    const service = build(
      [box('gift-box', 899, 999), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    const [combo] = await service.list();
    expect(combo?.partsPrice).toBe(628);
    expect(combo?.partsMrp).toBe(728);
    expect(combo?.savings).toBe(728 - 899);
    expect(combo?.totalGrams).toBe(500);
  });

  /**
   * A combo whose box costs more than its parts' MRP has negative savings. Rendering "save -₹171"
   * would be worse than rendering nothing, and brief §1 forbids unsupported claims — so the figure
   * is floored at zero and `savingsPercent` with it.
   */
  it('never claims a negative saving', async () => {
    const service = build(
      [box('gift-box', 2000, 2000), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    const [combo] = await service.list();
    expect(combo?.savings).toBe(0);
    expect(combo?.savingsPercent).toBe(0);
  });

  /**
   * The savings figure needs a fixture where the box is **cheaper** than its parts, which is what a real
   * combo looks like.
   *
   * An earlier version of this suite priced the box at 899 against parts of 728 and asserted
   * `savings === 728 - 899`, i.e. −171 — which `Math.max(0, …)` floors to 0, so the assertion was simply
   * wrong. Worse, at that price *both* the correct derivation (`partsMrp − price`) and the classic wrong
   * one (`partsPrice − price`) floor to 0, so it could not have told them apart. A test that cannot
   * discriminate, in the file constraint 5 is printed beside.
   *
   * Proved load-bearing at these numbers: swapping to `partsPrice` gives 29 instead of 129.
   */
  it('derives savings against parts MRP, not parts price', async () => {
    const service = build(
      [box('gift-box', 599, 699), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    const [combo] = await service.list();
    expect(combo?.partsPrice).toBe(628);
    expect(combo?.partsMrp).toBe(728);
    expect(combo?.savings).toBe(129);
    expect(combo?.savingsPercent).toBe(18);
  });

  /**
   * A composition naming a product that no longer exists must not take the whole combos page down,
   * and must not silently price the box as though the missing pack were free. The component is
   * dropped and the combo is omitted, because a box advertising four things and listing three is a
   * worse outcome than one fewer card on the page.
   */
  it('omits a combo whose composition references a missing product', async () => {
    const service = build([box('gift-box', 899, 999), pack('almonds', 299, 349)], composition);
    expect(await service.list()).toEqual([]);
  });

  it('omits a combo whose own box product is missing', async () => {
    const service = build([pack('almonds', 299, 349), pack('cashews', 329, 379)], composition);
    expect(await service.list()).toEqual([]);
  });

  it('omits a component whose named pack size does not exist on that product', async () => {
    const wrongSize = [
      { slug: 'gift-box', occasion: 'D', blurb: 'B', components: [{ slug: 'almonds', size: '900g' }] },
    ];
    const service = build([box('gift-box', 899, 999), pack('almonds', 299, 349)], wrongSize);
    expect(await service.list()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test -w backend -- combos.service`
Expected: FAIL — `Cannot find module './combos.service'`.

- [ ] **Step 4: Implement the service**

```ts
// backend/src/modules/catalog/combos.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { Combo, ComboComponent, Product } from '@nutwala/shared';
import { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { CatalogService } from './catalog.service';
import { COMBO_COMPOSITIONS, type ComboComposition } from './combo-composition';

/** Injected so the spec can supply its own fixtures instead of the real six. */
export const COMBO_COMPOSITION_SOURCE = 'COMBO_COMPOSITION_SOURCE';

@Injectable()
export class CombosService {
  constructor(
    private readonly catalog: CatalogService,
    @Inject(COMBO_COMPOSITION_SOURCE) private readonly compositions: ComboComposition[],
    private readonly logger: WinstonLoggerService,
  ) {}

  /**
   * Assembles every combo from live catalogue prices.
   *
   * One query for every product involved — the boxes and their components together — rather than one
   * per combo, because six combos of four components each would otherwise be thirty round trips for
   * a page that renders six cards.
   */
  async list(): Promise<Combo[]> {
    const slugs = new Set<string>();
    for (const composition of this.compositions) {
      slugs.add(composition.slug);
      for (const component of composition.components) slugs.add(component.slug);
    }

    const products = await this.catalog.productsBySlugs([...slugs]);
    const bySlug = new Map(products.map((product) => [product.slug, product]));

    return this.compositions
      .map((composition) => this.assemble(composition, bySlug))
      .filter((combo): combo is Combo => combo !== null);
  }

  private assemble(
    composition: ComboComposition,
    bySlug: ReadonlyMap<string, Product>,
  ): Combo | null {
    const boxProduct = bySlug.get(composition.slug);
    if (!boxProduct) {
      this.logger.warn('Combo omitted: its box product is missing', { comboSlug: composition.slug });
      return null;
    }

    // The box holds 4 × 250g, so the box's own 1kg pack is the combo price.
    const boxVariant = boxProduct.variants.find((variant) => variant.grams === 1000);
    if (!boxVariant) {
      this.logger.warn('Combo omitted: its box has no 1kg pack', { comboSlug: composition.slug });
      return null;
    }

    const components: ComboComponent[] = [];
    for (const wanted of composition.components) {
      const product = bySlug.get(wanted.slug);
      const variant = product?.variants.find((candidate) => candidate.size === wanted.size);
      if (!product || !variant) {
        // Omit the whole combo rather than a component: a box advertising four things and listing
        // three misprices itself and misleads the customer.
        this.logger.warn('Combo omitted: a component could not be resolved', {
          comboSlug: composition.slug,
          componentSlug: wanted.slug,
          size: wanted.size,
        });
        return null;
      }
      components.push({
        slug: product.slug,
        name: product.name,
        size: variant.size,
        grams: variant.grams,
        price: variant.price,
        mrp: variant.mrp,
      });
    }

    const partsPrice = components.reduce((sum, component) => sum + component.price, 0);
    const partsMrp = components.reduce((sum, component) => sum + component.mrp, 0);
    // Floored at zero: brief §1 forbids unsupported claims, and "save -₹171" is worse than silence.
    const savings = Math.max(0, partsMrp - boxVariant.price);

    return {
      slug: boxProduct.slug,
      name: boxProduct.name,
      subtitle: boxProduct.subtitle,
      blurb: composition.blurb,
      occasion: composition.occasion,
      image: boxProduct.images[0] ?? '',
      price: boxVariant.price,
      partsMrp,
      partsPrice,
      savings,
      savingsPercent: partsMrp > 0 ? Math.round((savings / partsMrp) * 100) : 0,
      totalGrams: components.reduce((sum, component) => sum + component.grams, 0),
      components,
    };
  }
}
```

- [ ] **Step 5: Add the lookup the service needs, and provide the composition**

Append to `catalog.service.ts`:

```ts
  /** One query for a set of slugs. Used by combo assembly to avoid a round trip per component. */
  async productsBySlugs(slugs: readonly string[]): Promise<WireProduct[]> {
    if (slugs.length === 0) return [];
    const rows = await this.baseQuery()
      .andWhere('product.slug IN (:...slugs)', { slugs: [...slugs] })
      .getMany();
    return rows.map(toWireProduct);
  }
```

In `catalog.module.ts`, add the provider so the real compositions are injected in the app while the
spec can pass its own:

```ts
    { provide: COMBO_COMPOSITION_SOURCE, useValue: COMBO_COMPOSITIONS },
```

with `import { COMBO_COMPOSITIONS } from './combo-composition';` and
`import { COMBO_COMPOSITION_SOURCE } from './combos.service';`. `LoggingModule` is `@Global()`, so
`WinstonLoggerService` needs no import here — but do not inject the `WINSTON_LOGGER` symbol, which
`LoggingModule` provides without exporting.

- [ ] **Step 6: Run and commit**

Run: `npm run test -w backend -- combos.service`
Expected: PASS — 6 tests.

```bash
git add backend/src/modules/catalog/combo-composition.ts backend/src/modules/catalog/combos.service.ts backend/src/modules/catalog/combos.service.spec.ts backend/src/modules/catalog/catalog.service.ts backend/src/modules/catalog/catalog.module.ts
git commit -F - <<'MSG'
feat(catalog): assemble combos from live prices, with the composition ported server-side
MSG
```

## Task 9: Catalogue integration tests

Against real Postgres and the seeded catalogue. This is where the facets query, the sort semantics and
the sold-out invariant are actually proven — the unit specs above prove the service *asks* for the
right thing, which is a different claim.

Spec §10.1 asks for one test in particular, and it is the reason Tasks 1, 2 and 4 exist: over every
seeded fixture, `variant.soldOut === (variant.available === 0)` and `product.soldOut` equals
`variants.every(...)` across active variants. That test converts the duplication risk into a build
failure.

**Files:**
- Create: `backend/test/integration/catalog.integration.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// backend/test/integration/catalog.integration.spec.ts
import type { CatalogFacets, Category, Combo, Paginated, Product } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedContent } from '../../src/database/seeds/content.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent, cookieEntry, cookieValue, expectError, expectSuccess, request, useIntegrationApp,
} from './helpers';

const BASE = '/api/v1/catalog';

describe('catalog', () => {
  const integration = useIntegrationApp();

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
    /**
     * `seedContent` is **required**, not optional garnish. An earlier version of this block omitted it,
     * which would have run every review test in this file against a database with **zero reviews** — so
     * the summary assertions would have compared empty to empty and passed for the wrong reason, and the
     * rating test would have failed on `ratingAvg` being 0 rather than 3.67 with no obvious cause.
     *
     * It is also what recomputes `Product.ratingAvg` / `reviewCount` from approved rows, which is what
     * makes 3.67 the correct expectation. Order matters: it needs `seedCatalog` to have run.
     */
    await seedContent(integration.dataSource);
  });

  describe('GET /products', () => {
    it('is public — the shop must render for a visitor with no session', async () => {
      const response = await request(integration.app).get(`${BASE}/products`).expect(200);
      expect(expectSuccess<Paginated<Product>>(response).total).toBe(27);
    });

    it('paginates, and page 2 does not repeat page 1', async () => {
      const first = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?page=1&limit=10`).expect(200),
      );
      const second = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?page=2&limit=10`).expect(200),
      );

      expect(first.items).toHaveLength(10);
      expect(second.items).toHaveLength(10);
      expect(first.total).toBe(27);
      // The reason every sort carries a `product.id` tiebreak. Without it Postgres may return the
      // same row on two pages and a customer scrolling the shop sees a duplicate and a gap.
      const overlap = first.items.filter((item) =>
        second.items.some((other) => other.slug === item.slug),
      );
      expect(overlap).toEqual([]);
    });

    it('rejects an oversized limit rather than silently capping it', async () => {
      // `ProductQueryDto` carries `@Max(60)`, so validation refuses this before the service is reached —
      // which means `CatalogService`'s own clamp is **unreachable over HTTP** and its unit test covers a
      // defence-in-depth path only. An earlier version of this test expected a 200 capped to 60.
      const response = await request(integration.app)
        .get(`${BASE}/products?limit=5000`)
        .expect(400);
      expect(expectError(response).details).toHaveProperty('limit');
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      // `forbidNonWhitelisted: true` is deliberate: a typo'd filter that is silently dropped looks
      // like a broken filter, and a filter that silently does nothing is how `inStockOnly` stayed
      // a no-op through all of Phase 1.
      const response = await request(integration.app)
        .get(`${BASE}/products?sortt=price-asc`)
        .expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });

    it('filters by category slug and treats "all" as no filter', async () => {
      const almonds = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?category=almonds`).expect(200),
      );
      expect(almonds.total).toBe(3);
      expect(almonds.items.every((item) => item.category === 'almonds')).toBe(true);

      const all = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?category=all`).expect(200),
      );
      expect(all.total).toBe(27);
    });

    it('searches name, subtitle and origin', async () => {
      const byName = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?q=mamra`).expect(200),
      );
      expect(byName.items.map((item) => item.slug)).toContain('mamra-almonds');

      const byOrigin = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?q=bihar`).expect(200),
      );
      expect(byOrigin.total).toBeGreaterThan(0);
    });

    it('sorts by the per-kg price, ascending and descending', async () => {
      const asc = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?sort=price-asc&limit=60`).expect(200),
      );
      const kgPrice = (product: Product): number =>
        product.variants.find((variant) => variant.grams === 1000)?.price ??
        product.variants[0]?.price ??
        0;
      const prices = asc.items.map(kgPrice);
      expect([...prices].sort((a, b) => a - b)).toEqual(prices);
      // The cheapest per-kg product in the seed is sunflower seeds at 449.
      expect(kgPrice(asc.items[0] as Product)).toBe(449);
    });

    it('emits rupees, never paise', async () => {
      const response = await request(integration.app).get(`${BASE}/products?limit=60`).expect(200);
      for (const product of expectSuccess<Paginated<Product>>(response).items) {
        for (const variant of product.variants) {
          /**
           * Per **kilogram**, not per pack.
           *
           * An earlier version asserted `price < 100_000` and failed on a correct catalogue: mamra
           * almonds' 50kg bulk pack is legitimately ₹143,450. A flat ceiling cannot tell a large pack
           * from a paise value — it rejects real data while still admitting a hundred-fold error on a
           * 100g pouch. The implied per-kg rate can do both: the dearest seeded product is ₹3,499/kg, and
           * a paise value would read as ₹349,900/kg.
           */
          const perKg = variant.price / (variant.grams / 1000);
          expect(perKg).toBeLessThan(10_000);
          expect(variant.mrp).toBeGreaterThanOrEqual(variant.price);
        }
        expect(typeof product.gstRate).toBe('number');
        expect(product.gstRate).toBe(5);
      }
    });
  });

  /**
   * Spec §10.1's required invariant. This is the test that turns "one derivation, reused everywhere"
   * from a convention into a build failure.
   */
  describe('sold-out derivation', () => {
    /**
     * Spec §10.1's required invariant — **and it must be run against drained stock.**
     *
     * An earlier version of this test swept all 27 seeded products as-is. Because the fixture stocks
     * every variant, it compared `false` to `false` 216 times and stayed **green against a hardcoded
     * `soldOut: false`**. Proved, by stripping the drains below and breaking the mapper: the sweep passed.
     * The most important test in this milestone could not fail.
     *
     * So: drain one variant of one product and every variant of another *first*, then assert both `true`
     * and `false` actually appear in the flags. The `toContain` guards are what stop a future fixture
     * change quietly making it vacuous again.
     *
     * `soldOutByRule` rather than an inline `variant.available === 0`, because that expression trips the
     * `no-restricted-syntax` rule Task 2 added — the rule catching this file is the rule working. The
     * parameter is named `stock` rather than `available` for the same reason. Importing `variantSoldOut`
     * would compare the implementation against itself and prove nothing.
     */
    const soldOutByRule = (stock: number): boolean => stock === 0;

    it('agrees with available on every seeded variant and product', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id = (
           SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'premium-california-almonds' AND v.size = '250g')
      `);
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'golden-raisins')
      `);

      const response = await request(integration.app).get(`${BASE}/products?limit=60`).expect(200);
      const products = expectSuccess<Paginated<Product>>(response).items;
      expect(products).toHaveLength(27);

      const variantFlags: boolean[] = [];
      const productFlags: boolean[] = [];
      for (const product of products) {
        for (const variant of product.variants) {
          expect(variant.soldOut).toBe(soldOutByRule(variant.available));
          variantFlags.push(variant.soldOut);
        }
        expect(product.soldOut).toBe(product.variants.every((v) => soldOutByRule(v.available)));
        productFlags.push(product.soldOut);
      }

      // Both values must be present, or the sweep proved nothing.
      expect(variantFlags).toContain(true);
      expect(variantFlags).toContain(false);
      expect(productFlags).toContain(true);
      expect(productFlags).toContain(false);
    });

    it('reports a variant sold out once its stock is drained, and not before', async () => {
      // Drain one 250g pack and leave its siblings alone, so the product must stay in stock while
      // that one variant goes out. This is brief §11's per-variant requirement.
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0
         WHERE variant_id = (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'premium-california-almonds' AND v.size = '250g'
         )
      `);

      const response = await request(integration.app)
        .get(`${BASE}/products/premium-california-almonds`)
        .expect(200);
      const product = expectSuccess<Product>(response);

      const drained = product.variants.find((variant) => variant.size === '250g');
      const sibling = product.variants.find((variant) => variant.size === '500g');
      expect(drained?.available).toBe(0);
      expect(drained?.soldOut).toBe(true);
      expect(sibling?.soldOut).toBe(false);
      expect(product.soldOut).toBe(false);
    });

    it('reports the product sold out only when every active variant is drained', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'golden-raisins'
         )
      `);

      const response = await request(integration.app)
        .get(`${BASE}/products/golden-raisins`)
        .expect(200);
      expect(expectSuccess<Product>(response).soldOut).toBe(true);
    });

    it('counts reserved stock against availability', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 5, reserved = 5
         WHERE variant_id = (
           SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'w320-cashews' AND v.size = '1kg'
         )
      `);
      const response = await request(integration.app).get(`${BASE}/products/w320-cashews`).expect(200);
      const variant = expectSuccess<Product>(response).variants.find((v) => v.size === '1kg');
      expect(variant?.available).toBe(0);
      expect(variant?.soldOut).toBe(true);
    });
  });

  describe('inStockOnly', () => {
    it('actually filters, and respects the channel', async () => {
      // Drain every retail variant of one product, leaving its bulk packs stocked. Phase 1's filter
      // used `some` across *all* variants, so this product wrongly survived a retail stock filter.
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'kimia-dates' AND v.channel = 'RETAIL'
         )
      `);

      const retail = expectSuccess<Paginated<Product>>(
        await request(integration.app)
          .get(`${BASE}/products?inStockOnly=true&channel=retail&limit=60`)
          .expect(200),
      );
      expect(retail.items.map((item) => item.slug)).not.toContain('kimia-dates');

      const bulk = expectSuccess<Paginated<Product>>(
        await request(integration.app)
          .get(`${BASE}/products?inStockOnly=true&channel=bulk&limit=60`)
          .expect(200),
      );
      expect(bulk.items.map((item) => item.slug)).toContain('kimia-dates');
    });
  });

  describe('GET /products/facets', () => {
    it('describes the whole catalogue, not one page', async () => {
      const facets = expectSuccess<CatalogFacets>(
        await request(integration.app).get(`${BASE}/products/facets`).expect(200),
      );

      // 27 products across 12 categories, so the counts must sum to 27 — the assertion that catches
      // a facets query accidentally scoped to a page.
      expect(facets.categories).toHaveLength(12);
      expect(facets.categories.reduce((sum, c) => sum + c.productCount, 0)).toBe(27);
      expect(facets.origins.length).toBeGreaterThan(5);
      expect(facets.grades.length).toBeGreaterThan(5);
      // Bounds in rupees, matching the per-kg figure the price filter uses.
      expect(facets.minPrice).toBe(449);
      expect(facets.maxPrice).toBe(3499);
    });

    it('is reachable at its own path rather than being matched as a product slug', async () => {
      // Route order: `products/facets` must be declared before `products/:slug`.
      await request(integration.app).get(`${BASE}/products/facets`).expect(200);
    });
  });

  describe('GET /products/:slug', () => {
    it('404s with a customer-readable message for an unknown slug', async () => {
      const response = await request(integration.app).get(`${BASE}/products/no-such-thing`).expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('includes every image in sortOrder', async () => {
      const product = expectSuccess<Product>(
        await request(integration.app).get(`${BASE}/products/mamra-almonds`).expect(200),
      );
      expect(product.images).toHaveLength(3);
    });
  });

  describe('GET /categories and /combos', () => {
    it('returns the twelve seeded categories in display order', async () => {
      const categories = expectSuccess<Category[]>(
        await request(integration.app).get(`${BASE}/categories`).expect(200),
      );
      expect(categories).toHaveLength(12);
      expect(categories[0]?.slug).toBe('almonds');
    });

    it('assembles combos with savings derived from live prices', async () => {
      const combos = expectSuccess<Combo[]>(
        await request(integration.app).get(`${BASE}/combos`).expect(200),
      );
      expect(combos.length).toBeGreaterThan(0);
      for (const combo of combos) {
        expect(combo.components.length).toBeGreaterThan(0);
        // `Math.max(0, partsMrp - price)`, not `partsPrice - price` — measured 497 where parts-minus-box
        // is 307. `savingsPercent` divides by `partsMrp` for the same reason.
        expect(combo.savings).toBe(Math.max(0, combo.partsMrp - combo.price));
        expect(combo.partsPrice).toBeGreaterThan(0);
        // Every figure in rupees.
        expect(combo.price).toBeLessThan(100_000);
      }
    });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:integration -w backend`
Expected: PASS — the 67 existing tests plus 20 new, 87 total across 6 suites.

- [ ] **Step 3: Prove the sold-out invariant test is load-bearing**

It is the single most important test in this milestone, so verify it fails when the derivation drifts:

```bash
cd /Users/kunal/Desktop/nutwala/backend
cp src/modules/catalog/mappers/product.mapper.ts "$SCRATCH/pm.bak"
python3 - <<'PY'
import pathlib, sys
# An earlier version of this script matched neither anchor: Task 4 shipped
# `variants.map((variant) => ({ available: availableFor(variant), isActive: variant.isActive }))`,
# not `activeVariants.map(… isActive: true)`, and `soldOut: false || productSoldOut(` is a semantic
# no-op regardless. Run as written it mutated nothing, the test passed, and the pass would have been
# recorded as proof that the test was load-bearing. Assert the replacement happened.
p = pathlib.Path('src/modules/catalog/mappers/product.mapper.ts')
before = p.read_text()
after = before.replace('soldOut: productSoldOut(', 'soldOut: productSoldOut([]) || false && productSoldOut(')
if after == before:
    sys.exit('MUTATION DID NOT APPLY — fix the anchor before trusting any result')
p.write_text(after)
PY
npx jest --config jest.integration.config.ts --runInBand -t "sold-out derivation" 2>&1 | grep -E "✕|Tests:"
cp "$SCRATCH/pm.bak" src/modules/catalog/mappers/product.mapper.ts
diff -q "$SCRATCH/pm.bak" src/modules/catalog/mappers/product.mapper.ts && echo RESTORED
```

Expected: the invariant test fails (an empty variant list makes `productSoldOut` vacuously true, so
every product claims to be sold out), then `RESTORED`.

- [ ] **Step 4: Commit**

```bash
git add backend/test/integration/catalog.integration.spec.ts
git commit -F - <<'MSG'
test(catalog): prove pagination, sort semantics and the sold-out invariant against Postgres
MSG
```

## Task 10: Reviews

Public reads are approved-only; creation is authenticated and lands `PENDING`. The denormalised
Measured seed state, so the tests can assert something concrete: **14 reviews, all `APPROVED`**, across 8
products, with 3 on `premium-california-almonds` giving it `ratingAvg` **3.67** and `reviewCount` **3**.
That is deliberately *not* the mock's `rating: 4.8, reviewCount: 324` — those were a Phase 1 display
device and Plan 1 recomputed from real rows, so a difference between the two is intended.

`Product.ratingAvg` and `Product.reviewCount` are recomputed from **approved rows only**, which is
what the seeder already does — so a pending review must not move the star rating on the product page.

**Files:**
- Create: `backend/src/modules/reviews/reviews.service.ts`, `reviews.controller.ts`, `reviews.module.ts`, `dto/create-review.dto.ts`, `mappers/review.mapper.ts`
- Test: `backend/src/modules/reviews/reviews.service.spec.ts`, and cases added to Task 9's integration spec

- [ ] **Step 1: Write the failing unit test for the summary maths**

The summary is the part with real logic; the reads are a `find` with a `where`.

```ts
// backend/src/modules/reviews/reviews.service.spec.ts
import { summarise } from './reviews.service';

const review = (rating: number, verifiedPurchase = false) => ({ rating, verifiedPurchase });

describe('summarise', () => {
  it('averages to one decimal place', () => {
    expect(summarise([review(5), review(4)]).average).toBe(4.5);
    expect(summarise([review(5), review(4), review(4)]).average).toBe(4.3);
  });

  it('counts verified purchases separately from the total', () => {
    const summary = summarise([review(5, true), review(4), review(3, true)]);
    expect(summary.total).toBe(3);
    expect(summary.verifiedCount).toBe(2);
  });

  /**
   * Five buckets always, five stars down to one, even where the count is zero. A distribution that
   * omits empty buckets makes the review histogram render with missing bars rather than short ones.
   */
  it('always returns five buckets, highest first', () => {
    const summary = summarise([review(5), review(5), review(3)]);
    expect(summary.distribution.map((bucket) => bucket.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(summary.distribution.map((bucket) => bucket.count)).toEqual([2, 0, 1, 0, 0]);
  });

  it('expresses each bucket as a whole percentage of the total', () => {
    const summary = summarise([review(5), review(5), review(4), review(1)]);
    expect(summary.distribution[0]?.percent).toBe(50);
    expect(summary.distribution[1]?.percent).toBe(25);
    expect(summary.distribution[4]?.percent).toBe(25);
  });

  /**
   * A product with no reviews must not divide by zero. `0/0` is `NaN`, which serialises to `null` in
   * JSON and renders as an empty star rating rather than "no reviews yet".
   */
  it('returns zeroes rather than NaN for a product with no reviews', () => {
    const summary = summarise([]);
    expect(summary.average).toBe(0);
    expect(summary.total).toBe(0);
    expect(summary.verifiedCount).toBe(0);
    expect(summary.distribution.every((bucket) => bucket.count === 0 && bucket.percent === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w backend -- reviews.service`
Expected: FAIL — `Cannot find module './reviews.service'`.

- [ ] **Step 3: Implement the mapper and service**

```ts
// backend/src/modules/reviews/mappers/review.mapper.ts
import type { Review as WireReview, ReviewStatus } from '@nutwala/shared';
import { ReviewStatus as ReviewStatusEnum } from '../../../entities/enums';
import type { Review } from '../../../entities/content/review.entity';

/**
 * Database enum to wire vocabulary, same translation shape as roles and channels.
 *
 * **The entity import is the aliased one, not the wire type.** Every other wire/DB pair in this repo is
 * distinguished by name — `Role`/`UserRole`, `Channel`/`VariantChannel`,
 * `PaymentMethod`/`PaymentMethodEnum` — so the bare name always means the wire vocabulary and every
 * mapper imports both without ceremony. `ReviewStatus`/`ReviewStatus` is the one colliding pair, and
 * aliasing the entity keeps that rule intact: inside the file whose whole job is keeping the two apart,
 * the uppercase enum never answers to the bare name.
 *
 * The mismatch is compiler-caught either way — `'APPROVED'` is not assignable to `'approved'` — so this
 * is about which reading is harder to misread, not about correctness.
 */
const TO_WIRE_STATUS: Record<ReviewStatusEnum, ReviewStatus> = {
  [ReviewStatusEnum.PENDING]: 'pending',
  [ReviewStatusEnum.APPROVED]: 'approved',
  [ReviewStatusEnum.REJECTED]: 'rejected',
};

export function toWireReview(review: Review): WireReview {
  return {
    id: review.id,
    // `productSlug` is a non-null snapshot column: a review survives its product being deleted
    // (`product_id` is `ON DELETE SET NULL`), so the slug is what identifies what was reviewed.
    productSlug: review.productSlug,
    author: review.author,
    rating: review.rating,
    body: review.body,
    ...(review.imageUrl ? { imageUrl: review.imageUrl } : {}),
    verifiedPurchase: review.verifiedPurchase,
    status: TO_WIRE_STATUS[review.status],
    createdAt: review.createdAt.toISOString(),
  };
}
```

```ts
// backend/src/modules/reviews/reviews.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { RatingBucket, Review as WireReview, ReviewSummary } from '@nutwala/shared';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Product } from '../../entities/catalog/product.entity';
import { Review } from '../../entities/content/review.entity';
import { ReviewStatus as ReviewStatusEnum } from '../../entities/enums';
import { toWireReview } from './mappers/review.mapper';
import type { CreateReviewDto } from './dto/create-review.dto';

/** The star values a histogram always shows, highest first. */
const STARS = [5, 4, 3, 2, 1] as const;

/**
 * Exported for its own unit test. Takes the minimum it needs rather than a full entity, so the spec
 * does not have to build one.
 */
export function summarise(
  reviews: readonly { rating: number; verifiedPurchase: boolean }[],
): ReviewSummary {
  const total = reviews.length;
  const distribution: RatingBucket[] = STARS.map((stars) => {
    const count = reviews.filter((review) => review.rating === stars).length;
    return { stars, count, percent: total === 0 ? 0 : Math.round((count / total) * 100) };
  });

  return {
    // Guarded, because `0/0` is NaN and JSON turns that into null, which renders as an empty rating
    // rather than "no reviews yet".
    average: total === 0 ? 0 : Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / total) * 10) / 10,
    total,
    verifiedCount: reviews.filter((review) => review.verifiedPurchase).length,
    distribution,
  };
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly dataSource: DataSource,
  ) {}

  /** Approved only. A pending review is invisible to everyone but its moderator. */
  async listForProduct(slug: string): Promise<WireReview[]> {
    const rows = await this.reviews.find({
      where: { productSlug: slug, status: ReviewStatusEnum.APPROVED },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toWireReview);
  }

  async summaryForProduct(slug: string): Promise<ReviewSummary> {
    const rows = await this.reviews.find({
      where: { productSlug: slug, status: ReviewStatusEnum.APPROVED },
      select: { rating: true, verifiedPurchase: true },
    });
    return summarise(rows);
  }

  /**
   * Creates a `PENDING` review and recomputes the product's aggregates.
   *
   * `verifiedPurchase` is **not** taken from the client — it is derived from whether this user has a
   * delivered order containing this product. Trusting a client-supplied flag would let anyone mint a
   * "Verified Purchase" badge, which is the whole value of the badge.
   *
   * Orders do not exist until the next plan, so this resolves to `false` today, with the query written
   * and commented where it belongs rather than left as a client-controlled field to be tightened later.
   */
  async create(slug: string, userId: string, dto: CreateReviewDto): Promise<WireReview> {
    const product = await this.products.findOne({ where: { slug }, select: { id: true, slug: true } });
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const created = await manager.getRepository(Review).save(
        manager.getRepository(Review).create({
          productId: product.id,
          productSlug: product.slug,
          userId,
          author: dto.author.trim(),
          rating: dto.rating,
          body: dto.body.trim(),
          imageUrl: dto.imageUrl?.trim() ?? null,
          // Server-derived, never client-supplied. See the doc comment above; becomes a real lookup
          // against delivered orders in the checkout plan.
          verifiedPurchase: false,
          status: ReviewStatusEnum.PENDING,
        }),
      );

      await this.recomputeAggregates(manager, product.id);
      return toWireReview(created);
    });
  }

  /**
   * Recomputes `ratingAvg` and `reviewCount` from **approved** rows only, in the same transaction as
   * the write.
   *
   * Approved-only matters: a pending review must not move the star rating on the product page, or a
   * single unmoderated one-star submission drops a product's public rating before anyone has read it.
   * The seeder computes these columns the same way, so the two cannot disagree.
   */
  private async recomputeAggregates(
    manager: EntityManager,
    productId: string,
  ): Promise<void> {
    await manager.query(
      `
      UPDATE products p
         SET "ratingAvg" = COALESCE(agg.avg_rating, 0),
             "reviewCount" = COALESCE(agg.review_count, 0)
        FROM (
          SELECT ROUND(AVG(r.rating)::numeric, 2) AS avg_rating,
                 COUNT(*)                          AS review_count
            FROM reviews r
           WHERE r.product_id = $1 AND r.status = 'APPROVED'
        ) agg
       WHERE p.id = $1
      `,
      [productId],
    );
  }
}
```

- [ ] **Step 4: Create the DTO, controller and module**

```ts
// backend/src/modules/reviews/dto/create-review.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Mirrors `frontend/src/features/reviews/schema.ts` so a submission the form accepts is not then
 * rejected by the server. `productSlug` is absent on purpose: it comes from the route, not the body,
 * so a caller cannot post a review for one product while reading another.
 */
export class CreateReviewDto {
  @ApiProperty({ example: 'Asha R.' })
  @IsString() @MinLength(2) @MaxLength(80)
  author: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt() @Min(1) @Max(5)
  rating: number;

  @ApiProperty({ example: 'Fresh, and the 500g pack is the right size for us.' })
  @IsString() @MinLength(20) @MaxLength(2000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(500)
  imageUrl?: string;
}
```

```ts
// backend/src/modules/reviews/reviews.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Review, ReviewSummary } from '@nutwala/shared';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('reviews')
@Controller('catalog/products/:slug/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Approved reviews for a product, newest first' })
  list(@Param('slug') slug: string): Promise<Review[]> {
    return this.reviews.listForProduct(slug);
  }

  @Public()
  @Get('summary')
  @ApiOperation({ summary: 'Rating average and star distribution' })
  summary(@Param('slug') slug: string): Promise<ReviewSummary> {
    return this.reviews.summaryForProduct(slug);
  }

  /**
   * Authenticated: a review needs an author to attribute and, later, a purchase to verify.
   * Rate-limited because it is a public write — five an hour is generous for a person and useless
   * for a script.
   */
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a review, which is held for moderation' })
  create(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewDto,
  ): Promise<Review> {
    return this.reviews.create(slug, user.id, dto);
  }
}
```

```ts
// backend/src/modules/reviews/reviews.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { Review } from '../../entities/content/review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [TypeOrmModule.forFeature([Review, Product])],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
```

Add `ReviewsModule` to `app.module.ts`'s `imports`.

- [ ] **Step 5: Add integration cases to Task 9's spec**

Append inside the top-level `describe('catalog', …)` block:

```ts
  describe('reviews', () => {
    it('returns only approved reviews', async () => {
      // The seeder's 14 reviews are all APPROVED. Insert a PENDING one and prove it stays hidden.
      await integration.dataSource.query(`
        INSERT INTO reviews (product_id, "productSlug", author, rating, body, "verifiedPurchase", status)
        SELECT p.id, p.slug, 'Nobody', 1, 'This should never be visible to a shopper.', false, 'PENDING'
          FROM products p WHERE p.slug = 'premium-california-almonds'
      `);

      const reviews = expectSuccess<Review[]>(
        await request(integration.app)
          .get(`${BASE}/products/premium-california-almonds/reviews`)
          .expect(200),
      );
      expect(reviews.every((review) => review.status === 'approved')).toBe(true);
      expect(reviews.map((review) => review.author)).not.toContain('Nobody');
    });

    it('excludes pending reviews from the summary, so one unmoderated star cannot move the rating', async () => {
      const before = expectSuccess<ReviewSummary>(
        await request(integration.app)
          .get(`${BASE}/products/premium-california-almonds/reviews/summary`)
          .expect(200),
      );

      await integration.dataSource.query(`
        INSERT INTO reviews (product_id, "productSlug", author, rating, body, "verifiedPurchase", status)
        SELECT p.id, p.slug, 'Nobody', 1, 'A one-star review awaiting moderation.', false, 'PENDING'
          FROM products p WHERE p.slug = 'premium-california-almonds'
      `);

      const after = expectSuccess<ReviewSummary>(
        await request(integration.app)
          .get(`${BASE}/products/premium-california-almonds/reviews/summary`)
          .expect(200),
      );
      expect(after).toEqual(before);
    });

    it('refuses an anonymous submission', async () => {
      await request(integration.app)
        .post(`${BASE}/products/premium-california-almonds/reviews`)
        .send({ author: 'Asha', rating: 5, body: 'A perfectly reasonable twenty-plus character body.' })
        // 403, not 401: `CsrfGuard` runs before `JwtAuthGuard` deliberately, so a state-changing
        // request with no CSRF token is refused before any session lookup happens.
        .expect(403);
    });

    it('never lets a client mint its own verified-purchase badge', async () => {
      const client = agent(integration.app);
      const login = await client
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);
      const { csrfToken } = expectSuccess<{ csrfToken: string }>(login);

      const created = expectSuccess<Review>(
        await client
          .post(`${BASE}/products/premium-california-almonds/reviews`)
          .set('X-CSRF-Token', csrfToken)
          // `verifiedPurchase` is not in the DTO, so `forbidNonWhitelisted` would reject it outright.
          // Sending a plausible body and asserting the flag proves the server derives it.
          .send({ author: 'Asha', rating: 5, body: 'A perfectly reasonable twenty-plus character body.' })
          .expect(201),
      );

      expect(created.verifiedPurchase).toBe(false);
      expect(created.status).toBe('pending');
    });

    /**
     * The approved-only recompute, tested through the path that actually triggers it.
     *
     * The summary test above inserts a `PENDING` row with raw SQL, which never calls
     * `recomputeAggregates` — so it cannot catch a recompute that counted pending rows, which is the
     * property it looks like it guards. This one posts through the API, where the recompute runs, and
     * asserts the **denormalised columns the product page reads** are untouched.
     *
     * Measured seed state: `ratingAvg` 3.67 across 3 approved reviews on this product. Dropping the
     * status filter makes a one-star pending submission count, giving (5+4+2+1)/4 = **3.00** — measured,
     * and what the broken recompute actually produced. An earlier version of this comment said 2.5.
     */
    it('does not let a pending submission move the product rating', async () => {
      const before = await integration.dataSource.query<{ avg: string; n: number }[]>(
        `SELECT "ratingAvg" AS avg, "reviewCount" AS n FROM products WHERE slug = $1`,
        ['premium-california-almonds'],
      );
      expect(before[0]?.avg).toBe('3.67');
      expect(before[0]?.n).toBe(3);

      const client = agent(integration.app);
      const login = await client
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      await client
        .post(`${BASE}/products/premium-california-almonds/reviews`)
        .set('X-CSRF-Token', expectSuccess<{ csrfToken: string }>(login).csrfToken)
        .send({ author: 'Asha', rating: 1, body: 'A one-star body of more than twenty characters.' })
        .expect(201);

      const after = await integration.dataSource.query<{ avg: string; n: number }[]>(
        `SELECT "ratingAvg" AS avg, "reviewCount" AS n FROM products WHERE slug = $1`,
        ['premium-california-almonds'],
      );
      expect(after[0]?.avg).toBe('3.67');
      expect(after[0]?.n).toBe(3);
    });
  });
```

Add `agent` and the `Review`/`ReviewSummary` types to that file's imports.

- [ ] **Step 6: Run everything and commit**

```bash
npm run test -w backend -- reviews.service
npm run test:integration -w backend
git add backend/src/modules/reviews backend/src/app.module.ts backend/test/integration/catalog.integration.spec.ts
git commit -F - <<'MSG'
feat(reviews): serve approved reviews and hold submissions for moderation
MSG
```

## Task 11: The query-string helper and the catalogue seam

`http.ts` has **no query-string support** — paths are opaque strings appended to `BASE_URL`, and only
`http.get` accepts an `AbortSignal`. Without one helper, every list call hand-rolls its own
serialisation and they drift: one omits `undefined`, another sends `inStockOnly=false`, a third
double-encodes a search term with a space in it.

**Files:**
- Create: `frontend/src/lib/query-string.ts`, `frontend/src/lib/query-string.test.ts`
- Rewrite: `frontend/src/features/catalog/api/index.ts`
- Modify: `frontend/src/features/catalog/types.ts`, `frontend/src/features/reviews/types.ts`
- Rewrite: `frontend/src/features/reviews/api/index.ts`

**The `+`-for-space encoding is correct — do not "fix" it.** `URLSearchParams` serialises
`application/x-www-form-urlencoded`, so a space becomes `+`. Express parses query strings with `qs`,
which decodes it back. Verified as a round trip rather than assumed:

| Input | On the wire | Server sees |
| --- | --- | --- |
| `kaju & badam` | `q=kaju+%26+badam` | `kaju & badam` |
| `California, USA` | `origin=California%2C+USA` | `California, USA` |
| `a+b` | `q=a%2Bb` | `a+b` |

The third row is the one worth knowing: a **literal** plus is escaped to `%2B`, so it survives rather
than arriving as a space. Someone seeing `+` in a URL and switching to `encodeURIComponent` to "fix" it
would break the round trip in the other direction.

- [ ] **Step 1: Write the failing test for the helper**

```ts
// frontend/src/lib/query-string.test.ts
import { describe, expect, it } from "vitest";
import { toQueryString } from "./query-string";

describe("toQueryString", () => {
  it("returns an empty string when there is nothing to send", () => {
    expect(toQueryString({})).toBe("");
    expect(toQueryString({ q: undefined })).toBe("");
  });

  it("prefixes with ? only when there is something to append", () => {
    expect(toQueryString({ q: "badam" })).toBe("?q=badam");
  });

  /**
   * Omitting `undefined` is the whole point. `ShopFilters` clears its checkbox to `undefined` rather
   * than `false`, and the backend's `forbidNonWhitelisted` validation rejects an unknown parameter —
   * so a serialiser that emitted `inStockOnly=undefined` would turn an unticked box into a 400.
   */
  it("omits undefined and null but keeps false and zero", () => {
    expect(toQueryString({ a: undefined, b: null, c: false, d: 0 })).toBe("?c=false&d=0");
  });

  it("encodes values that need it", () => {
    expect(toQueryString({ q: "kaju & badam" })).toBe("?q=kaju+%26+badam");
    expect(toQueryString({ origin: "California, USA" })).toBe("?origin=California%2C+USA");
  });

  it("sorts keys so the same filters always produce the same URL", () => {
    // React Query caches on the key, not the URL, but a stable URL keeps HTTP caches and server logs
    // legible and makes a failing request reproducible by copy-paste.
    expect(toQueryString({ sort: "rating", category: "almonds" })).toBe("?category=almonds&sort=rating");
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w frontend -- query-string`
Expected: FAIL — cannot resolve `./query-string`.

```ts
// frontend/src/lib/query-string.ts

/** What a query parameter may be before serialisation. */
type QueryValue = string | number | boolean | undefined | null;

/**
 * Serialises filters into a query string, `?` included, or `""` when there is nothing to send.
 *
 * `http.ts` takes an opaque path and offers no query support, so this is the single place list
 * parameters are encoded. `undefined` and `null` are dropped — the shop's filter components clear a
 * value to `undefined`, and the backend rejects unknown or malformed parameters outright, so emitting
 * `inStockOnly=undefined` would turn an unticked checkbox into a 400.
 */
export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `?${serialised}` : "";
}
```

- [ ] **Step 3: Rewrite the catalogue seam**

The exported surface keeps its shape so consumers change as little as possible — but the three list
methods now return `Paginated<Product>` rather than `Product[]`, which is breaking change A and is
handled in Task 12.

```ts
// frontend/src/features/catalog/api/index.ts
import type {
  CatalogFacets,
  Category,
  Combo,
  Paginated,
  Product,
  ProductFilters,
} from "@nutwala/shared";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The catalogue over the real API.
 *
 * Every method that took the mock's in-memory array now issues one request. Two behaviours are
 * deliberately preserved from the mock so no consumer has to change how it handles them:
 *
 * - `getProduct` and `getCategory` reject for an unknown slug. The mock threw `NotFoundError`; the
 *   server answers 404 and `http.ts` turns that into `ApiRequestError`. Both routes already cope, but
 *   **by different means, so do not "fix" either**: `product.$slug.tsx:92` tests `isError || !product`
 *   and renders its not-found state, while `category.$slug.tsx` never checks the error at all — it reads
 *   `category?.name ?? slug` throughout and shows the slug with an empty product grid. That degradation
 *   is deliberate and reads better than a 404 page; adding an error boundary there would replace a
 *   working empty state with a dead end.
 * - `listRelated` resolves to an empty page for an unknown slug rather than rejecting, because a
 *   related-products rail is decoration and must not break a page that otherwise renders.
 */
export const catalogApi = {
  listProducts: (filters: ProductFilters = {}): Promise<Paginated<Product>> =>
    http.get(`/catalog/products${toQueryString({ ...filters })}`),

  facets: (): Promise<CatalogFacets> => http.get("/catalog/products/facets"),

  getProduct: (slug: string): Promise<Product> =>
    http.get(`/catalog/products/${encodeURIComponent(slug)}`),

  listBestsellers: (limit = 8): Promise<Paginated<Product>> =>
    http.get(`/catalog/products/bestsellers${toQueryString({ limit })}`),

  listRelated: (slug: string, limit = 4): Promise<Paginated<Product>> =>
    http.get(`/catalog/products/${encodeURIComponent(slug)}/related${toQueryString({ limit })}`),

  listCategories: (): Promise<Category[]> => http.get("/catalog/categories"),

  getCategory: (slug: string): Promise<Category> =>
    http.get(`/catalog/categories/${encodeURIComponent(slug)}`),

  listCombos: (): Promise<Combo[]> => http.get("/catalog/combos"),
};
```

- [ ] **Step 4: Rewrite the reviews seam and turn both type files into shims**

```ts
// frontend/src/features/reviews/api/index.ts
import type { Review, ReviewDraft, ReviewSummary } from "@nutwala/shared";
import { http } from "@/lib/http";

const base = (slug: string): string => `/catalog/products/${encodeURIComponent(slug)}/reviews`;

/**
 * Reviews over the real API.
 *
 * The mock's `create` pushed onto the imported `reviews` array and handed back a `pending` row — so a
 * submitted review vanished on reload and the array grew for the lifetime of the tab. The server now
 * persists it as `PENDING`, which means a submission legitimately does **not** appear in the list, and
 * `useCreateReview`'s existing "only invalidate when approved" logic is correct rather than incidental.
 */
export const reviewsApi = {
  listForProduct: (slug: string): Promise<Review[]> => http.get(base(slug)),
  summaryForProduct: (slug: string): Promise<ReviewSummary> => http.get(`${base(slug)}/summary`),
  create: ({ productSlug, ...draft }: ReviewDraft): Promise<Review> =>
    http.post(base(productSlug), draft),
};
```

Replace the body of `frontend/src/features/reviews/types.ts` with a re-export shim, matching how
`features/catalog/types.ts` and `features/account/types.ts` already work:

```ts
/**
 * Re-export shim. The definitions moved to `shared/src/types/review.ts` in this plan, because the
 * server now produces these shapes and both sides must compile against one contract. Components keep
 * importing from here, so no call site changed.
 */
export type {
  RatingBucket,
  Review,
  ReviewDraft,
  ReviewStatus,
  ReviewSummary,
} from "@nutwala/shared";
```

Delete `summarise` from `features/reviews/api/index.ts` — the server owns that maths now, and a second
copy on the client is a second answer to the same question. If a component imports it, point that
component at `useReviewSummary` instead.

Add `CatalogFacets` to the re-exports in `frontend/src/features/catalog/types.ts`.

- [ ] **Step 5: Verify, then commit**

```bash
cd /Users/kunal/Desktop/nutwala
npm run test -w frontend -- query-string
npm run typecheck -w frontend
```

Expected: the helper's 5 tests pass. **The typecheck will fail**, with errors at every consumer that
treats a list result as an array — `ShopPage.tsx`, `routes/index.tsx`, `product.$slug.tsx`,
`category.$slug.tsx`, `cart.tsx`, `bulk-orders.tsx`, `bulk.$category.tsx`, `gifting.tsx`,
`SearchDialog.tsx`, `CartProvider.tsx`. That is breaking change A announcing itself, and Task 12 fixes
it. Read the list of errors before starting Task 12 — it is the accurate inventory of what to change.

```bash
git add frontend/src/lib/query-string.ts frontend/src/lib/query-string.test.ts frontend/src/features/catalog/api/index.ts frontend/src/features/catalog/types.ts frontend/src/features/reviews
git commit -F - <<'MSG'
feat(frontend): point the catalogue and review seams at the real API
MSG
```

## Task 12: Consume the paginated envelope, and get facets from the server

Fixes every typecheck error Task 11 produced. Two shapes of change: read `.items` where an array was
assumed, and replace the two full-catalogue facet fetches with the facets hook.

**Files.** This list was built by grepping every call site, not from memory — an earlier version named
nine files and missed six, and since implementers are told not to touch files their task does not name,
that gap either blocks the work or invites it to exceed its mandate silently.

**Seventeen `useProducts` call sites across sixteen files**, plus the hook module:

- Modify: `frontend/src/features/catalog/hooks/useCatalog.ts`
- Modify: `frontend/src/features/catalog/components/ShopPage.tsx` (**two** calls, lines 50 and 54), `SearchDialog.tsx`
- Modify: `frontend/src/routes/index.tsx`, `product.$slug.tsx`, `category.$slug.tsx`, `cart.tsx`, `bulk-orders.tsx`, `bulk.$category.tsx` (**two** calls, 68 and 80), `gifting.tsx`
- Modify: `frontend/src/features/gifting/components/CorporateGiftingForm.tsx`
- Modify: `frontend/src/features/cart/CartProvider.tsx`
- **Also, and missing from the earlier list:**
  - `frontend/src/features/checkout/components/CheckoutForm.tsx` (line 92)
  - `frontend/src/components/layout/CartDrawer.tsx` (line 13)
  - `frontend/src/routes/business/bulk-cart.tsx` (line 21)
  - `frontend/src/routes/business/rfqs/index.tsx` (line 19)
  - `frontend/src/routes/business/rfqs/new.tsx` (line 70)
  - `frontend/src/routes/business/rfqs/$id.tsx` (line 15)

**Not affected:** `routes/combos.tsx` — `useCombos` returns `Combo[]`, which this plan does not paginate.
And `routes/blog/$slug.tsx`'s `useRelatedPosts` is the content feature, untouched here.

**Watch for the `= []` default.** Nine of those call sites destructure as `const { data: products = [] } = useProducts()`. That default is only meaningful for an array; against `Paginated<Product>` it becomes a
type error rather than a silent `[]`, which is the outcome you want — but the fix is
`const { data } = …` then `data?.items ?? []`, not moving the default onto the envelope.

- [ ] **Step 1: Add the facets hook and keep the list hooks honest**

In `useCatalog.ts`, add to `catalogKeys`:

```ts
  facets: () => [...catalogKeys.all, "facets"] as const,
```

and the hook:

```ts
/**
 * Filter options for the shop sidebar.
 *
 * Replaces the second, unfiltered `useProducts()` that `ShopPage` and `bulk.$category` each fired to
 * derive origins, grades and price bounds from the whole catalogue. That worked only while lists were
 * unpaginated; against a paginated list it would have described one page and been quietly wrong.
 *
 * `staleTime` is generous because facets change when the catalogue changes, not per keystroke.
 */
export const useProductFacets = () =>
  useQuery({
    queryKey: catalogKeys.facets(),
    queryFn: () => catalogApi.facets(),
    staleTime: 5 * 60 * 1000,
  });
```

The list hooks need no signature change — they already return whatever `catalogApi` resolves to, which
is now `Paginated<Product>`. Leave `useProducts`, `useBestsellers` and `useRelated` alone so the
diff stays at the consumers, where the decisions are.

- [ ] **Step 2: Rewire `ShopPage`**

Three edits:

1. Delete the whole-catalogue query (`useProducts()` with no arguments) and the facet derivation that
   reads it. Replace with `const { data: facets } = useProductFacets();`
2. Read the list as `products?.items ?? []`. **Two places use `.length`, not one:** the count at line 171
   (`{products?.length ?? 0} products`) and the empty-state test at line 200
   (`products && products.length > 0`). The count is the one that matters — left alone it reports the page
   size and tells a customer the shop has 24 products — but the empty-state check would be a type error
   and must become `(products?.items.length ?? 0) > 0`.
3. Feed the sidebar from `facets`. Note its actual prop contract before writing this:
   `ShopFilters` takes `origins: string[]`, `grades: string[]` and **`priceCeiling: number`** — a
   single value, not a min/max pair. The existing `useMemo` rounds it up to the next 500 and falls
   back to 5000 for an empty catalogue, so preserve that:

   ```ts
   const { data: facets } = useProductFacets();
   const priceCeiling =
     !facets || facets.maxPrice === 0 ? 5000 : Math.ceil(facets.maxPrice / 500) * 500;
   ```

   `CatalogFacets.minPrice` is not consumed by the sidebar today. It is served anyway because a price
   *slider* with a floor is the obvious next thing to want and computing it costs nothing in the same
   aggregate — but do not wire it into a prop that does not exist.

Then add pagination controls. The shadcn `components/ui/pagination.tsx` primitive already exists in the
repo and is imported by nothing; use it rather than writing another. Page state belongs in the route's
search schema beside the filters, so a link to page 3 of a filtered shop is shareable:

```ts
// frontend/src/routes/shop.tsx — add to the existing search schema
  page: z.number().int().min(1).optional(),
```

**And changing a filter must reset the page, or the shop shows an empty grid.** `ShopPage.tsx:47`'s
`setFilter` spreads `{ ...prev, ...patch }`, so once `page` lives in the same object it survives every
filter change: pick a category while on page 3 of the unfiltered shop, land on page 3 of a result that
has one page, and see nothing. The customer's filter appears to have deleted the catalogue.

Two functions rather than one, because they want opposite things:

```ts
  /** Any filter change returns to the first page. */
  const setFilter = (patch: Partial<ShopSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true });

  /** Paging keeps every filter and changes only the page. */
  const setPage = (page: number) =>
    navigate({ search: (prev) => ({ ...prev, page: page === 1 ? undefined : page }), replace: true });
```

`page: undefined` rather than `1` in both, so the first page has no `?page=` in the URL — which keeps the
shareable link for an unpaged shop identical to what it is today, and means `resetFilters` needs no
special case.

Apply the same pair to `bulk.$category.tsx`, which has its own copy of `setFilter` and the same trap.

- [ ] **Step 3: Rewire the remaining consumers**

Each is a one-line change from an array to `.items`:

| File | Change |
| --- | --- |
| `routes/index.tsx` | `useBestsellers(8)` and `useProducts({ category: "combos" })` → `.items` |
| `product.$slug.tsx` | `useRelated(slug)` → `.items` |
| `category.$slug.tsx` | `useProducts({ category: slug })` → `.items`, and the empty-state test uses `.total === 0` |
| `cart.tsx`, `bulk-orders.tsx`, `gifting.tsx`, `CorporateGiftingForm.tsx` | `useProducts(...)` → `.items` |
| `SearchDialog.tsx` | `useProducts({ q: debounced })` → `.items`; pass `limit: 8` so the dialog stops pulling a full page per keystroke |
| `bulk.$category.tsx` | `.items`, and move `maxMoq` server-side — see the note below. Do **not** delete it |

### `maxMoq` has to move server-side, and an earlier version of this plan said to delete it

That instruction was wrong. `maxMoq` is not a client-side artefact — it is a **user-facing filter with
clickable buttons**: `bulk.$category.tsx` declares it in its search schema (line 31), filters on it
(line 95), counts it as an active filter (line 128), and renders a row of buttons for it (lines 147-150).
Deleting it removes a feature customers use.

But leaving it client-side is also wrong now, and quietly so: it filters whatever page was fetched, so
under pagination the results and the count describe page 1 rather than the category. It happens to be
harmless today — the largest category holds **8** products against a default limit of 24, so there is
only ever one page — which is exactly the kind of accident that breaks silently when a category grows.

So add it properly. Three small edits, and they are in this task's file list because nothing else touches
them:

1. `shared/src/types/catalog.ts` — `maxMoq?: number` on `ProductFilters`, beside `channel`.
2. `backend/src/modules/catalog/dto/product-query.dto.ts` — `@IsOptional() @toNumber() @IsNumber() @Min(0) maxMoq?: number`.
3. `backend/src/modules/catalog/catalog.service.ts` — in `applyFilters`:
   ```ts
   if (filters.maxMoq !== undefined) {
     query.andWhere('product.moqKg <= :maxMoq');
     parameters.maxMoq = filters.maxMoq;
   }
   ```
   `moqKg` is `numeric`, so Postgres compares it against the number correctly without a cast. The seeded
   values are `5.00`, `10.00` and `25.00`, which is what the page's buttons offer.

Then delete only the client-side `.filter(...)` at line 95 and pass `maxMoq: search.maxMoq` into the hook.
The buttons, the schema field, the reset and the active-filter count all stay.

- [ ] **Step 4: Point `CartProvider`'s product lookup at the new shape**

`CartProvider.tsx:46` calls `catalogApi.listProducts()` directly into local state because cart pricing
needs a synchronous product lookup. It now needs `.items`, and it must ask for enough rows:

```ts
    void catalogApi.listProducts({ limit: 60 }).then((page) => setProducts(page.items));
```

This is a stopgap until Task 25 replaces the whole provider with the server cart, which prices lines
server-side and removes the need to hold the catalogue in the browser at all. Leave a comment saying
so, or the next reader will assume holding 27 products in memory is the design.

- [ ] **Step 5: Verify against the real API in a browser**

Automated tests will pass with a stub; the thing worth checking is the shop with real data.

```bash
cd /Users/kunal/Desktop/nutwala
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
```

Use the stack that is already running. **Do not start your own**, and do not write logs to `/tmp` — the
root `dev` script is `concurrently … --kill-others-on-fail`, so a port collision in one workspace tears
down the other two, and scratch output belongs in the session scratchpad. If nothing is listening on
5173, say so rather than starting it.

Then open <http://localhost:5173/shop> and confirm, by looking:

- The product count reads **27**, not 24 — the tell that `total` is being read rather than the page length.
- The origin and grade filter lists are fully populated, and the price slider's ends are 449 and 3499.
- Ticking **In stock only** leaves all 27 products, because everything is stocked. Then drain one
  product's stock and confirm it disappears:
  ```bash
  docker exec nutwala-postgres psql -U nutwala -d nutwala -c "UPDATE inventory SET \"onHand\"=0 WHERE variant_id IN (SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='golden-raisins');"
  ```
  Reload with the filter on: 26 products, and `golden-raisins` gone. **Restore it by `UPDATE`-ing back
  the `onHand` you captured — not with `npm run seed`, and "which is idempotent" was the wrong reason to
  reach for it.**

  The seeder *is* largely idempotent: it `upsert`s on natural keys (`slug`, `key`, `orderNumber`), so
  product and variant ids survive. Two things it is not. `ProductImage` and `PricingTier` are
  delete-then-insert, because neither has a unique index — the seeder says so at
  `catalog.seed.ts:648`. And, decisively, `catalog.seed.ts:56` documents this:

  > *…but leaves the append-only ledger alone. So reseeding a database that has since recorded real
  > stock movements will break that invariant.*

  It resets `inventory.onHand` to the opening 120/40 and leaves `inventory_transactions` alone. Task 22
  ships `PATCH /admin/inventory/:variantId`, which writes those rows — so from that task onward a reseed
  silently breaks `SUM(inventory_transactions.delta) == inventory.onHand`, which is definition-of-done
  item 7 and is asserted by `schema-invariants.integration.spec.ts`. The failure surfaces later, in a
  suite that has nothing to do with whoever reseeded.
- Paging to 2 shows different products, and no product appears on both pages.

Leave the servers as you found them.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/catalog frontend/src/routes frontend/src/features/cart/CartProvider.tsx frontend/src/features/gifting
git commit -F - <<'MSG'
feat(frontend): read the paginated catalogue and take facets from the server
MSG
```

## Task 13: Render SOLD OUT

The visible payoff of Milestone 3, and one of the two things the client brief asks for by name. Until
now `available` and `soldOut` have existed in the types and been read by **nothing** — verified: a
case-insensitive grep across `frontend/src` finds six `soldOut` hits, every one of them data or a test
fixture, and no component, route or hook that reads either field.

Two rules, both from spec §10.1:

- **Per variant.** A 1kg pack can be sold out while 250g is in stock. Disabling the whole product
  because one size ran out loses a sale that was available.
- **Adding to cart reserves nothing** — the same behaviour as Amazon and Flipkart. Stock is checked
  here for feedback, and authoritatively again at checkout. So a variant that goes out of stock while
  it sits in someone's basket is expected, not a bug, and `POST /cart/validate` is what surfaces it.

**Files:**
- Modify: `frontend/src/features/catalog/components/ProductCard.tsx`
- Modify: `frontend/src/routes/product.$slug.tsx`
- Modify: `frontend/src/features/bulk/components/BulkProductCard.tsx`
- Create: `frontend/src/features/catalog/selection.ts` — the shared `openingRetailSize` derivation
- Test: `frontend/src/features/catalog/components/ProductCard.test.tsx` (new)
- Test: `frontend/src/features/bulk/components/BulkProductCard.test.tsx` (new) — the bulk card's badge
  and its disabled Add to Bulk Cart have nothing proving them otherwise
- Modify: `frontend/src/mocks/products.ts`

- [ ] **Step 1: Write the failing component test**

```tsx
// frontend/src/features/catalog/components/ProductCard.test.tsx
import type { Product, Variant } from "@nutwala/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProductCard } from "./ProductCard";

const variant = (size: string, available: number): Variant => ({
  sku: `SKU-${size}`,
  size,
  grams: size === "1kg" ? 1000 : 250,
  channel: "retail",
  price: 299,
  mrp: 349,
  moq: 1,
  available,
  soldOut: available <= 0,
});

const product = (variants: Variant[]): Product =>
  ({
    slug: "premium-california-almonds",
    name: "Premium California Almonds",
    category: "almonds",
    subtitle: "Crunchy kernels.",
    description: "",
    rating: 4.8,
    reviewCount: 324,
    images: ["/a.jpg"],
    origin: "California, USA",
    grade: "Independence",
    processing: "",
    shelfLife: "",
    storage: "",
    ingredients: "",
    hsn: "0802",
    gstRate: 5,
    variants,
    bulkTiers: [],
    moqKg: 10,
    soldOut: variants.every((v) => v.available <= 0),
    seo: { title: "", description: "", ogImage: "" },
  }) as Product;

describe("ProductCard sold-out states", () => {
  it("does not shout SOLD OUT when everything is in stock", () => {
    render(<ProductCard product={product([variant("250g", 120), variant("1kg", 40)])} />);
    expect(screen.queryByText(/sold out/i)).toBeNull();
  });

  /**
   * Per-variant, per spec §10.1 and brief §11. The card must offer the size that is in stock rather
   * than refusing the whole product, or a product with one empty pack size stops selling entirely.
   */
  it("disables only the sold-out size and leaves its siblings selectable", () => {
    render(<ProductCard product={product([variant("250g", 0), variant("1kg", 40)])} />);
    expect(screen.getByRole("button", { name: /250g/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /1kg/ })).toBeEnabled();
  });

  it("marks the whole card sold out only when every variant is out", () => {
    render(<ProductCard product={product([variant("250g", 0), variant("1kg", 0)])} />);
    expect(screen.getByText(/sold out/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeDisabled();
  });

  /**
   * The card must **not** open on a sold-out size when a stocked one exists.
   *
   * `ProductCard.tsx:14` hardcodes `useState("250g")`, so with 250g out and 1kg in stock it would open
   * on the empty size with Add to Cart disabled — a customer looking at a product that is available,
   * being shown a button that refuses. That is a self-inflicted lost sale, and it is the default state
   * of the page rather than something they did.
   *
   * So the initial selection becomes the first **available** retail size, falling back to the first
   * retail size when every one is out (in which case the product-level SOLD OUT badge is what explains
   * the disabled button).
   */
  it("opens on an available size rather than a sold-out default", () => {
    render(<ProductCard product={product([variant("250g", 0), variant("1kg", 40)])} />);
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /1kg/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("still disables Add to Cart when the customer picks a sold-out size", async () => {
    const user = userEvent.setup();
    render(<ProductCard product={product([variant("250g", 0), variant("1kg", 40)])} />);
    await user.click(screen.getByRole("button", { name: /250g/ }));
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeDisabled();
  });

  /**
   * `available` is a stock level, not a marketing number. Publishing "3 left" invites the pressure
   * tactics brief §1 rules out, and it leaks inventory to competitors. The flag is what renders.
   */
  it("never prints the raw stock figure", () => {
    render(<ProductCard product={product([variant("250g", 3), variant("1kg", 40)])} />);
    expect(screen.queryByText(/\b3\b\s*(left|remaining|in stock)/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w frontend -- ProductCard`

**The prediction that used to sit here — "FAIL, the size buttons are enabled and no SOLD OUT text
exists" — is wrong, and describes a failure that never happens.** As implemented, this is what the three
runs actually produced:

```
Run 1, the test exactly as written above: 6 tests | 6 failed, none on an assertion
  Error: useCart must be used inside CartProvider
    at useCart src/features/cart/CartProvider.tsx:144:17
    at ProductCard src/features/catalog/components/ProductCard.tsx:16:25

Run 2, after wrapping in CartProvider + RouterProvider: 4 failed | 2 passed
  Unable to find an accessible element with the role "button" and name `/250g/`
  There are no accessible roles.
  <body><div /></body>
```

Run 2 is the trap worth knowing: `RouterProvider` performs its first route match in an **effect**, so a
synchronous `render()` returns an empty body and every `queryBy*` assertion passes against nothing —
two of the six tests went green vacuously. Use **`RouterContextProvider`**, which supplies router
context and renders children immediately. Write a `renderCard` harness once rather than repeating it.

Only then do the real assertion failures appear (`toBeDisabled` on an enabled chip, no `/sold out/i`
text, `aria-pressed` returning `null`).

**And one of the six tests above cannot pass at all — delete it rather than trying.** *"still disables
Add to Cart when the customer picks a sold-out size"* is unsatisfiable alongside tests 2 and 4: test 2
requires the real `disabled` attribute (jest-dom's `toBeDisabled` ignores `aria-disabled`), and neither a
browser nor `userEvent` dispatches a click on a disabled control. So the click is a no-op, 1kg stays
selected, and Add to Cart is correctly *enabled*. Measured with the full implementation in place, it was
the only failure: `1 failed | 5 passed`.

Replace it with two tests that can fail:

- the click is refused and the stocked size stays selected (`aria-pressed` unchanged);
- the plan's actual requirement — *disabled on the selected variant, not merely on the product* —
  reached through the only arrangement that can reach it: **every retail pack out while a bulk pack is
  stocked**, so `productSoldOut` reports not-sold-out and the retail Add to Cart must still refuse.

- [ ] **Step 3: Implement in `ProductCard`**

The card already filters to retail variants and defaults its selected size to `"250g"`. Add:

- **Change the initial size from the hardcoded `"250g"`.** `useState("250g")` predates any stock data,
  and leaving it means a product whose 250g pack has run out opens with a disabled button even though
  500g and 1kg are on the shelf. Same change in `product.$slug.tsx:43`, which hardcodes it too.

  **Not "the first available retail size", which is a merchandising regression.** The seeded
  catalogue's first retail pack is **100g** (`RETAIL_PACKS` in `mocks/products.ts:4`), not 250g — so
  "first available" opens every in-stock product on the smallest, cheapest pack, halving the default
  order value across the whole shop. Measured: it broke two pre-existing smoke tests, one asserting
  `₹132 / 100g` and one asserting a `250g` cart line.

  The rule is: **prefer 250g when it is stocked, and fall back to the first stocked pack only when it
  is not** — identical to today's behaviour whenever 250g is available, with the sold-out default still
  fixed. Put it in `frontend/src/features/catalog/selection.ts` as one `openingRetailSize` function
  shared by the card and the detail page; inlining the rule in both is the duplicate-derivation mistake
  this task spends a paragraph warning against, and two copies is how the card and the page come to
  disagree about which pack is selected.

  On the detail page, hold the size as `string | null` and derive the opening pack after the product
  loads, matching the existing `kgInput` pattern — editing the `useState("250g")` at line 43 directly is
  not possible, because no stock is known on the first render.
- A `SOLD OUT` badge over the image when `product.soldOut`, using the existing `Badge` component with
  the `destructive` variant so it matches the cancelled-order badge the account area already renders.

  **Know how rarely that flag is true before you write a test around it.** `productSoldOut`
  (`shared/src/catalog/availability.ts:48`) filters on `isActive`, **not on channel**, and every seeded
  product carries eight variants in one array — four retail packs (100g/250g/500g/1kg) and four bulk
  (5/10/25/50kg). So `product.soldOut` becomes true only when **all eight** are out, the 50kg pack
  included. Draining every retail size leaves it `false`.

  That is defensible on the merits — the product genuinely is still purchasable, by the kilo — but it
  leaves a gap on the retail card: every size chip disabled and Add to Cart refused, with no badge
  saying why. Recorded rather than changed, because "does a retail card say SOLD OUT for something you
  can still buy in bulk" is a merchandising decision, not a bug. If it is taken up, the fix is for the
  card to aggregate the server's per-variant flags over the variants **it displays**
  (`retailVariants.every((v) => v.soldOut)`) — which is not the second derivation this task warns
  against, because it reads `soldOut` rather than recomputing it from `available`; it asks a different
  question, scoped to what the card sells.
- `disabled={variant.soldOut}` on each size button, plus a muted style and `aria-label` including
  "sold out" so the state is not colour-only — a screen reader must hear it too. **Write a test for the
  `aria-label` specifically.** None of the six tests above covers it: removing the label entirely leaves
  all of them green, because `getByRole("button", { name: /250g/ })` matches the plain text content just
  as well. It was the one accessibility requirement in this list with nothing enforcing it.
- **`aria-pressed={v.size === variant.size}` on each size button.** Step 1 asserts this and **nothing
  renders it today** — verified: the only `aria-pressed` in `ProductCard.tsx` is on the wishlist heart,
  and the size buttons signal their selection with `border-primary bg-primary` alone. Without this
  attribute the fourth test can never pass, and adding it is the same argument the bullet above makes
  for sold-out: a selected state carried only by colour is not announced.
- `disabled` on Add to Cart when the **selected** variant is sold out, not merely when the product is.
- Do **not** render `available`. The flag is the contract; the number is inventory.

Apply the same changes to `routes/product.$slug.tsx` (its size buttons, quantity stepper, Add to Cart
and Buy Now), including the hardcoded `useState("250g")` at line 43.

**`BulkProductCard.tsx` takes only the product-level pair**, not the per-size changes: it has **no size
buttons**. Verified — it renders a kg stepper (`useState(product.moqKg)`, `Minus`/`Plus`) and prices off
`bulkTiers[].pricePerKg`, so there is no per-variant control to disable and no selected variant to read.
Give it the `SOLD OUT` badge on `product.soldOut` and `disabled` on **Add to Bulk Cart** when it is set.
Leave **Request Quote** enabled: an RFQ for something out of stock is a legitimate order to place, which
is the whole point of a lead time, and `needsQuote` products have no purchasable stock at all.

Do not derive the state inline. Read `variant.soldOut` and `product.soldOut` — the server computed
them with the shared helper, and recomputing on the client is exactly the second derivation Task 2's
lint rule exists to prevent. The frontend's eslint config does not carry that rule, so this one is on
you rather than the tooling.

**One exception, and only one: `frontend/src/mocks/products.ts:138`.** It still carries
`soldOut: variants.every((v) => v.available === 0)` — the inline derivation the plan's file table said
would import the shared helper, and with `=== 0` where the helper uses `<= 0`. The mock is not a
consumer of server data; it *plays the server*, which is why it is allowed to derive at all. Replace
that line with `productSoldOut(variants.map((v) => ({ available: v.available, isActive: true })))` and
the two hardcoded per-variant `soldOut: false` literals (lines 32 and 48) with `variantSoldOut(...)`.
`isActive: true` is honest here: the mock has no inactive variants, and the server filters them out
before they reach this shape. Note that `mocks/products.ts` is imported **only** by
`src/test/catalog-api.stub.ts` — it is test fixture data, so this is a consistency fix, not a
user-facing one.

**And it is provably not load-bearing**, which is worth stating rather than leaving someone to assume
otherwise: reverting it to `variants.every((v) => v.available === 0)` leaves the whole suite green,
because the mock fixes `available` at 120 and 40, where `=== 0` and `<= 0` agree. Make the change
anyway — it is the fixture the sold-out tests are read against, and a fixture whose rule differs from
production's is how a false green happens — but do not claim a test protects it.

**And you could not recompute it correctly even if you tried**, which is worth knowing before you
reach for the helper: `productSoldOut` needs `{ available, isActive }` per variant, and a wire
`Variant` has `available` but **no `isActive`** — inactive variants are filtered out server-side and
never reach the client. Calling the helper over `product.variants` would therefore be measuring a
different set from the one the server measured. Read the fields.

Expected count: the listing above contains **6** `it(` blocks, not the 5 an earlier version of this
line claimed. With the unsatisfiable one replaced by two, plus the `aria-label` test, plus the bulk
card's own file, the committed total is 9 across two new files — frontend 149 → 162.

- [ ] **Step 4: Run the tests and check it in a browser**

```bash
npm run test -w frontend -- ProductCard
npm run test -w frontend
```

Then, with both servers up, drain one size and look at `/shop` and the product page:

**Do not reseed the development database to undo this.** Capture the original figures, mutate, look,
then restore exactly what you captured. `npm run seed -w backend` rewrites rows other work depends on,
and the standing constraint on this project is that the dev data is not yours to replace.

```bash
# 1. Capture. Keep this output — it is your undo.
docker exec nutwala-postgres psql -U nutwala -d nutwala -At -F'|' -c \
 "SELECT i.variant_id, i.\"onHand\" FROM inventory i JOIN product_variants v ON v.id=i.variant_id \
  JOIN products p ON p.id=v.product_id WHERE p.slug='premium-california-almonds';"

# 2. Drain one size.
docker exec nutwala-postgres psql -U nutwala -d nutwala -c \
 "UPDATE inventory SET \"onHand\"=0 WHERE variant_id=(SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.slug='premium-california-almonds' AND v.size='250g');"

# 3. …look at the pages… then restore, one UPDATE per captured pair:
docker exec nutwala-postgres psql -U nutwala -d nutwala -c \
 "UPDATE inventory SET \"onHand\"=<captured> WHERE variant_id='<captured-uuid>';"

# 4. Prove you restored it: this must print the same rows as step 1.
```

`available` is `onHand - reserved`, so restoring `onHand` restores `available` — nothing else was
touched.

Expected: on `/product/premium-california-almonds` the 250g button is disabled and audibly labelled
sold out, 500g and 1kg are selectable, the card shows no product-level SOLD OUT badge, and Add to Cart
becomes enabled once you pick 500g. Then drain every variant of one product and confirm the card in
`/shop` carries the badge with Add to Cart disabled.

Restore with the step-3 UPDATEs above and re-run step 1 to confirm. Not with `npm run seed`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/catalog/components frontend/src/routes/product.\$slug.tsx frontend/src/features/bulk/components/BulkProductCard.tsx frontend/src/mocks/products.ts
git commit -F - <<'MSG'
feat(frontend): render SOLD OUT per variant and refuse to add what is not there
MSG
```

## Task 14: Keep admin out of the customer app, and make it enforceable

**Decided by the user during this plan:** the admin console will be a **separate application in its own
repository**, not routes inside this one. This task makes the customer app hold that line by itself
rather than by anyone remembering.

What actually exists today, verified rather than assumed:

- **No `/admin` route files exist** in `frontend/src/routes/`. There is nothing to delete.
- `admin` appears in exactly two places: `frontend/src/mocks/users.ts` (which dies with the mocks) and
  the role enum in `frontend/src/features/auth/storage.ts`, which **must stay** — the API returns
  `admin` and a snapshot that failed to parse it would sign the admin out on every reload.
- `LoginForm.tsx:35` redirects to `redirectTo ?? "/account"` unconditionally. This is the real defect
  the user hit: signing in as `admin@demo.in` lands on the customer account page, which offers to
  "Track orders, manage addresses and keep your details current" — none of which is what an admin came
  for.

**Files:**
- Modify: `frontend/src/features/auth/components/LoginForm.tsx`
- Create: `frontend/src/features/auth/admin-redirect.ts`
- Create: `frontend/src/test/no-admin-routes.test.ts`
- Modify: `frontend/.env.development`, and document the variable in `README.md`

- [ ] **Step 1: Write the failing guard test**

This is the control. A comment saying "admin lives elsewhere" is not one.

**Facts checked before writing it, because this is the first frontend test in the repo that reads from
disk** — nothing else does, so none of it was established:

- `import.meta.dirname` **is** a string inside a Vitest test, and `readdirSync`/`readFileSync` work at
  runtime. Verified by running a probe, not assumed from Node's docs. **But the file does not
  typecheck**, which the probe could not have told us: `frontend/tsconfig.app.json` pins
  `"types": ["vite/client"]`, so `node:fs` and `import.meta.dirname` produce four errors under
  `tsc -b` (`TS2591` ×2, `TS2339`, `TS7006`).

  Build the guard on `import.meta.glob("../routes/**/*.{ts,tsx}", { query: "?raw", eager: true })`
  instead — `vite/client` already types it, and it gives both the file list and their contents.
  **Do not add `"node"` to the app's `types`** to make the original compile: that makes `process` and
  `Buffer` typecheck in every file of a browser bundle, to buy one test a directory listing.
- `frontend/src/routeTree.gen.ts` exists and is **not** gitignored, so it is safe to assert against.
- **It contains zero `createFileRoute` calls.** The generated tree imports the route modules and
  declares paths as `path: '/about'`; `createFileRoute` appears only in the 37 route *files*. So the
  two greps must target different things: `createFileRoute(\s*["'`]\/admin` against the route files,
  and `["'`]\/admin` against the generated tree, which matches its `path: '/admin'` form.
- Zero `/admin` paths in the tree today, so the suite starts green — which is why Step 2 requires you to
  make it fail before trusting it.

```ts
// frontend/src/test/no-admin-routes.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = path.resolve(import.meta.dirname, "../routes");

function everyFileUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? everyFileUnder(full) : [full];
  });
}

/**
 * The admin console is a separate application in its own repository. This suite is what stops an
 * admin screen drifting back into the customer app — which is the easy thing to do, because the
 * component library and the auth client are right here and it would work.
 *
 * It would also mean shipping admin code to every shopper and putting admin screens on the customer
 * origin, which is precisely the isolation the separate repo was chosen for.
 */
describe("the customer app contains no admin surface", () => {
  it("has no route file under an admin path", () => {
    const offenders = everyFileUnder(ROUTES)
      .map((file) => path.relative(ROUTES, file))
      .filter((file) => /(^|[./\\])admin/i.test(file));
    expect(offenders).toEqual([]);
  });

  it("declares no route whose path is /admin", () => {
    const offenders = everyFileUnder(ROUTES)
      .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
      .filter((file) => /createFileRoute\(\s*["'`]\/admin/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  /**
   * The generated route tree is the honest answer to "what does this app actually serve", because it
   * is what the router registers. A hand-written route file that escaped the checks above would still
   * appear here.
   */
  it("registers no /admin path in the generated route tree", () => {
    const tree = readFileSync(path.resolve(ROUTES, "../routeTree.gen.ts"), "utf8");
    expect(tree).not.toMatch(/["'`]\/admin/);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes today**

Run: `npm run test -w frontend -- no-admin-routes`
Expected: PASS — 3 tests. This one starts green on purpose: it is a regression guard, not a bug report.
Prove it can fail before trusting it:

```bash
cd /Users/kunal/Desktop/nutwala/frontend
mkdir -p src/routes/admin && cat > src/routes/admin/index.tsx <<'TSX'
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/admin/")({ component: () => null });
TSX
npx vitest run src/test/no-admin-routes.test.ts 2>&1 | grep -E "✕|Tests"
rm -rf src/routes/admin
npx vitest run src/test/no-admin-routes.test.ts 2>&1 | grep -E "Tests"
```

Expected: **three** failures with the offending path named, then green again after removal. Not two —
`tanstackRouter` is in `vite.config.ts`'s plugin list and Vitest shares that config, so planting a route
file regenerates `routeTree.gen.ts` **mid-run** and the generated-tree assertion fails as well:

```
expected [ 'admin/index.tsx' ] to deeply equal []              (route file check)
expected [ 'admin/index.tsx' ] to deeply equal []              (createFileRoute check)
expected '/* eslint-disable */…' not to match /["'`]\/admin/    (generated tree)
```

That regeneration is a side effect worth knowing about before you trigger it: **the proof dirties a
tracked file.** `routeTree.gen.ts` is committed, so after `rm -rf src/routes/admin` confirm it is back —
`git status` clean, or compare its checksum before and after. A guard you have never seen fail is a guard
you are guessing about; a proof that leaves a generated file rewritten is a different problem.

- [ ] **Step 3: Send an admin to the admin app instead of the customer account page**

```ts
// frontend/src/features/auth/admin-redirect.ts
import type { Role } from "@nutwala/shared";

/**
 * Where the admin console lives. Configured rather than hardcoded, because it differs per
 * environment and this app must not assume it is deployed beside anything.
 *
 * Unset in development, which is the common case while only the customer app is running: an admin
 * then stays put and sees the notice below rather than being bounced to a dead URL.
 */
const ADMIN_APP_URL: string | undefined = import.meta.env.VITE_ADMIN_APP_URL;

export const isAdmin = (role: Role | null | undefined): boolean => role === "admin";

/**
 * The admin console is a separate app in its own repo, so this is a **full page navigation**, not a
 * router `navigate()`. Using the router would look like it worked and then render nothing, because
 * this app has no `/admin` route and — per `no-admin-routes.test.ts` — never will.
 */
export function redirectToAdminApp(): boolean {
  if (!ADMIN_APP_URL) return false;
  window.location.assign(ADMIN_APP_URL);
  return true;
}
```

In `LoginForm.tsx`, replace the unconditional redirect:

```tsx
      const user = await login(values);
      // An admin has no business in the customer account area. Send them to the console if this
      // environment knows where it is; otherwise leave them on the sign-in page with an explanation,
      // which is more honest than dropping them into a customer dashboard that offers to manage their
      // delivery addresses.
      if (isAdmin(user.role)) {
        if (redirectToAdminApp()) return;
        setError("This is an administrator account. Please sign in through the admin console.");
        return;
      }
      toast.success(`Welcome back, ${user.name.split(" ")[0]}`);
      await navigate({ to: redirectTo ?? "/account" });
```

**Keep the `toast.success` line, and keep it *after* the admin branch.** The version of this snippet
originally in the plan omitted it, which would have silently deleted the welcome toast every customer
gets — `LoginForm.tsx:34` has it today, between the `login` call and the `navigate`. It belongs below
the branch rather than above it: "Welcome back, Nazaakat" beside "please sign in through the admin
console" is a contradiction, and an admin who is being turned away has not arrived anywhere.

- [ ] **Step 4: Add the variable and document it**

Add to `frontend/.env.development` — which is gitignored by the root `.gitignore` rule `.env.*`, so it
cannot be committed and the README has to carry the fact:

```
# Where the separate admin console is served. Leave unset while only this app runs locally: an admin
# signing in then gets an explanatory message instead of being sent to a URL that is not listening.
# VITE_ADMIN_APP_URL=http://localhost:5174
```

`frontend/.env.development` **already exists** (447 bytes, holding `VITE_API_URL`). **Append** to it.
Do not create or overwrite it. It is ignored by `.gitignore:48` (`.env.*`), so it cannot be committed —
which is exactly why the README has to carry the fact.

In `README.md`, two specific edits, not one:

- **`## \`frontend/.env.development\` is optional` (line 198) says: "The frontend reads exactly one
  variable, `VITE_API_URL`".** This task makes that sentence false. Correct it to name both variables
  and say what each does.
- **`## Configuration reference` (line 270)** — add `VITE_ADMIN_APP_URL` to it: optional, unset in
  development, and when unset an admin signing in gets an explanatory message instead of a navigation.
  State that the admin console is a separate application in its own repository, not a route here.

- [ ] **Step 5: Add a test for the redirect decision**

**The snippet this task originally carried named three things that do not exist.** Measured against
`frontend/src/test/routes.smoke.test.tsx`: there is no `renderRoute` (the helper is
`renderAt(path, seedCart?, seedAuth?)`, defined at line 98), there is no `signIn` helper at all (every
existing test types into the form with `userEvent`), and the fixture accounts live in the smoke test at
line 66 as `const sessions: Record<"b2c" | "b2b", User>` — **not** in `auth-api.stub.ts`, which only
exports `STUB_PASSWORD` and `installAuthStub`. Use the version below.

**Do not call `installAuthStub` yourself in the test.** `renderAt` already installs it (line 104) and
restores the previous one first. A second install would put two handlers on `globalThis.fetch`, which is
the order-dependency this plan warns about elsewhere and which Task 11's `catalog-api.stub.ts` was
deliberately *delegated from* `installAuthStub` to avoid.

Three edits to `routes.smoke.test.tsx`:

```tsx
// 1. Widen the fixture record and add the admin (line 66).
const sessions: Record<"b2c" | "b2b" | "admin", User> = {
  // …b2c and b2b unchanged…
  admin: {
    id: "usr-admin-001",
    name: "Nazaakat Admin",
    email: "admin@demo.in",
    phone: "9800000000",
    role: "admin",
    createdAt: "2025-11-04T09:12:00.000Z",
  },
};

// 2. Widen `renderAt`'s seed union and let the admin sign in (lines 98 and 106).
async function renderAt(path: string, seedCart?: CartLine[], seedAuth?: "b2c" | "b2b" | "admin") {
  // …
    accounts: [sessions.b2c, sessions.b2b, sessions.admin],
```

```tsx
// 3. The test itself.
  it("does not drop an admin into the customer account area", async () => {
    // VITE_ADMIN_APP_URL is unset under Vitest, so the honest outcome is an explanation rather than a
    // navigation to a URL that is not listening. What must not happen is landing on /account.
    const user = userEvent.setup();
    await renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in", level: 1 }, { timeout: 5000 });

    await user.type(screen.getByLabelText("Email"), "admin@demo.in");
    await user.type(screen.getByLabelText("Password"), STUB_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert).toHaveTextContent(/admin console/i);
    // `/account` renders `<h1>Overview</h1>` — the suite already keys on it at line 988 for the
    // successful b2c sign-in. Its *absence* is the assertion that the admin did not land there.
    // `window.location.pathname` would be worthless here: the router runs on `createMemoryHistory`,
    // so jsdom's URL never changes and `not.toBe("/account")` is true no matter what the code does.
    expect(screen.queryByRole("heading", { name: "Overview", level: 1 })).toBeNull();
  }, 30000);
```

`role="alert"` is the right query rather than `findByText`: `LoginForm` already renders its error as
`<p role="alert" className="text-destructive …">`, and the two existing failure tests key on that role.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/kunal/Desktop/nutwala
npm run test -w frontend
npm run typecheck -w frontend && npm run lint -w frontend
git add frontend/src/features/auth frontend/src/test README.md
git commit -F - <<'MSG'
feat(frontend): keep the customer app free of admin surface, and route admins away
MSG
```

## Task 15: Milestone 3 verification

- [ ] **Step 1: Run every suite**

```bash
cd /Users/kunal/Desktop/nutwala
npm run build -w @nutwala/shared
npm run test -w @nutwala/shared
npm run typecheck -w backend && npm run lint -w backend && npm run test -w backend
npm run test:integration -w backend
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
npm run format:check -w backend && npm run format:check -w frontend
npm run build
```

Expected: **every suite green, and no count lower than when the milestone started.** Do not assert
absolute totals here — an earlier version named "backend unit 120, integration 87" and was stale within
three tasks, which turns a verification step into a chore that gets edited rather than trusted.

Record what you actually observe, and compare against the figures at the head of Task 15's commit rather
than against a number written days earlier. For reference, the state entering Task 13 was: shared **61**,
backend unit **178**, backend integration **105**, frontend **149**.

- [ ] **Step 2: Confirm the milestone's claims in a browser, not in a test**

With both servers up.

**`npm run seed -w backend` is not the undo for any row in this table.** Every check below mutates the
development database, and the standing constraint on this project is that its seeded data is not ours to
replace — other work depends on those rows and on their ids. So for each check: `SELECT` the current
value first and keep the output, mutate, look at the page, then `UPDATE` it back to exactly what you
captured (or `DELETE` the row you inserted, by its id). Re-run the `SELECT` at the end and show that it
matches the one you took at the start. That last step is the deliverable, not a formality — a restore you
did not verify is a restore you are guessing about.

| Claim | How to see it |
| --- | --- |
| The shop reads Postgres | Change a product's name with `psql`, reload `/shop`, see the new name, then `UPDATE` it back to the value you captured. |
| The count is the catalogue, not the page | `/shop` reads 27 products with a page size of 24. |
| Facets describe everything | Origin and grade lists are complete; the price slider ends at 449 and 3499. |
| `inStockOnly` filters | Drain one product, tick the box, watch it leave. |
| SOLD OUT is per variant | Drain 250g of the almonds: that size disabled, 500g and 1kg selectable, no product badge. |
| SOLD OUT is per product | Drain every variant: card badge shows, Add to Cart disabled. |
| Reviews are approved-only | Insert a `PENDING` row; it does not appear and the rating does not move. `DELETE` that row by its id afterwards. |
| An admin is not shown the customer dashboard | Sign in as `admin@demo.in`; you get the console notice, not `/account`. |

- [ ] **Step 3: Commit the milestone note**

Add a short "Milestone 3 complete" section to this plan recording the final counts and anything that
turned out differently from what is written above, then:

```bash
git add docs/superpowers/plans/2026-08-20-nuts-nazaakat-catalogue-and-cart.md
git commit -F - <<'MSG'
docs(plan): record Milestone 3 completion
MSG
```

---

## Milestone 3 complete

**Measured 2026-08-20, not copied from an earlier run.**

| Suite | Result |
| --- | --- |
| `@nutwala/shared` | 61 passed / 4 files |
| backend unit | 178 passed / 15 suites |
| backend integration | 105 passed / 6 suites |
| frontend | 172 passed / 10 files |

`typecheck`, `lint`, `format:check` and `build` clean in both workspaces; root `npm run build` green.
No `.only`, `.skip`, `xit` or `fdescribe` anywhere — the only greps that matched were
`process.exit(1)` and `query.skip(...)`.

Entering Task 13 the figures were shared 61, backend 178, integration 105, frontend 149. Frontend
149 → 162 (Task 13) → 170 (Task 14) → 172 (the `/account` guard fix). Nothing regressed.

### What turned out differently from what this plan said

The plan's own corrections are listed against their tasks; these are the ones that changed the shape of
the work rather than a line of it.

1. **`guest_key` would have written a live credential into the logs.** Renamed to `guest_token` across
   79 references before any of it was built, and recorded as a deliberate deviation from spec §5.3.
2. **Two Milestone 4 defects would each have broken every request they touched**: `cartApi` posting the
   server's response shape into a DTO with `forbidNonWhitelisted` (400 on every cart write), and Task
   23's first guest test doing a cold `PUT` with no CSRF header (403). Both fixed in the plan.
3. **"First available retail size" was a merchandising regression** — the first retail pack is 100g, so
   it opened the whole shop on the smallest pack. Replaced with a shared `openingRetailSize` that
   prefers 250g when stocked.
4. **Four tests could not fail** and were replaced or corrected: Task 16's owner-exclusivity proof (the
   FK rejected the insert either way), Task 13's fifth case (a click on a disabled control is never
   dispatched), the `aria-label` requirement (nothing asserted it), and Task 17's redactor test (it
   restated the naming convention back to itself).
5. **The admin fix needed two halves, not one.** Routing an admin away at sign-in left
   `/account` reachable by direct navigation, because `requireAuth` checks presence and not role.

### Owed, and not to be ticked without doing it

**Every browser confirmation in Task 15 Step 2, and definition-of-done item 10** — but **not for the
reason recorded here originally, which was wrong.**

That reason was: the dev backend is serving a pre-catalogue build, `/api/v1/health` 200 and
`/api/v1/products` 404. The second probe was the mistake. `/api/v1/products` has never been a route —
`catalog.controller.ts` is `@Controller('catalog')`, so the path is `/api/v1/catalog/products`, which is
exactly how spec §6.1 lists it. Measured since: that path returns **200** with the seeded catalogue, and
`GET /api/v1/cart` returns 200 with a full six-field `CartTotals`. **The server was healthy the whole
time and `/shop` was never broken.** Tasks 13 onward were told to skip browser verification on a false
premise; that is a coverage loss, not a blocker.

One narrower thing *is* genuinely stale, and it is worth knowing because it is silent:
`dist/modules/catalog/catalog.service.js` has been frozen since 13:30 while the rest of the tree keeps
rebuilding, so the `maxMoq` filter its source carries three times over is absent from the running build.
`catalog/products?maxMoq=1` returns all 27 products instead of none — no error, no log line. See the
README's dev-server section. A backend restart fixes it; `nest build` must not be used, because
`deleteOutDir: true` deletes the `dist/` being served.

**Since discovering that, the payload-level half has been done — against the running server and the
development database, 2026-08-20:**

| Claim | Measured |
| --- | --- |
| The shop reads Postgres | `GET /catalog/products` → 200, seeded catalogue |
| The count is the catalogue, not the page | `total=27`, `items=24` at `limit=24` |
| Pages do not overlap | page 1 = 24, page 2 = 3, intersection **0**, union 27 |
| Facets describe everything | origins **13**, grades **19**, price **449–3499**, categories **12** |
| `soldOut` agrees with `available` | **0 disagreements** across 27 products and 216 variants |
| SOLD OUT is per variant | one pack drained → `available=0 soldOut=true`, `product.soldOut` stays **false** (seven siblings stocked) |
| SOLD OUT is per product | all eight drained → `product.soldOut=true` |
| `inStockOnly` filters real data | 27 → **26**, `golden-raisins` absent |
| Reviews are approved-only | a `PENDING` row inserted: **not listed**, and the summary did not move from 3.7 |
| The admin adjustment works | 16 audited `PATCH`es, `{"onHand":0}` then `{"onHand":120}` |
| `SUM(delta) == onHand` survives an adjustment | **0** variants disagree — definition-of-done item 7 |

Every mutation went through `PATCH /admin/inventory/:variantId` rather than raw SQL, precisely so the
ledger stayed consistent; the stock was captured first and `diff`ed after — **identical** — and the probe
review was deleted, leaving `APPROVED=14, total=14`.

**Two things remain genuinely unverified, and neither is a blocker:**

- **Visual rendering.** The badge, the disabled size chips and the refused Add to Cart are proven in
  jsdom only. Nothing here observed a browser.
- **`maxMoq`.** `catalog/products?maxMoq=1` returns all 27 rather than none, because
  `dist/modules/catalog/catalog.service.js` has been frozen since 13:30 while the rest of the tree
  rebuilds — the source carries the clause three times. A backend restart fixes it; `nest build` must
  not be used. See the README's dev-server section.

An earlier version of this paragraph read "no sold-out state, filter or facet in this milestone has been
seen in a browser", which was true and is still true of the *rendering* — but it was written as though
none of it had been checked at all, which is no longer the case.

Two narrower gaps, both stated rather than papered over: `redirectToAdminApp()`'s configured branch is
unproven (`VITE_ADMIN_APP_URL` is read once at module load, so exercising it needs `vi.stubEnv` plus
`vi.resetModules`), and the sold-out stock arrangement in `catalog-api.stub.ts` reaches only
`GET /catalog/products/:slug` — a sold-out card in the shop grid cannot be arranged that way yet.

---

# MILESTONE 4 — Cart and inventory

Goal: the cart lives on the server, a guest who signs in keeps their basket, and stock is checked
against real inventory.

Read spec §5.3, §10.1 and §10.2 before starting. Note that **nothing in this milestone reserves
stock** — spec §10.1 is explicit that adding to cart reserves nothing, the same as Amazon and Flipkart.
Stock is checked at add-to-cart for feedback and authoritatively at checkout, which is the next plan.

## Task 16: Make guest carts possible — a migration

**A gap between the spec and the schema, discovered rather than assumed.** Spec §5.3 designs
`Cart` as `id, userId? (null ⇒ guest), guestToken?`. The implemented table is:

```sql
CREATE TABLE "carts" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "user_id" uuid NOT NULL,          -- not nullable
  CONSTRAINT "PK_b5f695a59f5ebb50af3c8160816" PRIMARY KEY ("id")
)
```

`user_id` is **NOT NULL** and there is **no `guest_token` column**. A guest cart is therefore impossible
to store, which would be discovered halfway through Task 18 with the service already written.

`CartItem` is fine as it stands: spec §5.3 lists `size?` and `grams?`, but both are properties of the
variant the item already points at, so deriving them in the mapper is correct and storing them would be
a second copy that can disagree.

**The column is `guest_token`, not `guest_key` — and this is a security requirement, not a style
preference.** Spec §5.3 names the field `guestKey`; every task in this plan named it that until it was
measured against the real redactor. `common/logging/pii-redactor.ts` redacts a value whose *key*
contains `token`, and has no list of this application's field names:

```
redact({ guest_key:   'SECRETVALUE' })  ->  { guest_key:   'SECRETVALUE' }     <-- leaks
redact({ guestKey:    'SECRETVALUE' })  ->  { guestKey:    'SECRETVALUE' }     <-- leaks
redact({ guest_token: 'SECRETVALUE' })  ->  { guest_token: '[REDACTED]'  }
redact({ guestToken:  'SECRETVALUE' })  ->  { guestToken:  '[REDACTED]'  }
redact({ cart: { id: 'c1', guestKey: 'SECRET', guestToken: 'SECRET' } })
  ->  { cart: { id: 'c1', guestKey: 'SECRET', guestToken: '[REDACTED]' } }     <-- nested too
```

The value is a bearer credential: whoever holds it can read and replace that basket, and — per Task 17
— the same visitor's wishlist. Under `guestKey`, **any** log line that serialises a `Cart` row writes it
in plaintext: an error path dumping the entity, a debug line, TypeORM query logging. This is precisely
the `nn_rt` bug Plan 1 already paid for, one layer down: Plan 1 fixed the *cookie* name and left the
*column* name to be named after the spec.

Nothing is implemented yet, so the rename costs one edit here. After this migration runs it costs
another migration. The whole plan has been renamed to match — `guest_token`, `guestToken`,
`uq_carts_guest_token`, `readGuestToken`, `issueGuestToken`, `guest-token.ts`. Deviation from spec §5.3
is deliberate and recorded here.

**Files:**
- Create: `backend/src/database/migrations/20260820090000-GuestCarts.ts`
- Modify: `backend/src/entities/commerce/cart.entity.ts`

- [ ] **Step 1: Write the migration**

```ts
// backend/src/database/migrations/20260820090000-GuestCarts.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes a guest cart storable, per spec §5.3.
 *
 * `user_id` becomes nullable and `guest_token` arrives, with a check constraint asserting that exactly
 * one of them is set. Without that constraint the table permits a row belonging to nobody and a row
 * belonging to both, and both would be resolved by whichever `WHERE` clause happened to run first.
 *
 * The existing `uq_carts_user` unique index keeps working on a nullable column: Postgres treats NULLs
 * as distinct in a unique index, so any number of guest carts coexist while a user still has at most
 * one. That is exactly the semantics wanted, so the index is left alone rather than rebuilt as partial.
 */
export class GuestCarts20260820090000 implements MigrationInterface {
  name = 'GuestCarts20260820090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "carts" ALTER COLUMN "user_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "carts" ADD "guest_token" character varying(64)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_carts_guest_token" ON "carts" ("guest_token") WHERE "guest_token" IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_owner_exclusive"
      CHECK (("user_id" IS NOT NULL AND "guest_token" IS NULL)
          OR ("user_id" IS NULL AND "guest_token" IS NOT NULL))
    `);
  }

  /**
   * Guest carts are deleted rather than adopted on the way down: there is no user to attribute them
   * to, and leaving them would violate the restored NOT NULL. A `DELETE` in a `down()` deserves the
   * comment — this is a development-only reversal, and losing anonymous baskets is the correct
   * outcome of un-shipping the feature that created them.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "carts" DROP CONSTRAINT "ck_carts_owner_exclusive"`);
    await queryRunner.query(`DROP INDEX "public"."uq_carts_guest_token"`);
    await queryRunner.query(`DELETE FROM "carts" WHERE "user_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "carts" DROP COLUMN "guest_token"`);
    await queryRunner.query(`ALTER TABLE "carts" ALTER COLUMN "user_id" SET NOT NULL`);
  }
}
```

- [ ] **Step 2: Update the entity to match**

**Rewrite the class docblock as well as the fields.** It read *"Persisted for signed-in users only.
Guests keep their cart in localStorage and merge it on login (spec §7)"* — the exact opposite of what
this migration establishes, sitting directly above the new `guestToken` column. Leaving it ships a
comment that actively misleads whoever writes Task 18. It now describes the two-owner model: keyed by
`userId` or by `guestToken`, exactly one set, a guest's basket merged rather than lost on sign-in.

In `cart.entity.ts`:

```ts
  @Index('uq_carts_user', { unique: true })
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  /**
   * Opaque key for an anonymous cart, held in the `nn_guest_token` cookie. Exactly one of this
   * and `userId` is set — `ck_carts_owner_exclusive` enforces it in the database rather than trusting
   * every future writer to remember.
   */
  @Column({ type: 'varchar', length: 64, name: 'guest_token', nullable: true })
  guestToken: string | null;
```

**Migration ordering — three keys measured, the fourth predicted.** Only two migrations existed when
this was written, so `Wishlist20260820100000` (Task 26's) could not be checked: the three real keys are
`0260819120000 < 0260819130000 < 0260820090000`, verified arithmetically *and* by applying the whole
chain to an empty database in order. The Wishlist key computes correctly **if that class name is used**,
so treat it as a prediction to confirm in Task 26 rather than as already done. The mechanism itself is
confirmed in the installed TypeORM: `MigrationExecutor.js:430` is
`parseInt(migrationClassName.substr(-13), 10)`.
TypeORM derives a migration's ordering timestamp from the **last 13 characters of the class name**, so the
four sort keys are `0260819120000` (InitialSchema), `0260819130000` (AddReviewProductSnapshot),
`0260820090000` (GuestCarts) and `0260820100000` (Wishlist) — strictly ascending, with both new ones after
the existing pair and Wishlist after GuestCarts.

- [ ] **Step 3: Apply it and prove it reverts**

**Four constraint proofs, not two, and no seeder.** As written this step claims "owner exclusivity:
neither, and both" in a comment while issuing exactly one insert — the `NULL, NULL` one — so the `both`
branch is never exercised: a constraint written as only `user_id IS NOT NULL AND guest_token IS NULL`
would pass it. And it tests only the *guest* unique index, leaving `uq_wishlist_items_user_product`
unexercised. Run all four, and make each insert satisfy every constraint except the one under test, so
only that one can fire — the trap Task 16 paid for was a proof that passed with its constraint absent
because a foreign key rejected the row instead.

**Do not run `npm run seed` here**, which this step used to do: it resets `inventory.onHand` while
leaving the append-only ledger, breaking `SUM(delta) == onHand`. Insert one category, two products and
two users by hand on the throwaway — that is all the proofs need, and it removes any chance of pointing
the seeder somewhere it should not go. For the same reason do not `set -a && . ./.env`: that exports the
dev `DB_PORT` and `PORT=4400` into your shell before you override two of them. Write a literal env file
in the scratchpad and echo `DB_PORT` immediately before every write.

```bash
cd /Users/kunal/Desktop/nutwala
npm run migration:run -w backend
docker exec nutwala-postgres psql -U nutwala -d nutwala -c "\d carts"
```

Expected: `user_id` nullable, `guest_token` present, `ck_carts_owner_exclusive` listed.

Then prove both halves of the constraint bite, and that the migration reverses — on a throwaway
database, not the dev one. Remember `NODE_ENV=test`, or the exported `DB_PORT` is ignored and this
runs against the dev database:

```bash
docker run -d --name nn-cartcheck -e POSTGRES_USER=nutwala -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=nutwala -p 127.0.0.1:5558:5432 postgres:15-alpine >/dev/null
for i in $(seq 1 30); do docker exec nn-cartcheck pg_isready -U nutwala -q && break; sleep 1; done
cd backend && set -a && . ./.env && set +a
export NODE_ENV=test DB_PORT=5558 DB_PASSWORD=x
npm run migration:run
docker exec nn-cartcheck psql -U nutwala -d nutwala -c \
  "INSERT INTO carts (user_id, guest_token) VALUES (NULL, NULL);" 2>&1 | grep -c ck_carts_owner_exclusive
docker exec nn-cartcheck psql -U nutwala -d nutwala -c \
  "INSERT INTO carts (user_id, guest_token) VALUES ('11111111-1111-1111-1111-111111111111', 'k');" 2>&1 | grep -c ck_carts_owner_exclusive
npm run migration:revert && npm run migration:run
cd .. && docker rm -f nn-cartcheck >/dev/null
```

Expected: both `grep -c` calls print `1`, and the revert-then-reapply cycle clean. `nutwala-postgres`
and `nutwala-postgres-test` must be untouched throughout — check with `docker ps`.

**Why the second grep matches only the check constraint, and must not be widened to accept the foreign
key error as well.** That insert names a `user_id` no `users` row has, so two constraints could reject
it, and an earlier version of this step accepted either message. That version could not fail — measured
on a throwaway Postgres 15 with the same two constraints:

```
with    CONSTRAINT ck_owner_exclusive  -> ERROR: violates check constraint "ck_owner_exclusive"
without CONSTRAINT ck_owner_exclusive  -> ERROR: violates foreign key constraint "t_user_id_fkey"
```

Both messages match `"ck…|violates foreign key"`, so the step would have printed `1` and reported
success **with the constraint missing entirely** — the thing it exists to verify. The narrow grep is
discriminating because Postgres evaluates `CHECK` during tuple insertion while foreign keys are AFTER
ROW triggers: the check always wins the race, so a `0` here means the constraint is genuinely absent.

If you would rather remove the ambiguity at the source instead, insert a real `users` row first and use
its id — then only the check constraint can reject it. Either is fine; accepting both messages is not.

- [ ] **Step 4: Commit**

```bash
git add backend/src/database/migrations/20260820090000-GuestCarts.ts backend/src/entities/commerce/cart.entity.ts
git commit -F - <<'MSG'
feat(cart): make a guest cart storable, with the owner exclusivity enforced in the database
MSG
```

## Task 17: The guest cart cookie

**Files:**
- Create: `backend/src/modules/cart/guest-token.ts`
- Test: `backend/src/modules/cart/guest-token.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/cart/guest-token.spec.ts
import { redact } from '../../common/logging/pii-redactor';
import { GUEST_TOKEN_COOKIE, issueGuestToken, readGuestToken } from './guest-token';

const requestWith = (cookies: Record<string, string>) => ({ cookies }) as never;

/**
 * A real 43-character base64url key, which is what this service issues. **Not `'abc123'`**, which is
 * what an earlier version of this test used: `KEY_PATTERN` is `/^[A-Za-z0-9_-]{43}$/`, so a
 * six-character value is rejected and the assertion fails. Measured, that version ran 5 passed /
 * 1 failed against a correct implementation, and Step 5's "PASS — 6 tests" was unreachable.
 *
 * The tempting fix is the wrong one: loosening the pattern to `{1,64}` also turns everything green,
 * because `'not a key'` has a space, `'a'.repeat(200)` is over 64 and `''` is empty — all four
 * rejection assertions survive it. It would also admit values this service could never have issued,
 * which is the exact property the third test is named for. Fix the fixture, never the pattern.
 *
 * Includes `-` and `_` so it exercises the two characters that separate base64url from base64.
 */
const ISSUED_KEY = 'Zm9vYmFy-_YmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmE';

describe('readGuestToken', () => {
  it('reads the key from its cookie', () => {
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: ISSUED_KEY }))).toBe(ISSUED_KEY);
  });

  it('returns undefined when there is no cookie at all', () => {
    expect(readGuestToken(requestWith({}))).toBeUndefined();
    expect(readGuestToken({} as never)).toBeUndefined();
  });

  /**
   * The key names a cart row, so a caller who can guess or inject one reads someone else's basket.
   * Anything that is not a key this service issued is rejected rather than passed to a query — which
   * also stops a malformed value reaching a `varchar(64)` column and failing at the driver.
   */
  it('rejects a value this service could not have issued', () => {
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: 'not a key' }))).toBeUndefined();
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: '../../etc/passwd' }))).toBeUndefined();
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: 'a'.repeat(200) }))).toBeUndefined();
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: '' }))).toBeUndefined();
  });
});

describe('issueGuestToken', () => {
  it('sets an httpOnly cookie and returns the key it set', () => {
    const response = { cookie: jest.fn() };
    const key = issueGuestToken(response as never, { cookieDomain: 'localhost', cookieSecure: false });

    expect(key).toHaveLength(43);
    expect(response.cookie).toHaveBeenCalledWith(
      GUEST_TOKEN_COOKIE,
      key,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', secure: false, domain: 'localhost' }),
    );
  });

  /**
   * **`secure` and `domain` were pinned by nothing before this test existed.** Measured: replacing
   * `secure: settings.cookieSecure` with a hardcoded `secure: false` in `baseCookieOptions` — every
   * cookie the service sets losing its `Secure` flag, production included — left the entire backend
   * unit suite and the auth integration suite green. Every other case here passes
   * `cookieSecure: false` and `cookieDomain: 'localhost'`, so a constant satisfies all of them.
   *
   * Which is precisely the failure Step 2 exists to prevent, so it needs a case that would notice.
   * Because `CookieService.base()` delegates to the same function, this guards the access, refresh
   * and CSRF cookies too.
   */
  it('carries the environment settings through rather than assuming a local default', () => {
    const response = { cookie: jest.fn() };
    issueGuestToken(response as never, { cookieDomain: 'shop.example.in', cookieSecure: true });

    expect(response.cookie).toHaveBeenCalledWith(
      GUEST_TOKEN_COOKIE,
      expect.any(String),
      expect.objectContaining({ secure: true, domain: 'shop.example.in' }),
    );
  });

  /**
   * The generator and the validator must agree. `KEY_PATTERN`'s own docblock names this drift as the
   * catastrophic case — "turning every guest's basket into an empty one on their next request,
   * silently" — and nothing else here covers it: every other test hand-writes a value or checks only
   * the issued key's length. A `{43}` → `{44}` slip sails past four of the six original tests.
   */
  it('reads back a key it just issued', () => {
    const response = { cookie: jest.fn() };
    const key = issueGuestToken(response as never, { cookieDomain: 'localhost', cookieSecure: false });
    expect(readGuestToken(requestWith({ [GUEST_TOKEN_COOKIE]: key }))).toBe(key);
  });

  it('issues a different key every time', () => {
    const response = { cookie: jest.fn() };
    const settings = { cookieDomain: 'localhost', cookieSecure: false };
    expect(issueGuestToken(response as never, settings)).not.toBe(
      issueGuestToken(response as never, settings),
    );
  });

  it('is named so the log redactor scrubs it', () => {
    // Assert against the **real** `redact()`, not against the naming convention. An earlier version of
    // this test did `GUEST_TOKEN_COOKIE.replace(/[^a-z0-9]/g, '')).toContain('token')`, which only
    // restates the convention back to itself: it stays green if someone drops `token` from the
    // redactor's keyword list, which is the failure that actually matters. `pii-redactor.spec.ts`
    // already keys on real cookie names (`Cookie: 'nn_access_token=x'`) — follow that.
    //
    // A guest token is a bearer credential for a basket *and* the same visitor's wishlist. Plan 1
    // shipped `nn_rt`, which normalised to `nnrt` and matched nothing, before that lesson was learned.
    expect(redact({ [GUEST_TOKEN_COOKIE]: 'SECRETVALUE' })).toEqual({
      [GUEST_TOKEN_COOKIE]: '[REDACTED]',
    });
    expect(redact({ Cookie: `${GUEST_TOKEN_COOKIE}=SECRETVALUE` })).toEqual({
      Cookie: '[REDACTED]',
    });
  });
});
```

- [ ] **Step 2: Extract the cookie attributes every cookie shares**

`CookieService.base()` (`modules/auth/cookie.service.ts:97`) already returns exactly the object the
guest cookie needs — `httpOnly: true`, `secure: auth.cookieSecure`, `sameSite: 'lax'`,
`domain: auth.cookieDomain`, `path: '/'`. By the end of this milestone **three** places want it: that
method, `issueGuestToken` below, and Task 20's `csrfBootstrap` middleware. Three hand-written copies put
the "are cookies `secure`" decision in three files, and the copy that gets forgotten when that policy
changes is the one that sets a session cookie over plain HTTP.

It goes in `common/`, not in the cart module: `csrfBootstrap` **will live** at
`common/auth/csrf-bootstrap.middleware.ts` — Task 20 creates it, it does not exist yet — and a file
under `common/` importing from
`modules/cart/` is backwards — `common` is what feature modules depend on, not the reverse. Note also
that `CookieService` cannot simply be shared: it is **not** exported from `AuthModule` (verified —
`exports: [AuthService]` and nothing else), and widening that export to share five lines would couple
two feature modules to the auth module for no other reason.

```ts
// backend/src/common/http/cookie-options.ts
import type { CookieOptions } from 'express';

/** The two environment-dependent cookie settings, validated at boot by `env.schema.ts`. */
export interface CookieSettings {
  cookieDomain: string;
  cookieSecure: boolean;
}

/**
 * The attributes every cookie this service sets shares. One definition, three callers:
 * `CookieService.base()`, `issueGuestToken` and `csrfBootstrap`.
 *
 * Each caller spreads this and overrides only what genuinely differs — the refresh cookie's
 * `sameSite: 'strict'` and narrower `path`, the CSRF cookie's `httpOnly: false`, and each one's
 * `maxAge`. Anything not in that list is not allowed to differ.
 */
export function baseCookieOptions(settings: CookieSettings): CookieOptions {
  return {
    httpOnly: true,
    // `lax` rather than `strict`: a customer arriving from a Google result or a WhatsApp link must
    // still find the basket they built before they left, and a guest token grants nothing but a
    // basket and a wishlist. Forced `secure` in production by the env schema.
    sameSite: 'lax',
    secure: settings.cookieSecure,
    domain: settings.cookieDomain,
    path: '/',
  };
}
```

- [ ] **Step 3: Run the test, watch it fail, implement**

Run: `npm run test -w backend -- guest-token`
Expected: FAIL — `Cannot find module './guest-token'`.

```ts
// backend/src/modules/cart/guest-token.ts
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { baseCookieOptions, type CookieSettings } from '../../common/http/cookie-options';

/**
 * One anonymous-visitor key, shared by the cart **and** the wishlist.
 *
 * Not one cookie per feature: two would mean two merge paths on sign-in, two places to get the owner
 * exclusivity constraint right, and a visitor who signed in keeping one list while losing the other.
 *
 * Named in full rather than as `nn_gt`, so `pii-redactor.ts` scrubs it by key. The key is a bearer
 * credential for a basket and a saved-items list: whoever holds it can read and replace both. Plan 1 shipped the refresh cookie as `nn_rt`, which normalised to `nnrt` and matched nothing
 * in the redactor's keyword list, so a debug line dumping cookies wrote a live credential to the logs.
 * `guest_token` contains "token" and is caught.
 */
export const GUEST_TOKEN_COOKIE = 'nn_guest_token';

/**
 * 32 random bytes, base64url — 43 characters, comfortably inside the column's 64.
 *
 * Checked against 2000 generated keys: every one is exactly 43 characters and matches, and `base64url`
 * never emits `+`, `/` or `=`, so the character class needs no padding or standard-base64 allowance. A
 * pattern that was even slightly off would reject keys this service had just issued — turning every
 * guest's basket into an empty one on their next request, silently.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type GuestCookieSettings = CookieSettings;

/**
 * Reads a guest key, or `undefined` when there is not a valid one.
 *
 * Validated against the shape this service issues rather than passed through. The key goes straight
 * into a `WHERE guest_token = $1`, so an unvalidated value is both an injection surface for anything
 * that later interpolates it and a driver error waiting to happen on a `varchar(64)` column.
 */
export function readGuestToken(request: Request): string | undefined {
  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[GUEST_TOKEN_COOKIE];
  if (!value || !KEY_PATTERN.test(value)) return undefined;
  return value;
}

export function issueGuestToken(response: Response, settings: GuestCookieSettings): string {
  const key = randomBytes(32).toString('base64url');

  response.cookie(GUEST_TOKEN_COOKIE, key, {
    ...baseCookieOptions(settings),
    maxAge: THIRTY_DAYS_MS,
  });
  return key;
}
```

- [ ] **Step 4: Make `CookieService` delegate, so there is genuinely one definition**

Extracting `baseCookieOptions` only helps if the original stops duplicating it. In
`backend/src/modules/auth/cookie.service.ts`, replace the body of the private `base()` (line 97) with a
call to it, keeping the method so its three call sites are untouched:

```ts
  // plus: import { baseCookieOptions } from '../../common/http/cookie-options';
  private base(): CookieOptions {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return baseCookieOptions(auth);
  }
```

`auth` already carries `cookieDomain` and `cookieSecure`, which is the whole of `GuestCookieSettings`,
so this is structurally exact — no adapter. The comment about `secure` being forced true in production
moves to `baseCookieOptions` with the code it describes.

**Do not rely on the suites to confirm this.** Measured: with `domain` deleted from
`baseCookieOptions`, `npm run test:integration -w backend -- auth` is **31/31 green**.
`auth.integration.spec.ts:162-169` asserts `HttpOnly` on the access and refresh cookies,
`SameSite=Strict` and `Path=/api/v1/auth` on the refresh cookie, `Path=/;` on the access cookie, and the
*absence* of `HttpOnly` on the CSRF cookie. It never asserts `Domain`, `Secure`, or `SameSite=Lax`. So it
would catch a lost `httpOnly` or a broken override, and would not catch a lost `domain` or `secure`.

Capture the arguments instead. Drive `CookieService` with a stub `ConfigService` and a stub `Response`
that records the options object of every `cookie()` and `clearCookie()` call — six calls, run under two
configurations (`secure: false` / `localhost` and `secure: true` / a real domain) — once before the edit
and once after, and compare. A key-sorted diff must be empty; property *insertion* order may differ,
because the extracted function lists `sameSite` before `secure`, and Express builds `Set-Cookie` by named
lookup so order cannot matter.

What must survive, and appear in that captured data: the refresh cookie's `sameSite: 'strict'` and
`path: '/api/v1/auth'`, the CSRF cookie's `httpOnly: false`, all three `maxAge` values, and all three
`clear()` option sets.

One thing **not** to worry about, since it looks like a bug on first reading: `clear()` passes
`sameSite: 'lax'` for the refresh cookie although it was set `'strict'`. Browsers match a deletion on
name, domain and path only, so `sameSite` and `secure` play no part in it. That asymmetry is
pre-existing, harmless, and none of this task's business.
The refresh cookie's `sameSite: 'strict'` and `path: REFRESH_PATH`, and the CSRF cookie's
`httpOnly: false`, are spread **over** the base and must survive — they are the reason `base()` stays a
method rather than becoming a constant.

- [ ] **Step 5: Run and commit**

Run: `npm run test -w backend -- guest-token`
Expected: PASS — 8 tests.

```bash
git add backend/src/common/http/cookie-options.ts backend/src/modules/cart/guest-token.ts backend/src/modules/cart/guest-token.spec.ts backend/src/modules/auth/cookie.service.ts
git commit -F - <<'MSG'
feat(cart): issue a validated, redactor-visible guest cart cookie
MSG
```

## Task 18: The cart service — resolve, replace, merge

The merge is the part that matters. A guest builds a basket, signs in at checkout, and must find it
intact: losing it there is the most expensive bug this milestone can ship, because it happens at the
exact moment the customer was about to pay.

**Files:**
- Create: `backend/src/modules/cart/cart.constants.ts`
- Create: `backend/src/modules/cart/cart.service.ts`
- Create: `backend/src/modules/cart/dto/replace-cart.dto.ts` — **yes, here, not in Task 20.** The
  service does `import type { ReplaceCartDto } from './dto/replace-cart.dto'`, so without it nothing in
  this task typechecks: measured, `TS2307` plus three cascading errors (`TS7006` twice on `(line)`, and
  `TS2322` `Type '{ slug: unknown; }[]' is not assignable to FindOptionsWhere<Product>[]`). Take the file
  verbatim from Task 20 Step 1; Task 20 will find it already present. A structural type local to the
  service is the wrong shortcut — Step 2's entire rationale rests on that import existing — and a
  decorator-less stub is worse, because it is a *wrong* file Task 20 has to remember to replace.
- Test: `backend/src/modules/cart/cart.service.spec.ts` (merge arithmetic), with the database behaviour
  proven in **Task 23**, the cart integration spec — not Task 22, which is inventory and the admin
  adjustment

- [ ] **Step 1: Write the failing test for the merge arithmetic**

```ts
// backend/src/modules/cart/cart.service.spec.ts
import { MAX_LINE_QTY } from './cart.constants';
import { mergeLines } from './cart.service';

const line = (
  productId: string,
  variantId: string | null,
  mode: 'RETAIL' | 'BULK',
  qty: number,
  kg: string | null = null,
) => ({ productId, variantId, mode, qty, kg });

describe('mergeLines', () => {
  it('keeps lines that exist on only one side', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', 1)],
      [line('p2', 'v2', 'RETAIL', 2)],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * Summing is what a customer expects: they put two bags in as a guest, one more after signing in,
   * and want three. Taking the maximum would silently discard the earlier intent.
   *
   * Double-counting on a repeated merge is not a risk, because `mergeInto` deletes the guest cart in
   * the same transaction — so there is never a second merge of the same rows.
   */
  it('sums the quantity when the same line exists on both sides', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', 2)],
      [line('p1', 'v1', 'RETAIL', 1)],
    );
    expect(merged).toEqual([expect.objectContaining({ productId: 'p1', qty: 3 })]);
  });

  it('treats two sizes of the same product as different lines', () => {
    const merged = mergeLines(
      [line('p1', 'v-250g', 'RETAIL', 1)],
      [line('p1', 'v-1kg', 'RETAIL', 1)],
    );
    expect(merged).toHaveLength(2);
  });

  it('treats the same product in retail and bulk as different lines', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', 1)],
      [line('p1', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * Two bulk lines for the same product at different weights are different lines — 10kg and 25kg are
   * priced from different tiers, so folding them together would misprice the basket.
   */
  /**
   * `productId` in `lineKey` was pinned by nothing: dropping it left the original eight tests green.
   *
   * Not academic. A bulk line carries no variant, so two *different* products at the same weight key
   * identically and fold into one line — one product disappears from the basket and the other's
   * quantity doubles. Every other test here varies the product *and* something else, so none of them
   * isolates it.
   */
  it('treats two different products as different lines even at the same weight', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '25.00')],
      [line('p2', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * `mode` in `lineKey` was pinned by nothing either — the retail-vs-bulk test below varies variant,
   * weight **and** mode at once. `mode` is redundant against the rows `resolveLines` produces today
   * (retail always resolves a variant, bulk always carries a weight), which is exactly why nothing
   * noticed. This pins the documented contract rather than that incidental property.
   */
  it('keys on mode even when nothing else distinguishes the two lines', () => {
    const merged = mergeLines(
      [line('p1', null, 'RETAIL', 1)],
      [line('p1', null, 'BULK', 1)],
    );
    expect(merged).toHaveLength(2);
  });

  it('treats bulk lines of different weights as different lines', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '10.00')],
      [line('p1', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  it('folds bulk lines of the same weight together', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '25.00')],
      [line('p1', null, 'BULK', 2, '25.00')],
    );
    expect(merged).toEqual([expect.objectContaining({ qty: 3 })]);
  });

  it('is a no-op when the guest side is empty', () => {
    const existing = [line('p1', 'v1', 'RETAIL', 2)];
    expect(mergeLines(existing, [])).toEqual(existing);
  });

  /**
   * The sum must not exceed what `CartLineDto` accepts.
   *
   * `mergeInto` inserts straight into `cart_items`, bypassing the DTO, so an unclamped sum stores a
   * quantity the API will not accept back. The client reads the basket and echoes it to `PUT /cart`,
   * which then fails with `qty must not be greater than 999` — for every write, forever, including
   * removing the offending line. The basket becomes read-only at the moment the customer is paying.
   */
  it('never sums past the quantity the API accepts', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY)],
      [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY)],
    );
    expect(merged).toEqual([expect.objectContaining({ qty: MAX_LINE_QTY })]);
  });

  /**
   * The clamp on the **guest-only** branch, which the test above does not reach: it exercises the
   * summing path, and dropping the clamp from the `else` branch left every other test green.
   */
  it('clamps a guest-only line that arrives above the cap', () => {
    const merged = mergeLines([], [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY + 500)]);
    expect(merged).toEqual([expect.objectContaining({ qty: MAX_LINE_QTY })]);
  });
});
```

- [ ] **Step 2: Create the shared quantity cap**

Its own module, imported by both `cart.service.ts` and `dto/replace-cart.dto.ts`. **Not exported from
`cart.service.ts`**, which is where an earlier version of this task put it — that would make
`replace-cart.dto.ts` import `cart.service.ts` while `cart.service.ts` imports the DTO — a circular
import that would survive only because the service's DTO import is `import type` and therefore erased at
compile time. It is one edit away from becoming real: the first person who needs `ReplaceCartDto` as a
*value* in the service turns `MAX_LINE_QTY` into `undefined` at the moment class-validator evaluates
`@Max(...)` on the DTO — a decorator argument, so there is no runtime error, just a quantity cap that
silently stops working. A constants module cannot participate in that cycle at all.

```ts
// backend/src/modules/cart/cart.constants.ts
/**
 * The most of one line a basket may hold.
 *
 * Read by `CartLineDto`'s `@Max` and by `mergeLines`, which must honour the same bound because it
 * inserts into `cart_items` without passing through the DTO. One definition rather than the literal
 * `999` in two files, where one of them gets forgotten.
 *
 * 999 is where a customer should be using the RFQ form instead, which is also why the number is not
 * larger: a cart reserves no stock, so the cap is a usability boundary rather than a security one.
 */
export const MAX_LINE_QTY = 999;
```

- [ ] **Step 3: Run the test, watch it fail, implement the service**

Run: `npm run test -w backend -- cart.service`
Expected: FAIL — `Cannot find module './cart.service'`.

```ts
// backend/src/modules/cart/cart.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Cart } from '../../entities/commerce/cart.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { MAX_LINE_QTY } from './cart.constants';
import type { ReplaceCartDto } from './dto/replace-cart.dto';

/** The fields that decide whether two cart lines are the same line. */
interface MergeableLine {
  productId: string;
  variantId: string | null;
  mode: 'RETAIL' | 'BULK';
  kg: string | null;
  qty: number;
}

/**
 * The identity of a cart line.
 *
 * A product in two pack sizes is two lines; the same product retail and bulk is two lines; and two
 * bulk weights are two lines, because 10kg and 25kg resolve to different pricing tiers and folding
 * them would misprice the basket.
 */
const lineKey = (line: MergeableLine): string =>
  `${line.mode}|${line.productId}|${line.variantId ?? ''}|${line.kg ?? ''}`;

/**
 * Folds a guest's lines into the signed-in user's, summing quantities for lines that match.
 *
 * Exported for its own unit test: the arithmetic is the part worth testing in isolation, and the
 * database behaviour around it is proven against Postgres in Task 23.
 */
export function mergeLines<T extends MergeableLine>(existing: T[], incoming: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const line of existing) byKey.set(lineKey(line), { ...line });

  for (const line of incoming) {
    const key = lineKey(line);
    const current = byKey.get(key);
    // Summed, not maxed: two bags added as a guest plus one added after signing in is three bags.
    //
    // Clamped to `MAX_LINE_QTY`, which is the same cap `CartLineDto` enforces with `@Max`. Without the
    // clamp this function can write state the API's own validator refuses: 999 as a guest plus 999
    // signed in stores 1998 in an `int` column quite happily, and then **every** subsequent
    // `PUT /cart` fails validation with `qty must not be greater than 999` — because the client echoes
    // the basket back as it read it. The customer's cart becomes unremovable and unmodifiable, and
    // they discover it at checkout.
    //
    // Clamping rather than throwing, because the alternative is failing the sign-in merge, which is the
    // exact moment this task opens by calling the worst possible one to lose a basket. Keeping 999 of
    // something is a better outcome than keeping nothing, and a customer who genuinely wants more than
    // 999 units belongs in the RFQ form — which is the reasoning behind the cap in the first place.
    if (current) current.qty = Math.min(current.qty + line.qty, MAX_LINE_QTY);
    else byKey.set(key, { ...line, qty: Math.min(line.qty, MAX_LINE_QTY) });
  }

  return [...byKey.values()];
}

/*
 * **The clamp is asymmetric, deliberately.** The seeding loop above copies `existing` through with
 * `{ ...line }` and does not clamp, so a row already stored above the cap stays above it — this
 * function guarantees only that it never *emits* a value above `MAX_LINE_QTY`, not that its output
 * honours the DTO bound unconditionally. Nothing reachable writes such a row today: `replace` goes
 * through `CartLineDto`, and this function is the only other writer. Clamping pre-existing rows would
 * be a decision about silently rewriting stored quantities, which is not this function's to make.
 */

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart) private readonly carts: Repository<Cart>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(ProductVariant) private readonly variants: Repository<ProductVariant>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Finds the caller's cart, or `null` when they have never had one.
   *
   * Deliberately does not create on read: a bot crawling the shop would otherwise leave a cart row
   * per request. Rows are created on the first write instead.
   */
  async find(owner: { userId?: string; guestToken?: string }): Promise<Cart | null> {
    if (owner.userId) {
      return this.carts.findOne({
        where: { userId: owner.userId },
        relations: { items: { product: { pricingTiers: true }, variant: { inventory: true } } },
      });
    }
    if (owner.guestToken) {
      return this.carts.findOne({
        where: { guestToken: owner.guestToken },
        relations: { items: { product: { pricingTiers: true }, variant: { inventory: true } } },
      });
    }
    return null;
  }

  /**
   * Replaces the whole basket.
   *
   * A whole-basket `PUT` rather than per-line endpoints, because the client already holds the array
   * and this makes the server's state a function of one request instead of a sequence — so a dropped
   * request cannot leave the two disagreeing about a quantity, and there is no ordering to get wrong.
   *
   * Every line is resolved against the live catalogue and rejected if it does not exist. Storing a
   * slug the catalogue does not have would produce a basket that cannot be priced.
   */
  async replace(
    owner: { userId?: string; guestToken?: string },
    dto: ReplaceCartDto,
  ): Promise<Cart> {
    const resolved = await this.resolveLines(dto);

    return this.dataSource.transaction(async (manager) => {
      const cart = await this.upsertCart(manager, owner);
      await manager.getRepository(CartItem).delete({ cartId: cart.id });
      if (resolved.length > 0) {
        await manager.getRepository(CartItem).insert(
          resolved.map((line) => ({ ...line, cartId: cart.id })),
        );
      }
      // Touched so spec §38's abandoned-cart notification has a timestamp to read.
      await manager.getRepository(Cart).update({ id: cart.id }, { updatedAt: new Date() });
      return this.mustFind(manager, cart.id);
    });
  }

  /**
   * Folds a guest cart into the user's and deletes the guest one, in one transaction.
   *
   * Called immediately after sign-in. If this fails silently the customer loses their basket at the
   * checkout step, which is the worst possible moment, so it throws rather than swallowing.
   */
  async mergeInto(userId: string, guestToken: string): Promise<Cart> {
    return this.dataSource.transaction(async (manager) => {
      const guest = await manager.getRepository(Cart).findOne({
        where: { guestToken },
        relations: { items: true },
      });

      const userCart = await this.upsertCart(manager, { userId });

      if (!guest || guest.items.length === 0) {
        // Nothing to fold. Still delete the guest row if it exists, so a stale empty cart does not
        // outlive the cookie and hold the unique key.
        if (guest) await manager.getRepository(Cart).delete({ id: guest.id });
        return this.mustFind(manager, userCart.id);
      }

      const existing = await manager.getRepository(CartItem).find({ where: { cartId: userCart.id } });
      const merged = mergeLines(
        existing.map((item) => this.toMergeable(item)),
        guest.items.map((item) => this.toMergeable(item)),
      );

      await manager.getRepository(CartItem).delete({ cartId: userCart.id });
      await manager.getRepository(CartItem).insert(
        merged.map((line) => ({ ...line, mode: line.mode as OrderChannelEnum, cartId: userCart.id })),
      );
      // Deleting the guest cart cascades to its items, and is what makes a repeated merge impossible.
      await manager.getRepository(Cart).delete({ id: guest.id });

      return this.mustFind(manager, userCart.id);
    });
  }

  private toMergeable(item: CartItem): MergeableLine {
    return {
      productId: item.productId,
      variantId: item.variantId,
      mode: item.mode === OrderChannelEnum.BULK ? 'BULK' : 'RETAIL',
      kg: item.kg,
      qty: item.qty,
    };
  }

  /**
   * Resolves wire lines to entity columns, rejecting anything the catalogue cannot account for.
   *
   * One query for the products and one for the variants, not one per line: a twenty-line basket
   * would otherwise be forty round trips on every save.
   */
  private async resolveLines(dto: ReplaceCartDto): Promise<Omit<CartItem, 'id' | 'cartId' | 'cart' | 'product' | 'variant' | 'createdAt' | 'updatedAt'>[]> {
    if (dto.lines.length === 0) return [];

    const slugs = [...new Set(dto.lines.map((line) => line.slug))];
    const products = await this.products.find({
      where: slugs.map((slug) => ({ slug })),
      select: { id: true, slug: true },
    });
    const productBySlug = new Map(products.map((product) => [product.slug, product]));

    /**
     * **`find({ where: [] })` returns every row.** Measured: against the seeded catalogue it comes back
     * with all 27 products, not zero — TypeORM treats an empty OR-array as no condition at all, the same
     * trap as `IN ()` being a syntax error rather than an empty set.
     *
     * `products` is empty exactly when no line's slug resolved, so without this guard a basket full of
     * unknown slugs would load **every variant in the catalogue** before the loop below threw
     * `NOT_FOUND`. Harmless in outcome, wasteful now, and a genuine hazard the moment anyone reuses this
     * shape somewhere the result is returned rather than discarded.
     */
    const variants =
      products.length === 0
        ? []
        : await this.variants.find({
            where: products.map((product) => ({ productId: product.id })),
            select: { id: true, productId: true, size: true, isActive: true },
          });

    return dto.lines.map((line) => {
      const product = productBySlug.get(line.slug);
      if (!product) {
        throw new DomainError(
          ErrorCodes.NOT_FOUND,
          `We no longer stock one of the items in your basket.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { slug: line.slug },
        );
      }

      // A retail line names a pack size; a bulk line names a weight and is not variant-bound.
      const variant =
        line.mode === 'retail'
          ? variants.find(
              (candidate) =>
                candidate.productId === product.id && candidate.size === line.size && candidate.isActive,
            )
          : undefined;

      if (line.mode === 'retail' && !variant) {
        throw new DomainError(
          ErrorCodes.NOT_FOUND,
          `That pack size is no longer available.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { slug: line.slug, size: line.size },
        );
      }

      return {
        productId: product.id,
        variantId: variant?.id ?? null,
        mode: line.mode === 'bulk' ? OrderChannelEnum.BULK : OrderChannelEnum.RETAIL,
        kg: line.kg === undefined ? null : String(line.kg),
        qty: line.qty,
      };
    });
  }

  private async upsertCart(
    manager: EntityManager,
    owner: { userId?: string; guestToken?: string },
  ): Promise<Cart> {
    const repository = manager.getRepository(Cart);
    const where = owner.userId ? { userId: owner.userId } : { guestToken: owner.guestToken };

    /**
     * Insert-or-ignore, then read. **Not** `findOne` followed by `save` when it returns nothing — that
     * is a check-then-insert race, and this is a reachable one rather than a theoretical one.
     *
     * Two writes arrive for the same owner before either has created the row: a customer
     * double-clicking Add to Cart as a guest with no cart yet, or `mergeInto`'s `upsertCart({ userId })`
     * landing beside an in-flight `PUT /cart` from the same session. Both `findOne` calls return null,
     * both insert, and the second violates `uq_carts_user` or `uq_carts_guest_token` — a 500 on a
     * customer's first attempt to put something in their basket.
     *
     * `ON CONFLICT DO NOTHING` closes it. Inside this transaction the losing insert blocks on the unique
     * index until the winner commits, then does nothing; the `findOne` that follows runs on a fresh
     * READ COMMITTED snapshot and sees the winner's row. Task 27's wishlist already does exactly this,
     * for exactly this reason — Task 18 simply predates the pattern.
     *
     * `ck_carts_owner_exclusive` requires exactly one owner, so the unset side is explicitly null rather
     * than omitted. An omitted column would default to null anyway, but stating it is what makes the
     * constraint's requirement visible at the write site.
     */
    await repository
      .createQueryBuilder()
      .insert()
      .values({ userId: owner.userId ?? null, guestToken: owner.guestToken ?? null })
      .orIgnore()
      .execute();

    const cart = await repository.findOne({ where });
    if (!cart) {
      // Neither our insert nor a concurrent one produced a row, which cannot happen unless the owner
      // predicate and the inserted columns disagree. Loud rather than a null the callers would deref.
      throw new Error(`Cart for ${JSON.stringify(owner)} was neither found nor created`);
    }
    return cart;
  }

  private async mustFind(
    manager: EntityManager,
    id: string,
  ): Promise<Cart> {
    const cart = await manager.getRepository(Cart).findOne({
      where: { id },
      relations: { items: { product: { pricingTiers: true }, variant: { inventory: true } } },
    });
    if (!cart) throw new Error(`Cart ${id} vanished inside its own transaction`);
    return cart;
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `npm run test -w backend -- cart.service`
Expected: PASS — 12 tests.

```bash
git add backend/src/modules/cart/cart.constants.ts backend/src/modules/cart/cart.service.ts backend/src/modules/cart/cart.service.spec.ts
git commit -F - <<'MSG'
feat(cart): resolve, replace and merge server-side carts
MSG
```

## Task 19: Cart pricing

The server-side counterpart of `frontend/src/features/cart/cart-math.ts`, and **not** a port of it.

`cart-math.ts` accumulates GST as floating-point rupees (`total * gstRate / 100`) and rounds once at
the end. `shared/src/money.ts` warns against exactly that for server use, and Plan 1 settled the rule:
**GST is computed per line in paise and summed**, because an invoice whose tax does not equal the sum
of its lines' tax cannot be reconciled. The seeder already does it this way.

The consequence is worth stating rather than discovering: the two can disagree by a rupee. **The
server's figure is authoritative.**

**Everything else about the two must agree exactly**, and one rule is easy to get wrong because it has
two independent decisions in one line. `cart-math.ts:45` reads:

```ts
const shipping = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : SHIPPING_FLAT;
```

`>=`, so ₹999 exactly ships free — and the comparison is against the **pre-GST subtotal**, not the
total. Get either backwards and the cart page shows ₹0 shipping while this service charges ₹79, or the
reverse; since the client discards its own figure for this one, the customer sees the change only on the
final total. GST is where the two are *allowed* to differ, by design. Shipping is not. Task 23's provider replaces its optimistic local total with the
server's reply rather than merging them, and never shows the client's arithmetic once the server has
answered.

**Files:**
- Create: `backend/src/modules/cart/cart-pricing.service.ts`
- Test: `backend/src/modules/cart/cart-pricing.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/cart/cart-pricing.service.spec.ts
import { gstOn, toPaise, toRupees } from '@nutwala/shared';
import { CartPricingService } from './cart-pricing.service';

const settings = { freeShippingThreshold: 999, flatShippingRate: 79 };

/** A priced retail line, carrying its **line total**: 2 × ₹299 = ₹598 at 5% GST. */
const retailLine = (qty = 2, unitPaise = 29900n) => ({
  mode: 'RETAIL' as const,
  qty,
  kg: null,
  lineTotalPaise: unitPaise * BigInt(qty),
  gstRate: 5,
  quoteRequired: false,
});

describe('CartPricingService.totals', () => {
  const service = new CartPricingService();

  it('sums line totals into a subtotal in rupees', () => {
    const totals = service.totals([retailLine()], settings);
    expect(totals.subtotal).toBe(598);
  });

  /**
   * Per line, then summed — spec §8. **Verified against the real `gstOn`**: three lines of ₹33.33 at 5%
   * give 167 paise each and 501 altogether, where taxing the ₹99.99 aggregate gives 500. The difference
   * is the whole reason the rule exists, so it is asserted rather than described.
   */
  it('computes GST per line and sums it, never taxing the aggregate', () => {
    const line = { ...retailLine(1, 3333n) };
    const totals = service.totals([line, { ...line }, { ...line }], settings);
    expect(totals.gst).toBe(5.01);
  });

  it('charges flat shipping below the free threshold and nothing above it', () => {
    expect(service.totals([retailLine(1, 50000n)], settings).shipping).toBe(79);
    expect(service.totals([retailLine(1, 120000n)], settings).shipping).toBe(0);
  });

  /**
   * Two decisions this endpoint must make the **same way the cart page already makes them**, because
   * the plan declares the server authoritative: the client replaces its own figure with this one, so
   * any disagreement is a customer being charged more than the basket showed them.
   *
   * `frontend/src/features/cart/cart-math.ts:45` is the existing rule, verbatim:
   *
   *     const shipping = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : SHIPPING_FLAT;
   *
   * So: **`>=`, not `>`** — ₹999 exactly ships free; and the comparison is against the **pre-GST
   * subtotal**, not the total. Both assertions in the test above sit far from the boundary and pass
   * under either reading of either decision, which is why these are separate.
   */
  it('ships free at exactly the threshold, and charges a paise below it', () => {
    // ₹999.00 — the boundary itself.
    expect(service.totals([retailLine(1, 99900n)], settings).shipping).toBe(0);
    // ₹998.99 — one paise below it.
    expect(service.totals([retailLine(1, 99899n)], settings).shipping).toBe(79);
  });

  it('compares the threshold against the subtotal, not the GST-inclusive total', () => {
    // ₹980 subtotal, ₹49 GST at 5%. Subtotal-plus-GST is ₹1029, which is what crosses the ₹999
    // threshold; the basket's `total` is ₹1108 once the ₹79 ships. Under the correct rule the
    // *subtotal* is below the threshold so shipping is charged; comparing anything GST-inclusive
    // instead would ship it free and lose ₹79 a basket, silently, on every order in this band.
    const totals = service.totals([retailLine(1, 98000n)], settings);
    expect(totals.subtotal).toBe(980);
    expect(totals.total).toBeGreaterThan(settings.freeShippingThreshold);
    expect(totals.shipping).toBe(79);
  });

  /**
   * The two shipping figures come from `Setting` rows so an admin can change them without a deploy —
   * so a hardcoded `999` or `79` is a real regression, and one that **passed every test this task
   * originally wrote**, because the only fixture holds the seeded values. Measured: substituting
   * `toPaise(999)` and `toPaise(79)` for the arguments left all eight green.
   */
  it('reads the shipping figures from its arguments rather than assuming the seeded ones', () => {
    const custom = { freeShippingThreshold: 2500, flatShippingRate: 149 };
    expect(service.totals([retailLine(1, 100000n)], custom).shipping).toBe(149);
    expect(service.totals([retailLine(1, 250000n)], custom).shipping).toBe(0);
  });

  /**
   * `gstRate` is per line, and a single-rate fixture cannot show it: replacing `line.gstRate` with a
   * literal `5` also passed all eight. A mixed-rate basket is the only arrangement that notices.
   */
  it('taxes each line at its own rate', () => {
    const totals = service.totals(
      [{ ...retailLine(1, 10000n), gstRate: 5 }, { ...retailLine(1, 10000n), gstRate: 18 }],
      settings,
    );
    expect(totals.gst).toBe(toRupees(gstOn(10000n, 5) + gstOn(10000n, 18)));
  });

  it('charges no shipping on an empty basket', () => {
    const totals = service.totals([], settings);
    expect(totals).toEqual({ subtotal: 0, gst: 0, shipping: 0, total: 0, hasQuoteLines: false });
  });

  /**
   * **This assertion is not an invariant, and it passes here only because every fixture in this file
   * is 5% GST.** It adds three rupee *floats*; the implementation sums paise and converts once. Those
   * agree far less often than they look:
   *
   *   single-line baskets, rates 0/5/12/18, subtotals to ₹4000  ->  276,587 violations
   *   restricted to whole-rupee subtotals — 5% GST             ->  0
   *   restricted to whole-rupee subtotals — 12% GST            ->  1,239 of the first 20,000
   *   restricted to whole-rupee subtotals — 18% GST            ->  1,623 of the first 20,000
   *
   * Concretely: a ₹23 line at 12% plus ₹79 shipping is `104.76` summed in paise and
   * `104.75999999999999` summed as rupees. The catalogue is 5% today, so this is a latent flake rather
   * than a live one — and the trap is that the obvious way to make it stop flaking is to sum rupees in
   * the implementation, which is exactly what `shared/src/money.ts` forbids and what this whole service
   * exists to avoid.
   *
   * Kept, because it is a readable statement of intent and it does pass. The test below is the one that
   * states the real invariant.
   */
  it('adds subtotal, GST and shipping into the total', () => {
    const totals = service.totals([retailLine()], settings);
    expect(totals.total).toBe(totals.subtotal + totals.gst + totals.shipping);
  });

  /**
   * The invariant that actually holds: the total is the paise sum, converted once. Stated against a
   * 12% line, where the rupee-float form above is measurably wrong.
   */
  it('sums the total in paise rather than adding rupee floats', () => {
    const line = { ...retailLine(1, 2300n), gstRate: 12 };
    const totals = service.totals([line], { ...settings });
    expect(totals.total).toBe(toRupees(2300n + gstOn(2300n, 12) + toPaise(settings.flatShippingRate)));
  });

  /**
   * A quote-required bulk line has no price, so it must not be counted as free. `hasQuoteLines` is
   * what blocks checkout; a line silently contributing zero would let someone check out a 50kg order
   * for the cost of shipping.
   */
  /**
   * **`CartTotals` carries two flags, and this is why.** `hasQuoteLines` means *needs a quote* and
   * nothing else, because the frontend routes a basket onto the **business** track from it:
   * `routes/cart.tsx:140` offers a Request Quote link and `CheckoutForm.tsx:99` sets `isB2b`, which
   * switches to `b2bCheckoutSchema` and **demands a GSTIN**. `hasUnpriceableLines` is the broad one —
   * some line was left out of the money for any reason — and it is what the honesty notice keys on.
   *
   * An earlier version of this task defined `hasQuoteLines` as `billable.length !== lines.length` to
   * close a real gap (an unpriced line contributing zero to the subtotal and still clearing checkout).
   * That definition is correct for the *money* and wrong for the *routing*: it meant a B2C customer
   * whose only problem was one sold-out 250g bag was told about quote-required items, offered an RFQ,
   * and asked for a GST number. Verified by reading all three call sites. `hasQuoteLines` implies
   * `hasUnpriceableLines`; the converse is the case that was mishandled.
   *
   * On the client both are set together, because `cart-math.ts`'s `lineTotal` returns null only for a
   * quote-only bulk tier and never for a sold-out variant — only the server can report one without the
   * other, because only the server knows about stock.
   *
   * **`hasQuoteLines` must still derive from the *same* predicate that decides the money.** The billable
   * filter excludes a line for `quoteRequired` **or** a null `lineTotalPaise`; reading only
   * `quoteRequired` for the flag lets `{ quoteRequired: false, lineTotalPaise: null }` contribute zero
   * to the subtotal *and* leave checkout unblocked — the 50kg-order-for-the-cost-of-shipping outcome
   * this task's own docblock warns about, reached by the other route.
   *
   * The fixture below cannot distinguish them: it sets both signals at once. Measured, the filter's two
   * halves were *individually* unpinned — dropping either one still passed all eight tests.
   *
   * The fix in the implementation is one shared `isPriceable` predicate with
   * `hasQuoteLines: billable.length !== lines.length`, so the flag means "some line was left out of the
   * money" by construction rather than by a second condition someone has to keep in step.
   */
  it('flags a line it could not price, even when nothing marked it quote-required', () => {
    const totals = service.totals(
      [retailLine(1, 29900n), { ...retailLine(1, 29900n), lineTotalPaise: null }],
      settings,
    );
    expect(totals.hasQuoteLines).toBe(true);
    expect(totals.subtotal).toBe(299);
  });

  it('flags quote lines and excludes them from the money', () => {
    const totals = service.totals(
      [retailLine(1, 29900n), { mode: 'BULK', qty: 1, kg: '50.00', lineTotalPaise: null, gstRate: 5, quoteRequired: true }],
      settings,
    );
    expect(totals.hasQuoteLines).toBe(true);
    expect(totals.subtotal).toBe(299);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- cart-pricing`
Expected: FAIL — `Cannot find module './cart-pricing.service'`.

```ts
// backend/src/modules/cart/cart-pricing.service.ts
import { Injectable } from '@nestjs/common';
import { gstOn, sumPaise, toPaise, toRupees, type CartTotals, type Paise } from '@nutwala/shared';

/**
 * One line, already resolved to a **line total** in paise — not a unit price.
 *
 * An earlier version of this carried `pricePaise` per unit, which forced the caller to divide a line
 * total by the quantity and forced this service to multiply it back. That round trip loses paise
 * whenever the total is not divisible by the quantity: measured, ₹100 across qty 3 gives a unit of 3333
 * paise, which recomputes to 9999 — **a paise short of the ₹100 the customer was quoted.** Small, and
 * exactly the kind of discrepancy that makes an invoice fail to reconcile against its own lines.
 *
 * Carrying the total removes the division entirely.
 *
 * `lineTotalPaise` is null for a line this service cannot price. In practice that is a quote-required
 * bulk tier — but **do not write that down as an invariant**, which an earlier version of this docblock
 * did ("null only for a quote-required bulk line"), directly above a filter that defends against
 * exactly the case the sentence rules out. `isPriceable` treats a null total as unpriceable regardless
 * of `quoteRequired`, because a comment is not a constraint and the two must not disagree.
 */
export interface PricedLine {
  mode: 'RETAIL' | 'BULK';
  qty: number;
  kg: string | null;
  lineTotalPaise: Paise | null;
  gstRate: number;
  quoteRequired: boolean;
}

export interface ShippingSettings {
  freeShippingThreshold: number;
  flatShippingRate: number;
}

@Injectable()
export class CartPricingService {
  /**
   * Totals in rupees, computed in paise.
   *
   * GST is per line and summed, never applied to the aggregate subtotal — spec §8. The frontend's
   * `cart-math.ts` accumulates float rupees and rounds once, so the two figures can differ by a
   * rupee. This one is authoritative; the client replaces its optimistic total with this reply.
   */
  totals(lines: readonly PricedLine[], settings: ShippingSettings): CartTotals {
    const billable = lines.filter((line) => !line.quoteRequired && line.lineTotalPaise !== null);

    // No multiplication: the line total arrives already computed, so there is no unit price to
    // reconstruct and no rounding to lose.
    const lineTotals = billable.map((line) => line.lineTotalPaise as Paise);
    const subtotalPaise = sumPaise(lineTotals);

    const gstPaise = sumPaise(
      billable.map((line, index) => gstOn(lineTotals[index] as Paise, line.gstRate)),
    );

    // Free shipping is decided on the subtotal, matching `cart-math.ts` — not on the GST-inclusive
    // total, or a basket could cross the threshold on tax alone.
    const thresholdPaise = toPaise(settings.freeShippingThreshold);
    const shippingPaise =
      subtotalPaise === 0n || subtotalPaise >= thresholdPaise
        ? 0n
        : toPaise(settings.flatShippingRate);

    return {
      subtotal: toRupees(subtotalPaise),
      gst: toRupees(gstPaise),
      shipping: toRupees(shippingPaise),
      total: toRupees(subtotalPaise + gstPaise + shippingPaise),
      hasQuoteLines: lines.some((line) => line.quoteRequired),
    };
  }
}
```

- [ ] **Step 3: Run and commit**

Run: `npm run test -w backend -- cart-pricing`
Expected: PASS — 13 tests.

```bash
git add backend/src/modules/cart/cart-pricing.service.ts backend/src/modules/cart/cart-pricing.service.spec.ts
git commit -F - <<'MSG'
feat(cart): price baskets in paise with per-line GST, not the client's float arithmetic
MSG
```

## Task 20: The cart endpoints

Four routes. `GET`, `PUT` and `POST /cart/merge` need an owner — a session or a guest cookie.
`POST /cart/validate` is open to guests, per spec §6.3.

### Before anything else: the global `CsrfGuard` refuses every guest write

**Without this step the entire guest cart 403s, and it is the whole point of Milestone 4.**

`CsrfGuard` is registered globally and exempts only `GET`, `HEAD` and `OPTIONS`. Every other method must
present an `X-CSRF-Token` header matching an `nn_csrf` cookie. But `nn_csrf` is issued **only** by
`CookieService.issue()`, which runs on login, register and refresh — so a visitor who has never signed in
does not have one. `PUT /cart` and `POST /cart/validate` from a guest are therefore refused with
**403 `CSRF_TOKEN_INVALID`**, before any code in this task runs.

This is not speculation. Plan 1 recorded it as a Plan 3 problem, and it has already bitten once: the
request-pipeline spec's anonymous `POST /api/v1/validation-probe` had to be given `@SkipCsrf()` for
exactly this reason. Same guard, same shape, one milestone earlier than predicted.

**Do not fix it with `@SkipCsrf()` on the cart routes.** That list is a security exemption, it would grow
route by route, and it is wrong on the merits here: the cart is state a signed-in customer also mutates,
which is precisely what CSRF protects.

**Fix it by issuing `nn_csrf` to anonymous visitors** — the ordinary double-submit bootstrap — and do it
in **middleware**, not per endpoint.

Calling an `ensureCsrf()` from `GET /cart` and `GET /wishlist/slugs` would work most of the time and
leaves a race: both providers fetch on mount, and a customer who clicks Add to Cart before that `GET`
resolves has no cookie yet, so the write 403s. The optimistic UI would show the line and then roll it
back — recoverable, and baffling. Middleware removes the question of which endpoints need it.

**It narrows that race rather than closing it, and the difference matters when you write the tests.**
The middleware sets `nn_csrf` on the *response*, so it is available from the next request onward — it
cannot satisfy `CsrfGuard` on the request that minted it, because the client had nothing to echo. A
**cold write is therefore still a 403**, and that is correct: a guard that accepted a pair it had just
issued would hand the same pair to a cross-site POST and stop being a CSRF defence at all.

What the middleware buys is that *any* prior request of any kind seeds the cookie, instead of only the two
`GET`s a provider happens to make. In the browser that is enough — `CartProvider` fetches `GET /cart` on
mount — but do not write an integration test that `PUT`s from a fresh `agent()` and expects `200`. It
will 403, and the fix is a priming request, not a change to the guard.

```ts
// backend/src/common/auth/csrf-bootstrap.middleware.ts
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { baseCookieOptions } from '../http/cookie-options';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

/**
 * Ensures every visitor holds an `nn_csrf` cookie, so a guest's first write is not refused.
 *
 * `CsrfGuard` demands a cookie-and-header pair on every method but GET/HEAD/OPTIONS, and `nn_csrf` was
 * otherwise minted only by `CookieService.issue()` during sign-in — so the entire guest cart and
 * wishlist would 403. Bootstrapping here rather than in a handler means it is already set by the time
 * any request reaches a guard, whatever the client fetched first.
 *
 * Safe to hand to anyone: the token proves only that the caller could read a same-site cookie. It is not
 * a credential, and it is deliberately readable by JavaScript — that is how the double-submit works.
 *
 * **It must never rotate an existing token.** `CookieService.issue()` sets its own during sign-in, and
 * overwriting one mid-session invalidates a header the client is already sending — which would turn
 * every subsequent write into a 403 for a signed-in customer.
 */
export function csrfBootstrap(request: Request, response: Response, next: NextFunction): void {
  const existing = (request as { cookies?: Record<string, string> }).cookies?.[CSRF_COOKIE];
  if (!existing) {
    response.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      ...baseCookieOptions({
        cookieDomain: process.env.COOKIE_DOMAIN ?? '',
        cookieSecure: process.env.COOKIE_SECURE === 'true',
      }),
      // The one attribute that genuinely differs: the frontend has to read this cookie to echo it back
      // in the header, which is how the double-submit works at all.
      httpOnly: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
  next();
}
```

Register it in `app.module.ts`'s `configure()`, **after `cookieParser()`** — it reads `request.cookies`,
which does not exist before that — and before the body parsers, since it needs nothing from the body:

```ts
      .apply(
        // `RequestTrackingMiddleware` — not `requestContext`, which is not the identifier.
        RequestTrackingMiddleware,
        cookieParser(),
        csrfBootstrap,
        preservingStatus(json({ limit: BODY_LIMIT })),
        …
      )
      .forRoutes('/{*path}');
```

**Make this an injectable `NestMiddleware` class, not a plain function, and read `ConfigService`.**

An earlier version of this step read the two cookie settings from `process.env` and justified it with
*"plain Express middleware in this chain has no DI container."* That is false —
`RequestTrackingMiddleware`, the **first** entry in the very list below, is an injectable class. And the
shortcut had a concrete consequence: `process.env.COOKIE_DOMAIN ?? ''` yields `''` where
`ConfigService` yields the validated default `'localhost'`. A cookie jar keys on
**(name, domain, path)**, so the two disagreeing ships *two* differently-scoped `nn_csrf` cookies and
`cookie-parser` hands `CsrfGuard` whichever appears first — a 403 that depends on header ordering.

The *attributes* still come from `baseCookieOptions` (Task 17, Step 2) rather than being written out a
third time; only `httpOnly` and `maxAge` are overridden.

**And it must not double-mint with `CookieService.issue()` on the same request.** Unanticipated here, and
found by an assertion that already existed: on a brand-new client's `POST /auth/register` the middleware
mints a token *and* `issue()` mints another, `res.cookie` **appends** rather than replaces, and the
response carries two `Set-Cookie: nn_csrf` with different values while the body names only the second.
`auth.integration.spec.ts:151` caught it — `Expected: "62-WoIx1…" Received: "xVQCrkRG…"`. Note that
every `agent()`-based test stayed green throughout, because a cookie jar collapses the pair; only a
direct header read sees it.

The fix is one token per response: the middleware records what it minted on the response, `issue()`
reuses that instead of generating its own, and a client that arrived *already holding* a token still
gets it rotated by `issue()` as before.

Task 23's integration spec must cover this directly:

- a **first** request from a brand-new client receives an `nn_csrf` cookie, before it has fetched anything
- a guest `PUT /cart` carrying the cookie-and-header pair succeeds
- the same write **without** the header is refused with `CSRF_TOKEN_INVALID`
- a **signed-in** client's token is not rotated by a later request — sign in, note the token, issue
  another request, and assert the cookie is unchanged. This is the one that catches the rotation bug,
  and it is the one a naive implementation gets wrong.

A spec that only ever uses `agent()` after a `GET` would pass without proving any of it.

**Files:**
- Create: `backend/src/modules/cart/dto/replace-cart.dto.ts`, `validate-cart.dto.ts`
- Create: `backend/src/modules/cart/cart.controller.ts`, `cart.module.ts`
- Create: `backend/src/modules/cart/cart-read.service.ts` — **yes, here.** Steps 2 and 4 both import
  `./cart-read.service`, and the plan defines it in Task 21 with the words *"referenced by Task 20's
  controller and defined here."* Measured: `Cannot find module`, so nothing in this task typechecks
  without it. Land it now, exactly as Task 21 gives it, with `validateLines` still throwing as Task 21
  leaves it, and **do not** write its spec — that is Task 21's. This is the same precedent Task 18 set
  when it landed Task 20's `replace-cart.dto.ts`.

  **Consequence for Task 21:** its Step 2 expects `FAIL — Cannot find module './cart-read.service'`.
  That expectation is now stale; the file will be present.
- Create: `backend/src/modules/cart/cart-line.mapper.ts` — one `cartLineId(...)` shared by
  `present()` and `toValidatable()`. See the note in Task 21 on why that identity cannot be built twice.
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/modules/auth/auth.controller.ts`

- [ ] **Step 1: The DTOs**

**Task 18 already created this file**, verbatim from this step, because its service cannot typecheck
without it. Expect it to be present and Prettier-formatted; confirm it matches what follows rather than
overwriting it blind. Note that `IsOptional` is deliberately **not** imported — the two conditional
fields use `@ValidateIf`, and the docblocks below explain why the two must never be combined. An earlier
version of this block imported it and used it nowhere, which is a lint warning.

```ts
// backend/src/modules/cart/dto/replace-cart.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsString, Max, Min, MaxLength,
  ValidateIf, ValidateNested,
} from 'class-validator';
import { MAX_LINE_QTY } from '../cart.constants';

export class CartLineDto {
  @ApiProperty() @IsString() @MaxLength(120) slug: string;

  @ApiProperty({ enum: ['retail', 'bulk'] })
  @IsIn(['retail', 'bulk'])
  mode: 'retail' | 'bulk';

  /**
   * Retail only — the pack size, which resolves the variant. **Required when `mode` is `retail`.**
   *
   * `@ValidateIf`, not `@IsOptional`, and the two must not be combined: `@IsOptional()` skips every
   * other decorator when the value is absent, which is precisely the case being rejected here.
   */
  @ApiPropertyOptional()
  @ValidateIf((line: CartLineDto) => line.mode === 'retail')
  @IsString() @MaxLength(20)
  size?: string;

  /**
   * Bulk only — the weight. **Required when `mode` is `bulk`.**
   *
   * Conditional rather than merely optional, because a bulk line without a weight is accepted by an
   * `@IsOptional()` rule, stored with `kg = null`, and then reports `BELOW_MOQ` forever: `verdictFor`
   * reads `Number(line.kg ?? 0)` and `0 < moqKg` is always true. The customer ends up with a basket
   * line that can never validate and that they can only fix by deleting — for a field they never knew
   * they had to send. The retail side is not symmetric today but is just as wrong: a missing `size`
   * falls through to `variants.find(... candidate.size === undefined ...)`, which matches nothing and
   * raises *"That pack size is no longer available"* — a stock message for a malformed request.
   *
   * Both now fail validation, where the response names the field.
   */
  @ApiPropertyOptional()
  @ValidateIf((line: CartLineDto) => line.mode === 'bulk')
  @IsNumber() @Min(0.01) @Max(100_000)
  kg?: number;

  /**
   * Capped at `MAX_LINE_QTY`. A cart does not reserve stock, so a large quantity is not itself an
   * attack — but an unbounded integer reaches an `int` column and a `bigint` multiplication, and 999 of
   * anything is past the point where a customer should be using the RFQ form instead.
   *
   * The number lives in `cart.constants.ts` because `mergeLines` has to honour the same bound: it
   * inserts straight into `cart_items` without passing through this class, so a merge that summed past
   * this cap would store a basket that every later `PUT` to this endpoint rejects. Do not restate the
   * literal, and do not move it into `cart.service.ts` — that file imports this one.
   */
  @ApiProperty() @IsInt() @Min(1) @Max(MAX_LINE_QTY) qty: number;
}

export class ReplaceCartDto {
  /**
   * The whole basket, replacing whatever is stored.
   *
   * Capped at 50 lines: the shop has 27 products with 8 variants each, so a legitimate basket is far
   * smaller, and an uncapped array is an unbounded transaction and an unbounded response.
   */
  @ApiProperty({ type: [CartLineDto] })
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartLineDto)
  lines: CartLineDto[];
}
```

```ts
// backend/src/modules/cart/dto/validate-cart.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { CartLineDto } from './replace-cart.dto';

/**
 * Validation is open to guests and takes the lines in the body rather than reading the stored cart,
 * so the checkout page can validate what the customer is looking at — which may differ from what was
 * last saved if a save is still in flight.
 *
 * Omitting `lines` validates the stored cart instead, which is what the cart page wants.
 */
export class ValidateCartDto {
  @ApiPropertyOptional({ type: [CartLineDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CartLineDto)
  lines?: CartLineDto[];
}
```

- [ ] **Step 2: The controller**

```ts
// backend/src/modules/cart/cart.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CartLine, CartTotals, CartValidationResult } from '@nutwala/shared';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../../common/config/app.config';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CartService } from './cart.service';
import { CartReadService } from './cart-read.service';
import { GUEST_TOKEN_COOKIE, issueGuestToken, readGuestToken } from './guest-token';
import { ReplaceCartDto } from './dto/replace-cart.dto';
import { ValidateCartDto } from './dto/validate-cart.dto';

export interface CartResponse {
  lines: CartLine[];
  totals: CartTotals;
}

@ApiTags('cart')
@Controller('cart')
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly read: CartReadService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `@Public()` on every route here, and the owner resolved by hand.
   *
   * A guest must be able to build a basket, so these cannot require a session — but a signed-in
   * customer's cart must be found by their id rather than a cookie.
   *
   * **Two things an earlier version of this docblock asserted as fact, both false, both measured.**
   *
   * 1. *"`JwtAuthGuard` populates `request.user` … even on a `@Public()` route."* It does not:
   *    `if (isPublic) return true` returns **before** passport ever runs, so `request.user` is unset on
   *    every public route no matter what cookies the caller holds. Left alone, every signed-in
   *    customer's cart would be resolved by guest cookie instead of by their id — and a write would
   *    create a second, guest-owned cart beside their real one. No error, no 500: just the wrong
   *    basket, silently. The guard now attempts authentication on public routes and swallows only the
   *    failure, so a valid session is recognised and a guest is still let through.
   *
   * 2. *"`@CurrentUser()` is `undefined` for a guest."* It **throws** —
   *    `CurrentUser used on a route without JwtAuthGuard` — which is a 500 on every guest
   *    `GET /cart`. The `| undefined` on the parameter type typechecks and does nothing at runtime.
   *    Use `@OptionalUser()` on routes that genuinely admit anonymous callers, and keep the strict
   *    `@CurrentUser()` where a user is required, so its safety net survives.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'The current basket, priced live' })
  async get(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<CartResponse> {
    const cart = await this.cart.find(this.owner(user, request));
    return this.read.present(cart);
  }

  @Public()
  @Put()
  @ApiOperation({ summary: 'Replace the whole basket' })
  async replace(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() dto: ReplaceCartDto,
  ): Promise<CartResponse> {
    // A guest writing for the first time needs a key before there is a row to hang off it.
    const owner = user
      ? { userId: user.id }
      : { guestToken: readGuestToken(request) ?? this.issue(response) };

    const cart = await this.cart.replace(owner, dto);
    return this.read.present(cart);
  }

  /**
   * **Nothing in the frontend calls this.** Step 3 folds the guest basket in during `POST /auth/login`
   * and `POST /auth/register`, server-side, and Task 24's `cartApi` deliberately has no `merge` — the
   * client only refetches after sign-in. That is the more robust arrangement: a customer whose browser
   * closes the instant they sign in still keeps their basket, which a client-driven merge cannot
   * promise.
   *
   * An earlier version of this comment said "called by the frontend immediately after sign-in", which
   * contradicted Task 24 outright. The endpoint stays for two reasons worth stating so it is not
   * mistaken for dead code and deleted: it gives Task 23 a direct handle on `mergeInto` — the sign-in
   * path swallows merge failures by design, so testing through it can only observe success — and it is
   * the manual recovery path when a swallowed merge has left a guest cart stranded.
   *
   * Idempotent by construction: the guest cart is deleted inside the merge transaction, so a repeated
   * call finds nothing to fold and cannot double a quantity.
   */
  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fold the guest basket into the signed-in one' })
  async merge(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CartResponse> {
    const guestToken = readGuestToken(request);
    if (!guestToken) {
      const cart = await this.cart.find({ userId: user.id });
      return this.read.present(cart);
    }

    const cart = await this.cart.mergeInto(user.id, guestToken);
    // The key is spent. Clearing it stops a stale cookie recreating an empty guest cart on the next
    // anonymous write and keeps the unique index free.
    response.clearCookie(GUEST_TOKEN_COOKIE, { path: '/', domain: this.auth().cookieDomain });
    return this.read.present(cart);
  }

  @Public()
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-check stock and reprice, per line' })
  async validate(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Body() dto: ValidateCartDto,
  ): Promise<CartValidationResult> {
    if (dto.lines && dto.lines.length > 0) return this.read.validateLines(dto.lines);
    const cart = await this.cart.find(this.owner(user, request));
    return this.read.validateStored(cart);
  }

  private owner(
    user: AuthenticatedUser | undefined,
    request: Request,
  ): { userId?: string; guestToken?: string } {
    if (user) return { userId: user.id };
    const guestToken = readGuestToken(request);
    return guestToken ? { guestToken } : {};
  }

  private issue(response: Response): string {
    return issueGuestToken(response, this.auth());
  }

  private auth(): { cookieDomain: string; cookieSecure: boolean } {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return { cookieDomain: auth.cookieDomain, cookieSecure: auth.cookieSecure };
  }
}
```

- [ ] **Step 3: Trigger the merge from login and registration**

In `auth.controller.ts`, after `this.cookies.issue(...)` in both `login` and `register`, fold any guest
basket in. Wrap it so a merge failure cannot fail the sign-in — being signed in with a lost basket is
recoverable; being unable to sign in is not:

`AuthController`'s constructor (line 41) currently injects `AuthService`, `CookieService`,
`SessionsService` and `TokenService` — **no `ConfigService`**, so `cookieDomain` is not in scope. Add it,
and name the field `config`: `this.auth` is already taken by `AuthService`, so the
`this.auth().cookieDomain` shape used in `CartController` would collide here rather than compile.

```ts
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    private readonly carts: CartService,
    private readonly logger: WinstonLoggerService,
  ) {}
```

**Three additions, not one.** An earlier version of this step added `ConfigService` alone, and then its
own code block below wrote `this.carts.mergeInto(...)` and `this.logger.error(...)` — neither of which
existed on `AuthController`. Measured: `TS2554: Expected 4 arguments, but got 7`.

```ts
    const guestToken = readGuestToken(request);
    if (guestToken) {
      const { auth } = this.config.getOrThrow<AppConfiguration>('app');
      try {
        await this.carts.mergeInto(result.user.id, guestToken);
        response.clearCookie(GUEST_TOKEN_COOKIE, { path: '/', domain: auth.cookieDomain });
      } catch (error) {
        // Deliberately swallowed, and logged rather than hidden: a failed merge costs the customer
        // their basket, which is bad; a failed sign-in costs them the account, which is worse.
        this.logger.error('Guest cart merge failed after sign-in', { userId: result.user.id, error });
      }
    }
```

Note the `clearCookie` sits **inside** the `try`, after the merge, so a failed merge leaves the cookie in
place. That is deliberate: the token is the only name those guest rows have, so clearing it after a
failure strands them permanently, whereas leaving it means the next sign-in retries — and a retried merge
is harmless, because `mergeInto` finds no guest cart the second time.

**Task 27 restructures this block** when the wishlist merge joins it. Two independent merges must not
share one `catch`, or a cart failure returns before the wishlist merge is ever attempted and the customer
loses both. It is correct as a single `try` here, where there is only one thing to merge.

`AuthModule` must import `CartModule` for `CartService`, and `CartModule` must export it.

- [ ] **Step 4: Wire the module and verify by hand**

```ts
// backend/src/modules/cart/cart.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from '../../entities/commerce/cart.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { Setting } from '../../entities/ops/setting.entity';
import { CartController } from './cart.controller';
import { CartPricingService } from './cart-pricing.service';
import { CartReadService } from './cart-read.service';
import { CartService } from './cart.service';

@Module({
  imports: [TypeOrmModule.forFeature([Cart, CartItem, Product, ProductVariant, Setting])],
  controllers: [CartController],
  providers: [CartService, CartReadService, CartPricingService],
  exports: [CartService],
})
export class CartModule {}
```

Add `CartModule` to `app.module.ts`. Then, with the backend running:

```bash
# A guest builds a basket and gets a cookie back.
JAR="$SCRATCH/guest.jar"   # session scratchpad, never /tmp
curl -s -c "$JAR" -X PUT http://localhost:4400/api/v1/cart \
  -H 'Content-Type: application/json' \
  -d '{"lines":[{"slug":"premium-california-almonds","mode":"retail","size":"250g","qty":2}]}' | head -c 200; echo
grep -c nn_guest_token "$JAR"
curl -s -b "$JAR" http://localhost:4400/api/v1/cart | head -c 200
```

Expected: the `PUT` returns one line with live totals, the jar holds `nn_guest_token` flagged
`#HttpOnly_`, and the `GET` with the same jar returns the same basket. A `GET` without the jar returns
an empty basket — which is the check that a guest key is actually what scopes it.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/cart backend/src/app.module.ts backend/src/modules/auth/auth.controller.ts backend/src/modules/auth/auth.module.ts
git commit -F - <<'MSG'
feat(cart): expose the cart endpoints and merge a guest basket on sign-in
MSG
```

## Task 21: Presenting and validating a basket

`CartReadService` — referenced by Task 20's controller and defined here. It does the two things a
stored cart needs before it can be shown: price it live, and say per line whether it can still be
bought.

Spec §10.1: *"`POST /cart/validate` returns per-line `availableQty` so a cart holding more than remains
shows the problem before checkout rather than failing at the last step."* That sentence is the whole
design. The basket is never silently corrected — the customer is told, and decides.

Bulk tier resolution here uses the `DEFAULT` segment only. Business-specific and segment pricing is
Milestone 7; resolving it now would mean guessing at a resolution order the B2B plan owns.

**Files:**
- Create: `backend/src/modules/cart/cart-read.service.ts`
- Test: `backend/src/modules/cart/cart-read.service.spec.ts`

- [ ] **Step 1: Write the failing test for the per-line verdict**

```ts
// backend/src/modules/cart/cart-read.service.spec.ts
import { verdictFor } from './cart-read.service';

const retail = (qty: number, available: number, moq = 1) => ({
  id: 'line-1',
  slug: 'almonds',
  mode: 'RETAIL' as const,
  qty,
  kg: null,
  variant: { moq, pricePaise: 29900n, available },
  product: { gstRate: 5, moqKg: 10, bulkTiers: [] },
});

describe('verdictFor', () => {
  it('passes a line that is in stock and above its minimum', () => {
    const verdict = verdictFor(retail(2, 120));
    expect(verdict.code).toBeUndefined();
    expect(verdict.availableQty).toBe(120);
    expect(verdict.lineTotal).toBe(598);
  });

  /**
   * The point of the endpoint. The line is not silently reduced — `availableQty` and `requestedQty`
   * are both reported so the UI can say "only 3 left" and let the customer choose.
   */
  it('reports OUT_OF_STOCK with both quantities when the basket asks for more than remains', () => {
    const verdict = verdictFor(retail(10, 3));
    expect(verdict.code).toBe('OUT_OF_STOCK');
    expect(verdict.availableQty).toBe(3);
    expect(verdict.requestedQty).toBe(10);
  });

  it('reports OUT_OF_STOCK for a sold-out line rather than pricing it', () => {
    expect(verdictFor(retail(1, 0)).code).toBe('OUT_OF_STOCK');
  });

  /**
   * Both rules can fire at once, and the order decides which the customer is told. Sold out first,
   * because `BELOW_MOQ` on an empty variant sends them to raise the quantity and fail again.
   */
  it('reports OUT_OF_STOCK, not BELOW_MOQ, when a line is both under the minimum and sold out', () => {
    expect(verdictFor(retail(1, 0, 3)).code).toBe('OUT_OF_STOCK');
  });

  it('reports BELOW_MOQ when the quantity is under the variant minimum', () => {
    expect(verdictFor(retail(1, 120, 3)).code).toBe('BELOW_MOQ');
  });

  it('marks a line whose product or variant has gone as unavailable', () => {
    const verdict = verdictFor({ ...retail(1, 120), variant: null });
    expect(verdict.unavailable).toBe(true);
    expect(verdict.code).toBe('NOT_FOUND');
    expect(verdict.lineTotal).toBeNull();
  });

  /**
   * A bulk weight landing in a tier with no price is a quote, not a free item. `lineTotal` is null and
   * the code says so, which is what stops checkout treating it as zero.
   */
  it('reports QUOTE_REQUIRED for a bulk weight in an unpriced tier', () => {
    const verdict = verdictFor({
      id: 'line-2',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '50.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        bulkTiers: [
          { minKg: 25, maxKg: 49, pricePerKgPaise: 84900n },
          { minKg: 50, maxKg: null, pricePerKgPaise: null },
        ],
      },
    });
    expect(verdict.code).toBe('QUOTE_REQUIRED');
    expect(verdict.lineTotal).toBeNull();
  });

  it('prices a bulk line from its resolved tier', () => {
    const verdict = verdictFor({
      id: 'line-3',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '25.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        bulkTiers: [{ minKg: 25, maxKg: 49, pricePerKgPaise: 84900n }],
      },
    });
    expect(verdict.code).toBeUndefined();
    expect(verdict.lineTotal).toBe(21225);
  });

  it('reports BELOW_MOQ when a bulk weight is under the product minimum', () => {
    const verdict = verdictFor({
      id: 'line-4',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '5.00',
      variant: null,
      product: { gstRate: 5, moqKg: 10, bulkTiers: [{ minKg: 1, maxKg: 9, pricePerKgPaise: 99900n }] },
    });
    expect(verdict.code).toBe('BELOW_MOQ');
  });

  /**
   * A bulk line is not variant-bound, so there is no single inventory row to report. Null says
   * "not applicable" rather than "none left", which a zero would.
   */
  /**
   * The divide-before-multiply truncation. **This task's own docblock states the measurement, notes
   * that "the two cases checked below did not show it", and then does not add a case that does** —
   * so the mutation stayed alive. 84999 paise/kg at 0.01kg × qty 10 is 8499 correct, 8490 if the
   * division runs first: nine paise, multiplied by the quantity.
   */
  it('divides once at the end rather than per unit weight', () => {
    const verdict = verdictFor({
      id: 'line-x', slug: 'almonds', mode: 'BULK', qty: 10, kg: '0.01', variant: null,
      product: {
        gstRate: 5, moqKg: 0,
        bulkTiers: [{ minKg: 0, maxKg: null, pricePerKgPaise: 84999n }],
      },
    });
    expect(verdict.lineTotal).toBe(toRupees(84999n * 1n * 10n / 100n));
  });

  /**
   * Boundary conditions, every one of which was pinned by nothing: the task's ten tests left twelve
   * mutants alive and these are the ones that reach a customer.
   *
   * - `qty > available` → `>=` means the **last unit cannot be bought**.
   * - `qty < moq` → `<=` refuses a quantity sitting exactly on the minimum. Same for `kg < moqKg`.
   * - `kg <= maxKg` → `<` drops 49kg out of the 25–49 slab.
   * - Removing the `maxKg === null` branch is invisible to the `QUOTE_REQUIRED` test, because "no slab
   *   matched" and "slab matched but unpriced" produce the same verdict — and every seeded top slab is
   *   unpriced, so production has no input that would expose it either.
   */
  it('sells the last unit rather than calling it out of stock', () => {
    expect(verdictFor(retail(3, 3)).code).toBeUndefined();
  });

  it('accepts a quantity and a weight sitting exactly on the minimum', () => {
    expect(verdictFor(retail(3, 120, 3)).code).toBeUndefined();
  });

  /**
   * **The most serious of the twelve.** `present()` feeds `lineTotal` straight into the money, so a
   * price on a rejected line bills stock that does not exist.
   */
  it('prices nothing on a line it rejected', () => {
    expect(verdictFor(retail(5, 3)).lineTotal).toBeNull();
    expect(verdictFor(retail(1, 120, 3)).lineTotal).toBeNull();
  });

  it('reports a null availableQty for a bulk line', () => {
    const verdict = verdictFor({
      id: 'line-5', slug: 'almonds', mode: 'BULK', qty: 1, kg: '25.00', variant: null,
      product: { gstRate: 5, moqKg: 10, bulkTiers: [{ minKg: 25, maxKg: 49, pricePerKgPaise: 84900n }] },
    });
    expect(verdict.availableQty).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- cart-read`
Expected: FAIL — `Cannot find module './cart-read.service'`.

```ts
// backend/src/modules/cart/cart-read.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  toRupees,
  type CartLine,
  type CartValidationLine,
  type CartValidationResult,
  type Paise,
} from '@nutwala/shared';
import { Repository } from 'typeorm';
import type { Cart } from '../../entities/commerce/cart.entity';
import { Setting } from '../../entities/ops/setting.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { CartPricingService, type PricedLine, type ShippingSettings } from './cart-pricing.service';
import type { CartResponse } from './cart.controller';
import type { CartLineDto } from './dto/replace-cart.dto';

/** The minimum a line needs for a verdict. Structural, so entities and DTOs both fit. */
export interface ValidatableLine {
  id: string;
  slug: string;
  mode: 'RETAIL' | 'BULK';
  qty: number;
  kg: string | null;
  variant: { moq: number; pricePaise: Paise; available: number } | null;
  product: {
    gstRate: number;
    moqKg: number;
    bulkTiers: { minKg: number; maxKg: number | null; pricePerKgPaise: Paise | null }[];
  } | null;
}

/**
 * One line's verdict. Exported for its own unit test, because this is where the rules live and the
 * repository work around it is uninteresting by comparison.
 *
 * Order matters. `NOT_FOUND` first: a line whose product has gone cannot be measured against a minimum
 * or a stock level. Then the minimum, then stock — telling someone "only 3 left" when they asked for
 * fewer than the pack minimum would send them to fix the wrong thing.
 */
export function verdictFor(line: ValidatableLine): CartValidationLine {
  const base = { id: line.id, slug: line.slug, requestedQty: line.qty };

  if (!line.product || (line.mode === 'RETAIL' && !line.variant)) {
    return { ...base, unavailable: true, availableQty: null, lineTotal: null, code: 'NOT_FOUND' };
  }

  if (line.mode === 'BULK') {
    const kg = Number(line.kg ?? 0);
    // A bulk line is not variant-bound, so there is no single row to report. Null means "not
    // applicable"; zero would mean "none left", which is a different and wrong claim.
    const bulk = { ...base, unavailable: false, availableQty: null };

    if (kg < line.product.moqKg) return { ...bulk, lineTotal: null, code: 'BELOW_MOQ' };

    const tier = line.product.bulkTiers.find(
      (candidate) => kg >= candidate.minKg && (candidate.maxKg === null || kg <= candidate.maxKg),
    );
    if (!tier || tier.pricePerKgPaise === null) {
      return { ...bulk, lineTotal: null, code: 'QUOTE_REQUIRED' };
    }

    /**
     * `kg` is a `numeric(8,2)` string. Multiplied in paise to avoid a float rupee total. Verified: 25kg at
     * ₹849/kg gives exactly 2122500 paise (₹21,225), and 7.5kg gives 636750 (₹6,367.50) with no loss.
     *
     * **A fractional weight yields a sub-rupee total, which `inr()` rounds for display.** ₹6,367.50 shows
     * as ₹6,368, so a displayed line total can sit 50 paise from the figure the server bills. Not
     * reachable through the UI today — the bulk buttons offer whole weights — but the DTO accepts
     * `@Min(0.01)`, so the API allows it. Recorded rather than guarded: rounding paise for display is
     * inherent, and the server's figure stays authoritative for the order.
     */
    const perKg = tier.pricePerKgPaise;
    /**
     * Multiply everything, then divide **once**. Not `(perKg * kg100) / 100n * qty`.
     *
     * `BigInt` division truncates, so dividing before the `qty` multiplication truncates the per-unit
     * figure and then multiplies the error by the quantity. Measured:
     *
     *   perKg 84999 (₹849.99), kg 0.01, qty 10
     *     divide-then-multiply -> 8490 paise
     *     multiply-then-divide -> 8499 paise      9 paise lost
     *   perKg 99999, kg 0.03, qty 7               6 paise lost
     *
     * Both orders agree on every whole-rupee-per-kg tier the seeder holds — 25kg at ₹849 gives
     * 2122500 either way — which is why the two cases checked below did not show it. The loss needs a
     * `pricePerKgPaise` that is not a multiple of 100 together with a fractional `kg`, and the DTO
     * accepts `@Min(0.01)`, so the API reaches it even though the bulk buttons do not.
     */
    const totalPaise =
      (perKg * BigInt(Math.round(kg * 100)) * BigInt(line.qty)) / 100n;
    return { ...bulk, lineTotal: toRupees(totalPaise) };
  }

  const variant = line.variant as NonNullable<ValidatableLine['variant']>;
  const retail = { ...base, unavailable: false, availableQty: variant.available };

  /**
   * Stock **before** minimum, not the other way round. Both can be true at once, and only one of the
   * two answers is actionable.
   *
   * A variant with `moq: 3` and `available: 0` asked for qty 1 satisfies both rules. Reporting
   * `BELOW_MOQ` tells the customer to raise the quantity to 3, which they do, and the next validate
   * answers `OUT_OF_STOCK` — two round trips to learn there is nothing to buy. `OUT_OF_STOCK` first
   * tells them the truth immediately: remove the line.
   */
  if (line.qty > variant.available) return { ...retail, lineTotal: null, code: 'OUT_OF_STOCK' };
  if (line.qty < variant.moq) return { ...retail, lineTotal: null, code: 'BELOW_MOQ' };

  return { ...retail, lineTotal: toRupees(variant.pricePaise * BigInt(line.qty)) };
}

@Injectable()
export class CartReadService {
  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    private readonly pricing: CartPricingService,
  ) {}

  /** A stored cart as the client sees it: wire lines plus live totals. */
  async present(cart: Cart | null): Promise<CartResponse> {
    const shipping = await this.shippingSettings();
    if (!cart || cart.items.length === 0) {
      return { lines: [], totals: this.pricing.totals([], shipping) };
    }

    const lines: CartLine[] = cart.items.map((item) => ({
      // The client's line identity, rebuilt from the row so a mutation can address it. Matches the
      // scheme `CartProvider` already uses, so no consumer has to learn a new one.
      id:
        item.mode === OrderChannelEnum.BULK
          ? `b:${item.product.slug}:${Number(item.kg)}`
          : `r:${item.product.slug}:${item.variant?.size ?? ''}`,
      slug: item.product.slug,
      mode: item.mode === OrderChannelEnum.BULK ? 'bulk' : 'retail',
      ...(item.variant ? { size: item.variant.size, grams: item.variant.grams } : {}),
      ...(item.kg === null ? {} : { kg: Number(item.kg) }),
      qty: item.qty,
    }));

    const priced: PricedLine[] = cart.items.map((item) => {
      const verdict = verdictFor(this.toValidatable(item));
      return {
        mode: item.mode === OrderChannelEnum.BULK ? 'BULK' : 'RETAIL',
        qty: item.qty,
        kg: item.kg,
        // The line total, passed straight through. An earlier version divided by `qty` to produce a
        // unit price that the pricing service then multiplied back — a round trip that loses a paise
        // whenever the total is not divisible by the quantity.
        //
        // A line that cannot be bought contributes nothing to the money, and `hasQuoteLines` or the
        // validation call is what tells the customer why.
        lineTotalPaise: verdict.lineTotal === null ? null : toPaise(verdict.lineTotal),
        gstRate: Number(item.product.gstRate),
        quoteRequired: verdict.code === 'QUOTE_REQUIRED',
      };
    });

    return { lines, totals: this.pricing.totals(priced, shipping) };
  }

  async validateStored(cart: Cart | null): Promise<CartValidationResult> {
    const presented = await this.present(cart);
    const lines = (cart?.items ?? []).map((item) => verdictFor(this.toValidatable(item)));
    return { ok: lines.every((line) => line.code === undefined), lines, totals: presented.totals };
  }

  /**
   * Validates lines from the request body rather than the stored cart, so the checkout page can check
   * exactly what the customer is looking at — which may differ from what was last saved if a `PUT` is
   * still in flight. Spec §6.3 makes this route available to guests for the same reason.
   */
  async validateLines(lines: CartLineDto[]): Promise<CartValidationResult> {
    // Implementation note: resolve the products and variants in two queries keyed on the slugs, build
    // a `ValidatableLine` per entry exactly as `toValidatable` does for a stored item, then reuse
    // `verdictFor`. Do not write a second copy of the rules — one derivation, the same principle as
    // `soldOut`.
    throw new Error('Implement by resolving slugs then reusing verdictFor — see the note above.');
  }

  /**
   * `product.pricingTiers` **must** be loaded by whatever fetched this cart.
   *
   * An earlier version of this plan loaded only `product` and `variant.inventory`, which made
   * `pricingTiers` undefined, the `?? []` below yield an empty array, and therefore **every bulk line
   * report `QUOTE_REQUIRED`** — a wrong answer rather than an error, so nothing would have failed
   * except the bulk cart quietly refusing to price anything. All three `relations` clauses in
   * `CartService` now request it.
   */
  private toValidatable(item: Cart['items'][number]): ValidatableLine {
    return {
      id: item.id,
      slug: item.product.slug,
      mode: item.mode === OrderChannelEnum.BULK ? 'BULK' : 'RETAIL',
      qty: item.qty,
      kg: item.kg,
      variant: item.variant
        ? {
            moq: item.variant.moq,
            pricePaise: item.variant.pricePaise,
            available: (item.variant.inventory?.onHand ?? 0) - (item.variant.inventory?.reserved ?? 0),
          }
        : null,
      product: {
        gstRate: Number(item.product.gstRate),
        moqKg: Number(item.product.moqKg),
        bulkTiers: (item.product.pricingTiers ?? []).map((tier) => ({
          minKg: Number(tier.minKg),
          maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
          pricePerKgPaise: tier.pricePerKgPaise,
        })),
      },
    };
  }

  /**
   * Shipping rules from the seeded `Setting` rows rather than a constant, so admin can change them
   * without a deploy. `frontend/src/config/settings.ts` still holds hardcoded defaults and
   * `PincodeChecker.tsx` carries its own second copy of the 79 — both are Milestone 8's to remove.
   */
  private async shippingSettings(): Promise<ShippingSettings> {
    const rows = await this.settings.find({
      where: [{ key: 'freeShippingThreshold' }, { key: 'flatShippingRate' }],
    });
    const value = (key: string, fallback: number): number => {
      const row = rows.find((candidate) => candidate.key === key);
      return typeof row?.value === 'number' ? row.value : fallback;
    };
    return {
      freeShippingThreshold: value('freeShippingThreshold', 999),
      flatShippingRate: value('flatShippingRate', 79),
    };
  }
}
```

**`CartService.resolveLines` is not reusable here, despite the resemblance.** Measured before relying on
it: it is `private`, it returns entity *insert* columns rather than validation inputs, it **throws**
`DomainError` on an unknown slug — wrong for a per-line endpoint whose whole job is to report `NOT_FOUND`
per line — and its `select` clauses omit every field `verdictFor` needs. Products select `{ id, slug }`
with no `gstRate`, `moqKg` or `pricingTiers`; variants select `{ id, productId, size, isActive }` with no
`moq`, `pricePaise` or `inventory`. Only the two-query shape and the `isActive` filter carry over.

**Four defects in the code above, found while Task 20 landed this file early. Fix them as you go.**

1. **`toPaise` is used in `present()` and never imported.** It does not compile as given.
2. **The line identity is built twice, and the two disagree — so every verdict joins to nothing.**
   `present()` composes `r:${slug}:${size}` / `b:${slug}:${kg}`, which is the scheme
   `CartProvider.tsx` already keys on, while `toValidatable()` sets `id: item.id` — the row's uuid. A
   validation result whose `id` matches no line on the page cannot annotate the line it is about, which
   is the entire purpose of the endpoint. Extract one `cartLineId(item)` in `cart-line.mapper.ts` and
   call it from both. (Task 21's spec passes `id` in directly, so no test here notices.)
3. **`verdictFor`'s docblock states the wrong order.** It says "then the minimum, then stock" while the
   code, its own inline comment, and this task's own test all check **stock first** — deliberately, so a
   sold-out variant is not reported as `BELOW_MOQ`. Correct the docblock, not the code.
4. **The drift guard below shows no imports** for `CartValidationCode`, `ErrorCode` or `ErrorCodes`, and
   leaves `_codesExist` unused, which lint rejects. Import them and mark the constant as intentionally
   unread in the way this repo already does elsewhere.

**Two more found during implementation, neither fixable in this file:**

- **The seeded tier ladder has gaps at fractional weights.** `buildTiers` produces 1–4, 5–9, 10–24,
  25–49, 50+ while `CartLineDto` bounds `kg` only by `@Min(0.01)`, so **24.5kg or 49.5kg matches no slab**
  and reports `QUOTE_REQUIRED`. Not a bug in `verdictFor`, and the seeder is locked to Phase 1's visible
  behaviour, so it stays until someone widens the slabs or the DTO.
- **`hasQuoteLines` conflated "could not be priced" with "needs a quote", and it reached the customer.**
  Fixed in `a27b5d6`; see the note in Task 19.

**Two more, left deliberately and flagged rather than fixed:**

- The prose says bulk tiers resolve on the `DEFAULT` segment only, but `toValidatable` filters no
  segment at all. Latent today — no non-`DEFAULT` tiers exist until Milestone 7 — and it becomes wrong
  the moment they do.
- `shippingSettings`' `999` / `79` fallbacks restate the frontend's constants in a third place. Same
  class as the Task 19 finding, and Milestone 8 owns removing both.

**One obligation inherited from Task 3.** `CartValidationCode` is a named type over an `as const`
tuple in `shared/src/types/cart.ts`, deliberately so something can reference it — `shared/` cannot
import from `backend/`, so the guard against it drifting from `ErrorCodes` has to live here, where both
names are in scope. Add it to this file:

```ts
/**
 * Compile-time proof that every cart validation code is a real `ErrorCode`.
 *
 * Not decoration: without it, renaming a code in the registry leaves clients branching on a string the
 * server has stopped sending, and nothing fails. Verified to break on rename — `BELOW_MOQ` →
 * `BELOW_MINIMUM` in the registry makes this line fail with TS2339.
 */
const _validationCodesExist: Record<CartValidationCode, ErrorCode> = {
  OUT_OF_STOCK: ErrorCodes.OUT_OF_STOCK,
  BELOW_MOQ: ErrorCodes.BELOW_MOQ,
  QUOTE_REQUIRED: ErrorCodes.QUOTE_REQUIRED,
  NOT_FOUND: ErrorCodes.NOT_FOUND,
};
```

All four exist in `ErrorCodes` today; this was checked, not assumed.

**`validateLines` is left throwing on purpose, and it is the one thing in this plan you must finish
rather than copy.** The rules are already written in `verdictFor`; the work is resolving slugs to
products and variants — which `CartService.resolveLines` does **only in shape** — see the note below — and feeding them in. Writing a
second copy of the rules is the mistake to avoid.

- [ ] **Step 3: Finish `validateLines`, run, commit**

Run: `npm run test -w backend -- cart-read`
Expected: PASS — 9 tests. Add one more asserting `validateLines` agrees with `validateStored` for the
same basket, which is the test that catches a second copy of the rules drifting.

```bash
git add backend/src/modules/cart/cart-read.service.ts backend/src/modules/cart/cart-read.service.spec.ts
git commit -F - <<'MSG'
feat(cart): price a basket live and report a per-line stock verdict
MSG
```

## Task 22: Inventory and the admin adjustment

Spec §5.2's ledger, and Milestone 4's "admin adjust". The invariant Plan 1 established —
`SUM(inventory_transactions.delta) == inventory.onHand` per variant — must survive an adjustment, so
the column write and the ledger row go in **one transaction** or the two drift the first time one fails.

The admin UI for this lives in the separate admin repo; this task builds the endpoint it will call.

**Files:**
- Create: `backend/src/modules/inventory/inventory.service.ts`, `inventory.module.ts`, `inventory.controller.ts`, `dto/adjust-stock.dto.ts`
- Test: `backend/src/modules/inventory/inventory.service.spec.ts`, `inventory.controller.spec.ts`, and
  **its own** `backend/test/integration/inventory.integration.spec.ts`. An earlier version deferred the
  database cases to Task 23's spec, which does not exist when this task runs — and three of this
  endpoint's claims are unreachable from a test double: that `:delta` binds inside a raw `set()`, that
  the floor means what it reads as, and that the column write and the ledger row are atomic. Shipping a
  single-statement endpoint whose statement might not execute is the wrong trade. A separate file also
  means Task 23 adding cases to its own spec cannot collide.

**`availabilityFor` is named in this task's opening line and never specified — do not invent it.** There
is no step, no signature and no caller for it anywhere in this plan; it survives only in the
file-responsibility table. It also has no consumer: `cart-read.service.ts` already derives
`(inventory?.onHand ?? 0) - (inventory?.reserved ?? 0)` inline with a docblock explaining why. An unused
public method with an unspecified signature is speculative API, and the shape it would take is exactly
what Task 2's `no-restricted-syntax` availability rule exists to discourage. Whoever builds the admin
stock view owns defining it.

- [ ] **Step 1: The service**

```ts
// backend/src/modules/inventory/inventory.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { InventoryTransactionType } from '../../entities/enums';

@Injectable()
export class InventoryService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Applies a signed stock adjustment and records why, in one transaction.
   *
   * The ledger row and the column move together or not at all. Plan 1 established
   * `SUM(delta) == onHand` per variant as a tested invariant, and a write that updated one without the
   * other would break it silently — the column is what the storefront reads, so the shop would then
   * disagree with its own audit trail.
   *
   * The `UPDATE` is conditional in the same shape as spec §10.2's decrement: `onHand + delta >= reserved`
   * is evaluated inside the writing statement, so there is no read-then-write gap. **That property is
   * untested** — nothing in this codebase issues two concurrent adjustments — so treat it as a property
   * of the statement's shape rather than as covered.
   *
   * **The clause is not what prevents negative stock**, which an earlier version of this docblock
   * implied. `ck_inventory_non_negative` already enforces
   * `"onHand" >= 0 AND "reserved" >= 0 AND "onHand" >= "reserved"` (InitialSchema, line 392), so the
   * database refuses the write either way. What the clause buys is turning a 500 constraint violation
   * into a 409 carrying `OUT_OF_STOCK`, which the admin console can branch on.
   *
   * Zero rows affected has **two** causes and they need different answers — see the branch below.
   * An earlier version of this sentence said it "means the adjustment would have oversold what is
   * already spoken for", contradicting the code twenty lines down. Either way it is a rejection rather
   * than a clamp: silently clamping would tell the admin their correction succeeded when it did not.
   */
  async adjust(input: {
    variantId: string;
    delta: number;
    reason: string;
    actorUserId: string;
  }): Promise<{ onHand: number; balanceAfter: number }> {
    /**
     * **Truncate first, then reject zero.** An earlier version of this task checked
     * `input.delta === 0` and only then applied `Math.trunc`, which lets a fractional delta below one
     * unit through: `0.4` is not zero, truncates to `0`, and the method then returns **200** with
     * `onHand` unchanged *and writes an `ADJUSTMENT` row to the append-only ledger asserting a movement
     * of zero*. Measured — the test "is what a fractional delta below one unit becomes, and is refused
     * too" resolved `{ onHand: 120, balanceAfter: 120 }` instead of rejecting.
     *
     * `@IsInt()` on the DTO makes that unreachable over HTTP, but this method is also the one Plan 3's
     * checkout will call directly, and a guard that only holds because of a caller's decorator is not a
     * guard.
     */
    const delta = Math.trunc(input.delta);

    if (delta === 0) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'An adjustment of zero changes nothing. Enter the quantity added or removed.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      /**
       * `:delta` as a parameter, **not** interpolated into the SQL string.
       *
       * An earlier version of this plan built both clauses with template literals. Not exploitable —
       * `@IsInt()` guarantees a number, and a number cannot carry a quote — but it is the wrong habit in
       * the one file that writes raw SQL fragments, and it would have been copied. Verified that a
       * parameter survives inside a raw `set()` expression and is reused across both clauses:
       *
       * ```sql
       * UPDATE "public"."inventory" SET "onHand" = "onHand" + $1, "updatedAt" = CURRENT_TIMESTAMP
       *  WHERE "variant_id" = $2 AND "onHand" + $1 >= "reserved"
       * ```
       *
       * Note `updatedAt` is **not** set by hand. TypeORM's `@UpdateDateColumn` adds
       * `CURRENT_TIMESTAMP` itself, which is the database's clock — better than the application's, since
       * a stock ledger read against `updatedAt` should not depend on which host wrote the row.
       */
      const result = await manager
        .createQueryBuilder()
        .update(Inventory)
        .set({ onHand: () => '"onHand" + :delta' })
        .where('variant_id = :variantId')
        .andWhere('"onHand" + :delta >= reserved')
        .setParameters({ delta, variantId: input.variantId })
        .execute();

      if (result.affected !== 1) {
        /**
         * Zero rows affected has **two** causes, and they need different answers.
         *
         * The conditional `WHERE` can fail — the adjustment would take stock below what is reserved —
         * but so can `variant_id = :variantId` simply matching nothing, because the id is wrong or the
         * variant was deleted. An earlier version of this task reported both as
         * `OUT_OF_STOCK` / 409, so an admin who mistyped a variant id was told their correction would
         * oversell reserved orders: an explanation about stock levels for a row that does not exist,
         * sending them to look at the wrong thing entirely.
         *
         * One extra query, only ever on the failure path, separates them.
         */
        const exists = await manager
          .getRepository(Inventory)
          .exists({ where: { variantId: input.variantId } });

        if (!exists) {
          throw new DomainError(
            ErrorCodes.NOT_FOUND,
            'No such product variant.',
            HttpStatus.NOT_FOUND,
            { variantId: input.variantId },
          );
        }

        throw new DomainError(
          ErrorCodes.OUT_OF_STOCK,
          'That adjustment would take stock below what is already reserved for open orders.',
          HttpStatus.CONFLICT,
          { variantId: input.variantId, delta: input.delta },
        );
      }

      const inventory = await manager.getRepository(Inventory).findOneOrFail({
        where: { variantId: input.variantId },
      });

      await manager.getRepository(InventoryTransaction).insert({
        variantId: input.variantId,
        delta,
        type: InventoryTransactionType.ADJUSTMENT,
        reason: input.reason,
        balanceAfter: inventory.onHand,
        orderId: null,
        actorUserId: input.actorUserId,
      });

      return { onHand: inventory.onHand, balanceAfter: inventory.onHand };
    });
  }
}
```

- [ ] **Step 2: The DTO and controller**

```ts
// backend/src/modules/inventory/dto/adjust-stock.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, MinLength, NotEquals } from 'class-validator';

export class AdjustStockDto {
  /** Signed: positive for a receipt, negative for shrinkage or a correction. */
  @ApiProperty({ example: -5 })
  @IsInt() @NotEquals(0)
  delta: number;

  /**
   * Required, and not from a fixed list. Brief §32 wants the history to say *why*, and a free-text
   * reason an admin actually writes is more useful than a dropdown they pick the first option from.
   */
  @ApiProperty({ example: 'Damaged in transit — 5 packs discarded' })
  @IsString() @MinLength(4) @MaxLength(200)
  reason: string;
}
```

```ts
// backend/src/modules/inventory/inventory.controller.ts
import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { InventoryService } from './inventory.service';

/**
 * The first admin-only route in the service. `RolesGuard` is global and reads the role from the signed
 * token, so this is enforced server-side regardless of what any client believes — which is what makes
 * the admin console being a separate application a deployment choice rather than a security boundary.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Patch(':variantId')
  @ApiOperation({ summary: 'Adjust stock for a variant and record why' })
  adjust(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AdjustStockDto,
  ): Promise<{ onHand: number; balanceAfter: number }> {
    return this.inventory.adjust({ variantId, ...dto, actorUserId: user.id });
  }
}
```

Wire `InventoryModule` (importing `TypeOrmModule.forFeature([Inventory, InventoryTransaction])`) and add
it to `app.module.ts`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/inventory backend/src/app.module.ts
git commit -F - <<'MSG'
feat(inventory): adjust stock and its ledger together, refusing to oversell reserved units
MSG
```

## Task 23: Cart integration tests

Against real Postgres. The merge is the case that matters most, and it is not testable in a unit
spec — it needs two carts, a real unique index, a real cascade and a real transaction.

**Files:**
- Create: `backend/test/integration/cart.integration.spec.ts`
- Modify: `backend/test/integration/helpers/http.ts` — promote two cookie helpers (Step 0)
- Modify: `backend/test/integration/auth.integration.spec.ts` — import them instead of defining them

- [ ] **Step 0: Promote the cookie helpers so this spec can use them**

The spec below needs `cookieEntry` and `cookieValue`. They exist, but as **private** functions inside
`auth.integration.spec.ts` (lines 73 and 82) — not exported, so nothing else can reach them. Move them to
`backend/test/integration/helpers/http.ts`, which is already re-exported by `helpers/index.ts` and is
where `expectSuccess` and `expectError` live, then have `auth.integration.spec.ts` import them rather than
declare them.

Move the bodies unchanged, including the comments — both earn their place. `cookieEntry` explains why
`response.get('Set-Cookie')` is the only route that compiles (`@types/superagent` declares `headers` as
`{ [index: string]: string }` even though Node returns an array), and why it **throws** on a missing
cookie instead of returning `''`: `expect('').not.toMatch(/HttpOnly/)` passes, so a response that stopped
setting the cookie altogether would satisfy every negative assertion.

```ts
// appended to backend/test/integration/helpers/http.ts
import type { Response } from 'supertest';

export function cookieEntry(response: Response, name: string): string { /* moved verbatim */ }
export function cookieValue(response: Response, name: string): string { /* moved verbatim */ }
```

Confirm you changed nothing observable: `npm run test:integration -w backend` must stay green, with
`auth.integration.spec.ts` at the same count as before.

- [ ] **Step 1: Write the spec**

```ts
// backend/test/integration/cart.integration.spec.ts
import type { CartTotals, CartLine, CartValidationResult } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { agent, expectError, expectSuccess, request, useIntegrationApp } from './helpers';

interface CartResponse { lines: CartLine[]; totals: CartTotals }

const almonds = { slug: 'premium-california-almonds', mode: 'retail' as const, size: '250g', qty: 2 };

describe('cart', () => {
  const integration = useIntegrationApp();

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  /** Signs in and returns a cookie-persisting client plus its CSRF token. */
  async function signedIn(email = 'b2c@demo.in') {
    const client = agent(integration.app);
    const login = await client
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo.
   *
   * **A cold write can never succeed and must not be written as though it can.** `CsrfGuard` requires
   * both a cookie and a matching header on every method but GET/HEAD/OPTIONS —
   * `if (!cookie || !header) throw this.reject()` (`csrf.guard.ts:41`) — and a brand-new client has
   * neither. `csrfBootstrap` sets `nn_csrf` on the **response**, so it is available from the *next*
   * request onward; it cannot retroactively satisfy the guard on the request that minted it, and it
   * must not, or an attacker's cross-site POST would be handed a fresh pair too.
   *
   * So one priming request first — any safe method will do, since the middleware runs on all of them.
   * `signedIn()` gets its token from `CookieService.issue()` instead, which is why only the guest path
   * needs this.
   */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get('/api/v1/cart').expect(200);
    return { client, csrf: cookieValue(primer, 'nn_csrf') };
  }

  describe('guest carts', () => {
    it('creates a basket for a visitor with no session and hands back a cookie', async () => {
      const { client, csrf } = await guest();
      const response = await client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const body = expectSuccess<CartResponse>(response);
      expect(body.lines).toHaveLength(1);
      expect(body.totals.subtotal).toBe(598);

      const cookies = response.get('Set-Cookie') ?? [];
      const guestCookie = cookies.find((cookie) => cookie.startsWith('nn_guest_token='));
      expect(guestCookie).toBeDefined();
      // The key is a bearer credential for the basket, so script must not be able to read it.
      expect(guestCookie).toMatch(/HttpOnly/i);
    });

    it('returns the same basket to the same cookie and nothing to a different visitor', async () => {
      const { client: first, csrf } = await guest();
      await first.put('/api/v1/cart').set('X-CSRF-Token', csrf).send({ lines: [almonds] }).expect(200);
      expect(expectSuccess<CartResponse>(await first.get('/api/v1/cart').expect(200)).lines).toHaveLength(1);

      // A fresh client is a different visitor. If this returns the first basket, the cart is not
      // actually scoped by the key and every guest shares one.
      const second = agent(integration.app);
      expect(expectSuccess<CartResponse>(await second.get('/api/v1/cart').expect(200)).lines).toEqual([]);
    });

    it('refuses a forged guest key rather than querying with it', async () => {
      const response = await request(integration.app)
        .get('/api/v1/cart')
        .set('Cookie', 'nn_guest_token=../../etc/passwd')
        .expect(200);
      // Treated as no key at all: an empty basket, not an error and not someone else's cart.
      expect(expectSuccess<CartResponse>(response).lines).toEqual([]);
    });
  });

  describe('merge on sign-in', () => {
    /**
     * The case this milestone exists to get right. A guest builds a basket, signs in at checkout, and
     * must find it intact — losing it there is the most expensive bug available, because it happens at
     * the moment the customer was about to pay.
     */
    it('folds a guest basket into the account on sign-in', async () => {
      const client = agent(integration.app);
      await client.put('/api/v1/cart').send({ lines: [almonds] }).expect(200);

      await client
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      const after = expectSuccess<CartResponse>(await client.get('/api/v1/cart').expect(200));
      expect(after.lines).toHaveLength(1);
      expect(after.lines[0]?.qty).toBe(2);
    });

    it('sums quantities when both baskets hold the same line', async () => {
      // Put one bag in the account first.
      const { client: signedInClient, csrf } = await signedIn();
      await signedInClient
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [{ ...almonds, qty: 1 }] })
        .expect(200);

      // Then a separate anonymous visit adds two more and signs in.
      const guest = agent(integration.app);
      await guest.put('/api/v1/cart').send({ lines: [{ ...almonds, qty: 2 }] }).expect(200);
      await guest
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      const merged = expectSuccess<CartResponse>(await guest.get('/api/v1/cart').expect(200));
      expect(merged.lines).toHaveLength(1);
      expect(merged.lines[0]?.qty).toBe(3);
    });

    it('deletes the guest cart so a second merge cannot double the quantity', async () => {
      const client = agent(integration.app);
      await client.put('/api/v1/cart').send({ lines: [almonds] }).expect(200);
      const login = await client
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);
      const csrf = expectSuccess<{ csrfToken: string }>(login).csrfToken;

      // Calling merge again explicitly must be a no-op.
      await client.post('/api/v1/cart/merge').set('X-CSRF-Token', csrf).expect(200);
      const after = expectSuccess<CartResponse>(await client.get('/api/v1/cart').expect(200));
      expect(after.lines[0]?.qty).toBe(2);

      const guestCarts = await integration.dataSource.query<{ count: string }[]>(
        'SELECT count(*)::text AS count FROM carts WHERE guest_token IS NOT NULL',
      );
      expect(guestCarts[0]?.count).toBe('0');
    });

    it("keeps one customer out of another customer's basket", async () => {
      const b2c = await signedIn('b2c@demo.in');
      await b2c.client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', b2c.csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const b2b = await signedIn('b2b@demo.in');
      expect(expectSuccess<CartResponse>(await b2b.client.get('/api/v1/cart').expect(200)).lines).toEqual([]);
    });
  });

  /**
   * Task 20 requires these four directly, and an earlier version of this spec had none of them: every
   * CSRF token in it came from `signedIn()`, so nothing exercised the anonymous bootstrap at all. Task
   * 20 predicted precisely that — *"a spec that only ever uses `agent()` after a `GET` would pass
   * without proving any of it."*
   */
  describe('the anonymous CSRF bootstrap', () => {
    it('hands a brand-new client an nn_csrf cookie on its very first request', async () => {
      const response = await request(integration.app).get('/api/v1/cart').expect(200);
      const entry = cookieEntry(response, 'nn_csrf');
      // Readable by script on purpose — the frontend has to echo it in a header, which is the whole
      // mechanism. It is not a credential: it proves only that the caller could read a same-site cookie.
      expect(entry).not.toMatch(/HttpOnly/i);
    });

    it('lets a guest write once it holds the cookie-and-header pair', async () => {
      const { client, csrf } = await guest();
      await client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [almonds] })
        .expect(200);
    });

    it('refuses the same write without the header', async () => {
      const { client } = await guest();
      const response = await client.put('/api/v1/cart').send({ lines: [almonds] }).expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    /**
     * **The one a naive implementation gets wrong.** If `csrfBootstrap` mints a token unconditionally
     * instead of only when the cookie is absent, it overwrites the one `CookieService.issue()` set at
     * sign-in — invalidating the header the client is already sending, so every subsequent write from a
     * signed-in customer 403s. Nothing else in this suite would notice: `signedIn()` reads its token
     * once, and each test makes one write.
     */
    it("does not rotate a signed-in client's token on a later request", async () => {
      const { client, csrf } = await signedIn();
      const later = await client.get('/api/v1/cart').expect(200);

      // Either the response re-sets the identical value, or it sets no nn_csrf at all. What it must
      // not do is set a different one.
      const reset = (later.get('Set-Cookie') ?? []).find((c) => c.startsWith('nn_csrf='));
      if (reset !== undefined) expect(cookieValue(later, 'nn_csrf')).toBe(csrf);

      // And the original token must still be accepted, which is the consequence that actually matters.
      await client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [almonds] })
        .expect(200);
    });
  });

  /**
   * The race `upsertCart`'s insert-or-ignore exists to close, and **nothing else in this plan covers
   * it.** Task 18's unit test pins the code *shape*, and it says so: a single-threaded fake cannot tell
   * insert-or-ignore from `findOne`-then-`save`, because the latter passes too. Only concurrent writes
   * against real Postgres can.
   *
   * Two simultaneous first writes from one fresh guest cookie. Under `findOne`-then-`save` both reads
   * return nothing, both insert, and the loser violates `uq_carts_guest_token` — a 500 on a guest's very
   * first Add to Cart. Under insert-or-ignore the loser blocks on the index, does nothing, and reads the
   * winner's row.
   */
  it('survives two simultaneous first writes from one guest', async () => {
    const { client, csrf } = await guest();

    const [first, second] = await Promise.all([
      client.put('/api/v1/cart').set('X-CSRF-Token', csrf).send({ lines: [almonds] }),
      client.put('/api/v1/cart').set('X-CSRF-Token', csrf).send({ lines: [almonds] }),
    ]);

    // Neither may 500. A whole-basket PUT is last-writer-wins, so both answering 200 is correct.
    expect([first.status, second.status]).toEqual([200, 200]);

    // And exactly one cart row exists, not two and not zero.
    const rows = await integration.dataSource.query<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM carts WHERE guest_token IS NOT NULL',
    );
    expect(rows[0]?.count).toBe('1');
  });

  describe('the owner exclusivity constraint', () => {
    it('is enforced by the database, not only by the service', async () => {
      // The service always sets exactly one owner. This asserts the constraint would catch a future
      // writer that forgot — which is the reason it exists rather than a comment.
      await expect(
        integration.dataSource.query(`INSERT INTO carts (user_id, guest_token) VALUES (NULL, NULL)`),
      ).rejects.toThrow(/ck_carts_owner_exclusive/);
    });
  });

  describe('POST /cart/validate', () => {
    it('reports availability per line and stays open to guests', async () => {
      const response = await request(integration.app)
        .post('/api/v1/cart/validate')
        .send({ lines: [{ ...almonds, qty: 2 }] })
        .expect(200);

      const result = expectSuccess<CartValidationResult>(response);
      expect(result.ok).toBe(true);
      expect(result.lines[0]?.availableQty).toBe(120);
    });

    /**
     * Spec §10.1: a basket holding more than remains must show the problem *before* checkout. The line
     * is reported, never silently reduced — the customer decides.
     */
    it('reports OUT_OF_STOCK with both figures rather than trimming the line', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 3, reserved = 0
         WHERE variant_id = (
           SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'premium-california-almonds' AND v.size = '250g')
      `);

      const result = expectSuccess<CartValidationResult>(
        await request(integration.app)
          .post('/api/v1/cart/validate')
          .send({ lines: [{ ...almonds, qty: 10 }] })
          .expect(200),
      );

      expect(result.ok).toBe(false);
      expect(result.lines[0]).toMatchObject({ code: 'OUT_OF_STOCK', availableQty: 3, requestedQty: 10 });
    });

    it('agrees with the stored-cart path for the same basket', async () => {
      // The two entry points must not grow separate copies of the rules.
      const client = agent(integration.app);
      await client.put('/api/v1/cart').send({ lines: [almonds] }).expect(200);

      const stored = expectSuccess<CartValidationResult>(
        await client.post('/api/v1/cart/validate').send({}).expect(200),
      );
      const explicit = expectSuccess<CartValidationResult>(
        await client.post('/api/v1/cart/validate').send({ lines: [almonds] }).expect(200),
      );
      expect(explicit.lines[0]?.code).toBe(stored.lines[0]?.code);
      expect(explicit.totals).toEqual(stored.totals);
    });

    it('flags a quote-required bulk weight instead of pricing it as free', async () => {
      const result = expectSuccess<CartValidationResult>(
        await request(integration.app)
          .post('/api/v1/cart/validate')
          .send({ lines: [{ slug: 'premium-california-almonds', mode: 'bulk', kg: 50, qty: 1 }] })
          .expect(200),
      );
      expect(result.ok).toBe(false);
      expect(result.lines[0]?.code).toBe('QUOTE_REQUIRED');
      expect(result.lines[0]?.lineTotal).toBeNull();
      expect(result.totals.hasQuoteLines).toBe(true);
    });
  });

  describe('PUT /cart validation', () => {
    it('rejects a line for a product that does not exist', async () => {
      const response = await request(integration.app)
        .put('/api/v1/cart')
        .send({ lines: [{ slug: 'no-such-product', mode: 'retail', size: '250g', qty: 1 }] })
        .expect(422);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    /**
     * A mode's own field is required, not merely allowed. Without `@ValidateIf` a bulk line with no
     * weight is stored and then reports `BELOW_MOQ` on every validate — a line the customer cannot
     * check out with and can only fix by deleting.
     */
    it('rejects a bulk line with no weight and a retail line with no size', async () => {
      const { client, csrf } = await guest();

      const noKg = await client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [{ slug: 'premium-california-almonds', mode: 'bulk', qty: 1 }] })
        .expect(400);
      expect(JSON.stringify(expectError(noKg).details)).toContain('kg');

      const noSize = await client
        .put('/api/v1/cart')
        .set('X-CSRF-Token', csrf)
        .send({ lines: [{ slug: 'premium-california-almonds', mode: 'retail', qty: 1 }] })
        .expect(400);
      expect(JSON.stringify(expectError(noSize).details)).toContain('size');
    });

    it('rejects a basket larger than the cap rather than accepting an unbounded transaction', async () => {
      const lines = Array.from({ length: 51 }, () => almonds);
      await request(integration.app).put('/api/v1/cart').send({ lines }).expect(400);
    });
  });

  /**
   * **`PATCH /admin/inventory/:variantId` is deliberately not covered here.** Task 22 ships its own
   * `backend/test/integration/inventory.integration.spec.ts` with 18 cases across authorization, a
   * well-formed adjustment, the reserved floor and DTO validation — because three of that endpoint's
   * claims are unreachable from a test double and Task 23's spec does not exist when Task 22 runs.
   *
   * An earlier version of this task carried three cases (a customer refused, an adjustment writing its
   * ledger row, an adjustment breaching the floor) which are now a strict subset of that file. Two
   * suites asserting the same behaviour is how they come to disagree, and the one nobody edits is the
   * one that goes stale. Leave them there.
   */
});

async function firstVariantId(dataSource: { query: (sql: string) => Promise<{ id: string }[]> }): Promise<string> {
  const [row] = await dataSource.query(`
    SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE p.slug = 'premium-california-almonds' AND v.size = '250g' LIMIT 1
  `);
  return row?.id ?? '';
}
```

- [ ] **Step 2: Run, then prove the merge test is load-bearing**

Run: `npm run test:integration -w backend`
Expected: PASS — 87 from before plus 18 new, 105 across 7 suites.

Then break the merge and watch the right test fail:

```bash
cd /Users/kunal/Desktop/nutwala/backend
cp src/modules/cart/cart.service.ts "$SCRATCH/cs.bak"
python3 - <<'PY'
import pathlib
p = pathlib.Path('src/modules/cart/cart.service.ts')
# The bug this test exists to catch: the guest basket is dropped instead of folded in.
p.write_text(p.read_text().replace('if (current) current.qty += line.qty;', 'if (current) return;'))
PY
npx jest --config jest.integration.config.ts --runInBand -t "merge on sign-in" 2>&1 | grep -E "✕|Tests:"
cp "$SCRATCH/cs.bak" src/modules/cart/cart.service.ts
diff -q "$SCRATCH/cs.bak" src/modules/cart/cart.service.ts && echo RESTORED
```

Expected: the summing test fails, then `RESTORED`.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/cart.integration.spec.ts
git commit -F - <<'MSG'
test(cart): prove guest scoping, the sign-in merge and the ledger invariant against Postgres
MSG
```

## Task 24: The server-backed cart on the client

Breaking change C. Every `CartProvider` mutator is synchronous today and writes to `localStorage` under
`nn.cart.v1`; a server cart cannot be. The shape of the context is preserved as far as possible so
consumers change as little as possible, but the mutators return promises.

**The merge needs nothing from the client.** Task 20 folds the guest basket in during `POST /auth/login`
and `POST /auth/register`, server-side, so the frontend only has to refetch after sign-in. That is
deliberately more robust than calling `/cart/merge` from the client: a customer whose browser closes
immediately after signing in still keeps their basket.

**Files:**
- Create: `frontend/src/features/cart/api/index.ts`
- Rewrite: `frontend/src/features/cart/CartProvider.tsx`
- Modify: `frontend/src/features/cart/types.ts` → re-export shim over `@nutwala/shared`
- Keep: `frontend/src/features/cart/cart-math.ts` and its tests, for the optimistic total
- Test: `frontend/src/features/cart/CartProvider.test.tsx` (new)

- [ ] **Step 1: The seam**

```ts
// frontend/src/features/cart/api/index.ts
import type { CartLine, CartTotals, CartValidationResult } from "@nutwala/shared";
import { http } from "@/lib/http";

export interface CartState {
  lines: CartLine[];
  totals: CartTotals;
}

/**
 * The cart over the real API.
 *
 * `replace` sends the whole basket rather than a delta. The server's state is then a function of one
 * request instead of a sequence, so a dropped request cannot leave the two disagreeing about a
 * quantity — and there is no ordering between concurrent mutations to get wrong.
 *
 * There is no `merge` here on purpose: the server folds a guest basket in during sign-in, so the client
 * only refetches. See `CartProvider`.
 */
export const cartApi = {
  get: (): Promise<CartState> => http.get("/cart"),
  replace: (lines: CartLine[]): Promise<CartState> =>
    http.put("/cart", { lines: lines.map(toRequestLine) }),
  validate: (lines?: CartLine[]): Promise<CartValidationResult> =>
    http.post("/cart/validate", lines ? { lines: lines.map(toRequestLine) } : {}),
};
```

**`toRequestLine` is not optional plumbing — without it every cart write returns 400.**

`CartLine` is what the server *sends*; `CartLineDto` (Task 20) is what it *accepts*, and it is deliberately
narrower. Compared field by field:

| `CartLine` (response) | `CartLineDto` (request) | |
| --- | --- | --- |
| `id: string` | — | **rejected** |
| `slug: string` | `slug` | ok |
| `mode: Channel` | `mode: 'retail' \| 'bulk'` | ok — `Channel` *is* `'retail' \| 'bulk'`, verified in `shared/src/types/catalog.ts:3` |
| `size?: string` | `size?` | ok |
| `grams?: number` | — | **rejected** |
| `kg?: number` | `kg?` | ok |
| `qty: number` | `qty` | ok |

`app.module.ts:231-232` sets `whitelist: true` **and** `forbidNonWhitelisted: true`, so `id` and `grams`
do not get stripped — they are refused:

```json
{"details":{"lines.0.id":["property id should not exist"],
            "lines.0.grams":["property grams should not exist"]}}
```

Every `PUT /cart` and every `POST /cart/validate` carrying lines, on the first attempt. **`tsc` cannot
catch this**: `lines` is a variable, so excess-property checking does not apply — the same reason
Task 12's `ShopPage` shipped `?focus=true` into a 400 until it was measured. Dropping `id` is right
semantically too: `replace` deletes and re-inserts the rows, so the server issues new ids on every write
and a client-supplied one is meaningless.

```ts
/**
 * `CartLine` narrowed to `CartLineDto`. Written out field by field rather than by deleting keys, so a
 * field added to the wire response cannot silently start being posted back.
 */
const toRequestLine = (line: CartLine) => ({
  slug: line.slug,
  mode: line.mode,
  qty: line.qty,
  ...(line.size !== undefined ? { size: line.size } : {}),
  ...(line.kg !== undefined ? { kg: line.kg } : {}),
});
```

Replace `frontend/src/features/cart/types.ts` with a shim:

```ts
/** Re-export shim — the definitions moved to `shared/src/types/cart.ts` so the server can produce them. */
export type { CartLine, CartTotals, CartValidationLine, CartValidationResult } from "@nutwala/shared";
```

- [ ] **Step 2: Write the failing provider test**

```tsx
// frontend/src/features/cart/CartProvider.test.tsx
import type { CartState } from "./api";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CartProvider, useCart } from "./CartProvider";

const state = (qty: number): CartState => ({
  lines: [{ id: "r:almonds:250g", slug: "almonds", mode: "retail", size: "250g", grams: 250, qty }],
  totals: { subtotal: 299 * qty, gst: 15 * qty, shipping: 79, total: 393 * qty, hasQuoteLines: false },
});

function Probe() {
  const cart = useCart();
  return (
    <div>
      <span data-testid="count">{cart.count}</span>
      <span data-testid="total">{cart.totals.total}</span>
      <button onClick={() => void cart.addRetail("almonds", "250g", 250, 1)}>add</button>
    </div>
  );
}

/**
 * `AuthProvider` must wrap it. `CartProvider` calls `useAuth()` for the reload-on-identity-change
 * effect, and `useAuth` throws "useAuth must be used inside AuthProvider" — so rendering
 * `<CartProvider>` alone fails every case in this file before any assertion runs. The real tree always
 * has `AuthProvider` outside it (`providers/AppProviders.tsx`), so this mirrors production rather than
 * working around the hook.
 *
 * One stub answers both, because both providers fetch on mount and there is a single `globalThis.fetch`
 * to stub: `/auth/me` gets a 401 (nobody is signed in for these cases) and `/cart` gets the state under
 * test. Layering two stubs on one global is how you get a test that depends on installation order.
 */
const renderCart = () =>
  render(
    <AuthProvider>
      <CartProvider>
        <Probe />
      </CartProvider>
    </AuthProvider>,
  );

/** Answers the two mount-time requests. `cart` is the state under test; auth is always anonymous here. */
function stubBoth(cart: CartState, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/auth/me")) {
      return Promise.resolve(
        new Response(JSON.stringify({ success: false, statusCode: 401, message: "Unauthorized" }), {
          status: 401,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(status === 200 ? { success: true, data: cart } : cart), { status }),
    );
  });
}

describe("CartProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the basket from the server on mount", async () => {
    stubBoth(state(2));
    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("2"));
  });

  /**
   * The server's totals are authoritative. `cart-math.ts` accumulates float rupees and rounds once;
   * the server computes per-line GST in paise, so the two can differ by a rupee. The provider must
   * *replace* its optimistic figure with the reply, never keep its own.
   */
  it("replaces its optimistic total with the server's reply", async () => {
    stubBoth({ ...state(1), totals: { ...state(1).totals, total: 999 } });
    renderCart();
    await waitFor(() => expect(screen.getByTestId("total")).toHaveTextContent("999"));
  });

  it("shows the change immediately and does not wait for the round trip", async () => {
    let resolve: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { lines: [], totals: state(0).totals } }), { status: 200 }))
      .mockImplementationOnce(() => new Promise((r) => { resolve = r; }));

    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));

    await act(async () => { screen.getByText("add").click(); });
    // Optimistic: the count moved before the PUT resolved.
    expect(screen.getByTestId("count")).toHaveTextContent("1");

    await act(async () => {
      resolve?.(new Response(JSON.stringify({ success: true, data: state(1) }), { status: 200 }));
    });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  });

  /**
   * A rejected write must not leave the UI claiming something is in the basket that is not on the
   * server. Rolling back is less pleasant than pretending, and far less unpleasant than a customer
   * reaching checkout with a basket the server never had.
   */
  it("rolls back an optimistic change when the server refuses it", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { lines: [], totals: state(0).totals } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, statusCode: 422, message: "We no longer stock that.", code: "NOT_FOUND" }), { status: 422 }),
      );

    renderCart();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
    await act(async () => { screen.getByText("add").click(); });
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("0"));
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then rewrite the provider**

Run: `npm run test -w frontend -- CartProvider`
Expected: FAIL — the current provider never calls `fetch`, so the count stays at whatever
`localStorage` held.

The rewrite, in outline — write it out fully, this is the shape rather than a substitute for the code:

- State: `lines: CartLine[]`, `totals: CartTotals`, `isLoading`, `error: string | null`.
- On mount: nothing separate. **Do not add a mount fetch beside the identity effect below** — that
  effect runs on mount too, so a `void cartApi.get()` here means two `GET /cart` calls on every page
  load. One of them wins the race and sets state, and which one is not defined. The identity effect is
  the single load path; a 401 is impossible on it because the route is public, so any failure is a real
  one and belongs in `error` rather than being swallowed.
- Every mutator computes the next `lines` array locally with the **existing** logic (the line-identity
  scheme and the fold-duplicates behaviour are unchanged), sets it immediately for the optimistic
  update, then `await cartApi.replace(next)` and replaces both `lines` and `totals` with the reply. On
  rejection, restore the previous array and set `error`.
- `totals` comes from the server. Use `cartTotals` from `cart-math.ts` **only** for the optimistic
  window between a mutation and its reply — and say so in a comment, or the next reader will delete
  `cart-math.ts` as dead code or, worse, start trusting it.
- Keep `mode`, `setMode`, `open`, `setOpen`, `count`, `lineTotalFor` exactly as they are. They are
  local UI state and derived reads; nothing about them belongs on the server.
- `clear()` becomes `await cartApi.replace([])`.
- Delete the `localStorage` read and write, and the `nn.cart.v1` key. The server is the store now, and a
  second copy in `localStorage` would be a cache nobody invalidates — a basket that reappears after
  checkout is exactly that bug.

  **This breaks seven places in `frontend/src/test/routes.smoke.test.tsx`, and the plan needs to say so
  rather than leaving you to discover it mid-task.** Measured:

  | Line | What it does |
  | --- | --- |
  | 47 | `const CART_KEY = "nn.cart.v1"` — the key itself |
  | 117, 121 | `renderAt`'s `seedCart` parameter, which writes that key before rendering |
  | 451 | asserts the whole stored line after an Add to Cart on `/combos` |
  | 895 | asserts the cart is **empty** after the order confirmation clears it |
  | 953 | asserts the stored bulk line after Add to Bulk Cart |
  | 973 | asserts empty again |

  Plus three tests that pass a `seedCart` array positionally (`renderAt("/checkout", [ … ])`).

  Both halves need rehousing, and they are different problems:

  - **Seeding** a basket becomes stubbing `GET /cart` to return those lines and the totals the server
    would compute. That is a real change in what the test asserts — the old form seeded the client's
    own store, the new one seeds the server's answer — so pick the totals deliberately rather than
    letting a stub invent them.
  - **Asserting** the stored basket becomes asserting the request the client sent: `PUT /cart` with that
    line array, through `toRequestLine`, which is exactly where `id` and `grams` are dropped. Do **not**
    weaken these to "some request happened" — line 451 and line 953 pin the composed line identity
    (`r:daily-dry-fruit-combo:1kg`, `b:w320-cashews:10`), and that identity is what `POST /cart/validate`
    joins its verdicts on. Line 895's "empty after confirmation" becomes `PUT /cart` with `lines: []`,
    which is what `clear()` now sends.

  Do this in the same commit. A rewrite that leaves seven references to a deleted key is not finishable
  in pieces.
- Drop `CartProvider`'s **own** `catalogApi.listProducts()` call and its local `products` state. Pricing
  is server-side, so the *provider* no longer needs the catalogue.

  **Scope that precisely: "holding the catalogue in the browser is no longer needed" is not true, and
  taking it at face value renders a blank cart.** `CartLine` deliberately carries no name, price or
  image, so the two screens that display a basket resolve those by slug against a whole-catalogue
  fetch of their own:

  ```
  components/layout/CartDrawer.tsx:14   useProducts({ limit: WHOLE_CATALOGUE })  -> products.find(...)
  routes/cart.tsx:26                    useProducts({ limit: WHOLE_CATALOGUE })  -> products.find(...)
  ```

  Both stay. What goes is the provider's third copy of the same fetch.

  **A design question this exposes, recorded rather than decided.** Fetching 60 products to render a
  two-line basket is the stopgap Task 12 left, and the obvious fix is for the cart response to carry
  `name` and `image` per line. The reason `CartLine` omits them is documented in
  `shared/src/types/cart.ts` — *"a cached price on the line is how a cart comes to disagree with the
  catalogue"* — and that argument is about **price**, which is genuinely re-resolved on every read. It
  does not transfer to a product's name or its thumbnail: those change rarely, and a stale one costs a
  wrong label rather than a wrong charge. Adding them would let both screens drop the catalogue fetch
  entirely. It is a wire-contract change with two consumers, so it belongs to whoever owns the cart's
  next revision, not to this task.

Reload when the signed-in identity changes. **Do this inside `CartProvider`, watching auth — not
inside `AuthProvider`, calling the cart.**

One consequence to carry into the spec: `CartProvider` now depends on `AuthProvider`, so
`CartProvider.test.tsx` must render it **inside** one. `useAuth` throws when its context is missing, so a
standalone `<CartProvider>` fails every case before an assertion runs.

The providers live in `frontend/src/providers/AppProviders.tsx` (not `main.tsx`), ordered
`QueryClientProvider > AuthProvider > CartProvider`. So `CartProvider` can already call `useAuth()`,
and no reordering is needed:

```tsx
// in CartProvider
  const { user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    /**
     * Reload whenever the signed-in identity changes, in either direction.
     *
     * On **sign-in** the server has already folded any guest basket into the account during
     * `POST /auth/login`, so the client only has to pick up the result — which is why nothing here
     * calls `/cart/merge`. Doing the merge server-side means a customer whose browser closes straight
     * after signing in still keeps their basket.
     *
     * On **sign-out** this matters just as much and is easy to miss: the account's cart is no longer
     * reachable, and the customer reverts to a fresh guest cart. Without this the browser would keep
     * displaying the signed-out user's basket, and the next add-to-cart would write it into a guest
     * cart that never had those lines.
     *
     * Watching the id rather than hooking the login call is what makes both directions fall out of
     * one effect instead of needing two call sites to remember.
     */
    void reload();
  }, [userId, reload]);
```

**`reload` must be `useCallback`-wrapped with a stable dependency list, and this is not a style note.**
It is in that dependency array. An unmemoised `reload` gets a new identity on every render, so the effect
re-fires, `reload` sets state, the component re-renders, `reload` is new again — an unbounded loop of
`GET /cart` for as long as the page is open. It will look like the server is under attack, and the cause
will be four characters of missing memoisation.

`AuthProvider` is the model to copy and it is right next door: it wraps `persist` in `useCallback` and
its context value in `useMemo` (`AuthProvider.tsx:93` and `:99`). Do the same here — and if `reload`
genuinely needs to close over changing state, read that state through a ref rather than widening the
dependency list.

Watching `userId` — a **string** — rather than the `user` object is load-bearing for the same reason.
`AuthProvider` holds `user` in `useState(() => readSnapshot())`, so it is populated synchronously on the
first render, and its `/auth/me` validation may then set a *different object with the same id*. On the
object that is a changed dependency and refetches the cart for nothing; on the id it is not.

Expose `reload` on the context too — the cart page wants it for a manual retry after a failed write.

**Three things this task's own text got wrong, found by implementing it.**

1. **Step 3 contradicts itself.** It says keep `lineTotalFor` "exactly as [it is]" *and* remove the
   provider's catalogue. `lineTotalFor` is not local UI state — it needs product data. Measured with
   `find` returning undefined: 6 tests red, the cart renders **₹0**, and `Quote Required` never appears.
   The resolution is neither: the provider drops its *own* `catalogApi.listProducts()` and reads the
   shared `useProducts({ limit: WHOLE_CATALOGUE })` query instead, which took whole-catalogue requests
   per journey from 2 to 1.
2. **"The provider's third copy" undercounts.** Five consumers fetch the whole catalogue, not three:
   `CartDrawer.tsx:14`, `cart.tsx:26`, `CheckoutForm.tsx:93`, `business/bulk-cart.tsx:22`, and the
   provider.
3. **"Lines 451 and 953 pin the composed line identity" cannot be true of the request body**, because
   `toRequestLine` drops `id` — that is its purpose. Assert **both**: the request (which pins the field
   list) and the resulting stored basket read back (which pins `r:daily-dry-fruit-combo:1kg` and
   `b:w320-cashews:10`, recomposed server-side).

**And three things nothing pinned, all now covered:**

- **The error rendering Step 4 asks for.** Deleting the cart page's error banner outright failed **0 of
  188** tests. The stub needed `failCartLoad`/`failCartWrite` arrangements before any of the three
  surfaces could be held to it.
- **`AppProviders.tsx`.** Nothing pinned the provider order, and this task makes that dangerous:
  `CartProvider` newly requires `useAuth()` and a `QueryClient` above it, so a wrong order typechecks,
  builds, passes every other suite, and white-screens on first paint.
- **Overlapping `PUT`/`GET`.** `/order-success/$id` clears the basket in a mount effect while the mount
  `GET` is still outstanding; the `GET` landing second repopulates what was just cleared, and the next
  add writes those lines back. Same shape as the defect Task 23 found server-side. Guarded with a
  monotonic generation counter.

- [ ] **Step 4: Fire-and-forget call sites**

Every `onClick={() => addRetail(...)}` now discards a promise. `oxlint` does not flag that by default,
but it means a rejected write goes nowhere visible — which is precisely what the `error` state is for.
Render it: the cart drawer and the product page should surface `error` when it is set, and clear it on
the next successful mutation. A silent failure here is a customer clicking Add to Cart, seeing nothing
happen, and clicking again.

Mark each intentional discard with `void` so the intent is explicit rather than accidental.

- [ ] **Step 5: Verify in a browser, including the case that matters**

```bash
cd /Users/kunal/Desktop/nutwala
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
```

**Do not start the dev servers yourself.** An earlier version of this step ran
`(npm run dev > /tmp/dev.log 2>&1 &)`, which breaks two of this project's standing rules at once: it
writes outside the session scratchpad, and it starts a second stack on ports another process already
holds — the root `dev` script is `concurrently … --kill-others-on-fail`, so a port collision in one
workspace tears down the other two. If a stack is already running, use it. If it is not, ask; starting
and stopping the user's servers is not a subagent's call.

The guest-to-customer path, by hand, because it is the one this milestone exists for:

1. In a fresh private window, **do not sign in.** Add two bags of almonds. Confirm the badge shows 2.
2. Reload the page. The basket survives — it is on the server now, not in `localStorage`.
3. Check DevTools → Application → Cookies: `nn_guest_token` is present and flagged HttpOnly, and
   `localStorage` has **no** `nn.cart.v1`.
4. Sign in as `b2c@demo.in`. **The basket is still there.** This is the assertion; everything else in
   this task is machinery for it.
5. Confirm in the database that the guest cart is gone and the row now belongs to the user:
   ```bash
   docker exec nutwala-postgres psql -U nutwala -d nutwala -c \
     "SELECT (user_id IS NOT NULL) AS owned, guest_token IS NULL AS no_guest_token, count(*) FROM carts GROUP BY 1,2;"
   ```
6. Drain the variant's stock to 1, reload the cart page, and confirm the out-of-stock line is
   *reported* rather than silently reduced.

**Restore that stock with the value you captured, not with `npm run seed`.** Reseeding rewrites rows and
ids other work depends on. `SELECT` the `onHand` first, keep the output, `UPDATE` it back afterwards, and
re-run the `SELECT` to show it matches. Do not stop any server you did not start.

**And if `/api/v1/products` answers 404 while `/api/v1/health` answers 200, stop here and report it
rather than working around it.** That is the stale-watch-server symptom the README documents: the running
process predates its own `dist/`. Steps 1–6 are unobservable until it restarts, and restarting it is the
user's call. Report the steps as not performed rather than describing an outcome you did not see.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/cart frontend/src/features/auth/AuthProvider.tsx \
  frontend/src/components/layout/CartDrawer.tsx frontend/src/routes/cart.tsx \
  frontend/src/routes/product.\$slug.tsx frontend/src/test/routes.smoke.test.tsx
git commit -F - <<'MSG'
feat(frontend): move the cart to the server and keep a guest basket through sign-in
MSG
```

**Still not right, twice over — corrected again after implementation.** It names
`features/auth/AuthProvider.tsx`, which needs no change at all: this task says to do the reload inside
`CartProvider`, and `AuthProvider` already memoises what it exposes. And it omits eight files the task
must touch — the four `void` call sites (`ProductCard`, `ComboCard`, `BulkProductCard`, `bulk-cart`),
`routes/order-success.$id.tsx`, and the two existing harnesses that wrap `CartProvider` bare
(`ProductCard.test.tsx`, `BulkProductCard.test.tsx`), which the note about rendering inside an
`AuthProvider` overlooked.

**The path list above is corrected; the earlier one was wrong in three ways.** It named
`frontend/src/main.tsx`, but the providers live in `frontend/src/providers/AppProviders.tsx` — this task
says so itself a few paragraphs up — and `main.tsx` needs no change at all. It omitted
`frontend/src/test/routes.smoke.test.tsx`, which this task *must* edit because seven references there
depend on the `nn.cart.v1` key being deleted. And it omitted the three files Step 4 asks you to render
`error` in: the cart drawer, the cart page and the product page. Add `AppProviders.tsx` too if the
provider order changes; it should not need to.

```bash
```

## Task 25: Milestone 4 verification

- [ ] **Step 1: Every suite**

```bash
cd /Users/kunal/Desktop/nutwala
npm run build -w @nutwala/shared && npm run test -w @nutwala/shared
npm run typecheck -w backend && npm run lint -w backend && npm run test -w backend
npm run test:integration -w backend
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
npm run format:check -w backend && npm run format:check -w frontend
npm run build
npm audit --audit-level=high
```

- [ ] **Step 2: The migration chain still reverts**

A migration landed in this milestone, so re-prove item 7 rather than assuming it. Use a throwaway
database and remember `NODE_ENV=test`, or the exported `DB_PORT` is ignored and this runs against the
dev database:

```bash
**Use a literal port, never a shell variable.** `set -a && . ./.env` **overwrites any same-named
variable you already set**, and `.env` defines `PORT=4400` — so a helpfully-parameterised
`PORT=5559 … export DB_PORT=$PORT` becomes `DB_PORT=4400` and the migration runs against **the user's
node dev server**. Measured during Task 16: it fails with `Connection terminated unexpectedly` because
an HTTP server rejects the Postgres wire protocol, so nothing was harmed — but the same slip with a
number that happens to be a live database would not be so kind. Export `DB_PORT` *after* sourcing, as
below, and echo it once before running anything.

```bash
docker run -d --name nn-revertcheck -e POSTGRES_USER=nutwala -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=nutwala -p 127.0.0.1:5559:5432 postgres:15-alpine >/dev/null
for i in $(seq 1 30); do docker exec nn-revertcheck pg_isready -U nutwala -q && break; sleep 1; done
cd backend && set -a && . ./.env && set +a && export NODE_ENV=test DB_PORT=5559 DB_PASSWORD=x
# Prove where this is pointed before it writes anything. 5559, not 5442 and not 4400.
echo "DB_PORT=$DB_PORT NODE_ENV=$NODE_ENV"
npm run migration:run

# Revert until nothing is left, rather than a fixed number of times. An earlier version of this step
# reverted exactly three, which was right for the two migrations that existed when it was written and
# wrong the moment this plan added GuestCarts and Wishlist — it would have left one applied and then
# reported a leaked table as a clean result. A loop cannot go stale.
while npm run migration:show 2>/dev/null | grep -q '^\[X\]'; do npm run migration:revert; done

docker exec nn-revertcheck psql -U nutwala -d nutwala -qtA -c \
  "SELECT 'tables=' || count(*) FROM pg_stat_user_tables;
   SELECT 'enums=' || count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e' AND n.nspname='public';"
npm run migration:run
cd .. && docker rm -f nn-revertcheck >/dev/null
```

Expected: once the loop drains, `tables=1` — only `migrations` — and **`enums=0`**. Enum leakage is the
part a hand-written `down()` most often misses, because a dropped table leaves its `CREATE TYPE` behind
and the next `migration:run` then fails on "type already exists" rather than on anything informative.

Do not restate a revert *count* here. This line used to read "after three reverts", which is the exact
staleness the loop's own comment warns against — and it was wrong the moment this plan added two more
migrations. The loop's termination is the condition; a number beside it is a second source of truth that
goes stale independently.

- [ ] **Step 3: Record what actually happened**

Append a "Milestone 4 complete" section with the final counts, and — more usefully — anything that
turned out differently from what this plan says. Plan 1's most valuable artefact was the list of
places its own plan had been wrong; this plan will have its own.

```bash
git add docs/superpowers/plans/2026-08-20-nuts-nazaakat-catalogue-and-cart.md
git commit -F - <<'MSG'
docs(plan): record Milestone 4 completion
MSG
```

---

## Definition of done

1. `npm run build` passes across `shared`, `backend` and `frontend` under `strict: true`.
2. `npm run lint` and `npm run format:check` pass in both workspaces.
3. Every suite passes: shared, backend unit, backend integration, frontend.
4a. **Every route a client calls is reachable — asserted against the routing table, not the handler.**

   Added after Task 27 shipped a wishlist controller with **no `@Get('slugs')` decorator** while 349
   unit and 155 integration tests stayed green. `GET /api/v1/wishlist/slugs` answered **404** on the
   running service; the client Task 28 built mounts against exactly that route.

   The reason nothing noticed is general and worth stating once: **every controller test in this
   codebase calls its handler as a plain method**, and a hand-built call never consults the routing
   table. A method with a correct body, correct DTO and correct return type passes every behavioural
   test it has while being unreachable over HTTP. The same blind spot hid
   `@CurrentUser()`-on-a-`@Public()`-route (a 500 for every guest) and a missing `@HttpCode` (201 where
   200 was documented) — three defects, one cause.

   Two things close it: read the handlers out of Nest's metadata (`PATH_METADATA`, `METHOD_METADATA`,
   `ROUTE_ARGS_METADATA`, `HTTP_CODE_METADATA`) and assert the set, or hit the route over HTTP in the
   integration suite. Prefer the second where a suite already exists.

4. **Every test file is collected by exactly one runner.** An orphaned spec looks like coverage and
   never executes; compare `find`'s list against `jest --listTests` and Vitest's file count.

   Measured 2026-08-20 and currently clean: 24 test files on disk under `backend/`, 18 collected by the
   unit config and 6 by the integration config, **zero** collected twice and **zero** collected by
   nothing.

   **And check the runners, not only the specs** — the same failure exists one level up.
   `npm run test:e2e -w backend` prints `No tests found, exiting with code 0`: its config sets
   `roots: ['<rootDir>/test/e2e']`, that directory does not exist, and `passWithNoTests: true` makes it
   green. That is deliberate and commented, and the script is not in the standard sweep, so it masks
   nothing today. It would the moment anyone adds it to CI ahead of the Playwright work. Two notes for
   whoever gets there: the config's comment says "empty until Plan 4" while §16 puts Playwright in
   Milestone 10, and `passWithNoTests` should come back out when the first journey lands, or an empty
   `test/e2e/` will keep reporting success.
5. No `.only`, `.skip`, `xit` or `fdescribe` anywhere — each silently shrinks a suite while every
   report still says "passed".
6. The migration chain applies to an empty database, reverts cleanly leaving no orphaned enum types,
   and re-applies.
7. `SUM(inventory_transactions.delta) == inventory.onHand` holds for every variant, **including after
   an admin adjustment**.
8. Every catalogue surface reads Postgres: `frontend/src/mocks/products.ts`, `categories.ts`,
   `combos.ts` and `reviews.ts` are imported by **nothing outside `src/test/`**.

   **Not "imported by nothing", which is what this item used to say and is false.** Task 11 moved the
   mock seam's `applyFilters`, `buildCombo` and `summarise` into `src/test/catalog-api.stub.ts` rather
   than reimplementing them, deliberately, because the smoke tests pin figures derived from them
   (₹132/100g, ₹989/kg, the ₹497 combo saving). Measured — all four have exactly **one** real importer:

   ```
   products    src/test/catalog-api.stub.ts
   categories  src/test/catalog-api.stub.ts
   combos      src/test/catalog-api.stub.ts
   reviews     src/test/catalog-api.stub.ts
   ```

   `routes.smoke.test.tsx` appears in a naive `grep -rln "mocks/products"` but only mentions the path in
   two comments — check for an `import`, not for the string, or you will chase a match that is prose.

   So the check is that **no production module** reads them, which is what the item was always for. The
   remaining three have production importers and are expected until later plans: `orders.ts` and
   `addresses.ts` from `features/account/api/index.ts`, `rfqs.ts` from `features/rfq/api/index.ts`.
9. `soldOut` agrees with `available` on every seeded variant and product, asserted over all 27 products.
10. **SOLD OUT renders** per variant and per product, and Add to Cart is disabled for a sold-out
    selection. Confirmed in a browser, not only in jsdom.

    **Outstanding as of Task 13, and it must not be ticked from the jsdom evidence alone.** Task 13
    implemented and unit-tested all of it and was told to skip the browser step because the dev backend
    looked dead. It was not: the probe used `/api/v1/products`, and the route is
    `/api/v1/catalog/products` — spec §6.1's own spelling. That path has been answering 200 with the
    seeded catalogue throughout. So this item is undone rather than blocked, and doing it needs no
    restart. Use capture-mutate-restore on the stock rows, never `npm run seed`.
11. `inStockOnly` filters real data and respects `channel`.
12. Facets describe the whole catalogue: twelve categories summing to 27 products, price bounds 449 and
    3499.
13. Lists are paginated and page 2 shares no product with page 1.
14. No money field on the wire looks like paise, and `gstRate` arrives as a `number`.
15. A guest builds a basket, signs in, and **still has it**. The guest cart row is gone afterwards.
16. One customer cannot read another's cart, and a forged guest key yields an empty basket rather than
    someone else's.
17. `POST /cart/validate` reports `availableQty` and `requestedQty` per line and never silently trims a
    line.
18. A quote-required bulk line is flagged, not priced as free.
19. `PATCH /admin/inventory/:variantId` refuses a customer with 403, refuses an adjustment that would
    oversell reserved stock with 409, and writes column and ledger together.
20. **The customer app contains no admin surface** — no route file, no `createFileRoute("/admin…")`, and
    nothing matching `/admin` in the generated route tree. An admin signing in is not shown the
    customer dashboard, **and neither is an admin who arrives at `/account` any other way.**

    The second half is a separate defect and was missed at first. Task 14 changed `LoginForm`, which
    covers only the path through the sign-in form; `requireAuth` (`features/auth/guards.ts`) answers
    "is someone signed in", not "who", so an admin navigating to `/account` directly — or arriving
    holding a snapshot from an earlier session — still rendered the customer dashboard. Closed by
    `requireCustomer`, mirroring the `requireBusiness` role check beside it. Verify **both** paths.
21. `nn_guest_token` is httpOnly and is scrubbed by the log redactor.
22. No `.env` is tracked by git and `npm audit` reports nothing at high or above.

## What this plan deliberately leaves undone

Listed so their absence is not mistaken for an oversight:

- **No order is ever written.** COD checkout, the race-safe decrement, coupons, pincode serviceability,
  order history, the tracking timeline, cancellation and the address book are all Milestones 5–6.
- `frontend/src/features/checkout/api/index.ts` still fabricates an order id and writes the receipt to
  `sessionStorage`; `features/account/api/index.ts` still reads `mocks/orders.ts` and keeps addresses in
  `localStorage`.
- Bulk tier resolution uses the `DEFAULT` segment only. Business-specific and segment pricing is
  Milestone 7.

  **This is a Milestone 7 precondition, not just deferred work, and it is currently a comment rather
  than a guard.** `cart-read.service.ts`'s `toProductRules` maps **every** `pricingTiers` row with no
  segment or business filter, while `catalog/mappers/product.mapper.ts` filters to
  `segment === DEFAULT && businessId === null`. `verdictFor` then takes the **first** array match, and
  there is no `ORDER BY` anywhere in the load. So the price the bulk product page shows and the price
  the cart bills come from two different tier sets, resolved in an unspecified order.

  They agree today only because of the data — `SELECT segment, business_id IS NULL, count(*) FROM
  pricing_tiers GROUP BY 1,2` returns one row, `DEFAULT | t | 135`. **The first `RETAILER` or
  per-business tier row inserted makes the cart misprice against the page it is showing, with no
  error.** Whoever opens Milestone 7 must define the resolution order (business, then segment, then
  `DEFAULT`) and apply it in **both** places before inserting any non-`DEFAULT` tier — not after.
- `Review.verifiedPurchase` is always `false` **on reviews created through the API** — not on every
  review, which is what this line used to say. `reviews.service.ts:114` hardcodes `false` because the
  derivation needs delivered orders; `review.mapper.ts:36` passes the **stored** column through, and the
  seeder set it, so **12 of the 14 dev-database rows are `true`**. Anyone reading the old wording and
  then seeing a "Verified Purchase" badge would think the control had failed.

  The control itself is intact and is the part that matters: `CreateReviewDto` omits the field entirely,
  so a client cannot forge it (spec §13's row on this). What is missing is only the derivation — the
  `DELIVERED`-order query — which belongs in the checkout plan.
- `config/settings.ts` still holds hardcoded defaults, and `PincodeChecker.tsx` still carries its own
  second copy of the ₹79 shipping constant. Milestone 8 removes both.
- Combo composition is a backend constant, not a table. The admin plan owns turning it into
  `ComboComponent` rows with foreign keys.
- No Playwright journeys. Milestone 10.
- **Two spec §6.1 endpoints are not built here:** `GET /catalog/bulk/products` and
  `POST /catalog/bulk/quote-preview`. Both exist to serve *resolved* tier pricing, which needs the
  segment and per-business resolution order that Milestone 7 owns. Nothing breaks in the meantime:
  `Product.bulkTiers` carries the `DEFAULT` tiers, so `/bulk-orders`, `/bulk/$category` and the product
  page's bulk calculator all work, and `ProductFilters.channel` gives the bulk pages a server-side
  filter. What a B2B customer does *not* get yet is their negotiated rate — they see list pricing, which
  is honest rather than wrong.


---

## Milestone 4 complete

**Measured 2026-08-20 by Task 25, every figure from a command run in that session — nothing copied
forward from an earlier task's report.**

| Suite | Result | Command |
| --- | --- | --- |
| `@nutwala/shared` | 61 passed / 4 files | `npm run test -w @nutwala/shared` |
| backend unit | 318 passed / 29 suites | `npm run test -w backend` |
| backend integration | 155 passed / 8 suites | `npm run test:integration -w backend` |
| frontend | 191 passed / 12 files | `npm run test -w frontend` |

`typecheck`, `lint` and `format:check` exit 0 in both workspaces; `npm run build -w @nutwala/shared`
and `npm run build -w frontend` exit 0; `npm audit --audit-level=high` reports 0 vulnerabilities.
Exit codes were captured from the commands themselves, not read off a pipeline — an earlier pass here
had `echo "EXIT=$?"` after a `| tail`, which reports `tail`'s status and is green unconditionally.

**`nest build` was deliberately not run, and Step 1 as written cannot be.** Root `npm run build`
expands to `npm run build -w backend`, which is `nest build`, and `nest-cli.json` sets
`deleteOutDir: true` — it would delete the `dist/` the dev server on 4400 is executing. The backend's
exact build configuration was proven instead with `npx tsc -p tsconfig.build.json --noEmit`, exit 0.
`strict: true` confirmed in `shared/tsconfig.json`, `backend/tsconfig.json` and
`frontend/tsconfig.app.json`; the first two also set `noUncheckedIndexedAccess`.

**Step 2, on a throwaway container on 5559 — never the dev database.** `DB_PORT` echoed as 5559 before
anything wrote. The chain is **three** migrations. The loop drained it in three reverts, leaving
`tables=1` (`migrations` alone) and **`enums=0`**; `migration:run` then re-applied all three to
`tables=34`, `enums=18`. The container was removed and `docker ps` confirmed only `nutwala-postgres`
and `nutwala-postgres-test` remained.

`SUM(inventory_transactions.delta) == inventory."onHand"` verified directly against the development
database: 216 variants, 234 ledger rows, **0** mismatched variants.

### What turned out differently from what this plan said

1. **Step 1's `npm run build` is not runnable while the dev server is up**, for the `deleteOutDir`
   reason above. The step should call the three workspace builds and skip or replace the backend's.
2. **Definition-of-done item 4's figures were stale by a whole milestone.** It recorded 24 test files
   under `backend/`, 18 unit and 6 integration. Actually **37** on disk, **29** collected by the unit
   config and **8** by the integration config. The invariant it exists to protect still holds exactly:
   `comm` over `jest --listTests` for both configs against `find` shows **zero** files collected twice
   and **zero** collected by nothing. The numbers went stale; the property did not.
3. **Item 4's stated cause for the green e2e run is wrong.** It says `roots: ['<rootDir>/test/e2e']`
   points at a directory that "does not exist". `backend/test/e2e/` **does** exist and holds a
   `.gitkeep`. `No tests found, exiting with code 0` comes from `testRegex: '.*\.e2e-spec\.ts$'`
   matching nothing inside it, plus `passWithNoTests: true`. The conclusion stands — the runner is
   green with zero tests — but a future reader creating the directory would fix nothing.
4. **Step 2's justification names a migration that was never written.** It says a fixed count of three
   reverts "was wrong the moment this plan added GuestCarts and Wishlist". There is no Wishlist
   migration; `GuestCarts20260820090000` is the only one this milestone added, so the chain is three
   long and a hardcoded three would in fact have been correct today. The loop is still the right
   construct for the stated reason — it just has not been vindicated yet.
5. **Item 8's importer table is stale, and its remainder list is incomplete.** It claims each of the
   four catalogue mocks has "exactly one real importer". `mocks/products` now has **two**:
   `src/test/catalog-api.stub.ts` and `src/test/cart-api.stub.ts`. Both are under `src/test/`, so the
   item's actual requirement — no production module reads them — is confirmed. Separately, "the
   remaining three have production importers" misses a fourth: `mocks/posts.ts` is imported by
   `features/content/api/index.ts`. And `mocks/users.ts` is imported by nothing at all, production or
   test; there is no `src/mocks/index.ts` barrel that could hide a reference.
6. **`Review.verifiedPurchase` is not "always `false`".** `reviews.service.ts` hardcodes `false` when
   *creating* a review, and `create-review.dto.ts` omits the field so no client can forge it — that
   half is right and is the half that matters for trust. But `review.mapper.ts` passes the stored
   column straight to the wire, and `content.seed.ts` seeds the mock's values: **12 of 14** rows in the
   development database are `true`. The accurate claim is "a review created through the API is always
   `verifiedPurchase: false`".
7. **The second copy of the ₹79 shipping constant is not where this plan says.** `config/settings.ts`
   does hold hardcoded defaults, but ₹79 is not among them — it holds `freeShippingThreshold: 999`.
   The two frontend copies of `SHIPPING_FLAT = 79` are `features/catalog/components/PincodeChecker.tsx`
   and `features/cart/cart-math.ts`. The backend now owns the value as well, as a `flatShippingRate`
   settings row with a `79` fallback in `cart-read.service.ts`, so Milestone 8 has three places to
   collapse rather than two.
8. **"No order is ever written" is true of application code only.** No order controller or service
   exists and nothing in `backend/src` inserts into `orders`, but `database/seeds/orders.seed.ts` does,
   and the development database holds 6 order rows. The bullet means "checkout writes no order", which
   is confirmed; as written it reads wider than it is.
9. **Root `package.json` declares a workspace that does not exist.** `"workspaces"` lists `e2e`, and
   there is no `/e2e` directory. npm tolerates it silently today.

### Still outstanding

**Definition-of-done item 10 — the browser confirmation of SOLD OUT and the disabled Add to Cart — is
not done, and Task 25 could not do it.** No browser driver is installed anywhere in the monorepo
(no Playwright, no Puppeteer, nothing in `node_modules/.bin`), and the verification also needs a
capture-mutate-restore on live stock rows, which risks the `SUM(delta) == onHand` invariant item 7
asserts and which is currently clean. jsdom coverage exists and passes; it is not what item 10 asks
for. This remains the one unticked item in Milestone 4.

**`dist/modules/catalog/catalog.service.js` is still stale, and still silent.** Re-measured: the file
is frozen at 13:30:48 while sibling modules in the same `dist/` tree carry timestamps up to 16:24:20.
`maxMoq` appears **3** times in `catalog.service.ts` and **0** times in the compiled file, and
`GET /api/v1/catalog/products?maxMoq=1` answers 200 with all **27** products instead of none. No error,
no log line. Not fixed here: `nest build` is the wrong instrument for the reason given above, and
nothing that this session did not start may be restarted.

For the record, the healthy-server correction recorded under Milestone 3 still holds:
`GET /api/v1/catalog/products` returns 200, `/catalog/products/facets` returns 12 categories summing to
27 products with `minPrice` 449 and `maxPrice` 3499, page 2 of a 12-per-page list shares no product
with page 1, and `gstRate` arrives as the number 5. `soldOut` agrees with `available` across all 27
products and all 216 variants.

---

# MILESTONE 4b — Wishlist

Goal: the heart on a product card actually saves something.

**Why this is here rather than in a later plan.** Brief §8 lists "Wishlist" on the product card beside
Add to Cart. The backend spec omitted it entirely — that gap is now recorded in spec §5.3 — and
`ProductCard.tsx:15` already ships a heart button whose state is `useState(false)`, local to each card.
It toggles, it looks like it works, and it forgets on the next navigation. A customer saving five
products and silently losing them is worse than a card with no heart on it.

It belongs immediately after the cart because it needs the **same** machinery: an anonymous-visitor key
and a merge on sign-in. Tasks 17, 18 and 20 build all of that. Doing the wishlist here reuses it; doing
it in a later plan means deriving it again and probably differently.

Four tasks, 26 to 29.

## Task 26: The wishlist table

**Files:**
- Create: `backend/src/entities/commerce/wishlist-item.entity.ts`
- Create: `backend/src/database/migrations/20260820100000-Wishlist.ts`
- Modify: `backend/src/data-source.ts` if it enumerates entities explicitly — check rather than assume

One flat table, not a parent and child. A wishlist has no attributes of its own: it is a set of
products per owner. `Cart` needs a parent row because it carries `updatedAt` for the abandoned-cart
notification and because a cart line has a quantity and a mode; a saved product has neither.

- [ ] **Step 1: The entity**

```ts
// backend/src/entities/commerce/wishlist-item.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from '../catalog/product.entity';
import { User } from '../identity/user.entity';

/**
 * One saved product, owned by either an account or an anonymous visitor.
 *
 * Exactly one of `userId`/`guestToken` is set — `ck_wishlist_items_owner_exclusive` enforces it in the
 * database rather than trusting every future writer, the same reasoning as `carts`.
 */
@Entity('wishlist_items')
export class WishlistItem extends BaseEntity {
  @Index('idx_wishlist_items_user')
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  /** The shared `nn_guest_token` key. See `guest-token.ts`. */
  @Index('idx_wishlist_items_guest')
  @Column({ type: 'varchar', length: 64, name: 'guest_token', nullable: true })
  guestToken: string | null;

  /**
   * `CASCADE`, not `SET NULL`, and this matches the existing split rather than inventing one.
   *
   * Checked every FK referencing `products`: `cart_items`, `pricing_tiers`, `product_images` and
   * `product_variants` all CASCADE — they describe what a product *is* or what is currently in someone's
   * basket, so they have no meaning without it. `order_items`, `reviews` and `rfq_items` all SET NULL —
   * they are historical records that must survive to reprint an invoice or keep a review readable.
   *
   * A saved product is the first group: there is nothing to reprint, and a wishlist row pointing at
   * nothing is not a record worth keeping. `cart_items` is the closest analogue and does the same.
   *
   * (Nothing referencing `products` uses RESTRICT, so a product can actually be deleted — which is what
   * makes Task 29's cascade test runnable at all.)
   */
  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;
}
```

- [ ] **Step 2: The migration**

```ts
// backend/src/database/migrations/20260820100000-Wishlist.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Wishlist20260820100000 implements MigrationInterface {
  name = 'Wishlist20260820100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wishlist_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid,
        "guest_token" character varying(64),
        "product_id" uuid NOT NULL,
        CONSTRAINT "pk_wishlist_items" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "wishlist_items"
        ADD CONSTRAINT "fk_wishlist_items_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "wishlist_items"
        ADD CONSTRAINT "fk_wishlist_items_product"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "wishlist_items" ADD CONSTRAINT "ck_wishlist_items_owner_exclusive"
      CHECK (("user_id" IS NOT NULL AND "guest_token" IS NULL)
          OR ("user_id" IS NULL AND "guest_token" IS NOT NULL))
    `);

    /**
     * Two unique indexes, one keyed on each owner column, so the same product cannot be saved twice.
     *
     * **The load-bearing choice is *two* indexes, not the `WHERE` predicates** — an earlier version of
     * this comment had that backwards. It claimed a plain `UNIQUE (user_id, product_id)` would permit
     * duplicate guest rows because Postgres treats NULLs as distinct. Measured, in two parts:
     *
     * - With *only* `UNIQUE (user_id, product_id)` and no guest index, the same
     *   `(guest_token, product_id)` pair inserted three times returns `INSERT 0 1` three times. So the
     *   substance of the claim is true: one index cannot cover both owners.
     * - But replacing the guest index with a **plain, non-partial** composite on the *same two columns*
     *   still rejects the duplicate guest save — a user-owned row's `guest_token` is NULL, and NULLs
     *   are distinct in that index too.
     *
     * So the predicates enforce nothing on their own. They narrow each index to the rows it is about,
     * which keeps it smaller and its intent legible, and they would become load-bearing only under
     * PG15's opt-in `NULLS NOT DISTINCT`, which this schema does not use.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_wishlist_items_user_product"
        ON "wishlist_items" ("user_id", "product_id") WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_wishlist_items_guest_product"
        ON "wishlist_items" ("guest_token", "product_id") WHERE "guest_token" IS NOT NULL
    `);

    await queryRunner.query(`CREATE INDEX "idx_wishlist_items_user" ON "wishlist_items" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "idx_wishlist_items_guest" ON "wishlist_items" ("guest_token")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table takes its indexes and constraints with it. Listed explicitly anyway, because
    // an accidental partial revert leaving an orphaned index is what makes the next `up` fail with
    // "relation already exists" rather than anything informative.
    await queryRunner.query(`DROP INDEX "public"."idx_wishlist_items_guest"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wishlist_items_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wishlist_items_guest_product"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wishlist_items_user_product"`);
    await queryRunner.query(`DROP TABLE "wishlist_items"`);
  }
}
```

- [ ] **Step 3: Apply, prove both constraints bite, prove it reverts**

Against a throwaway database, **not** the dev one, and remember `NODE_ENV=test` or the exported
`DB_PORT` is ignored and this runs against the dev database:

```bash
cd /Users/kunal/Desktop/nutwala
docker run -d --name nn-wishcheck -e POSTGRES_USER=nutwala -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=nutwala -p 127.0.0.1:5560:5432 postgres:15-alpine >/dev/null
for i in $(seq 1 30); do docker exec nn-wishcheck pg_isready -U nutwala -q && break; sleep 1; done
cd backend && set -a && . ./.env && set +a && export NODE_ENV=test DB_PORT=5560 DB_PASSWORD=x
npm run migration:run && npm run seed

# Owner exclusivity: neither, and both.
docker exec nn-wishcheck psql -U nutwala -d nutwala -c \
  "INSERT INTO wishlist_items (user_id, guest_token, product_id) SELECT NULL, NULL, id FROM products LIMIT 1;" 2>&1 | grep -c ck_wishlist_items_owner_exclusive
# Duplicate save for the same guest.
docker exec nn-wishcheck psql -U nutwala -d nutwala -c \
  "INSERT INTO wishlist_items (guest_token, product_id) SELECT 'k', id FROM products LIMIT 1;
   INSERT INTO wishlist_items (guest_token, product_id) SELECT 'k', id FROM products LIMIT 1;" 2>&1 | grep -c uq_wishlist_items_guest_product

npm run migration:revert && npm run migration:run
cd .. && docker rm -f nn-wishcheck >/dev/null
docker ps --format '{{.Names}}'
```

Expected: both violations rejected by name, the revert-then-reapply cycle clean, and only the user's
two containers left running.

- [ ] **Step 4: Commit**

```bash
git add backend/src/entities/commerce/wishlist-item.entity.ts backend/src/database/migrations/20260820100000-Wishlist.ts
git commit -F - <<'MSG'
feat(wishlist): add the saved-items table, with owner exclusivity in the database
MSG
```

## Task 27: The wishlist endpoints

**Files:**
- Create: `backend/src/modules/wishlist/wishlist.service.ts`, `wishlist.controller.ts`, `wishlist.module.ts`
- Test: `backend/src/modules/wishlist/wishlist.service.spec.ts`
- Modify: `backend/src/app.module.ts`, and `backend/src/modules/auth/auth.controller.ts` (merge on sign-in)

Reuses `readGuestToken`/`issueGuestToken` from `backend/src/modules/cart/guest-token.ts` — the same
`nn_guest_token` cookie, per spec §5.3. Do **not** add a second cookie.

- [ ] **Step 1: The service**

```ts
// backend/src/modules/wishlist/wishlist.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Product as WireProduct } from '@nutwala/shared';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Product } from '../../entities/catalog/product.entity';
import { WishlistItem } from '../../entities/commerce/wishlist-item.entity';
import { CatalogService } from '../catalog/catalog.service';

export interface WishlistOwner {
  userId?: string;
  guestToken?: string;
}

@Injectable()
export class WishlistService {
  constructor(
    @InjectRepository(WishlistItem) private readonly items: Repository<WishlistItem>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly catalog: CatalogService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The saved products, newest first, priced live through the catalogue mapper.
   *
   * Returns full wire `Product` objects rather than slugs, so the wishlist page renders the same
   * `ProductCard` as the shop — including its SOLD OUT state, which is the most useful thing a saved
   * list can tell you.
   */
  async list(owner: WishlistOwner): Promise<WireProduct[]> {
    // `id` is selected deliberately. `select` constrains the root entity's columns while `relations`
    // still hydrates the relation in full — the pattern `seed-context.ts:81` already relies on — but
    // omitting the primary key from a select is asking for trouble with relation hydration, and
    // `slugs()` below selects it too. Keep the two consistent.
    const rows = await this.items.find({
      where: this.ownerWhere(owner),
      order: { createdAt: 'DESC' },
      select: { id: true, createdAt: true },
      relations: { product: true },
    });
    if (rows.length === 0) return [];

    const bySlug = new Map(
      (await this.catalog.productsBySlugs(rows.map((row) => row.product.slug))).map((product) => [
        product.slug,
        product,
      ]),
    );
    // Ordered by the wishlist, not by the catalogue query, so "newest saved first" survives.
    return rows
      .map((row) => bySlug.get(row.product.slug))
      .filter((product): product is WireProduct => product !== undefined);
  }

  /**
   * Saves a product. Idempotent: saving twice is not an error, because the heart is a toggle and a
   * double click must not 409 at the customer.
   */
  async add(owner: WishlistOwner, slug: string): Promise<void> {
    const product = await this.products.findOne({ where: { slug }, select: { id: true } });
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }

    // `orIgnore()` leans on the partial unique index, so two concurrent saves cannot both insert —
    // the same reasoning as the cart's conditional update, one layer simpler.
    await this.items
      .createQueryBuilder()
      .insert()
      .values({
        userId: owner.userId ?? null,
        guestToken: owner.guestToken ?? null,
        productId: product.id,
      })
      .orIgnore()
      .execute();
  }

  async remove(owner: WishlistOwner, slug: string): Promise<void> {
    const product = await this.products.findOne({ where: { slug }, select: { id: true } });
    // Removing something that is not there is a no-op, not a 404: the customer's intent is satisfied
    // either way, and a toggle that errors on the second click is worse than one that does nothing.
    if (!product) return;
    await this.items.delete({ ...this.ownerWhere(owner), productId: product.id });
  }

  /**
   * Folds a guest's saved items into the account on sign-in, then deletes the guest rows.
   *
   * `orIgnore()` again, because the customer may have saved the same product both signed in and as a
   * guest — a duplicate is the expected case here, not an exception.
   */
  async mergeInto(userId: string, guestToken: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `
        INSERT INTO wishlist_items (user_id, product_id)
        SELECT $1, w.product_id FROM wishlist_items w WHERE w.guest_token = $2
        ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL DO NOTHING
        `,
        [userId, guestToken],
      );
      await manager.getRepository(WishlistItem).delete({ guestToken });
    });
  }

  /*
   * `WHERE user_id IS NOT NULL` in the `ON CONFLICT` clause is **required, not decorative**, and
   * deleting it is the obvious simplification. `uq_wishlist_items_user_product` is a *partial* unique
   * index, and Postgres only infers a partial index when the predicate is restated. Measured on
   * Postgres 15 against this exact table, with the user already holding product A and the guest holding
   * A and B:
   *
   *   ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL DO NOTHING
   *     -> INSERT 0 1        A skipped, B transferred. Correct.
   *   ON CONFLICT (user_id, product_id) DO NOTHING
   *     -> ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
   *
   * That error is **swallowed** by the caller's catch in `auth.controller.ts`, so the broken version
   * returns 200 from sign-in, writes one line to a log, and the customer's saved list is simply gone.
   * There is no failing request to notice. Task 29's merge tests exist to be the thing that notices.
   *
   * The self-reference is safe: `INSERT ... SELECT` reads the snapshot taken at statement start, so the
   * rows this statement writes are invisible to its own `SELECT`. Verified — the merge above terminates
   * with exactly the rows expected, not a growing table.
   */

  /**
   * Just the saved slugs, newest first. What the heart needs and what both mutations return.
   *
   * Deliberately separate from `list()`: that one goes through the catalogue mapper to build full wire
   * products for the wishlist page, which is far more work than a toggle needs.
   */
  async slugs(owner: WishlistOwner): Promise<string[]> {
    const rows = await this.items.find({
      where: this.ownerWhere(owner),
      order: { createdAt: 'DESC' },
      relations: { product: true },
      select: { id: true, createdAt: true },
    });
    return rows.map((row) => row.product.slug);
  }

  private ownerWhere(owner: WishlistOwner): { userId: string } | { guestToken: string } {
    if (owner.userId) return { userId: owner.userId };
    if (owner.guestToken) return { guestToken: owner.guestToken };
    // Never build an unscoped query. An empty `where` would return every wishlist in the database.
    throw new DomainError(
      ErrorCodes.NOT_FOUND,
      'No wishlist for this visitor.',
      HttpStatus.NOT_FOUND,
    );
  }
}
```

- [ ] **Step 2: Write the failing test for the part that has teeth**

```ts
// backend/src/modules/wishlist/wishlist.service.spec.ts
import { WishlistService } from './wishlist.service';

describe('WishlistService owner scoping', () => {
  /**
   * The whole risk in this service is an unscoped query. `ownerWhere` throwing rather than returning
   * `{}` is what stops `list()` returning every wishlist in the database and `remove()` deleting
   * everyone's saved items — both of which an empty `where` object does silently in TypeORM.
   */
  it('refuses to build a query with no owner', async () => {
    const service = new WishlistService({} as never, {} as never, {} as never, {} as never);
    await expect(service.list({})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
```

Run it, watch it fail, then implement. The rest of the service is proven against Postgres in Task 29,
because scoping and the unique indexes are database behaviour and a repository double would only
confirm it agrees with itself.

- [ ] **Step 3: The controller**

```ts
// backend/src/modules/wishlist/wishlist.controller.ts
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Product } from '@nutwala/shared';
import type { Request, Response } from 'express';
import type { AppConfiguration } from '../../common/config/app.config';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { issueGuestToken, readGuestToken } from '../cart/guest-token';
import { WishlistService, type WishlistOwner } from './wishlist.service';

/**
 * `@Public()` throughout, with the owner resolved by hand — the same shape as `CartController`, and for
 * the same reason: a visitor must be able to save something before they have an account.
 */
@ApiTags('wishlist')
@Controller('wishlist')
export class WishlistController {
  constructor(
    private readonly wishlist: WishlistService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Saved products, newest first' })
  async list(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<Product[]> {
    const owner = this.owner(user, request);
    // A visitor who has never saved anything has no key and no rows. An empty list, not a 404.
    if (!owner.userId && !owner.guestToken) return [];
    return this.wishlist.list(owner);
  }

  /**
   * Both mutations answer **200 with the new set of saved slugs**, not 204.
   *
   * Two reasons, and the first is a correctness one. `TransformInterceptor` is global and turns a
   * handler returning `undefined` into `{ success: true, data: null }` — so `@HttpCode(204)` would emit
   * a 204 *with a body*, which RFC 9110 forbids and which no route in this service currently does. The
   * choice is therefore between exempting these two routes from the one enforced response shape, or not
   * using 204. Not using 204 is cheaper and keeps `http.ts`'s envelope unwrapping working unchanged.
   *
   * The second is that returning the new state makes the client's optimistic toggle trivial to
   * reconcile — the reply is authoritative, exactly as `PUT /cart` returns the new basket. Slugs rather
   * than full products keeps it small: the heart only needs to know membership, and the wishlist page
   * fetches the products itself.
   */
  @Public()
  @Post(':slug')
  @ApiOperation({ summary: 'Save a product, returning the new set of saved slugs' })
  async add(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ slugs: string[] }> {
    const owner: WishlistOwner = user
      ? { userId: user.id }
      : { guestToken: readGuestToken(request) ?? issueGuestToken(response, this.cookieSettings()) };
    await this.wishlist.add(owner, slug);
    return { slugs: await this.wishlist.slugs(owner) };
  }

  @Public()
  @Delete(':slug')
  @ApiOperation({ summary: 'Unsave a product, returning the new set of saved slugs' })
  async remove(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() request: Request,
  ): Promise<{ slugs: string[] }> {
    const owner = this.owner(user, request);
    if (!owner.userId && !owner.guestToken) return { slugs: [] };
    await this.wishlist.remove(owner, slug);
    return { slugs: await this.wishlist.slugs(owner) };
  }

  private owner(user: AuthenticatedUser | undefined, request: Request): WishlistOwner {
    if (user) return { userId: user.id };
    const guestToken = readGuestToken(request);
    return guestToken ? { guestToken } : {};
  }

  private cookieSettings(): { cookieDomain: string; cookieSecure: boolean } {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return { cookieDomain: auth.cookieDomain, cookieSecure: auth.cookieSecure };
  }
}
```

**Never verify with `npx eslint .`, and this is not a style preference.** There is no ESLint config at
the repo root — it lives at `backend/eslint.config.mjs` — and **ESLint 9 exits 0 when it cannot find
one**. Measured from `/Users/kunal/Desktop/nutwala`:

```
$ npx eslint .
Oops! Something went wrong! :(
ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
$ echo $?
0
```

So a step built on it reports success while linting nothing at all — and inside an `&&` chain it lets
everything after it run too. Use `npm run lint -w backend`, which resolves the config from the workspace.

- [ ] **Step 4: Merge on sign-in, beside the cart's merge**

In `auth.controller.ts`, where Task 20 already folds the guest cart in, fold the wishlist too, against
the same key — but in a **separate** `catch`, not a shared one. An earlier version of this sentence said
"in the **same** `try` block", which contradicted the code comment three lines below it that argues at
length for the opposite. The comment is right: two independent merges sharing one catch means a cart
failure returns before `wishlists.mergeInto` is ever called, so a customer whose basket merge broke
loses their saved list too. Measured — collapsing them into one `try` fails two tests, one on
`wishlists.mergeInto` calls being 0 and one on the log naming the wrong merge.

```ts
    const guestToken = readGuestToken(request);
    if (guestToken) {
      // Caught **separately**, not in one shared `try`. The two merges are independent, which is the
      // argument *against* sharing a catch rather than for it: with one block, a cart failure returns
      // before `wishlists.mergeInto` is ever called, so a customer whose basket merge broke silently
      // loses their saved list too — a second loss caused by nothing to do with the wishlist.
      //
      // Still swallowed and logged rather than thrown: losing a basket or a saved list is bad, failing
      // the sign-in is worse, and neither is worth an account the customer cannot get into. The log now
      // names *which* merge failed, which the shared message could not.
      let allMerged = true;
      const merges = [
        ['cart', () => this.carts.mergeInto(result.user.id, guestToken)],
        ['wishlist', () => this.wishlists.mergeInto(result.user.id, guestToken)],
      ] as const;

      for (const [what, run] of merges) {
        try {
          await run();
        } catch (error) {
          allMerged = false;
          this.logger.error(`Guest ${what} merge failed after sign-in`, {
            userId: result.user.id,
            error,
          });
        }
      }

      // Cleared only when both succeeded. Clearing it after a failure would strand the guest's rows
      // permanently — the token that names them is gone, so nothing can ever find them again. Leaving
      // the cookie means the next sign-in retries, and a retried merge is harmless: `mergeInto` finds
      // no guest cart the second time and deletes nothing.
      if (allMerged) {
        response.clearCookie(GUEST_TOKEN_COOKIE, { path: '/', domain: auth.cookieDomain });
      }
    }
```

**Apply the same shape to Task 20's cart-only version of this block**, which this replaces — Task 20
writes it with the single `try` because the wishlist does not exist yet. When you reach this step, the
cart merge is already in place; restructure it rather than adding a second block beside it.

`AuthModule` imports `WishlistModule`; `WishlistModule` exports `WishlistService` and imports
`CatalogModule` for `CatalogService`.

- [ ] **Step 5: Wire and commit**

```bash
npm run test -w backend -- wishlist.service
npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend
git add backend/src/modules/wishlist backend/src/app.module.ts backend/src/modules/auth
git commit -F - <<'MSG'
feat(wishlist): save and unsave products, merged into the account on sign-in
MSG
```

## Task 28: Wire the heart, and give the wishlist somewhere to live

**Files:**
- Create: `frontend/src/features/wishlist/api/index.ts`, `WishlistProvider.tsx`, `hooks/useWishlist.ts`
- Note: `http.delete` accepts no body and no `AbortSignal` — check `frontend/src/lib/http.ts` before
  assuming otherwise. It does unwrap the envelope, so a 200 returning `{ slugs: [...] }` resolves to
  `{ slugs: [...] }`.
- Create: `frontend/src/routes/wishlist.tsx`
- Modify: `frontend/src/features/catalog/components/ProductCard.tsx`
- Modify: `frontend/src/providers/AppProviders.tsx`, `frontend/src/components/layout/SiteHeader.tsx`
- Test: `frontend/src/features/wishlist/WishlistProvider.test.tsx`

- [ ] **Step 1: The seam**

```ts
// frontend/src/features/wishlist/api/index.ts
import type { Product } from "@nutwala/shared";
import { http } from "@/lib/http";

/**
 * Both mutations return the new set of saved slugs, so a toggle needs no follow-up read and the reply
 * is what the provider reconciles its optimistic state against — the same shape as `PUT /cart`.
 */
export const wishlistApi = {
  list: (): Promise<Product[]> => http.get("/wishlist"),
  slugs: (): Promise<{ slugs: string[] }> => http.get("/wishlist/slugs"),
  add: (slug: string): Promise<{ slugs: string[] }> =>
    http.post(`/wishlist/${encodeURIComponent(slug)}`),
  remove: (slug: string): Promise<{ slugs: string[] }> =>
    http.delete(`/wishlist/${encodeURIComponent(slug)}`),
};
```

- [ ] **Step 2: The provider**

Mirror `CartProvider`'s shape, including the reload-on-identity-change effect — for the same reasons,
and the sign-out case matters here too: the account's saved list must stop being displayed the moment
the customer signs out.

Two consequences of that, both learned the hard way on `CartProvider`:

- **It goes inside `AuthProvider`** in `providers/AppProviders.tsx`, alongside `CartProvider`, because it
  calls `useAuth()`. Sibling rather than nested — nothing needs both contexts at once.
- **`WishlistProvider.test.tsx` must render it inside an `AuthProvider`**, and stub `/auth/me` in the same
  `fetch` mock that answers `/wishlist/slugs`. `useAuth` throws when its context is missing, so a
  standalone render fails every case before an assertion runs, and two separate stubs on one
  `globalThis.fetch` make the suite depend on installation order.

```tsx
interface WishlistCtx {
  /** Slugs, for the O(1) check every card makes. */
  slugs: Set<string>;
  products: Product[];
  isLoading: boolean;
  has: (slug: string) => boolean;
  toggle: (slug: string) => Promise<void>;
  reload: () => Promise<void>;
  count: number;
}
```

`toggle` is optimistic: flip the slug in the local set immediately, call the server, then **replace the
set with the reply's `slugs`** — the server is authoritative, exactly as the cart replaces its totals.
Roll back to the previous set on rejection. The heart must respond to the click, not to the round trip.

On mount, load membership from `GET /wishlist/slugs` rather than `GET /wishlist`: every page renders
hearts, and only `/wishlist` itself needs the full products. Add that route to the controller beside the
others — a `@Get('slugs')` declared **before** `@Get(':slug')` would be shadowed if the latter existed,
so keep the ordering rule from `catalog.controller.ts` in mind even though there is no `:slug` GET here
today.

Keep `slugs` as a `Set` rather than deriving from `products` on every render. Every `ProductCard` on a
24-product shop page calls `has()`, and a linear scan of an array per card per render is the kind of
thing that is invisible at 27 products and embarrassing at 500.

- [ ] **Step 3: Wire `ProductCard`**

**Its accessibility is already right — do not rewrite it.** Checked: the button carries
`aria-pressed={wished}` and a state-aware label, `Remove ${product.name} from wishlist` /
`Save ${product.name} to wishlist`. That is what makes the control usable without seeing the fill
colour, and it is better than most wishlist buttons ship with. Only the state source is wrong.

**Before you touch `ProductCard.tsx`, know what this breaks.** Task 13 created
`frontend/src/features/catalog/components/ProductCard.test.tsx`, whose `renderCard` harness (line 69)
wraps the card in `CartProvider` and `RouterContextProvider` — and only those, because `useCart` was the
only context the card consumed. The moment the card calls `useWishlist()`, **every test in that file
fails** with `useWishlist must be used inside WishlistProvider`, before reaching a single assertion.
That is exactly how Task 13's own first run died on `useCart`, and how an earlier task's `CartProvider`
change broke a test by adding a `useAuth()` call.

So add `WishlistProvider` to `renderCard` in the same commit, and note two things about doing it:

- `WishlistProvider` fetches on mount, so the harness needs the wishlist request stubbed or the tests
  log unhandled rejections. `renderCard` is not inside the `frontend/src/test/` stub machinery — it
  builds its own tree — so stub `globalThis.fetch` locally in that file, or give the provider an
  injectable seam. Do not reach for `installAuthStub`: there must be exactly **one** handler on
  `globalThis.fetch`, and `renderCard` is not the file that owns it.
- Use `RouterContextProvider`, not `RouterProvider`, for the same reason the file already documents at
  line 64: `RouterProvider` renders nothing synchronously, so assertions pass against an empty body.

Then delete `const [wished, setWished] = useState(false);` — it is the bug. Replace with:

```tsx
  const { has, toggle } = useWishlist();
  const wished = has(product.slug);
```

and `onClick={() => void toggle(product.slug)}`. Keep the existing `aria-pressed` and the
`Remove …/Save …` label logic exactly as they are: they were already correct, and they are what makes
the control usable without sight of the fill colour.

- [ ] **Step 4: The wishlist page and the header count**

`routes/wishlist.tsx` renders the saved products with the same `ProductCard` the shop uses — so a saved
product that has since sold out says so, which is the most useful thing a saved list can tell anyone.
Empty state: a line of copy and a link to `/shop`, matching how `/cart` handles empty.

Add a count beside the cart badge in `SiteHeader`. Do not add a second drawer; the page is enough.

- [ ] **Step 5: Test the two things that matter**

```tsx
  it("keeps the heart filled across a remount, which useState did not", async () => {
    // The bug this feature fixes. The old `useState(false)` reset on every navigation, so a saved
    // product looked unsaved the moment the customer went anywhere.
  });

  it("rolls back the heart when the server refuses the save", async () => {
    // An optimistic toggle that cannot fail is a lie: the customer would see a filled heart and find
    // nothing in their list.
  });
```

Write both out fully against a stubbed `fetch`, following `frontend/src/test/auth-api.stub.ts`'s shape.

- [ ] **Step 6: Verify in a browser, then commit**

The path that proves it, by hand:

1. As a guest, heart three products on `/shop`. Navigate to `/cart` and back. **The hearts are still
   filled** — this is the assertion; the old behaviour lost them here.
2. Reload the page. Still filled.
3. Open `/wishlist`: the three products, newest first.
4. Sign in as `b2c@demo.in`. The list survives the merge.
5. Confirm the guest rows are gone:
   ```bash
   docker exec nutwala-postgres psql -U nutwala -d nutwala -c \
     "SELECT count(*) FILTER (WHERE user_id IS NOT NULL) AS owned, count(*) FILTER (WHERE guest_token IS NOT NULL) AS guest FROM wishlist_items;"
   ```
6. Sign out. The list is no longer displayed.
7. Drain one saved product's stock and reload `/wishlist`: it shows SOLD OUT.

```bash
git add frontend/src/features/wishlist frontend/src/routes/wishlist.tsx frontend/src/features/catalog/components/ProductCard.tsx frontend/src/features/catalog/components/ProductCard.test.tsx frontend/src/providers/AppProviders.tsx frontend/src/components/layout/SiteHeader.tsx
git commit -F - <<'MSG'
feat(frontend): make the wishlist heart save something
MSG
```

## Task 29: Wishlist integration tests

**Files:**
- Create: `backend/test/integration/wishlist.integration.spec.ts`

Cover, against real Postgres:

- A guest saves, gets a cookie, and reads the list back. A **different** guest reads an empty list — the
  check that scoping is real rather than incidental.
- Saving twice is a no-op, not a 409, and leaves one row. Prove the partial unique index is what does it
  by attempting the duplicate insert directly and asserting the index name in the error.
- Removing something never saved is a no-op, not a 404.
- Sign-in merges the guest's saved items and deletes the guest rows. **Assert the resulting rows, never
  sign-in's status code.** `auth.controller.ts` catches and logs a failed merge so the sign-in still
  succeeds, so a completely broken merge returns `200` with the customer's list gone. A test that checks
  the response status passes against every implementation, working or not.
- A product saved both as a guest and in the account survives the merge as **one** row.
- **A wishlist merge failure does not cost the customer their cart, and vice versa.** The two are caught
  independently for this reason; with one shared `try` the first failure skips the second merge entirely.
  Force one to throw — stub the service, or merge against a product id that violates the FK — and assert
  the *other* still completed and that `nn_guest_token` was **not** cleared, so the next sign-in retries.
- One customer cannot read or delete another's saved items.
- `ck_wishlist_items_owner_exclusive` rejects a row with neither owner and one with both.
- Deleting a product removes its wishlist rows (`ON DELETE CASCADE`) — and, unlike `OrderItem`, leaves
  no snapshot behind, which is the intended difference.

Then prove the scoping test is load-bearing: change `ownerWhere` to return `{}` for a missing owner and
confirm the cross-customer test fails rather than passing on a technicality.

**A note on this task's form, since it differs from every other task in this plan.** The above is a
coverage list, not test code — the one place this plan leaves the tests to the implementer. That is a
gap by this plan's own standard, and it lands on the task covering the operation whose failures are
deliberately swallowed. Write the file to the same standard as
`backend/test/integration/catalog.integration.spec.ts` and `cart.integration.spec.ts` (Task 23): real
Postgres on 5443, no mocked repositories, and every assertion made against rows or response bodies
rather than status codes. Before you finish, revert each behaviour the list names and confirm the
matching test fails — a suite this list produces is exactly the kind that goes green against an empty
table, which has already happened twice in this project.

