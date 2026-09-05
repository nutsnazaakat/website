# Nuts & Nazaakat — Milestone 9: Admin Console (Design Spec)

**Date:** 2026-08-26
**Milestone:** 9 of 10 (Phase 2 backend)
**Status:** approved — decomposition and the two open decisions settled by the user 2026-08-26

---

## 1. Purpose

Give the business an operator console: manage catalogue, stock, orders, customers, businesses,
quote requests, pricing, coupons, reviews, blog, support queries and settings.

Backend design spec §16 assigns Milestone 9 **two distinct bodies of work**:

1. the **27 `@Roles(ADMIN)` endpoints** of §6.4, in this repository;
2. an **18-route admin frontend, in a separate application and separate repository** (§7.1).

That is comparable in size to Milestones 4–8 combined, so it is decomposed below rather than
attempted as one plan.

## 2. Decisions taken 2026-08-26

### 2.1 `@nutwala/shared` is extracted into its own git repository

Both applications must depend on the same wire types and money rules. §7.1 is explicit that the
admin repo must **not** redeclare `Product`, `AccountOrder` or the paise conversions — "a second
definition is how the two drift while both still compile."

`shared/` currently sits in this monorepo as a workspace with `"private": true`, and no npm
registry is configured. **Chosen mechanism: extract `shared/` into its own git repository; both
applications depend on it via a git URL pinned to a tag.**

- No registry infrastructure, no auth tokens on dev machines or in CI.
- Versions are explicit, and a breaking change cannot silently reach one app while the other
  still compiles against the old shape.
- Accepted cost: a contract change is three steps — tag `shared`, bump the dependency in this
  repo, bump it in the admin repo. That friction is deliberate; it is what makes the drift §7.1
  warns about visible.

Rejected: a private registry (infra cost, and `shared/` leaves this monorepo's build graph so a
local change needs a publish before it can be tested); a git submodule (the option teams most
often regret — detached HEADs, forgotten `--recursive` clones); keeping one repo (see §2.3).

### 2.2 Backend before frontend

All 27 endpoints ship, with integration coverage, before the admin application is built against
them. This mirrors Phase 1 → Phase 2: the UI is never written against a guessed contract, and the
contract is never shaped by a half-built screen.

### 2.3 A note on "separate repository", recorded so it is not re-litigated

§7.1's security argument is entirely about a separate **origin** — cookies, CSP, service-worker
scope, deploy cadence, and an XSS in the storefront reaching what the admin session can reach.
Every one of those is a deploy-time property. One repository can deploy two applications to two
origins and obtain all of them.

The repo split is therefore a **workflow choice, not a security requirement**. The user confirmed
it twice (during Plan 2, and again on 2026-08-26). It stands. This paragraph exists so that a
future reader does not mistake §2.1's distribution work for something the security argument
compelled.

## 3. What already exists

- **`admin/inventory` only.** `backend/src/modules/inventory/inventory.controller.ts` carries
  `@Controller('admin/inventory')` with `PATCH /admin/inventory/:variantId`, backed by 18
  integration cases.

> **Corrected 2026-08-27 during execution.** This originally added "`businesses.controller.ts` also
> has `@Roles(ADMIN)` routes." It does not — that controller carries `@Roles(UserRole.BUSINESS)` at
> class level. The guard-coverage test's "no route outside `admin/*` carries `@Roles(ADMIN)`" case
> confirms it.
- **`GET /admin/inventory` and `GET /admin/inventory/:variantId/transactions` are owed by this
  milestone**, per §6.4's own note. §14's E2E journey 3 depends on the former.
- **Services with no controller, built deliberately for this milestone to call:**
  `OrderStatusService.transition` (given a route in Milestone 7) and `RfqStatusService.transition`
  (Milestone 8, still routeless). Milestone 9 is their intended caller.
- **`NotificationsService.queue`** is the single notification write path and always joins the
  caller's transaction. Admin writes that should notify must call it inside their own transaction.
- **The customer app must stay free of admin routes.** `frontend/src/test/no-admin-routes.test.ts`
  fails the build if an `/admin` path enters the generated route tree. That test is not to be
  weakened by this milestone.

## 4. Decomposition

Six plans. Each produces something verifiable on its own.

| Plan | Scope | Endpoints |
|---|---|---|
| **9.1** Admin foundation & catalogue | Admin module conventions, `RolesGuard` coverage test, audit-log writes, dashboard, products, variants, categories | 14 |
| **9.2** Stock & orders | `GET /admin/inventory`, transactions, orders list/detail, status transition, COD collection, shipment | 8 |
| **9.3** People & B2B | Customers, businesses, RFQs (list/detail/patch/notes), pricing tiers | 12 |
| **9.4** Content & operations | Coupons, reviews moderation, blog posts, settings, support tickets, audit-log read | 17 |
| **9.5** Extract `@nutwala/shared` | New repository, tagged release, both consumers repointed, CI green in both | — |
| **9.6** Admin application | Separate repo: 18 routes, auth, layout, every screen against the live API | — |

Endpoint counts exceed 27 because §6.4's table groups several verbs per line; 27 is the count of
distinct `@Roles(ADMIN)` *route handlers* named in §16, and the per-plan figures above count
handlers including the ones already shipped.

**9.5 sits between the backend and the frontend deliberately.** Extracting the contract package
before the admin app exists means the admin app is written against a tagged dependency from its
first commit, rather than against a workspace path that would later have to be unpicked.

## 5. Constraints carried forward

These are not new; they have governed every milestone and apply unchanged.

- **`docs/client-brief.md` wins over plan and spec on conflict.** Raise the conflict; do not
  silently pick. Brief §29–§36 are this milestone's requirements; §33's order and RFQ status
  vocabularies are normative and were already corrected once after an agent guessed them.
- **Authorisation is the server's.** The admin app guards routes on `role === "admin"` for UX
  only; `RolesGuard` remains the sole authority. A separate origin changes nothing about that.
- **No `any` / `as any` / `@ts-ignore` / `eslint-disable`** to get past a type error.
- **No test's assertions may be weakened.** Updating a test's *setup* for a genuinely new
  precondition is legitimate; changing what it asserts is not.
- **Money stays in paise**, per §8. The float accumulation §8 records as an open defect is
  Milestone 10's, not this one's — but no admin endpoint may add a second one.
- **Every destructive admin action writes an audit-log row.** Brief §45 lists `AuditLogs` as a
  model; §6.4 exposes `GET /admin/audit-logs`. A delete or a status change that leaves no trace
  is a defect in this milestone, not a gap for a later one.

## 5a. Decisions settled by plan 9.1 — later plans must stay consistent

- **Destructive admin deletes are hard deletes, refused with a named `409 ENTITY_IN_USE`** when the
  row is referenced. Not soft deletes. The schema already supports this: `order_items.product_id`
  and `.variant_id` are nullable `ON DELETE SET NULL` with `productSlug`, `name` and
  `unitPricePaise` snapshotted, so an invoice survives its product's deletion unchanged. The real
  blocker is `inventory_transactions.variant_id ON DELETE RESTRICT`, and the endpoint checks for it
  first so the operator gets an instruction rather than an opaque 500 carrying a constraint name.
  **Plan 9.1's own text asserted the opposite** — that a hard delete would trip the FK or orphan
  history — and was wrong about this schema.
- **A soft-delete column was rejected**, because it would be a second hidden state beside
  `isPublished` (which already has its own endpoint, audit action and cart semantics) and would have
  to be honoured by every catalogue query, cart read, checkout assessment and dashboard aggregate.
- **Unpublishing writes nothing to carts holding the product.** `CartReadService.toValidatable`
  already reports it: the line stays, `verdictFor` answers `NOT_FOUND`, `lineTotal` is null,
  `hasUnpriceableLines` is raised and checkout is blocked. That file had already rejected deleting
  the rows in writing — "an admin who withdraws a product for a week would have emptied every
  basket holding it."
- **A write that changes nothing writes no audit row**, including an idempotent publish.
- **Products are always created unpublished**, so every live listing has a `product.publish` audit
  row behind it. `publishedAt` is stamped on first publish only, never cleared.
- **Admin wire types live in `@nutwala/shared`** (`types/admin.ts`), each *extending* the storefront
  type rather than restating it — §7.1 forbids the admin repo redeclaring them, and plan 9.5
  extracts that package next.

## 4a. Repository split, decided by the user 2026-08-27

The user will keep **three application repositories**, not two:

```
nutwala-backend      NestJS + Postgres          (backend/ today)
nutwala-client       customer storefront        (frontend/ today)
nutwala-admin        admin console              (new, plan 9.6)
```

**Consequence: `@nutwala/shared` needs a home of its own — a fourth repository.** All three
applications consume it (143 files import it today), and §7.1 forbids any of them redeclaring
`Product`, `AccountOrder` or the paise conversions. The alternatives were rejected: a copy per repo
is the drift §7.1 warns about and this project has already suffered once (the B2B order statuses
were declared separately in the frontend and had to be consolidated), and pointing the two
front-ends at the backend repo would make them clone a whole service for a types folder.

So: **`nutwala-shared`, its own repo, consumed by the other three as a git dependency pinned to a
tag** — the mechanism the user chose on 2026-08-27 and recorded in §2.1. Four repositories in
total, three of them applications.

Nothing has been split yet. Everything is still one monorepo, so this is reversible until plan 9.5
runs.

## 5b. Three questions plan 9.1 raised, answered by the user 2026-08-27

- **Dashboard dates: a business timezone becomes a `Settings` field in plan 9.4.** `salesOverTime`
  currently groups by **UTC day**, which is wrong at the margin for an IST operator — a 04:00 IST
  order lands on the previous bar. Nothing in the brief, spec or codebase named a business timezone.
  **Plan 9.4 must add one (default `Asia/Kolkata`) and apply it to every dated admin figure at
  once** — a per-endpoint fix is how two figures start disagreeing. Until then the bars are
  UTC-shifted; that is accepted, not overlooked.
- **SKU stays variant-level only.** Brief §30 lists "SKU" among *product* fields, but there is no
  `products.sku` column and none should be added: SKU lives on `product_variants` with
  `uq_product_variants_sku`, which is where §30's own variant sentence puts it and where `OrderItem`
  and the stock ledger address it. §30's product-level mention is loose wording, confirmed with the
  user. A product-level SKU would be a second vocabulary with no consumer.
- **Unpublishing a category hides its tile, not its products — intended.** `CatalogService.baseQuery`
  filters `product.isPublished` and never `category.isPublished`. That is a navigation decision, not
  a bulk withdrawal: hiding products through a category field would surprise an operator who only
  wanted to tidy the menu. Pinned by a test so it cannot drift into either behaviour by accident.

## 6. Open risks

- **`POST /checkout/orders` is unthrottled** (§13, `docs/known-issues.md` item 3) and assigned to
  Milestone 10. Nothing in this milestone should depend on it being fixed.
- **The intermittent integration flake** (`docs/known-issues.md` item 1, ~2 failures per 15 full
  runs) will be met during this milestone's verification runs. Re-run before concluding a
  regression, and capture the failing test name **and response body** if it appears — that
  capture is the one step that would close it.
- **27 endpoints is a lot of surface to secure.** Every one is a `@Roles(ADMIN)` route reachable
  from the public internet. Plan 9.1 owes a test that enumerates the admin controllers and asserts
  every handler is guarded, so a route added later without `@Roles` fails the build rather than
  shipping open.
