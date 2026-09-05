# Admin Console Plan 9.3 — People & B2B

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.** Every prior milestone left
> them unticked, and the git log is what told the next session what had been done.

**Goal:** Give the operator the people and B2B surfaces — who the customers are, which businesses
buy, what they have asked to be quoted, and the pricing that answers them.

**Covers:** backend design spec §6.4 rows 13–17, brief §31, §34 and §35. **11 route handlers.**

---

## Facts verified against the code on 2026-08-27 — do not re-derive these

Plan 9.1 shipped with six errors written from memory. These were checked in this repo:

1. **`RfqStatusService.transition(rfqNumber, to)` takes an RFQ *number*, opens its own
   transaction, and accepts **no options at all** — no `actorUserId`, no audit. §6.4 spells the
   route `PATCH /admin/rfqs/:id`; that is the same `:id` drift already recorded for
   `PATCH /admin/inventory/:variantId` and the four order routes. **Use `:rfqNumber`.**
2. **`OrderStatusService` is the precedent to copy.** Plan 9.2 gave it `TransitionOptions.audit`
   (so the audit row is written *inside* its own transaction) and `TransitionOptions.manager` (so a
   caller can join it). `RfqStatusService` needs the same treatment, for the same reason.
3. **`RfqNote` already exists** (`entities/**/rfq-note.entity.ts`), and `Rfq` carries both a
   `notes: string | null` column and a `notesList: RfqNote[]` relation. Brief §34's internal notes
   have a home; **do not add a second one**, and decide explicitly which of the two you write to.
4. **RFQ statuses are `shared/src/constants/taxonomy.ts`'s `RFQ_STATUSES`** — new, contacted,
   quote-sent, negotiation, approved, rejected, converted. Exactly brief §34's seven. **The list
   may not be extended by this plan**, and `RFQ_TRANSITIONS` in `constants/rfq-status.ts` is the
   only rule about what follows what.
5. **`PricingTier`** carries `productId`, `minQty`, `maxQty`, `pricePerKg`, a `segment`
   (`CustomerSegment`: DEFAULT / RETAILER / DISTRIBUTOR / HORECA — brief §31's four, verified) and
   a **nullable `businessId`** which is how §31's "customer-specific pricing" is expressed.
6. **Integration tests live at `backend/test/integration/*.integration.spec.ts`.** Nothing else
   runs — the unit config roots at `src/`, the integration config roots at `test/integration` *and*
   requires the `.integration.spec.ts` suffix.
7. **A literal route segment must be declared above any `:param` sibling**, or the pattern
   swallows it.

## Conventions you are bound by

- **`@Roles(UserRole.ADMIN)` at class level**, carrying the **database enum**. The token carries
  `ADMIN`, an auth body carries `admin` — **`@Roles('admin')` compiles and refuses every admin.**
- **`@ApiTags('admin')`**. A **second controller** beside the public one, never mixed scopes.
- **`actorUserId` after the DTO spread**, so no body field can override the audit "who".
- **`admin-routes-guarded.integration.spec.ts` must keep passing and must discover your routes.**
  It compares roles metadata as raw `string[]` on purpose — **do not narrow it to `UserRole`**, or
  `@Roles('admin')` reads as `[]`, which `RolesGuard` treats as open.
- **Every admin write records an audit row in the same transaction as the change. A write that
  changes nothing writes no row.**
- Money in paise (§8). No `any` / `as any` / `@ts-ignore` / `eslint-disable`.
- Do not weaken an existing test's assertions. Touch no front-end repo.
- **Do not run root `npm run build`** while a `nest start --watch` is live — `deleteOutDir: true`.

---

## Task 1: `GET /admin/customers` and `GET /admin/customers/:id`

Brief §35 separates B2C from B2B customers.

- [ ] List: paginated, searchable by name/email/phone, filterable by role. Columns per §35.
- [ ] Detail: profile, order count, total spend, last order, addresses. **Total spend excludes
      cancelled and refunded**, matching `GET /admin/dashboard` and Milestone 5's account totals —
      diverging would show the operator a different number from the customer for the same order.
- [ ] **Never return a password hash.** Add a test asserting the field is absent from both shapes;
      a mapper that spreads the entity is one careless edit from leaking it.
- [ ] Commit — `feat(admin): customer list and detail`

## Task 2: `GET /admin/businesses` and `GET /admin/businesses/:id`

- [ ] Brief §35's B2B profile: company, GSTIN, business type, orders, total spend, RFQs, last
      order. (`assignedSalesperson` has no column — see the note in Task 4.)
- [ ] `businesses.controller.ts` carries `@Roles(UserRole.BUSINESS)` for the business's *own* view.
      This is a second controller; do not widen that one.
- [ ] Commit — `feat(admin): business list and detail`

## Task 3: `GET /admin/rfqs` and `GET /admin/rfqs/:rfqNumber`

- [ ] Brief §34's columns: RFQ ID, business, contact, products, quantity, expected value, status.
- [ ] Filter by status; paginate; newest first with a total tiebreak (see 9.2's ledger note — a
      `@CreateDateColumn` defaults to transaction-start time, so several rows can share a
      timestamp exactly and `LIMIT`/`OFFSET` needs a total order).
- [ ] Detail returns the line items and the note history.
- [ ] Commit — `feat(admin): RFQ list and detail`

## Task 4: `PATCH /admin/rfqs/:rfqNumber` and `POST /admin/rfqs/:rfqNumber/notes`

- [ ] **The status change goes through `RfqStatusService.transition`**, which is exported with no
      controller precisely for this milestone. Give it an `audit` option first, mirroring what plan
      9.2 did to `OrderStatusService` — **the audit row must be written inside its own
      transaction**, not by the controller around it.
- [ ] Illegal transitions must answer 422 carrying `allowed`, as the order route does. `RFQ_TRANSITIONS`
      is the only rule; do not add a second one.
- [ ] Notes: `RfqNote` exists. **Decide and state** whether a note also writes `Rfq.notes` or
      whether that column is legacy — two places holding "the notes" is how they disagree.
- [ ] **Brief §34 also asks for an assigned salesperson, and no column exists for it.** Do not
      invent one silently: either add it with a migration and say so loudly in the commit, or
      report it as a gap for 9.4. Prefer reporting — a schema change on the last night before the
      admin app is built is the wrong time.
- [ ] Commit — `feat(admin): RFQ status transition and internal notes`

## Task 5: pricing tiers — `GET`, `POST`, `PATCH /admin/pricing-tiers/:id`

- [ ] Brief §31: MOQ, price/kg, quantity tiers, retailer/distributor/HORECA pricing, and
      customer-specific pricing via the nullable `businessId`.
- [ ] **Overlapping tiers are the real hazard here.** Two rows covering the same quantity for the
      same product and segment make the resolver's answer depend on row order. Decide whether the
      write refuses an overlap, and test it either way — `pricing.resolver.ts` is what has to live
      with the answer, so read it first.
- [ ] A tier that changes nothing writes no audit row.
- [ ] Commit — `feat(admin): pricing tier CRUD`

---

## Task 6: Plan 9.3 verification

- [ ] `npm run test -w @nutwala/shared` — expect 71
- [ ] `npm run test -w backend` — expect ≥ 1030, report the total
- [ ] `npm run test:integration` — expect ≥ 566, report the total. **Check no other integration run
      is in flight first** (`ps aux | grep "[j]est --config jest.integration"`); two suites share one
      `postgres-test` database and will corrupt each other.
- [ ] `npm run typecheck -w backend`, `lint -w backend`, `format:check -w backend`
- [ ] Guard test passes; report the discovered admin-route count before and after (was **23**)
- [ ] Mutation-test one at a time, reverting by re-editing and confirming `git diff --stat` empty
      between each:
      1. move the RFQ audit write outside `transition`'s transaction → a rollback test must fail
      2. drop the overlap refusal in Task 5 (if you added one) → its test must fail
      3. spread the user entity into the customer mapper → the password-hash absence test must fail
- [ ] Append a "Plan 9.3 complete" record: counts, mutation results, and everywhere this plan was
      wrong or needed a judgment call.
- [ ] Commit — `docs(admin): Plan 9.3 complete — verification record`

---

## Plan 9.3 complete — verification record, 2026-08-27

**11 route handlers, five commits.** `ac4bc41` customers, `c475496` businesses, `89655a6` RFQ reads,
`cc57e13` RFQ writes, `8b2a62d` pricing tiers.

### Counts

| Suite | Before | After |
| --- | --- | --- |
| `npm run test -w @nutwala/shared` | 71 / 6 files | **71 / 6 files** — type-only additions |
| `npm run test -w backend` | 1030 / 79 suites | **1198 / 92 suites** |
| `npm run test:integration` | 566 / 28 suites | **653 / 32 suites** |
| discovered `admin/*` routes | 23 | **34** |

`typecheck`, `lint` and `format:check` all clean — the two pre-existing warnings in
`rfq-status.integration.spec.ts` are untouched and still the only ones. `git status --short` shows
only `.claude/`, an untracked worktree belonging to a **different** agent session (`git worktree
list` reports it locked at `247dd90`); nothing of this plan's is uncommitted.

### Mutation results — each applied alone, reverted with `git checkout --`, `git diff --stat` empty between

1. **RFQ audit row written outside `transition`'s transaction** (wrapped in its own
   `dataSource.transaction`) → `admin-rfqs` *"rolls the audit row back with the change when a later
   write in the same request fails"* **failed**: the row survived the rollback, exactly the
   "claiming a change that never happened" failure the option exists to prevent.
2. **Overlap refusal dropped** (the probe short-circuits to `undefined`) → **10 integration cases
   and 7 unit cases failed.**
3. **`...user` spread into the customer mapper** → `admin-customer.mapper.spec.ts` **failed 3
   cases**, including the exact-key-list one.

**Mutation 3 taught something worth keeping.** The integration disclosure test as first written —
"the body contains no `$2b$` and no `passwordHash`" — **passed under the mutation**. `passwordHash`
is `select: false`, so the entity the route loads does not carry it and a spread leaks nothing
*today*; it starts leaking the day any query in that module reaches for `addSelect`. The unit
fixture is built *with* the hash present for exactly that reason and caught it. The integration test
has since been strengthened to assert the response's whole key list, and now fails on the spread
too — a "no secret in the body" assertion is not a test of the mapper, it is a test of the column's
default.

### Where the plan was wrong

- **Fact-list item 5 and Tasks 2 and 4: `assignedSalesperson` has a column, and always has.**
  Task 2 says *"`assignedSalesperson` has no column"* and Task 4 asks for it to be reported as a gap
  for 9.4 rather than migrated. Both `rfqs.assigned_salesperson_id` and
  `businesses.assigned_salesperson_id` are in `20260819120000-InitialSchema.ts` — `uuid REFERENCES
  users(id) ON DELETE SET NULL`, with `idx_businesses_assigned_salesperson` on the second — and both
  entities have carried mapped properties since. `business.entity.ts` even documents it as
  *"Brief §34/§35. An admin user, not a separate staff table."* So brief §34's column is read on both
  admin surfaces and written by `PATCH /admin/rfqs/:rfqNumber`, and **no migration was written**.
- **Fact-list item 5's column names.** `PricingTier` carries `minKg`, `maxKg` and
  `pricePerKgPaise`, not `minQty`, `maxQty` and `pricePerKg`. The `segment`, the nullable
  `businessId` and the four `CustomerSegment` members were all correct.
- **The briefing's "never run two integration suites at once".** `docs/known-issues.md` item 4,
  committed while this plan was being executed, records the opposite and is right: `globalSetup`
  starts a fresh testcontainer per invocation on a random port. Observed directly — every run in
  this session reported its own container and port.

The other five facts held exactly as written.

### The three judgement calls

**1. Where a note goes.** `RfqNote` only; `Rfq.notes` is **not legacy** and no admin route writes
it. It is the *prospect's* own "additional requirements" from brief §17's public form — written by
`CreateRfqDto.notes`, and spread onto the customer-facing shape by `rfq.mapper.ts`'s
`toRfqDetail`. Writing a sales note there would destroy what the customer typed *and* publish a
confidential note back to them on their own enquiry page. `AdminRfq` therefore carries `notes`
(theirs, same field and same name as `RfqDetail.notes`) and `internalNotes` (`rfq_notes`), and the
column has gained a docblock saying so. Tested from both ends: the column is unchanged by a note,
and the note is absent from `GET /rfqs/:rfqNumber`.

**2. Overlapping tiers.** The write refuses them, `409 PRICING_TIER_OVERLAP`, naming the rung in the
way. `pricing.resolver.ts` decides nothing about overlap: `bulkTierFor` takes the **first** rung
whose range contains the weight over a ladder sorted by `minKg`, so two overlapping rungs make the
price depend on row order — on `minKg` where they differ, and on the driver's row order where they
do not. `CheckoutService.place` snapshots the resolved rate onto `order_items`, so it is a money
disagreement, not a display one.

**The grouping is the resolver's, not `(product, segment, business)`** — and this is the part a
naive check gets wrong. `resolveTiers`' first rung filters on `businessId` **alone** and never looks
at the band, so a business holding a `DEFAULT` rung and a `RETAILER` rung has both in one resolved
ladder. A uniqueness check on all three columns would let exactly that overlap through. Both
directions are tested: two overlapping business rungs in different bands are refused; two
overlapping *unscoped* rungs in different bands are accepted, because those genuinely are two
ladders.

The `products` row is locked `FOR UPDATE` before the probe. Read-then-write under `READ COMMITTED`
would let two operators adding 10–24 and 20–30 at once both pass. And the rule was checked against
the data that already exists: a query over `seedCatalog`'s output finds no overlapping pair, so no
seeded ladder is un-editable.

**3. The assigned salesperson.** Not a gap — see above. Implemented, with the role checked
(`business.entity.ts` settled that a salesperson is an admin user, and the column is a bare
`users(id)` reference, so nothing at the database level stops an enquiry being assigned to a
customer). A non-admin id gets the same 404 an unknown one does, so the route is not an oracle for
which uuids are operator accounts.

### Other judgement calls, recorded so they can be reversed knowingly

- **`GET /admin/customers` excludes admins, and the detail route 404s on an admin's uuid.** Brief
  §35's screen is "separate B2C and B2B customers"; `GET /admin/dashboard`'s `customers` card
  already counts `role <> 'ADMIN'`, and a list including admins would disagree with the card beside
  it. `?role=admin` is refused by the DTO.
- **`orders` counts every status, `totalSpend` excludes `cancelled` and `refunded`.** The plan asks
  for the second; the first is `AdminDashboardCards`' existing, deliberate asymmetry, kept so the
  count agrees with `GET /admin/orders`. `lastOrderAt` covers every status too.
- **Business figures are all-channel, not `channel = bulk`.** Brief §46 puts retail and bulk on one
  account, so a bulk-only total would make `GET /admin/businesses/:id` and
  `GET /admin/customers/:id` disagree about the same person. The shared `orderTotalsByUser` is what
  makes them identical, and an integration case fetches both screens and compares them.
  `GET /business/stats`'s `bulkOrders`/`bulkSpend` are a different question under different names.
- **`AdminBusinessSummary` carries `openRfqs` beside `rfqs`.** Brief §35's column is "RFQs"; the
  second figure is free from the same `count(*) FILTER` and is what an operator triaging a queue
  needs. `OPEN_RFQ_STATUSES` is imported from `BusinessStatsService`, not restated.
- **A note writes an `audit_logs` row carrying the note's id and not its body.** The convention says
  every admin write is audited; the `INVENTORY_UPDATE` precedent argues an append-only ledger with
  an actor is its own trail. Both were honoured: the row is written, the confidential text is not
  copied into a second table.
- **`PATCH /admin/rfqs/:rfqNumber` sets three fields, not one.** The plan describes only the status.
  Brief §34's screen also has "expected value" and "assigned salesperson", §6.4 gives this resource
  exactly one `PATCH`, and both columns exist — so a status-only route would leave two of the
  brief's own columns unwritable.
- **`GET /admin/pricing-tiers` is paginated where `GET /admin/categories` is not.** Brief §7 fixes
  categories at twelve; a ladder is per product per band per business.
- **`?businessId=none`** is a sentinel, because a query string has no null and "the rungs that
  belong to nobody in particular" cannot otherwise be asked. `AdminProductQueryDto` records the
  mirror-image decision — `all` is *not* a sentinel there — for the same reason.
- **`POST /admin/pricing-tiers` answers 201**, unlike the order writes' explicit `@HttpCode(OK)`: it
  creates a resource and answers with that resource. `POST .../notes` answers 200, because its body
  is the whole enquiry rather than the created note.
- **`UsersModule` is now listed in `AppModule.imports`.** It was reachable only through `AuthModule`
  and `ProfileModule`, which registers its providers correctly and its first controller by accident.
- **`orderTotalsByUser` was extracted into `modules/orders/`** as a plain function rather than
  copied into two services. It needs no provider for the reason `resolveTiers` does not.
- **`PricingModule` is new; `pricing.resolver.ts` stays a plain import.** Turning two pure functions
  into a provider to keep a new controller company would change four call sites for no gain.

### Not fixed, found on the way

- **No `PATCH /admin/businesses/:id`, and §6.4 does not list one.** `businesses.segment` — brief
  §31's price band — therefore still has no writer, which `business.entity.ts` already flagged
  ("`DEFAULT` for every business until Milestone 9's `PATCH /admin/businesses/:id` exists"), and
  `assignedSalespersonId` has none on the business side either. The RFQ side gained both. This is a
  real gap for 9.4 and it is the one Task 4 should have been asking about.
- **`profile.module.spec.ts` needed a setup fix** after `UsersModule` gained
  `forFeature([Business, Address])`: an unoverridden `forFeature` token resolves its repository off
  that spec's stub `DataSource`. Setup only, no assertion changed. It was committed broken in
  `ac4bc41` and fixed in `cc57e13`, because the intermediate verification ran the touched module's
  tests rather than the whole unit suite. Run `npm run test -w backend` before every commit, not
  the directory you happen to be in.
