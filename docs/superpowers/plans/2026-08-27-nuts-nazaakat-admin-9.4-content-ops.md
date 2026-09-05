# Admin Console Plan 9.4 — Content & Operations

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.**

**Goal:** The last of the admin API surface — coupons, review moderation, the blog, settings
(including the business timezone the dashboard needs), support tickets and the audit-log read.

**Covers:** backend design spec §6.4 rows 18–23 and **§6.1's `GET /settings`, which is specced but
was never built**. Brief §26, §27, §28, §36 and §38. **19 route handlers.**

---

## Facts verified against the code on 2026-08-27 — do not re-derive these

1. **Every entity you need already exists**: `commerce/coupon`, `content/review`,
   `content/blog-post`, `ops/setting`, `ops/support-ticket`, `ops/support-ticket-note`,
   `ops/audit-log`. **No migration should be needed** except the one in Task 6 — say so loudly if
   you think otherwise.
2. **`Review` already carries moderation state**: `status: ReviewStatus`, defaulting to `PENDING`,
   with `idx_reviews_status`. Approve/reject is a status transition, not a new column.
3. **`Setting` is key/value**: `@PrimaryColumn varchar(60) key`, `jsonb value`, plus
   `isPublic: boolean` and `updatedByUserId`. **A new setting is a row, not a schema change.**
4. **`Setting.isPublic`'s docblock says "False keeps a setting out of the public `GET /settings`
   response" — and that endpoint does not exist.** `SettingsService` has exactly one method,
   `payment()`, and there is **no settings controller anywhere in the service.** Spec §6.1 lists
   `GET /settings — public subset only`. It is owed; see Task 5.
5. **`SupportTicketNote` exists**, so §38's ticket notes have a home. `SupportTicketsModule` was
   built in Milestone 8 with `POST /contact` and deliberately **no read routes** — "No read routes
   this milestone". This plan adds them.
6. **Integration tests live at `backend/test/integration/*.integration.spec.ts`.** Nothing else runs.
7. **A literal route segment must be declared above any `:param` sibling.**

## Conventions you are bound by

- **`@Roles(UserRole.ADMIN)` at class level**, carrying the **database enum**. The token carries
  `ADMIN`, an auth body carries `admin` — **`@Roles('admin')` compiles and refuses every admin.**
- **`@ApiTags('admin')`**; a second controller beside any public one.
- **`actorUserId` after the DTO spread.**
- **`admin-routes-guarded.integration.spec.ts` must pass and must discover your routes.** It
  compares roles metadata as raw `string[]` — **do not narrow it to `UserRole`.**
- **Every admin write records an audit row in the same transaction. A write that changes nothing
  writes no row.**
- Money in paise. No `any` / `as any` / `@ts-ignore` / `eslint-disable`.
- **Do not run root `npm run build`** while a `nest start --watch` is live.

---

## Task 1: Coupons — `GET`, `POST`, `PATCH /:code`, `DELETE /:code`

Brief §36 is normative: percentage discount, flat discount, minimum order value,
category-specific, B2C-only, B2B-only, first-order, expiry, usage limit.

- [ ] **Decide the identifier and say why.** A coupon has a natural key (its code) and a uuid.
      §6.4 spells `:id`; the order routes went with the human-readable `:orderNumber` for the same
      reason. Be consistent with whichever you choose and note it so §6.4 can be corrected.
- [ ] **Deleting a coupon that has been redeemed** is the same class of decision plan 9.1 settled
      for products (spec §5a): hard delete, refused with `409 ENTITY_IN_USE` when referenced. Check
      what references a coupon before choosing — `orders.couponCode` is a **snapshot string**, so a
      delete may not be referenced at all, in which case say so rather than inventing a guard.
- [ ] Usage limit and expiry are enforced at redemption, which already exists. **Do not
      re-implement that here**; read it and make sure the admin write cannot produce a coupon the
      redemption path would mis-handle (a limit below current usage, an expiry in the past).
- [ ] Commit — `feat(admin): coupon CRUD`

## Task 2: Review moderation — `GET /admin/reviews`, `POST /:id/approve`, `POST /:id/reject`

Brief §27: admin approves or rejects; the storefront shows Verified Purchase.

- [ ] List filterable by status, defaulting to `PENDING` — that is the queue the operator opens
      this page for.
- [ ] Approve/reject are status transitions. **A second approve writes no audit row** (nothing
      changed), per plan 9.1's rule.
- [ ] Approving must make the review visible on the storefront, and rejecting must not. Assert
      both **through the public catalogue route**, not just by reading the column — that is the
      behaviour anyone cares about.
- [ ] Commit — `feat(admin): review moderation`

## Task 3: Blog — `GET /admin/posts`, `POST`, `PATCH /:slug`, `DELETE /:slug`

Brief §28's categories and §39's SEO fields (title, meta description, slug, OG image).

- [ ] The admin list includes unpublished posts; the public one must not. Add a test asserting a
      seeded unpublished post appears here and **not** in the public list — the same test plan 9.1
      wrote for products.
- [ ] A slug change on a published post breaks its live URL. Decide whether to allow it, and say
      what happens to the old URL.
- [ ] Commit — `feat(admin): blog post CRUD`

## Task 4: Support tickets — `GET`, `GET /:ticketNumber`, `PATCH /:ticketNumber`, `POST /:ticketNumber/notes`

Milestone 8 built `POST /contact` and deliberately no read routes. These are them.

- [ ] `SupportTicketNote` exists. Status transitions, assignment and internal notes.
- [ ] `TICKET_NUMBER_PATTERN` is `/^ST-\d{4}-\d{6,}$/` and already a committed, tested contract in
      `shared/`. **Address tickets by number**, consistent with orders and RFQs.
- [ ] Commit — `feat(admin): support ticket triage`

## Task 5: Settings — `GET`/`PUT /admin/settings`, **and the public `GET /settings`**

- [ ] `GET /admin/settings` returns every row; `PUT` writes with `updatedByUserId` and an audit row.
- [ ] **Build the public `GET /settings` that spec §6.1 lists and nobody built.** It returns only
      rows where `isPublic` is true — which is what that column exists for, and its docblock already
      describes an endpoint that does not exist. Add a test asserting a non-public row is absent.
- [ ] **This is what unblocks the storefront's empty contact details.** `nutwala-client`'s
      `src/config/settings.ts` is still the Phase-1 mock, with WhatsApp number, support email,
      GSTIN and certifications all deliberately empty — brief §26/§37 forbid inventing them.
      Rewiring the client is **not this plan's job** (different repository), but note in the commit
      that it is now possible.
- [ ] Commit — `feat(settings): admin read/write, and the public subset endpoint`

## Task 6: The business timezone

Spec §5b records the user's decision: **a business timezone becomes a `Settings` field here, and
must be applied to every dated admin figure at once.** A per-endpoint fix is how two figures start
disagreeing.

- [ ] Seed `business.timezone`, default `Asia/Kolkata`, `isPublic: false`.
- [ ] **Apply it to both known consumers together**: `salesOverTime` in `GET /admin/dashboard`
      (plan 9.1, currently grouping by UTC day — a 04:00 IST order lands on the previous bar) and
      the `?from`/`?to` filter on `GET /admin/orders` (plan 9.2, where a date-only bound is
      midnight UTC, 05:30 IST). Plan 9.2 flagged that it left them consistent deliberately so they
      could be moved together. **Move them together.**
- [ ] Test with an order placed at 04:00 IST and assert it lands on the correct day in both
      surfaces. A test that only checks the setting is stored proves nothing.
- [ ] Commit — `feat(admin): a business timezone, applied to every dated figure at once`

## Task 7: `GET /admin/audit-logs`

- [ ] Filterable by actor, entity type, entity id and date range; paginated; newest first with a
      total tiebreak.
- [ ] **State plainly, in the response shape or a docblock, that stock movements are not here.**
      Plan 9.2 decided the `inventory_transactions` ledger *is* the audit trail for stock — an
      append-only row carrying delta, reason, balance and actor, which is brief §32's history in
      full — so no `AuditAction` member exists for a stock movement. An operator who opens this
      page expecting to find one and does not is the failure mode; say so rather than let them
      conclude the trail is broken.
- [ ] Commit — `feat(admin): audit log read`

---

## Task 8: Plan 9.4 verification

- [ ] `npm run test -w @nutwala/shared`, `-w backend`, and `npm run test:integration` — report all
      three totals. **Check no other integration run is in flight first.**
- [ ] `npm run typecheck -w backend`, `lint -w backend`, `format:check -w backend`
- [ ] Guard test passes; report the discovered admin-route count before and after
- [ ] Mutation-test one at a time, reverting by re-editing, `git diff --stat` empty between each:
      1. make `GET /settings` return non-public rows → its absence test must fail
      2. apply the timezone to `salesOverTime` but not to the order date filter → the 04:00 IST
         test must fail on one surface, which is the whole point of moving them together
      3. drop the unpublished filter from the public blog list → the Task 3 test must fail
- [ ] Append a "Plan 9.4 complete" record: counts, mutation results, and everywhere this plan was
      wrong or needed a judgment call.
- [ ] Commit — `docs(admin): Plan 9.4 complete — verification record`

---

## After this plan

Milestone 9's backend is complete: all 27 `@Roles(ADMIN)` endpoints of §6.4, plus the public
`GET /settings` it turned out nobody had built. What remains is **plan 9.6** — the admin
application's 18 routes, in `~/Desktop/nutwala-admin`, which is scaffolded and carries the contract
already. Plan 9.5 (extracting `@nutwala/shared` to a fourth repository) **was cancelled**: the user
chose three repositories, and the front-ends vendor the contract from the backend instead.

---

## Plan 9.4 complete — verification record

**Completed 2026-08-27.** Seven commits, one per task, plus a test fix the verification turned up.

### Counts

| Suite | Command | Before | After |
| --- | --- | --- | --- |
| shared | `npm run test -w @nutwala/shared` | 71 / 6 files | **71 / 6 files** |
| backend unit | `npm run test -w backend` | 1030 / 79 suites | **1038 / 80 suites** |
| backend integration | `npm run test:integration` | 566 / 28 suites | **674 / 35 suites** |
| discovered admin routes | `admin-routes-guarded` | 23 | **41** |

`typecheck` exits 0. `format:check` clean. `lint` reports the **2 pre-existing warnings** in
`rfq-status.integration.spec.ts:154,156` and nothing else. `git status --short` empty.

**41 − 23 = 18 admin routes**, plus the public `GET /settings` = the 19 handlers this plan
promised. Three further **public** routes were built that the plan did not count — see "the
second gap" below. No `any` / `as any` / `@ts-ignore` / `eslint-disable` was added. **No
migration was needed at all** (see fact 1 below).

### Mutation results — all three failed as intended, one at a time, tree clean between each

1. **`GET /settings` returns non-public rows.** `settings.integration` failed on *"omits a
   non-public row entirely"* and on *"gives no way to change isPublic"*. It also **exposed a
   real defect in one of this plan's own tests**, which is the whole reason to do this:
   `business-timezone`'s privacy assertion used
   `expect(publicSettings).not.toHaveProperty('business.timezone')`, and **Jest reads a dotted
   string as a property path** — so it asked for `settings.business.timezone` and passed
   unconditionally, including while the setting was being published to every visitor. Fixed to
   `expect(Object.keys(...)).not.toContain(key)` and re-verified against the same mutation
   (commit `ff7d85a`). `business.timezone` is the only dotted key in the table.
2. **Timezone applied to `salesOverTime` but not to the order date filter.** Exactly the split
   the plan predicted: *"puts a 04:00 IST order on the IST day's bar"* still **passed**, while
   four order-filter cases failed. That asymmetry is the argument for moving them together,
   made visible.
3. **Unpublished filter dropped from the public blog list.** `admin-posts` failed on *"includes
   an unpublished post the public list omits"* — and on nothing else, so the test is specific.

### Where this plan was wrong

- **Fact 1 is wrong, and fact 3 contradicts it.** Fact 1 says "no migration should be needed
  **except the one in Task 6**"; fact 3 says "a new setting is a row, not a schema change".
  Fact 3 is right. `business.timezone` is an upserted row in `settings.seed.ts` and **this plan
  added no migration at all**.
- **Task 1's hypothesis about deleting a redeemed coupon is wrong.** The plan says
  `orders.couponCode` is a snapshot string "so a delete may not be referenced at all, in which
  case say so rather than inventing a guard". The snapshot half is correct — it is a
  `varchar(40)` with no foreign key. But **`coupon_redemptions.coupon_id` is `ON DELETE
  RESTRICT`**, and its own docblock already says why: *"`DELETE /admin/coupons/:id` is a real
  endpoint, and deleting a used coupon must not wipe its redemption history."* So there is a
  real reference, and it gets spec §5a's `409 ENTITY_IN_USE` — the same relationship plan 9.1
  found between `inventory_transactions.variant_id` and `DELETE /admin/products/:id`.
- **Task 3 and Task 8 assume a public blog list exists. It does not — and neither do the other
  two `/content/posts` routes.** Spec §6.1 lists `GET /content/posts`, `/content/posts/:slug`
  and `/content/posts/:slug/related`; there was **no `content` controller anywhere in the
  service**, so `blog_posts` carried eight seeded posts since Milestone 3 with nothing able to
  read them. Task 3 requires a test asserting a draft is absent from "the public list" and
  Task 8's third mutation requires dropping "the unpublished filter from the public blog list",
  neither of which is possible against a list that does not exist. **So `GET /settings` was not
  the only §6.1 gap — there were four missing public routes, not one.** All four were built;
  the three blog routes are scope this plan did not state.
- **Task 1's "a coupon the redemption path would mis-handle" names two cases that are not
  mis-handled.** Read `coupon.service.ts` for both: a past expiry answers `COUPON_EXPIRED` and
  a limit below current usage answers `COUPON_LIMIT_REACHED`, each correctly and each with its
  own actionable code. So a past expiry is **allowed** (back-dating one is how a campaign is
  ended at a stated moment). A limit below current usage is refused anyway, for a different
  reason: the coupon dies the instant the write commits and nothing in a 200 response would
  say so. What the redemption path genuinely cannot defend against is a **self-contradictory
  row**, and those are what `assertCoherent` refuses.

### Where the surrounding docs were wrong

- **`AuditAction` and `AuditEntity` are not in `backend/src/entities/enums.ts`.** They are in
  `backend/src/modules/admin/audit-log.service.ts`. (Stated in the task brief given to this
  agent, not in the plan itself.)
- **`SettingsModule`'s old docblock named the future route `GET /settings/public`.** Spec §6.1
  spells it `GET /settings`, and §6.1 is the contract the front-ends read, so that is what
  shipped.
- **Spec §6.3's `GET /support/tickets` — "own tickets only" — does not exist either.** Found
  while building the admin ticket routes. Customer-facing, so outside this plan's scope
  (§6.4 plus §6.1's `GET /settings`); recorded in `admin-support-tickets.controller.ts`.
- **Spec §2.1 and §4a still describe plan 9.5 extracting `@nutwala/shared` into a fourth
  repository.** This plan's own closing section records that 9.5 was **cancelled**. The spec
  has not been updated to match.

### §6.4 identifier corrections this plan owes the spec

Three more rows where the shipped spelling is not the table's, for the reason §6.4 already
records about `PATCH /admin/inventory/:variantId` and plan 9.2 recorded about `:orderNumber`.
Appended to §6.4 rather than edited inline, to keep a concurrent plan's merge trivial.

| §6.4 says | Shipped | Why |
| --- | --- | --- |
| `/admin/coupons/:id` | **`:code`** | `CouponService.preview` looks a coupon up by code and nothing else; `orders.couponCode` snapshots it; `uq_coupons_code`. The code is **immutable** for exactly that reason. |
| `/admin/posts/:id` | **`:slug`** | The slug is the live URL `GET /content/posts/:slug` serves, and `uq_blog_posts_slug` makes it unique. Mutable, unlike a coupon code — brief §39 makes it an editable SEO field. |
| `/admin/support/tickets/:id` | **`:ticketNumber`** | `TICKET_NUMBER_PATTERN` is a committed contract in `shared/`, and `ST-2026-000123` is the reference the customer was given. Consistent with `:orderNumber` and `:rfqNumber`. |

`/admin/reviews/:id` **is** the uuid, matching §6.4: a review has no human-readable alternate
key, so it is the one resource in this plan where §6.4's spelling was already right.

### Judgment calls, and where each is recorded

| Call | Answer | Recorded in |
| --- | --- | --- |
| Coupon identifier | `:code`, and immutable | `UpdateCouponDto`, `AdminCouponsService` |
| Delete a redeemed coupon | Refused, `409 ENTITY_IN_USE` | `AdminCouponsService.remove` |
| Coupon rows the redemption path cannot defend against | Four `assertCoherent` rules | `AdminCouponsService.assertCoherent` |
| Published post's slug | May change; the old URL **404s**, no redirect table | `UpdatePostDto` |
| Review moderation actions | Two members, `review.approve` / `review.reject` | `AuditAction` |
| Rejection reason | Optional; cleared on a later approval | `RejectReviewDto` |
| `PUT /admin/settings` on an unknown key | 404 naming it; a new setting is a seed insert | `AdminSettingsService` |
| `isPublic` | Reported, never editable over HTTP | `ReplaceSettingsDto` |
| Settings payload shape | Array of entries, not a flat map | `ReplaceSettingsDto` |
| Ticket `resolvedAt` | Tracks the status; not the stamp-once `publishedAt` rule | `resolvedAtFor` |
| Ticket status moves | No state machine; backwards is legal | `ChangeSupportTicketDto` |
| Ticket assignee | Must be an admin account | `AdminSupportTicketsService.assertAssignable` |
| A repeated note | Always writes; a note is an append, not a change | `AdminSupportTicketsService.addNote` |
| Timezone reader | Plain exported function — a service method would be a module cycle | `business-timezone.ts` |
| Date-only vs instant bounds | Only date-only is timezone-shifted | `AdminOrderQueryDto`, `AdminOrdersService.list` |
| Audit-log `entity`/`action` filters | Free strings, not `@IsIn` | `AuditLogQueryDto` |
| Audit-log date range | Same business-day rule, born consistent | `AdminAuditLogsService` |

### Two existing tests whose *setup* changed

Spec §5's rule is that updating a test's setup for a genuinely new precondition is legitimate
and changing what it asserts is not. Both of these are the former:

- `admin-dashboard`'s sales-over-time case derived "today" from `new Date().toISOString()` — the
  **UTC** date. It now derives it in `Asia/Kolkata`. The claim is unchanged. Left alone it would
  have failed for 5½ hours out of every 24 and passed for the rest.
- `admin-orders.service.spec`'s harness gained a manager stub, because `list` now reads a
  setting. The instant-bound assertions are untouched, and **five cases were added**.

`settings.integration`'s row count moved 15 → 16 for the new key.

### What this unblocks, and what remains

`GET /settings` is live, so `nutwala-client`'s `src/config/settings.ts` — still the Phase-1 mock
with WhatsApp number, support email, GSTIN and certifications deliberately empty per brief §26
and §37 — **can now be rewired against the server**. Different repository, not this plan's job.

Milestone 9's backend is complete once plan 9.3 lands: all `@Roles(ADMIN)` endpoints of §6.4,
plus the four public §6.1 routes nobody had built. What remains is **plan 9.6**, the admin
application's 18 routes in `~/Desktop/nutwala-admin`.
