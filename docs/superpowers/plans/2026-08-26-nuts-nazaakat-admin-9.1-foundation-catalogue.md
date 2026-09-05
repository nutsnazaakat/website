# Admin Console Plan 9.1 — Foundation & Catalogue

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Ticking them is not the record
> of completion — commits are.** Earlier milestones left every box unticked and the git log is what
> told the next session what was done.

**Goal:** Establish the admin module conventions and a build-breaking guard-coverage test, then ship
the dashboard, products, variants and categories endpoints.

**Covers:** backend design spec §6.4 **rows 1–6** (14 route handlers) and the Milestone 9 design
spec's plan 9.1.

> **Corrected 2026-08-26 during execution.** Originally read "rows 1–7 (14 route handlers)". Rows
> 1–6 are the 14; row 7 (`GET /admin/inventory`) belongs to plan 9.2 per the Milestone 9 spec's own
> table. The spec's table also says 9.1 is 13 endpoints while Tasks 3–8 below add up to 14 — **14 is
> correct**, and the spec has been corrected to match.

**Architecture:** New `AdminModule` groups admin-only controllers that have no customer-facing
counterpart; existing modules that gain admin routes (products/catalog) get a second controller
alongside their public one rather than mixing scopes in one class. Every admin write goes through a
service method that takes `actorUserId` and writes an `AuditLog` row inside the same transaction as
the change it records.

---

## Conventions this plan is bound by

Read `backend/src/modules/inventory/inventory.controller.ts` and its spec before writing anything.
It is the only admin controller in the service and it establishes four things:

1. **`@Roles(UserRole.ADMIN)` at class level**, carrying the **database enum**, never a string
   literal. There are two role vocabularies here: the token carries `ADMIN`, an auth response body
   carries `admin` via `toAuthUser`. `@Roles('admin')` **compiles and refuses every admin.**
2. **`RolesGuard` is global and fails open.** It returns `true` early for a route with no `@Roles()`.
   A controller that loses the decorator is not refused — it is silently opened to every
   authenticated customer, no behavioural test notices, and `roles.guard.ts` has no spec of its own.
   Task 1 exists because of this.
3. **`actorUserId` is assigned after the DTO spread**, so a body field can never override the audit
   trail's "who": `this.svc.adjust({ variantId, ...dto, actorUserId: user.id })`.
4. **`@ApiTags('admin')`** on every admin controller.

Also carried forward, unchanged from every prior milestone:

- `docs/client-brief.md` **wins over plan and spec on conflict** — raise it, do not silently choose.
  §30 (product management fields) and §29 (dashboard cards and charts) are normative here.
- No `any` / `as any` / `@ts-ignore` / `eslint-disable` to get past a type error.
- No existing test's **assertions** may be weakened. Updating a test's *setup* for a genuinely new
  precondition is legitimate.
- Money stays in paise (§8).
- `frontend/src/test/no-admin-routes.test.ts` must keep passing. Nothing in this plan touches the
  customer app.

---

## Task 1: The guard-coverage test — before any endpoint exists

**Files:**
- Create: `backend/test/integration/admin-routes-guarded.integration.spec.ts`

> **Corrected 2026-08-26 during execution.** This plan originally said
> `backend/test/admin-routes-guarded.spec.ts`. **No jest config matches that path** — the unit
> config roots at `<rootDir>/src`, the integration config roots at `<rootDir>/test/integration`
> *and* requires a `.integration.spec.ts` suffix. The file would have been invisible to every
> config: a guard test that never runs, which is worse than no guard test, because it would be
> trusted. It also has to live in the integration suite regardless — booting `AppModule` to walk
> its routes instantiates the TypeORM DataSource, so it needs Postgres, and the unit config's own
> docblock says "Unit tests only — fast, no database, no HTTP."

This is first deliberately. It must be in place *as* the endpoints land, not retrofitted after 27
of them exist.

- [ ] **Step 1: Write the test**

It must enumerate every controller whose path starts `admin/` and assert each carries
`@Roles(UserRole.ADMIN)` — not by a hand-maintained list of controller names (which is the same
"someone must remember" failure one level up), but by discovering them.

Discover through the compiled Nest application: boot `AppModule` in the same way
`test/integration/helpers` does, walk the registered routes, and for each path matching `^admin/`
resolve its controller class and read `Reflect.getMetadata(ROLES_KEY, ctor)`.

Assert three things:
1. every `admin/*` route's controller carries `[UserRole.ADMIN]`;
2. the set of discovered `admin/*` routes is **non-empty** (a discovery bug that finds nothing must
   fail, not pass vacuously);
3. no route outside `admin/*` carries `[UserRole.ADMIN]` by accident.

- [ ] **Step 2: Prove it is not vacuous**

Temporarily comment out `@Roles(UserRole.ADMIN)` on `InventoryController`. Run the test; it **must
fail**, naming that controller. Restore the decorator by re-editing the exact original line — not
by `git checkout` — and confirm the test passes and `git diff --stat` on that file is empty.

Record both outcomes in the commit message. A guard test that has never been seen to fail is
decoration.

- [ ] **Step 3: Commit**

`test(admin): every admin route is guarded, discovered not listed`

> **Result, 2026-08-26.** Shipped as 5 cases. Verified against two independent mutations of
> `InventoryController`: removing `@Roles(UserRole.ADMIN)` entirely, and replacing it with the
> wire-role string `'admin'` — the trap `inventory.controller.ts`'s own docblock warns about. **Both
> fail 2 of the 5 cases.** The second only works because the metadata is compared as raw `string[]`
> and never narrowed to `UserRole`: narrowing would turn `['admin']` into `[]`, which `RolesGuard`
> reads as *no* `@Roles()` at all, i.e. open. Do not add that narrowing.
>
> One note for readers: `inventory.controller.spec.ts:35` claims "`roles.guard.ts` has no spec of
> its own to notice". That is stale — `backend/src/common/auth/roles.guard.spec.ts` exists. The
> *reasoning* still holds (that spec tests the guard's behaviour **given** metadata; it cannot
> notice a controller that lost its decorator), so this task is still needed for exactly the stated
> reason.

---

## Task 2: The audit-log write path

**Files:**
- Create: `backend/src/modules/admin/audit-log.service.ts` + spec

- [ ] **Step 1: Write `AuditLogService.record(manager, input)`**

Mirror `NotificationsService.queue`'s contract exactly, because the reasoning is identical: it
**takes the caller's own open transaction** and writes inside it. An audit row committed separately
from the change it describes can outlive a rolled-back write, or be lost while the write survives —
both are worse than no audit trail, because both are trusted.

Input: `actorUserId`, `action` (a string enum, not free text), `entityType`, `entityId`, and an
optional `before`/`after` pair for field-level changes.

- [ ] **Step 2: Unit-test the transaction contract**

Assert it uses the passed manager and never opens its own. Assert a rejected driver/insert
propagates rather than being swallowed — unlike notifications, a failed audit write **must** fail
the operation.

- [ ] **Step 3: Commit** — `feat(admin): AuditLogService, one write path inside the caller's transaction`

---

## Task 3: `GET /admin/dashboard`

Brief §29 is normative: cards are Total Sales, B2C Sales, B2B Sales, Orders, Pending Orders,
Pending RFQs, Customers, B2B Customers, Low Stock; charts are sales over time, B2C vs B2B, top
products, top categories.

- [ ] **Step 1** — figures are computed in SQL, not by loading rows and reducing in JS. `GET
  /business/stats` (Milestone 7) is the precedent for a server-computed dashboard; read it first.
- [ ] **Step 2** — exclude cancelled and refunded orders from revenue, and say so in the response
  shape or a docblock. Milestone 5's account totals already made this choice; diverging silently
  would give the operator a different number from the customer for the same order.
- [ ] **Step 3** — integration test asserting each card against seeded data, and that an empty
  database answers zeroes rather than `null` or `NaN`.
- [ ] **Step 4: Commit** — `feat(admin): GET /admin/dashboard, computed in SQL`

---

## Task 4: Products — list and read

`GET /admin/products` (paginated, filterable, **includes unpublished** — the whole point of the
admin view), `GET /admin/products/:id`.

- [ ] The public catalogue endpoint filters to published; this one must not. Add a test that a
  seeded unpublished product appears here and does **not** appear in the public list.
- [ ] Commit — `feat(admin): GET /admin/products and /:id, unpublished included`

## Task 5: Products — create, update, delete

`POST /admin/products`, `PATCH /admin/products/:id`, `DELETE /admin/products/:id`.

- [ ] Brief §30's field list is normative: name, slug, description, category, SKU, HSN, GST, origin,
  grade, ingredients, shelf life, storage instructions.
- [ ] **Decide and document delete semantics.** A hard delete of a product referenced by an
  `OrderItem` either fails on the FK or orphans order history. Soft-delete (or refuse with a clear
  error when referenced) is almost certainly right; whichever is chosen, state it in the commit
  message and cover it with a test that has a real order against the product.
- [ ] Every write records an `AuditLog` row in the same transaction.
- [ ] Commit — `feat(admin): product create, update and delete, audited`

## Task 6: Publish / unpublish

`POST /admin/products/:id/publish`, `POST /admin/products/:id/unpublish`.

- [ ] Unpublishing a product that sits in live carts is a real case: assert what happens to those
  carts. `CartService`'s existing sold-out handling (§10.1) is the precedent to follow rather than
  invent beside.
- [ ] Commit — `feat(admin): publish and unpublish, with a test for carts holding the product`

## Task 7: Variants

`POST /admin/products/:id/variants`, `PATCH /admin/variants/:id`, `DELETE /admin/variants/:id`.

- [ ] Creating a variant must create its `Inventory` row in the same transaction. A variant with no
  inventory row is invisible to the sold-out logic and would read as infinitely in stock.
- [ ] Deleting a variant with stock, or with an order against it, is the same class of decision as
  Task 5's — resolve it the same way and consistently.
- [ ] Commit — `feat(admin): variant CRUD, inventory row created with the variant`

## Task 8: Categories

`GET /admin/categories`, `POST /admin/categories`, `PATCH /admin/categories/:id`.

- [ ] No delete in §6.4 — do not add one. If it seems needed, report rather than inventing surface.
- [ ] Commit — `feat(admin): category list, create and update`

---

## Task 9: Plan 9.1 verification

- [ ] `npm run test -w @nutwala/shared`
- [ ] `npm run test -w backend`
- [ ] `npm run test -w frontend` — must be unchanged; this plan touches no frontend file
- [ ] `npm run test:integration` — twice, back to back. `docs/known-issues.md` item 1 records an
      intermittent flake (~2 per 15 runs). If one appears, re-run, and **capture the failing test
      name and its response body into that file** — that capture is the single step that would
      close it.
- [ ] `npm run lint` and `npm run build` at the repo root
- [ ] Confirm the Task 1 guard test still passes **and** still fails when a decorator is removed
- [ ] Mutation-test, one at a time, reverting by re-editing and confirming `git diff --stat` is
      empty between each — the discipline that corrupted files twice in Milestone 7 when skipped:
      1. the unpublished-inclusion filter in `GET /admin/products` → the Task 4 test must fail
      2. `actorUserId` moved *before* the DTO spread → an audit-trail test must fail
      3. the `Inventory`-row creation in Task 7 → a sold-out test must fail
- [ ] Append a "Plan 9.1 complete" record to this file: exact counts, mutation results (marking any
      that only integration could kill), any flake and how it was confirmed benign, and everywhere
      this plan turned out wrong or needed a judgment call.
- [ ] Commit — `docs(admin): Plan 9.1 complete — verification record`

---

## Plan 9.1 complete — Tasks 1–8

Executed 2026-08-26/27. Commits `097cd07`, `46ec78e`, `17b1408`, `8463536`, `38035d4`, `946d84a`.

| Suite | Entering | Leaving |
| --- | --- | --- |
| shared | 71 / 6 | **71 passed / 6 files** |
| backend unit | 943 / 74 | **978 passed / 77 suites** |
| backend integration | 398 / 21 | **474 passed / 26 suites** |
| frontend | 266 / 14 | **266 passed / 14 files** (untouched) |

**1,789 total**, from 1,678. `typecheck -w backend`, `lint -w backend`, `format:check -w backend`
all exit 0, with only the two pre-existing `rfq-status.integration.spec.ts:154,156` warnings. Root
`npm run build` deliberately never run (`deleteOutDir: true` vs. the live `nest start --watch`).

**The guard test earned its place immediately.** Route discovery grew from 1 admin route to **15
across 4 controllers**, with no list to update — the 14 new handlers are exactly what Tasks 3–8
owed. Verified against two mutations of `InventoryController`: removing `@Roles(UserRole.ADMIN)`,
and replacing it with the wire-role string `'admin'`. Both fail 2 of the 5 cases.

### Where this plan was wrong

1. **Task 1's file path would never have run.** `backend/test/admin-routes-guarded.spec.ts` matches
   no jest config — the unit config roots at `src/`, the integration config roots at
   `test/integration/` *and* requires a `.integration.spec.ts` suffix. A guard test that never
   executes, on the security control for 27 endpoints. Corrected above.
2. **Task 5's delete premise was factually wrong for this schema.** See spec §5a: `order_items` is
   `SET NULL` and fully snapshotted, so a hard delete neither trips the FK nor orphans history. The
   genuine blocker is `inventory_transactions.variant_id ON DELETE RESTRICT`.
3. **Header said "§6.4 rows 1–7 (14 handlers)"** — rows 1–**6** are the 14; row 7 is plan 9.2.
4. **The spec's table said 9.1 was 13 endpoints**; it is 14.
5. **The spec called Task 1's subject `AdminGuard`**; there is no such guard, it is `RolesGuard`.
6. **The spec claimed `businesses.controller.ts` carries `@Roles(ADMIN)`**; it carries
   `@Roles(UserRole.BUSINESS)`.

### Deviation from "commit per task"

Tasks 4–7 landed as one commit (`8463536`). `POST /admin/products/:id/variants` must sit on
`AdminProductsController` — one base path per Nest controller — and Tasks 4–6 share one service
file, so any split yields either partial-file surgery across six files or an intermediate commit
whose own tests fail. A wider commit was chosen over a broken bisect point. Task 8 was isolated.

### Carried forward

- **Plan 9.2 owes a way to change `lowStockThreshold` on an existing variant.** §6.4 exposes none:
  the adjust route takes only `delta` + `reason`, and `GET /admin/inventory` is a read. 9.1 can only
  set it at variant creation.
- **`catalog.seed.ts`'s own warning is now live.** It says its ownership of images and pricing tiers
  "expires the moment admin product-editing ships" — which it now has. `npm run seed -- catalog`
  would destroy hand-edited images and tiers, and neither table has a unique key, so a real upsert
  is not expressible. 9.1 adds no image or tier editing, so nothing is broken yet.
- **Deleting a product empties baskets and wishlists holding it** (`cart_items`, `wishlist_items`
  CASCADE). Pre-existing schema intent; unpublish is the non-destructive operation.
- **Third sighting of `docs/known-issues.md` item 1**, and the first at a status other than 400: a
  401 from an arrange-step `POST /admin/products/:id/variants` whose login had just returned 200.
  That rules out "the anomalous status is always a validation refusal" — a 401 means
  `SessionsService.isActive` answered false for a session created moments earlier.
