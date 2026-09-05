# Checkout, Orders and Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer can place a COD order that survives a double-click, see it in their account, watch it move through real statuses, and cancel it while that is still allowed — with stock, money and the audit trail correct under concurrency.

**Architecture:** Spec §10.2's race-safe decrement in one `READ COMMITTED` transaction; `OrderEvent` rows as the single source of both the admin's history and the customer's tracking timeline; an `IdempotencyInterceptor` over the existing `idempotency_keys` table; and the four remaining frontend seams (`checkout`, `account`) swapped from mocks to `http` without changing a screen.

**Tech Stack:** NestJS 11, TypeORM 0.3.31, Postgres 15, React 19 + TanStack Router/Query, Vitest, Jest, `@nutwala/shared` as the wire contract.

**Covers:** spec §16 Milestone 5 (Checkout & orders) and Milestone 6 (Account & tracking) — 12 of §6.3's endpoints.

**Does not cover:** the admin console. §7.1 puts it in a **separate application and repository**, so its 18 screens and the 27 `@Roles(ADMIN)` endpoints of §6.4 get their own plan in that repo. This plan builds only what a customer touches, plus the two admin-facing pieces the customer path cannot work without — the status transition service and the payment-collection hook — so that the admin plan wires screens to services that already exist and are tested.

---

## Why this milestone is the riskiest one so far

Every previous milestone added surface. This one **moves money and decrements stock**, and it is the first where a bug costs the business rather than costing a page.

Three properties have to hold simultaneously, and each is easy to get right alone:

1. **No overselling.** Two customers racing for the last bag must produce exactly one order and one clear rejection.
2. **No double orders.** A double-clicked Place Order must replay the first response, not create a second order — and the `idempotency_keys` table exists for this while nothing uses it.
3. **The ledger never drifts.** `SUM(inventory_transactions.delta) == inventory.onHand` is asserted by `schema-invariants.integration.spec.ts` and is currently clean at 0 mismatches. Every decrement must write its `SALE` row in the same transaction.

The seeder deliberately writes **no** `InventoryTransaction` rows for its six orders (`orders.seed.ts:25-30`), so the invariant currently holds trivially for order history. The first real order is also the first time these two systems meet.

---

## What already exists, measured — do not rebuild it

This was inventoried before the plan was written. Trust it over your assumptions, but verify anything you are about to depend on.

### Entities: all present, none used

`Order`, `OrderItem`, `OrderEvent`, `Payment`, `Shipment`, `Address`, `Coupon`, `CouponRedemption`, `ServiceablePincode`, `IdempotencyKey` all exist under `backend/src/entities/`. The migration is applied; `orders.status` is a **`varchar(24)` with a check constraint**, not a Postgres enum, mirroring `@nutwala/shared`'s 14-value tuple.

**There is no order backend at all.** Verified explicitly rather than inferred: no `modules/orders/`, `modules/checkout/`, `modules/coupons/`, `modules/payments/`, `modules/addresses/` or `modules/settings/`; `app.module.ts` imports exactly `LoggingModule, HealthModule, AuthModule, CartModule, CatalogModule, InventoryModule, ReviewsModule, WishlistModule`; and no module injects an `Order`, `Coupon`, `Payment`, `Shipment` or `ServiceablePincode` repository.

### The transition map is already built and tested

`shared/src/constants/order-status.ts` holds `RETAIL_TRANSITIONS`, `BULK_TRANSITIONS`, `nextStatuses()`, `canTransition()` and `isTerminalStatus()`, pinned by 16 cases in `order-status.test.ts` — including that a **no-op transition is refused**, so a duplicate admin click is not recorded twice, and that `isTerminalStatus` **throws** on a cross-channel status rather than answering.

**Nothing in the frontend imports those three functions.** `OrderStatusService` is therefore a thin server-side consumer of a rule that already exists, not a second copy of it. Writing a second transition table anywhere in this plan is a defect.

### The tracking timeline UI already exists

`frontend/src/features/account/components/OrderTimeline.tsx` renders `OrderEvent[]` **oldest first**, treats the last entry as current, and takes its labels from `ORDER_STATUS_LABEL`. Its docblock states the constraint the backend must honour: *"The order's own history, oldest first — not a fixed nine-step ladder."*

So `GET /account/orders/:orderNumber` returns whatever events exist, in order. It does not synthesise a ladder, and it does not pad.

### The seeder is richer than you would guess

`orders.seed.ts` writes **six orders and 38 events covering all 14 statuses**, plus one `Payment` per order. That is the fixture every read endpoint in Milestone 6 is tested against, and it is why those tasks need no new seed data.

---

## How to mutate, since every task in this plan asks you to

Each task asks you to prove its tests can fail by reverting the behaviour they cover. **Do not do that
with `if (false && …)` or by commenting out a condition inside a narrowed block.** TypeScript drops
narrowing inside unreachable code, so a guarded `row` reverts to `Coupon | null`, the suite fails to
*compile*, and jest reports `Tests: 0 total` — which reads like a kill and proves nothing. Task 4 had six
first-round mutations invalidated this way before redoing them as outright deletions.

It is the same shape as the bigint hazard below: a result that looks like evidence and is not. **Delete
the line, run, restore byte-identically, and verify the restore with a checksum.**

## A raw `UPDATE` does not return rows — it returns `[rows, rowCount]`

**This defect shipped twice and passed 458 unit tests.** Read it before you write any raw write.

`PostgresQueryRunner.query` special-cases the commands that report an affected count
(`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:198-205`, verified):

```js
switch (raw.command) {
  case "DELETE":
  case "UPDATE":
    result.raw = [raw.rows, raw.rowCount];   // <-- not raw.rows
    break;
  default:
    result.raw = raw.rows;
}
```

So for a bare `UPDATE … RETURNING "onHand"`, `rows[0]` is the **rows array**, and `rows[0]?.onHand` is
`undefined`. In `CheckoutService.sell` the `undefined` branch threw `OUT_OF_STOCK`, so **every successful
decrement was reported as a sell-out and no order with a retail line could be placed at all**; the
identical statement in `OrderStatusService.putStockBack` threw `NOT_FOUND`, so **every cancellation
failed**. Both found in Task 7 and fixed in `4f06392` by wrapping the write in a data-modifying CTE
(`WITH sold AS (UPDATE … RETURNING) SELECT`), which makes the statement's command `SELECT` while keeping
it one statement with the predicate still inside the write.

Three things to take from it:

- **`INSERT` is not special-cased.** `INSERT … RETURNING` returns `raw.rows` and behaves as you expect,
  which is exactly why this trap stayed hidden — the existing INSERT-returning code is fine.
- **Unit doubles hid it completely.** The fakes answered `[{ onHand }]`, the shape a `SELECT` returns.
  They modelled the right shape; the driver's special case was the liar. All 458 unit tests passed
  before and after the fix, so **no unit test can protect you here** — only a real database can.
- **The audit is already done.** Every production `.query()` site that reads rows back was checked:
  `checkout.service.ts:548` (the decrement) and `order-status.service.ts:261` (the restock) were the two
  affected and are fixed; `order-number.ts:34` and `checkout.service.ts:612` are genuine `SELECT`s and
  are safe. If you add a new raw `UPDATE`/`DELETE` that reads its own output, use the CTE shape.

## An `undefined` or `null` in a `where` clause is silently dropped, and the query then returns everything

Every remaining task writes a scoped `where`, so this belongs here rather than in one of them. Measured in
`typeorm/query-builder/SelectQueryBuilder.js:2496-2517`:

```js
if (parameterValue === undefined) {
    const undefinedBehavior = …?.undefined || "ignore";
    if (undefinedBehavior === "throw") throw …
    continue;                                   // <-- the criterion is dropped
}
if (parameterValue === null) {
    const nullBehavior = …?.null || "ignore";
    if (nullBehavior === "ignore") continue;     // <-- and so is this one
    …
}
```

Both default to `"ignore"`. So `where: { userId }` with `userId` holding `undefined` **is not a query for
rows with no owner — it is a query with no owner clause at all**, and it answers with every row in the
table. TypeORM's own error text for the non-default setting says the rest: *"To match with SQL NULL, the
`IsNull()` operator must be used."*

Three consequences for the IDOR work in this milestone:

- **`{ userId: userId ?? undefined }` is the shape that leaks.** Task 15 measured it: the guard replaced
  that way returned all seven orders in the database, both other customers' included. Guard the guest case
  with an early return instead, before any `where` is built.
- **`{ userId: null }` does not compile**, so it is not the hazard to warn about — `FindOptionsWhere<T>`
  runs each property through `NonNullable`. The plan previously described the danger as "a missing `userId`
  in a `where` clause", which reads as a warning about `null`; the reachable version is `undefined`.
- **`IsNull()` compiles and is wrong here for a different reason.** `user_id IS NULL` is shared by every
  guest order ever placed, so a guest asking for "my orders" would receive all of them.

The same trap is one step away in a filter: an unvalidated `channel` string arriving as `undefined`
**widens** the query to every channel rather than narrowing it, which is why Task 17's DTO needs `@IsIn`.

**But this hazard is confined to reads and raw queries — `update` and `delete` refuse an empty criteria.**
Measured in `typeorm/entity-manager/EntityManager.js:355-370`: `normalizeAndValidateWhereCriteria` drops
every `undefined`, then calls `rejectEmpty()`, so `update({}, …)` and `update({ id: undefined }, …)` both
throw *"Empty criteria(s) are not allowed for the update method"* — a 500, not a whole-table write. That
applies to `update`, `delete`, `softDelete` and `restore`; `find`/`findOne` go through
`SelectQueryBuilder` and are **not** protected, and neither is `manager.query`.

So the dangerous shape for a write is a `where` that is **present and wrong**, not one that is empty.
Task 21's `clearDefault` finding is exactly that and still stands: dropping its `userId` leaves
`{ isDefault, deletedAt }`, which is non-empty and demotes every customer. When you mutate a scoped write,
replace the owner clause with another plausible predicate rather than emptying it — emptying it produces a
500 that any test will notice, which makes the mutation look killed while the reachable bug goes
unexercised.

## A unique index refuses *two*, never *zero* — so a scoped `UPDATE` still needs its owner clause

Task 21's mutation testing found a cross-tenant corruption that **91 unit and 34 integration cases all
missed**, and the shape generalises to every clear-then-set write in this codebase.

`clearDefault` is `UPDATE addresses SET "isDefault" = false` over a `where`. Drop the `userId` from that
`where` and it demotes **every customer in the database**. Nothing objects, for two compounding reasons:

- `uq_addresses_one_default_per_user` is `UNIQUE (user_id) WHERE isDefault = true AND deletedAt IS NULL`.
  It refuses a *second* live default. Leaving **zero** violates nothing.
- The victim's book is never read under their own id during the offending request, so the
  promote-a-replacement step never runs for them either. They simply lose their default, silently, and
  find out at their next checkout.

**The lesson is not "remember the owner clause".** It is that a unique index feels like protection and
guards only the direction it was written for, so a write that *removes* a property is unprotected by the
index that constrains *having* it. Mutate the `where` of every scoped `UPDATE`, not only the `where` of
every scoped `SELECT` — the reads in this milestone were all covered and this write was not.

**And a transaction does not enforce "exactly one default" either.** Two concurrent creates on an empty
book each count zero, each decide to promote themselves, and the second dies on the index — a **500 on an
ordinary double-click of Add Address**. The plan asserted the transaction was sufficient; it is not. Task
21 added a per-customer mutex, `SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE`, taken at the top of
every write. Two details worth keeping:

- **`FOR NO KEY UPDATE`, not `FOR UPDATE`.** It conflicts with itself, which is all that is wanted, while
  `FOR UPDATE` also conflicts with the `FOR KEY SHARE` that *any* insert referencing that user takes — so
  it would queue an address save in front of that customer's checkout.
- **Lock the `users` row, not the addresses.** On an empty book there is no address row to lock, which is
  precisely the case that collides.

## An integration assertion can be a coin toss, and a green run is not proof it is not

Task 20 found a **pre-existing** one in `checkout.integration.spec.ts` and measured it: *"writes one
snapshotted line per cart line…"* compared `order.items` against a literal in cart order, while
`ITEMS_IN_ORDER` sorts by a v4 uuid that **every seed run re-randomises**. Three failures in four runs
before the fix, none in four after.

Two things follow, and the second is uncomfortable.

**Sort before comparing whenever the query's order is a uuid.** The fix is one `localeCompare` on `slug`,
and `orders.integration.spec.ts` had already done it for the same reason — that file was written *after*
the flaky one, so the lesson existed and had not travelled backwards.

**Milestone 5's verification signed off on a green integration run it got by luck.** I ran the full suite
during Task 14 and recorded 230/230, with a one-in-four assertion in it. That is worth stating plainly
rather than quietly fixing: a single green run of a suite you have not mutated is weak evidence, and the
two "unreproducible flakes" reported by Tasks 17 and 18 should have been chased rather than noted. If a
suite fails once and passes on re-run, the honest reading is that something in it is non-deterministic
until proven otherwise.

## An empty `UPDATE … SET {}` is not an error, because `updatedAt` is always in the statement

Recorded because two tasks reasoned from the opposite belief and one of them shipped a docblock saying so.

`BaseEntity` carries `@UpdateDateColumn({ type: 'timestamptz' }) updatedAt` (`base.entity.ts:20-21`), and
TypeORM puts an update-date column into **every** update expression. So `update({ id }, {})` is valid SQL,
succeeds, and bumps the timestamp — it is not a syntax error and it does not raise
`UpdateValuesMissingError`.

The consequence for testing is the sharp part. An empty-patch guard is still worth having — it stops an
audit trail claiming an edit that never happened — but **its absence is invisible unless a test compares
`updatedAt`**. Task 22 measured this: deleting the guard survived all 26 of its integration cases until
`updatedAt` was added to the row comparison. `Address` extends `BaseEntity` too, so
`AddressesService.update`'s guard has the same correct behaviour and the same wrong justification in its
docblock.

## Three things that look like defects and are not — audited, so nobody spends the time twice

Both were checked while auditing committed Milestone 5 code, and both are the kind of thing a careful
reader stops on.

**`repository.update(...).affected` is trustworthy; `manager.query('UPDATE …')` is not.** These are the
same SQL operation down two different code paths, and only one carries the trap in the preamble's
raw-`UPDATE` section. The driver sets `result.affected = raw.rowCount` before the `switch (raw.command)`
that mangles `result.raw`, so TypeORM's own abstraction reads the count correctly while a raw query hands
you `[rows, rowCount]`. Do not "fix" an `.affected` check by rewriting it as a raw query.

**The decrement and the restock filter their lines differently, and that is correct.**
`CheckoutService.decrementStock` keeps lines where `variantId !== null` **and** `mode !== BULK`
(`checkout.service.ts:502`); `OrderStatusService.applyStockConsequence` keeps lines where
`variantId !== null` alone. Read side by side that looks like a cancellation crediting stock a placement
never debited — which would inflate `onHand` and break the `SUM(delta) = onHand` invariant this milestone
spends three tasks protecting. It does not, because **a bulk line has no `variantId` to begin with**:
`cart.service.ts:257` says *"a retail line names a pack size; a bulk line names a weight and is not
variant-bound"*, and `variantId: variant?.id ?? null` leaves it null for every bulk line, which
`toOrderItem` then copies through. So the single filter already excludes them.

The two clauses in the decrement are **not** interchangeable, though, so do not tidy either away:
dropping `mode !== BULK` changes nothing today, but dropping `variantId !== null` would pass `null` to
`sell()` for a retail line whose variant was later deleted (`SET NULL`), where the conditional `UPDATE`
matches no row and the caller reports `OUT_OF_STOCK` — a placement refused for an order that is fine.

**`In([])` matches nothing; `where: []` matches everything.** They look alike and behave oppositely.
`cart-read.service.ts:338` documents the second — an empty OR-array is no condition at all, so
`find({ where: [] })` returns the whole table — and it would be reasonable to assume the first is equally
dangerous. It is not: TypeORM compiles an empty `In` to the literal `0=1`
(`query-builder/QueryBuilder.js:755-758`). So `PincodeService.resolve('')` builds no candidates, matches no
rows and returns its `NO_MATCH` refusal, which is the honest answer. Guarded by DTO validation anyway,
but not *only* by it.

## Writing a concurrency proof that contends on the thing you meant

Three tasks in this plan race two placements, and every one of them has hit the same trap: **the
placements serialise on something other than the mechanism under test, and the proof passes for the wrong
reason.** The measurements, so you inherit them rather than repeat them:

- **Two baskets on the same inventory variant serialise on that row.** Task 8 measured the coupon
  no-`FOR UPDATE` mutant *surviving* **3/3** written that way: the loser's redemption count runs after the
  winner has committed, so it refuses correctly by accident. For a coupon proof the baskets must not
  contend on stock.
- **But a signed-in customer cannot hold two different baskets.** `CartService.find` keys on `userId`
  (`cart.service.ts:98`), so one customer has exactly one cart and two of their concurrent placements
  necessarily read the *same* lines. "Use distinct variants" is therefore unavailable for any proof about
  one customer — which is every per-user rule.
- **The way out is a bulk-only basket.** `decrementStock` filters `mode !== BULK`
  (`checkout.service.ts:502`), so a basket of bulk lines touches **no** inventory row at all and the
  coupon row becomes the only thing either placement can queue on. Assert it rather than trusting it:
  Task 8's Proof F checks `countSaleRows() === 0`, which is what turns "no stock contention" from a claim
  into a measurement.
- **Assert *which statement* blocked, not merely that something did.** `waitForABlockedWriter`
  (`test/integration/helpers/locks.ts`) returns the blocked rows for exactly this. A proof that only sees
  a refusal cannot tell the coupon lock from the inventory lock, and the two are the difference between
  proving the mechanism and proving nothing.

## `workerThreads: true` did not close the uncountable-failure class — it closed one instance of it

**Read this before running any mutation against a module spec.** The bigint section below says
`workerThreads: true` "handles BigInt natively" and treats the problem as solved. That is true of BigInt
and false of the class. The mechanism is `structuredClone` in jest-worker's `reportSuccess`, and **any**
value in a failure payload that cannot be cloned loses the whole file's results the same way.

Measured, by reintroducing the exact wiring bug Task 9 fixed (narrowing `CartModule.exports` back to
`[CartService]`):

```
default workers:   Test Suites: 1 failed, 43 passed, 44 total
                   Tests:       567 passed, 567 total      <-- zero failures, and 569 became 567
                   } could not be cloned.

--runInBand:       Nest can't resolve dependencies of the CheckoutService (…, ?, …).
                   Please make sure that the argument CartReadService at index [2] is available…
```

So a real wiring regression reports **all green on the `Tests:` line**, with two tests quietly vanishing
and the actual message replaced by `} could not be cloned.` The cause is that Nest's
`UnknownDependenciesException` carries module classes and functions in its payload, and functions are not
structured-cloneable — exactly as `JSON.stringify` used to throw on a `BigInt`.

Two consequences:

- **Run mutation verification with `--runInBand`** for anything touching module wiring or DI. Grepping
  `Tests:` under the default runner will tell you a killed mutant survived.
- **`Test Suites:` is the line that stays honest.** If suites-failed is non-zero while tests-failed is
  zero, you are looking at a lost result set, not a pass. Both `checkout.module.spec.ts` and
  `orders.module.spec.ts` are affected today.

## Money is `bigint`, and a failing money assertion used to be invisible

`backend/jest.config.ts` sets `workerThreads: true`, and every task here that touches paise depends on
it. Jest's default child-process workers serialise a failure with `JSON.stringify`, which throws on a
`BigInt` — so `expect(1n).toBe(2n)` reported `Test suite failed to run: TypeError: Do not know how to
serialize a BigInt`, the failure **uncounted**, and the rest of that file's results lost with it.

Two remedies were tried and rejected: `BigInt.prototype.toJSON` in `setupFiles` cannot work, because it
patches the prototype inside jest's vm sandbox while `messageParent` serialises in the outer realm; and
wrapping assertions in `String()` is insufficient, because one raw bigint anywhere in a file destroys
that file's whole result set. `workerThreads` uses `structuredClone`, which handles BigInt natively.

**If you ever see that serialisation error, something has reverted that config.** Say so rather than
stringifying your expectations around it.

## The money arithmetic already exists — do not write it again

`shared/src/money.ts` exports `toPaise`, `toRupees`, `gstOn`, `sumPaise`, **`applyPercent(amount,
percent, maxPaise?)`** and **`applyFlat(amount, flat)`**, under 61 passing tests
including *"never discounts more than the amount itself"* and *"clamps to the amount so a total can never
go negative"*.

**`clampDiscount` is *not* exported** — an earlier version of this section said it was. It is a private
helper at `money.ts:86`, and `applyFlat(subtotal, discount)` is exactly `clampDiscount(discount,
subtotal)`, so reach for `applyFlat`: the clamp is still `shared`'s arithmetic rather than a local copy.

Measured before Task 4: `applyPercent` and `applyFlat` were imported by **nothing** — only `money.ts` and
`money.test.ts` mentioned them. So a task that describes discount arithmetic reads as new work and invites
a second copy of the rules, against a `bigint` total with no check constraint to catch a negative. Use
them. The same applies to `gstOn`, which is what makes per-line GST per §8 a call rather than a formula.

## There is no MSW. There is exactly one `globalThis.fetch` stub, and every new seam registers with it

Every task in this plan that points a frontend seam at the server needs this, and none of their Files
lists mention it. Verified end to end:

- `globalThis.fetch` is assigned in **one** place, `frontend/src/test/auth-api.stub.ts:126`, by
  `installAuthStub`. Its own comment says why nothing may layer a second one on top: *"there is a single
  `globalThis.fetch`, so layering a second stub on top of this one would make the tests depend on
  installation order."*
- `PREFIX` is **`/api/v1/auth`** (`:35`), not `/api/v1`. Only auth paths are handled inline. Everything
  else falls into the `!url.startsWith(PREFIX)` branch and is offered to delegated handlers in turn —
  `handleCatalogRequest`, `handleCartRequest`, `handleWishlistRequest`.
- The shape to copy is `handleCartRequest` (`cart-api.stub.ts:219`):

  ```ts
  export function handleCartRequest(url: string, method: string, init?: RequestInit): Response | undefined {
    const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
    const [path] = rest.split("?");
    if (path !== "/cart") return undefined;   // decline, so the next handler gets a turn
    ...
  }
  ```

  Returning `undefined` is how a handler declines. **An unmatched request rejects loudly** — *"api stub
  received an unexpected request: POST /api/v1/checkout/orders"* — rather than hanging, so a forgotten
  handler is an immediate, readable failure and not a timeout. That is the error you should expect first.

So: **add `frontend/src/test/checkout-api.stub.ts` exporting `handleCheckoutRequest`, and delegate to it
from `auth-api.stub.ts` alongside the other three.** Do not install a second stub, and do not reach for
MSW — it is not a dependency of this project.

**One fidelity gap to know about, because a green smoke test will not tell you.** The dispatcher's CSRF
check lives *inside* the `PREFIX` branch, so it applies to auth routes only; the cart, catalogue and
wishlist handlers run **before** it and `cart-api.stub.ts` does not check CSRF itself. A `POST` that omits
`X-CSRF-Token` therefore succeeds against the stub and would be a **403** against the real server. For
checkout that matters more than it did for the cart, because placement is the request you least want to
discover is malformed in production. Two consequences: mirror the CSRF check inside
`handleCheckoutRequest` if you want the suite to catch it, and either way treat **Task 10's integration
tests as the real proof** that placement carries the header — a passing frontend suite is evidence about
the component, not about the wire.

## The seven disagreements this plan has to settle

These were found by inventory, not by reasoning, and each one is a decision the plan makes explicitly rather than leaving to whoever gets there first. **Read this section before starting any task.** Most of the "surprising" test failures in this milestone come from here.

### 1. Pincode serviceability says three different things

| Source | Says |
| --- | --- |
| `features/checkout/api/index.ts:42` | `/^[2-8]\d{5}$/` — prefix `1` is **not** serviceable |
| `routes.smoke.test.tsx:272-274` | pins Delhi `110001` as *"We don't deliver here yet."* |
| `pincodes.seed.ts:13` | prefix `'1'` **is** serviceable, `etaDays 4` — and `4` for *every* prefix, though `shippingPaise` is ₹79 only on the eight serviceable rows and **₹0** on `0` and `9` |
| `PINCODE_REGEX` | `/^\d{6}$/` — accepts `110001` at checkout |

The seeder's own docblock claims it reproduces Phase 1 "closely enough for the existing checker UI to keep behaving". It does not. **The database wins** — refusing to deliver to Delhi is not a behaviour worth preserving — and Task 12 updates that smoke test with the reason recorded. Whoever writes it must change the assertion, not the seed.

**The assertion that proves the database is in charge is `110001` *delivering*, not some other pincode
being refused — and the obvious reading of this table gets that backwards.** Worked through: the mock
regex `/^[2-8]\d{5}$/` refuses prefixes `0`, `1` and `9`; the seeded table refuses only `0` and `9`. So
every pincode the *table* refuses was already refused by the *mock*, and moving the refusal assertion to
another unserviceable pincode produces a test that **passes identically with the seam reverted to the
deleted mock**. The set of "refused by the table but not by the mock" is empty. Prefix `1` is the only
discriminator, in the other direction: the mock refused Delhi and the table serves it. Pin that, and pin
the request itself the way `cart-api.stub.ts` exposes `lastCartWrite()` — a recorded outgoing call is what
distinguishes a live seam from a mock that happens to agree.

**The ETA half of that test survives the switch, and it is worth knowing why before you touch it.** The
560001 assertion at `:269` reads `/Delivers to 560001 in \d working days\./` — a **single** `\d`. Every
seeded row carries `etaDays: 4` (`ETA_DAYS`, one constant for all ten prefixes), so it keeps matching; but
it is one admin edit to 10 days away from failing on a regex that has nothing to do with what it is
testing. Widen it to `\d+` while you are in there — **and know that widening it is not enough to make the ETA
observable.** Measured during Task 12: replacing `{data.etaDays}` with the literal `4` in
`PincodeChecker.tsx` failed **0 of 67** frontend cases, because every seeded prefix carries four days, so
neither `\d` nor `\d+` can tell a response apart from a constant. Closing that needs a fixture with a
*different* ETA — Task 12 added `seedPincodeRule` to the checkout stub for exactly this, so a case can
arrange a nine-day row and watch the number follow. This is the same shape as `CheckoutForm.tsx:620`'s
hardcoded four days, which is why that line is a real bug and not a harmless duplicate. Note also that the mock *derived* a per-pincode ETA
(`2 + digitsum % 5`, so 2–6 days) while the server has one flat number: any test that distinguished two
pincodes by their ETA is testing a mock behaviour that no longer exists.

### 2. The form defaults to a payment method the server must reject

`CheckoutForm.tsx:113` defaults `paymentMethod: "online"` and renders a "Pay Online" card. Meanwhile `settings.seed.ts:35` seeds `onlinePaymentEnabled: false`, spec §10.4 requires `POST /checkout/orders` to reject `"online"` with **422 `PAYMENT_METHOD_UNAVAILABLE`**, and every seeded and mocked order is `cod`.

The choice is currently **discarded** — `onSubmit` never sends it. So today the default is harmless and tomorrow it is a 422 on the happy path. Task 13 makes `cod` the default, gates the online card on the `onlinePaymentEnabled` setting, and sends the field.

### 3. Four unrelated ETAs

`checkPincode` returns `2 + digitSum % 5` days; `placeOrder` hardcodes `+4 days`; `ServiceablePincode.etaDays` is seeded `4`; and the Shipping section renders its own `addDays(new Date(), 4)`. **The pincode row is the only one with a claim to authority**, because it is per-destination and admin-editable. `Order.estimatedDelivery` is computed from it at placement and returned; the three client-side computations go.

### 4. Four sources for a ₹79 shipping charge

`cart-math.ts:5` and `PincodeChecker.tsx:11` each hold `SHIPPING_FLAT = 79`; `flatShippingRate: 79` is a `Setting`; and `ServiceablePincode.shippingPaise` is seeded per prefix and **read by nothing**.

This plan does **not** unify all four — that is Milestone 8's. It does settle which one the *order* uses: the pincode row, falling back to the setting when no prefix matches, because a per-destination charge that nothing reads is worse than no per-destination charge at all. Recorded in Task 6.

### 5. GST rounding differs between the mock and the server — but **not on this fixture**, measured

**Settled by Task 18, and the answer is that no frontend figure moves.** This disagreement was written on
the assumption that switching the account seam to the server would shift the pinned totals by about a
rupee. Measured against all six seeded orders, it shifts nothing:

| Order | subtotal | per-line GST (server) | aggregate GST (mock rule) | |
| --- | --- | --- | --- | --- |
| 005107 | ₹1,406 | ₹70.30 | ₹70.30 | agree |
| 005042 | ₹38,640 | ₹1,932.00 | ₹1,932.00 | agree |
| 004977 | ₹659 | ₹32.95 | ₹32.95 | agree |
| 004821 | ₹2,197 | ₹109.85 | ₹109.85 | agree |
| 004650 | ₹978 | ₹48.90 | ₹48.90 | agree |
| 004488 | ₹35,025 | ₹1,751.25 | ₹1,751.25 | agree |

**Two independent reasons, both properties of the fixture rather than luck.** Every seeded line total is a
whole number of rupees, and 5% of a whole rupee is exact to the paise — five paise per rupee — so **no
line rounds at all** and per-line-then-sum equals tax-the-aggregate on every one of the six. Then
`lib/format.ts`'s `inr()` is `Math.round(n)`, so the server's ₹77,348.25 and the mock's ₹77,348 render as
the identical string.

So the divergence §8 exists to prevent is real — `cart-pricing.service.spec.ts` demonstrates it with three
₹33.33 lines, where per-line gives ₹5.01 and the aggregate ₹5.00 — but **the seeded orders do not exhibit
it**, and an implementer told to "move the figures" would have edited two correct assertions into wrong
ones. The genuine difference between mock and server here is rupee rounding versus paise, which `inr()`
then hides.

**Corrections to what this section used to claim.** The `₹424` total is **asserted**, not merely described
in a comment. And the receipt figures `₹329 / ₹16 / ₹79 / ₹424` are not seeded values at all: they come
from `fromReceipt` over a hand-written `nn.order.NN-2026-777777` payload, so no server row produces them —
Task 19 deletes the receipt, the reconstruction and that case together. The figures do not move; the case
does.

**Line citations in this plan decay.** Every number this section carried was correct when verified and is
now stale, because Task 13 added roughly 460 lines to `routes.smoke.test.tsx`: the spend assertion moved
from `:1476` to `:1932`, its docblock from `:1255` to `:1711`, the receipt figures from `:1511` to
`:1968-1970`. Search for the string, not the line.

`mocks/orders.ts:46-53` rounds a single aggregate (`Math.round(subtotal * 0.05)`). `orders.seed.ts:319-330` and `cart-pricing.service.ts:66-68` compute **per line and sum**. The seeder's own comment acknowledges the divergence.

Two live assertions are pinned to the mock's arithmetic: the business dashboard's `₹77,348` (`routes.smoke.test.tsx:1468`) and the receipt reconstruction's `₹16`/`₹424` (`:1508-1511`). **Switching the account API to the backend will move both by a rupee.** That is the correct direction — an invoice whose tax does not equal the sum of its lines' tax cannot be reconciled — so Task 18 recomputes the expected figures from the seeded orders and records the old and new values side by side. Do not "fix" the server to match the mock.

### 6. The receipt's item shape has no `slug`, so a fresh order's items do not link

`checkout/api`'s local `OrderItem` is `{ name, detail, qty, total }`. `shared`'s `OrderLine` additionally has an optional `slug`, and `account/orders/$id.tsx`'s `LineName` links to the product **only when `slug` is present**. A just-placed order therefore renders unlinked names while a seeded one links. `OrderItem` the entity **does** carry `productSlug`, so this disappears the moment the endpoint is real. No task needed; it is listed so nobody mistakes it for a regression they caused.

### 7. `fromReceipt` invents a contradictory timeline, and one test pins it

`account/api/index.ts` reconstructs an order from the sessionStorage receipt — every line verified where
this says it is: `Math.round(subtotal * 0.05)` at `:25`, `status: "confirmed"` at `:34`, the
`"Payment received."` note at `:39`, `paymentStatus: "pending"` at `:50`, and the test pinning it at
`routes.smoke.test.tsx:1483`. With `gst = Math.round(subtotal * 0.05)`, `shipping = amount - subtotal - gst` ("the residue is what shipping cost"), a hardcoded `status: "confirmed"`, `paymentStatus: "pending"`, and a two-event synthetic timeline whose `confirmed` event carries the note **"Payment received."** — on a COD order that has been paid for by nobody.

`routes.smoke.test.tsx:1480` hand-writes an `nn.order.NN-2026-777777` payload and pins that reconstruction exactly. **The whole function goes** in Task 19, along with the receipt, the `sessionStorage` key, and that test — replaced by a case that places an order through the real endpoint and opens it from `/account/orders/:orderNumber`. The receipt exists only because there was no server; there is now.

---

## File structure

### `backend/` — four new modules

| File | Responsibility |
| --- | --- |
| `backend/src/common/http/idempotency.interceptor.ts` | **New.** Replays a stored response for a repeated `Idempotency-Key` in the same scope; 409 when the same key arrives with a different body. Uses the existing `idempotency_keys` table, which nothing references today. |
| `backend/src/common/http/idempotency.interceptor.spec.ts` | Its unit spec. |
| `backend/src/modules/orders/order-number.ts` | `NN-{year}-{6 digits}`, allocated from Postgres so two concurrent placements cannot collide. Pure module so the format is testable without a database. |
| `backend/src/modules/orders/order-status.service.ts` | The **only** server-side consumer of `@nutwala/shared`'s transition map. Validates a transition, appends the `OrderEvent`, and drives the stock consequence (`CANCELLATION` / `RETURN`). An illegal transition is a 422. |
| `backend/src/modules/orders/orders.service.ts` | Reads: a customer's orders and one order by `orderNumber`, both IDOR-scoped. Cancel, which delegates the transition to `OrderStatusService`. |
| `backend/src/modules/orders/orders.controller.ts` | `GET /account/orders`, `GET /account/orders/:orderNumber`, `POST /account/orders/:orderNumber/cancel`. |
| `backend/src/modules/orders/mappers/order.mapper.ts` | Entity → wire `AccountOrder`. Paise → rupees, and `UPPERCASE` enums lowered for **`channel` and `paymentMethod`/`paymentStatus` only** — `orders.status` is already stored lowercase-hyphen. Measured: the six seeded orders hold `out-for-delivery`, `cancelled`, `delivered`, `refunded`, `shipped` against `RETAIL`/`BULK`, `COD`, `PENDING`/`COLLECTED`/`REFUNDED`. Getting that backwards ships `RETAIL` where a status belongs, which every `status.ts` lookup then misses, rendering an empty badge rather than an error. `OrderEvent[]` oldest-first. |
| `backend/src/modules/orders/orders.module.ts` | Wires the above; exports `OrderStatusService` so the admin plan can use it. |
| `backend/src/modules/checkout/checkout.service.ts` | Placement: one transaction, race-safe decrement in ascending `variantId`, `SALE` ledger rows, coupon redemption under `FOR UPDATE`, `Payment` opened `PENDING`, first `OrderEvent`. |
| `backend/src/modules/checkout/coupon.service.ts` | Preview and redemption of a `Coupon`, including every eligibility rule the entity's columns imply. |
| `backend/src/modules/checkout/pincode.service.ts` | Longest-prefix match over `ServiceablePincode`; the single source of ETA and per-destination shipping. |
| `backend/src/modules/checkout/checkout.controller.ts` | `POST /checkout/coupon/preview`, `POST /checkout/orders`. |
| `backend/src/modules/checkout/dto/place-order.dto.ts` | The address block, `paymentMethod`, `couponCode`, and the B2B fields. |
| `backend/src/modules/checkout/checkout.module.ts` | |
| `backend/src/modules/addresses/*` | `GET`/`POST`/`PATCH`/`DELETE /account/addresses`, `POST /account/addresses/:id/default`. Soft-delete via `deletedAt`; exactly one default enforced by `uq_addresses_one_default_per_user`. |
| `backend/src/modules/profile/*` | `GET`/`PATCH /account/profile`. Small, but it is the one place a customer edits their own `User` row, so it is separate from `AuthModule` rather than bolted to it. |

### `frontend/` — four seams swapped, no new screens

| File | Change |
| --- | --- |
| `frontend/src/features/checkout/api/index.ts` | **Rewrite** over `http`. `placeOrder` posts the basket and returns the created order; `checkPincode` calls the server. `saveOrder`/`getOrder` and the `sessionStorage` receipt are **deleted**. |
| `frontend/src/features/checkout/components/CheckoutForm.tsx` | **Modify.** `cod` default, the online card gated on a setting, an `Idempotency-Key` per attempt, a real coupon Apply, and every validated field actually sent. |
| `frontend/src/routes/order-success.$id.tsx` | **Modify.** Reads `GET /account/orders/:orderNumber` instead of a receipt, so the confirmation survives a reload and a different device. Stops rendering a confirmation for an id it has never heard of. |
| `frontend/src/features/account/api/index.ts` | **Rewrite** over `http`. `fromReceipt` and the `nn.addresses.v1` overlay are **deleted**. |
| `frontend/src/features/account/hooks/useAccount.ts` | **Modify.** Query keys and invalidation for the real endpoints. |
| `frontend/src/routes/account/addresses.tsx` | **Modify.** Server-allocated ids; drop `adr-${Date.now()}`. |
| `frontend/src/routes/account/profile.tsx` | **Modify.** Editable name and phone against `PATCH /account/profile`. |
| `frontend/src/features/account/components/OrderTimeline.tsx` | **Keep unchanged.** It already renders what the server will send. Listed so nobody rewrites it. |

### `shared/`

| File | Change |
| --- | --- |
| `shared/src/types/order.ts` | **Modify.** Add the placement request/response shapes and a coupon-preview result. `AccountOrder`, `OrderEvent` and `OrderLine` are already right and do not change. |

---

## Task list

Twenty-four tasks. **Milestone 5 is Tasks 1–14; Milestone 6 is Tasks 15–24.**

Milestone 5 builds placement and proves it under concurrency before any screen touches it. Milestone 6 swaps the account seams onto the orders the first milestone can now create.

| # | Task | Why it is where it is |
| --- | --- | --- |
| 1 | The `IdempotencyInterceptor` | Nothing else can be safely retried until this exists. |
| 2 | `order-number.ts` — allocation without collision | Placement needs it; testable alone. |
| 3 | `PincodeService` — longest-prefix match | Settles disagreements 1, 3 and 4 before anything reads a shipping figure. |
| 4 | `CouponService.preview` | Read-only, so it is provable before redemption exists. |
| 5 | `OrderStatusService` — transitions and their stock consequence | Placement's first event cannot go through it — nothing transitions *to* `pending`, so `transition()` has no `from` to validate — but placement's stock decrement shares its shape, so this comes first. |
| 6 | `CheckoutService.place` — the transaction | The heart of the milestone. |
| 7 | The race-safe decrement, proven concurrently | Its own task because a passing single-threaded test proves nothing. |
| 8 | Coupon redemption under `FOR UPDATE` | Same reason. |
| 9 | `POST /checkout/orders` and `POST /checkout/coupon/preview` | The HTTP surface, with the interceptor applied. |
| 10 | Checkout integration tests | Against real Postgres, including the two concurrency proofs at HTTP level. |
| 11 | `shared` placement types | Needed by both ends; small, and late so its shape is settled by what the service actually returns. |
| 12 | The pincode seam and its smoke test | Where disagreement 1 is resolved in the open. |
| 13 | `CheckoutForm` — send what it validates | Where disagreement 2 is resolved. |
| 14 | Milestone 5 verification | |
| 15 | `OrdersService` reads, IDOR-scoped | |
| 16 | `order.mapper.ts` — paise and status vocabularies | One mapper, because two would drift. |
| 17 | `GET /account/orders` and `:orderNumber` | |
| 18 | Order-read integration tests | Where disagreement 5's moved figures are recorded. |
| 19 | The account seam and the death of the receipt | Where disagreements 6 and 7 are resolved. |
| 20 | `POST /account/orders/:orderNumber/cancel` | Needs `OrderStatusService` and the read path both working. |
| 21 | The address book, server-side | |
| 22 | `GET`/`PATCH /account/profile` | |
| 23 | `order-success` reads the order, not a receipt | Last, because it depends on Task 17. |
| 24 | Milestone 6 verification | |

---

# MILESTONE 5 — Checkout and orders

Goal: a customer can place a COD order that survives a double-click, and stock and the ledger stay
correct when two of them race for the last bag.

Read spec §10.2, §10.3 and §10.4 before starting, and the "seven disagreements" section above.

## Task 1: The idempotency interceptor

Spec §10.4 says order placement is "wrapped in Gateway's `IdempotencyInterceptor` under a
`checkout:orders` scope keyed on an `Idempotency-Key` header the frontend generates per checkout
attempt." **That interceptor does not exist in this repository.** Verified:
`find backend/src -name '*idempot*'` returns exactly one file, the entity, and
`grep -rn IdempotencyKey backend/src backend/test` finds no consumer. `main.ts:59` already allows the
`Idempotency-Key` header through CORS, so the client half was anticipated and the server half was not.

Building it first is deliberate: every later task in this milestone is a write that must be safe to
retry, and retro-fitting replay semantics to a transaction that already ships is far harder than
starting with them.

**A trap in the table, found by reading it.** The entity's docblock says `scope` *"namespaces the key,
e.g. `checkout:orders`, so two features cannot collide"* — but `key` alone is the `@PrimaryColumn`, and
`scope` is an ordinary column. Nothing stops one client key existing once across both features. The
claim is only true if the **stored** key carries the scope, so this interceptor stores
`` `${scope}:${clientKey}` `` and never the bare header value. Changing the primary key instead would
mean a migration for a table nothing has written to yet — legitimate, but the prefix achieves the
docblock's promise without one, and the docblock is what a future reader will trust.

**Files:**
- Create: `backend/src/common/http/idempotency.interceptor.ts`
- Create: `backend/src/common/http/idempotency.interceptor.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/common/http/idempotency.interceptor.spec.ts
import { CallHandler, ConflictException, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { IdempotencyInterceptor, IDEMPOTENCY_HEADER } from './idempotency.interceptor';

interface Row {
  key: string;
  scope: string;
  requestHash: string;
  responseBody: Record<string, unknown> | null;
  statusCode: number | null;
}

/**
 * An in-memory stand-in for `idempotency_keys` that enforces the one property the interceptor leans
 * on: the primary key is unique, so a second insert of the same key **throws** rather than
 * overwriting. A double that silently accepted it would make every test here pass while the real
 * table rejected the second claim — the failure this whole file exists to prevent.
 */
function fakeStore() {
  const rows = new Map<string, Row>();
  return {
    rows,
    insert: jest.fn((row: Row) => {
      if (rows.has(row.key)) {
        return Promise.reject(
          Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          }),
        );
      }
      rows.set(row.key, { ...row });
      return Promise.resolve({ identifiers: [{ key: row.key }] });
    }),
    findOne: jest.fn(({ where }: { where: { key: string } }) =>
      Promise.resolve(rows.get(where.key) ?? null),
    ),
    update: jest.fn((criteria: { key: string }, patch: Partial<Row>) => {
      const existing = rows.get(criteria.key);
      if (existing) rows.set(criteria.key, { ...existing, ...patch });
      return Promise.resolve({ affected: existing ? 1 : 0 });
    }),
    // Required, and an earlier version of this fake omitted it while the implementation's `error:`
    // branch called it — so the one test covering release could not observe release at all.
    delete: jest.fn((criteria: { key: string }) => {
      const existed = rows.delete(criteria.key);
      return Promise.resolve({ affected: existed ? 1 : 0 });
    }),
  };
}

function contextFor(header: string | undefined, body: unknown) {
  const request = { headers: header ? { [IDEMPOTENCY_HEADER]: header } : {}, body };
  const response = { statusCode: 201 };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const handlerReturning = (value: unknown): CallHandler => ({
  handle: jest.fn(() => of(value)),
});

describe('IdempotencyInterceptor', () => {
  /**
   * No header is not an error. Placement is the only route that will carry one at first, and a route
   * that silently required it would fail every existing client and every integration test written
   * before this task.
   */
  it('passes a request with no key straight through', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const handler = handlerReturning({ orderNumber: 'NN-2026-000001' });

    const result = await interceptor.intercept(contextFor(undefined, { a: 1 }), handler).toPromise();

    expect(result).toEqual({ orderNumber: 'NN-2026-000001' });
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('runs the handler once and stores its response', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');

    await interceptor
      .intercept(contextFor('abc', { lines: [] }), handlerReturning({ orderNumber: 'NN-1' }))
      .toPromise();

    // Stored under the *scoped* key, not the bare header. `key` is the table's primary key and
    // `scope` is an ordinary column, so the bare value would let two features collide — which the
    // entity's own docblock promises cannot happen.
    expect([...store.rows.keys()]).toEqual(['checkout:orders:abc']);
    expect(store.rows.get('checkout:orders:abc')).toMatchObject({
      scope: 'checkout:orders',
      responseBody: { orderNumber: 'NN-1' },
      statusCode: 201,
    });
  });

  /**
   * The point of the whole task: a replayed key answers with the stored response and **does not run
   * the handler**. If the handler runs, stock is decremented twice.
   */
  it('replays the stored response without running the handler again', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const body = { lines: [{ slug: 'almonds', qty: 1 }] };

    const first = handlerReturning({ orderNumber: 'NN-1' });
    await interceptor.intercept(contextFor('abc', body), first).toPromise();

    const second = handlerReturning({ orderNumber: 'NN-2' });
    const replayed = await interceptor.intercept(contextFor('abc', body), second).toPromise();

    expect(replayed).toEqual({ orderNumber: 'NN-1' });
    expect(second.handle).not.toHaveBeenCalled();
  });

  /**
   * The same key with a *different* body is a client bug, not a retry. Answering it with the first
   * response would tell a customer their second, different basket had been ordered.
   */
  it('refuses the same key carrying a different body', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');

    await interceptor
      .intercept(contextFor('abc', { lines: [{ qty: 1 }] }), handlerReturning({ orderNumber: 'NN-1' }))
      .toPromise();

    await expect(
      interceptor
        .intercept(contextFor('abc', { lines: [{ qty: 2 }] }), handlerReturning({ orderNumber: 'NN-2' }))
        .toPromise(),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /**
   * Two concurrent requests with one key. The loser must not run the handler — this is the
   * double-click case, and it is the reason the row is claimed **before** the handler runs rather
   * than written after it. A design that inserted afterwards would let both execute.
   */
  it('refuses a second request that arrives while the first is still running', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const body = { lines: [] };

    // The first claim succeeds but has not yet written a response — exactly the in-flight state.
    await store.insert({
      key: 'checkout:orders:abc',
      scope: 'checkout:orders',
      requestHash: interceptor.hashOf(body),
      responseBody: null,
      statusCode: null,
    });

    const handler = handlerReturning({ orderNumber: 'NN-2' });
    await expect(interceptor.intercept(contextFor('abc', body), handler).toPromise()).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(handler.handle).not.toHaveBeenCalled();
  });

  /**
   * A handler that throws must leave no claim behind, or the customer's retry is refused for ever
   * with a key they cannot reuse and a response that was never stored.
   */
  it('releases the key when the handler fails', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const failing: CallHandler = {
      handle: jest.fn(() => {
        throw new Error('out of stock');
      }),
    };

    await expect(interceptor.intercept(contextFor('abc', {}), failing).toPromise()).rejects.toThrow(
      'out of stock',
    );
    expect(store.rows.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w backend -- idempotency`
Expected: FAIL — `Cannot find module './idempotency.interceptor'`.

- [ ] **Step 3: Implement**

```ts
// backend/src/common/http/idempotency.interceptor.ts
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { defer, from, Observable, of, switchMap, tap } from 'rxjs';
import type { Repository } from 'typeorm';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';

/** Lower-case, because Node normalises incoming header names and `request.headers` is keyed that way. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Postgres unique-violation SQLSTATE. The only error this interceptor treats as "someone beat me". */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly keys: Repository<IdempotencyKey>,
    private readonly scope: string,
  ) {}

  /**
   * The request body, hashed, so a replay can be checked against what was originally sent.
   *
   * `JSON.stringify` is stable enough here because the body has already been through
   * `ValidationPipe` with `whitelist: true`, which rebuilds it from the DTO's declared properties in
   * declaration order — so two identical requests produce identical strings. It is **not** stable for
   * an arbitrary object, which is why this is a method on the interceptor rather than a general helper
   * someone might reuse.
   */
  hashOf(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const clientKey = request.headers[IDEMPOTENCY_HEADER];

    // Absent header means "not a retryable attempt", which is the ordinary case for every route that
    // is not placement. Requiring it would break every existing client.
    if (typeof clientKey !== 'string' || clientKey.length === 0) return next.handle();

    // Scoped, because `key` is this table's primary key and `scope` is only a column — see the
    // task note. The bare header value would let two features share a namespace.
    const key = `${this.scope}:${clientKey}`;
    const requestHash = this.hashOf(request.body);

    return from(this.claim(key, requestHash)).pipe(
      switchMap((replay) => {
        if (replay) return of(replay);

        // `defer`, not a bare `next.handle()`. A handler that throws **synchronously** throws before
        // `.pipe()` is ever reached, so the `error:` callback below is never attached and the claim is
        // never released — measured: the release test failed `Expected: 0, Received: 1`, and notably
        // *not* with a `TypeError`, which proves the branch never ran rather than ran and failed.
        // `defer` moves the call inside the subscription, so a synchronous throw becomes an error
        // notification these operators can see.
        return defer(() => next.handle()).pipe(
          tap({
            next: (body: unknown) => {
              const statusCode = context.switchToHttp().getResponse<Response>().statusCode;
              void this.keys.update(
                { key },
                { responseBody: body as Record<string, unknown>, statusCode },
              );
            },
            // A failed attempt must leave no claim, or the customer's retry meets their own key and
            // is refused for ever against a response that was never written.
            error: () => void this.keys.delete({ key }),
          }),
        );
      }),
    );
  }

  /**
   * Claims the key, or returns the response to replay.
   *
   * The insert comes **first**, and that ordering is the whole mechanism: two concurrent requests
   * both reach here, exactly one insert survives the primary key, and the loser is told so. Writing
   * the row after the handler instead would let both run and place two orders — which is precisely
   * the double-click this exists to stop.
   */
  private async claim(key: string, requestHash: string): Promise<unknown | null> {
    try {
      await this.keys.insert({ key, scope: this.scope, requestHash, responseBody: null, statusCode: null });
      return null;
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    }

    const existing = await this.keys.findOne({ where: { key } });
    if (!existing) throw new ConflictException('Duplicate request could not be resolved.');

    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different request body.',
      );
    }

    // Claimed but unanswered: the first attempt is still in flight. Refusing is the honest answer —
    // the alternative is waiting on a transaction whose duration we do not control.
    if (existing.responseBody === null) {
      throw new ConflictException('An identical request is already in progress.');
    }

    return existing.responseBody;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test -w backend -- idempotency`
Expected: PASS — 7 tests.

**Three things in the code above that do not survive contact with the toolchain**, all measured:

1. **The `update()` call does not compile as written.** `TS2322`: `Record<string, unknown>` is not
   assignable to `_QueryDeepPartialEntity<Record<string, unknown> | null>`, because that type maps a
   jsonb column's values into a deep partial whose values must extend `{}`, and `unknown` does not.
   Assert to `QueryDeepPartialEntity<IdempotencyKey>` — a real public TypeORM export — and say in a
   comment whose type problem it is.
2. **Five lint errors under `npm run lint -w backend`**, all from the code above: four
   `@typescript-eslint/unbound-method` on `expect(handler.handle)` because annotating
   `handlerReturning` as `: CallHandler` makes `handle` an interface *method*, and one
   `no-redundant-type-constituents` on `Promise<unknown | null>`. Leave `handlerReturning`'s return type
   inferred — still structurally assignable — and use `Promise<unknown>` with the `null` sentinel
   documented in the docblock rather than in the type.
3. **Neither block is Prettier-clean.** If other agents are working the same tree, run
   `npx prettier --write` on **your two paths only** rather than `npm run format -w backend`, which would
   rewrite their in-flight files.

- [ ] **Step 5: Prove each test can fail**

Six mutations, each applied to the implementation, run, then restored byte-identically:

| Mutation | Must fail |
| --- | --- |
| claim after the handler instead of before | *refuses a second request that arrives while the first is still running* |
| store under `clientKey` rather than the scoped key | *runs the handler once and stores its response* |
| skip the `requestHash` comparison | *refuses the same key carrying a different body* |
| return `null` instead of the stored body on replay | *replays the stored response* |
| drop the `error:` branch | *releases the key when the handler fails* |
| treat every insert error as a conflict, not just `23505` | **it survives the six tests above — measured — so add a seventh rather than deferring it.** An earlier version of this table said it would be "caught in Task 10 against real Postgres", which is optimistic: Task 10 catches it only if someone deliberately writes a case producing a non-`23505` insert failure, and nothing makes that automatic. One `mockRejectedValueOnce` proves it now. It matters because `key` is `varchar(200)` and the stored value is `` `${scope}:${clientKey}` ``, so an over-long client key genuinely raises SQLSTATE `22001` — and a blanket catch answers that with `409 "duplicate request"` for an order that never reached the handler, telling the customer to stop retrying something that never happened. |
| drop the absent-header passthrough | *passes a request with no key straight through* — added, because the six mutations above left that test with none of its own. |

- [ ] **Step 6: Commit**

```bash
git add backend/src/common/http/idempotency.interceptor.ts backend/src/common/http/idempotency.interceptor.spec.ts
git commit -F - <<'MSG'
feat(http): replay a repeated Idempotency-Key instead of placing a second order
MSG
```

---

## Task 2: Allocate an order number two placements cannot share

`Order.orderNumber` is `varchar(20)`, uniquely indexed as `uq_orders_order_number`, and its docblock
says `NN-{year}-{6 digits}` — *"the reference a customer quotes to support"*. The Phase 1 mock generated
it with `Math.floor(Math.random() * 900000) + 100000` (`features/checkout/api/index.ts:49`), which is a
collision waiting for the birthday paradox and has no server behind it at all.

**There is no sequence to draw from.** Measured: `SELECT sequence_name FROM information_schema.sequences`
returns only `migrations_id_seq`. So this task adds one, which is the one migration this plan needs.

**Start it at 100000, not at 1.** The seeder writes six orders occupying `004488` through `005107`
(measured). A sequence from 1 would issue `NN-2026-000001` happily and then collide on the 4,488th
order — a unique-violation in the middle of a placement transaction, years later, with nothing in the
code explaining why. Starting above the seeded range removes the interaction rather than documenting it.

**Files:**
- Create: `backend/src/database/migrations/20260821090000-OrderNumberSequence.ts`
- Create: `backend/src/modules/orders/order-number.ts`
- Create: `backend/src/modules/orders/order-number.spec.ts`

Migration ordering derives from the **last 13 characters of the class name** —
`MigrationExecutor.js:430` is `parseInt(migrationClassName.substr(-13), 10)`, confirmed in the installed
TypeORM. The four existing keys are `0260819120000`, `0260819130000`, `0260820090000`, `0260820100000`;
`OrderNumberSequence20260821090000` gives `0260821090000`, which sorts last. Verify that with
`npm run migration:show` rather than trusting this paragraph.

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/orders/order-number.spec.ts
import { formatOrderNumber, ORDER_NUMBER_PATTERN } from './order-number';

describe('formatOrderNumber', () => {
  it('pads to six digits behind the year', () => {
    expect(formatOrderNumber(2026, 100000)).toBe('NN-2026-100000');
    expect(formatOrderNumber(2026, 1)).toBe('NN-2026-000001');
  });

  /**
   * The column is `varchar(20)` and `NN-2026-1000000` is 15 characters, so a seventh digit fits.
   * Truncating to keep six would start re-issuing numbers that already exist — a unique violation on
   * the millionth order, which is a good problem to have and a terrible way to meet it.
   */
  it('grows past six digits rather than truncating', () => {
    expect(formatOrderNumber(2026, 1_000_000)).toBe('NN-2026-1000000');
    expect(formatOrderNumber(2026, 1_000_000).length).toBeLessThanOrEqual(20);
  });

  it('matches the pattern the frontend and support both key on', () => {
    expect(formatOrderNumber(2026, 100000)).toMatch(ORDER_NUMBER_PATTERN);
    expect(formatOrderNumber(2030, 999999)).toMatch(ORDER_NUMBER_PATTERN);
  });

  /**
   * Every seeded order must satisfy the same pattern, or a test that greps for it passes on generated
   * numbers and fails on the fixtures — which is how a format claim comes to be half true.
   */
  it('accepts the seeded numbers', () => {
    for (const seeded of [
      'NN-2026-004488',
      'NN-2026-004650',
      'NN-2026-004821',
      'NN-2026-004977',
      'NN-2026-005042',
      'NN-2026-005107',
    ]) {
      expect(seeded).toMatch(ORDER_NUMBER_PATTERN);
    }
  });

  it('rejects the shapes that are not order numbers', () => {
    for (const wrong of ['NN-2026-12345', 'nn-2026-100000', 'NN-26-100000', 'NN-2026_100000', '100000']) {
      expect(wrong).not.toMatch(ORDER_NUMBER_PATTERN);
    }
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- order-number`
Expected: FAIL — `Cannot find module './order-number'`.

```ts
// backend/src/modules/orders/order-number.ts
import type { EntityManager } from 'typeorm';

/**
 * `NN-{year}-{at least 6 digits}`.
 *
 * Anchored, and the digit run is `{6,}` rather than `{6}`: the millionth order legitimately carries
 * seven, and a pattern that refused it would make the format claim expire silently rather than the
 * number. `varchar(20)` has room for eleven.
 */
export const ORDER_NUMBER_PATTERN = /^NN-\d{4}-\d{6,}$/;

/** The sequence added by `20260821090000-OrderNumberSequence`. */
export const ORDER_NUMBER_SEQUENCE = 'order_number_seq';

export function formatOrderNumber(year: number, sequence: number): string {
  return `NN-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Allocates the next order number from Postgres.
 *
 * `nextval` rather than `max(orderNumber) + 1`, and the difference is the whole point: counting then
 * inserting is a read-then-write gap, so two placements racing would compute the same number and one
 * would die on `uq_orders_order_number` **after** its stock decrement had already run inside the same
 * transaction. `nextval` is atomic and, deliberately, is **not** rolled back by a failed transaction —
 * so a rejected placement burns a number rather than handing it to the next customer. A gap in the
 * sequence is invisible to everyone; a duplicate reference is not.
 *
 * Takes the transaction's `EntityManager` so the call joins the placement rather than opening a second
 * connection — which would work, but would make the burn-on-rollback behaviour depend on which
 * connection happened to serve it.
 */
export async function nextOrderNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    ORDER_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${ORDER_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatOrderNumber(now.getFullYear(), value);
}
```

```ts
// backend/src/database/migrations/20260821090000-OrderNumberSequence.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sequence order numbers are drawn from.
 *
 * `START 100000` clears the seeded fixtures, which occupy `004488`–`005107`. From 1 the sequence would
 * issue perfectly good numbers for 4,487 orders and then collide with `NN-2026-004488` inside a
 * placement transaction — the kind of defect that arrives long after everyone has forgotten the seeder
 * wrote fixed numbers.
 *
 * Not `CYCLE`: wrapping would re-issue a reference a customer has already quoted to support.
 */
export class OrderNumberSequence20260821090000 implements MigrationInterface {
  name = 'OrderNumberSequence20260821090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "order_number_seq" START 100000 INCREMENT 1 NO CYCLE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "order_number_seq"`);
  }
}
```

- [ ] **Step 3: Apply it, and prove the sequence does what the docblock claims**

```bash
cd /Users/kunal/Desktop/nutwala
npm run migration:run -w backend
docker exec nutwala-postgres psql -U nutwala -d nutwala -At -c \
  "SELECT last_value, is_called FROM order_number_seq;"
```

Then prove the two properties that matter, on a **throwaway** container — not the dev database:

1. **`nextval` is not rolled back.** `BEGIN; SELECT nextval('order_number_seq'); ROLLBACK;` then
   `SELECT nextval(...)` again — the second value must be *higher*, not the same. That is the behaviour
   the docblock leans on, and it is worth seeing once rather than believing.
2. **Two concurrent calls never agree.** Two sessions, each `SELECT nextval(...)`, values distinct.

Remember `NODE_ENV=test` and a **literal** port, and echo the resolved target before anything writes.

**The hazard is real but the path in earlier versions of this warning was wrong**: there is no root
`.env` — only `.env.example` at the root and the real file at `backend/.env`, which does define
`PORT=4400` and `DB_PORT=5442`. So `set -a && . ./backend/.env` is what exports them, and a
parameterised port has already pointed a migration at the user's node server once on this project.
Print the DataSource's host, port and database name before every write, and confirm `PORT` is
`undefined` — that is how you know `NODE_ENV=test` kept `.env` out.

- [ ] **Step 4: Run and commit**

Run: `npm run test -w backend -- order-number`
Expected: PASS — 8 tests, not the 5 an earlier version of this line predicted. Three gaps in the five
above, all measured:

1. **Nothing pins the `{6,}` decision this task spends a docblock defending.** Tightening the pattern to
   `/^NN-\d{4}-\d{6}$/` passes all five: the seven-digit test asserts the *string* and its length but
   never matches it against the pattern, and the pattern test uses only six-digit values. So the pattern
   could come to reject `NN-2026-1000000` — the exact value `formatOrderNumber` is documented to produce
   — with a green suite. One `toMatch` inside the existing `it` closes it.
2. **Nothing holds the pattern to being anchored**, though the docblock calls it that. Dropping both `^`
   and `$` passes all five, because none of the five rejected shapes contains a well-formed order number
   as a substring. Add `'XNN-2026-100000'` and `'NN-2026-100000X'` to that array.
3. **`nextOrderNumber` — the point of the task — has no test at all**, including an unreached
   `Number.isSafeInteger` guard. Add three, and drive it through the real driver once by hand:
   `SELECT nextval($1)` relies on Postgres inferring `$1` as `regclass` from a text parameter, which is a
   real failure mode and not something a repository double can show.

One honest limit on the third: `toHaveBeenCalledWith(..., [ORDER_NUMBER_SEQUENCE])` is self-referential —
both sides read the same constant, so it pins "the function passes the exported constant", not "the
constant is `order_number_seq`". Nothing automated checks that constant against the migration. The first
integration test that places a real order closes it.

```bash
git add backend/src/modules/orders/order-number.ts backend/src/modules/orders/order-number.spec.ts backend/src/database/migrations/20260821090000-OrderNumberSequence.ts
git commit -F - <<'MSG'
feat(orders): draw order numbers from a sequence rather than from Math.random
MSG
```

---

## Task 3: `PincodeService` — one answer about delivery

This settles disagreements 1, 3 and 4 in one place, before anything reads a shipping figure or an ETA.
Four numbers currently claim to be the ETA and four claim to be the shipping charge; after this task the
order reads exactly one of each.

`ServiceablePincode` is keyed on `pincode_prefix varchar(6)` with `isServiceable`, `etaDays` (default 4)
and `shippingPaise`. Its docblock says *"1 to 6 digits… Longest-prefix match wins"*, and `pincodes.seed.ts`
writes ten single-digit rows: `'1'`–`'8'` serviceable at 4 days and ₹79, `'0'` and `'9'` not.

**Files:**
- Create: `backend/src/modules/checkout/pincode.service.ts`
- Create: `backend/src/modules/checkout/pincode.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/checkout/pincode.service.spec.ts
import { PincodeService } from './pincode.service';

const rows = [
  { pincodePrefix: '1', isServiceable: true, etaDays: 4, shippingPaise: 7900n },
  { pincodePrefix: '110', isServiceable: true, etaDays: 2, shippingPaise: 4900n },
  { pincodePrefix: '110001', isServiceable: false, etaDays: 4, shippingPaise: 7900n },
  { pincodePrefix: '9', isServiceable: false, etaDays: 4, shippingPaise: 7900n },
];

/**
 * The double **must apply the `where`**. An earlier version of this file returned every fixture row
 * regardless, and that makes two of the three tests below fail against a correct implementation:
 * `resolve('110002')` receives all four rows and `reduce` picks `'110001'` — the longest row in the
 * fixture rather than the longest *matching* prefix. Measured, `isServiceable` came back `false` where
 * `true` was expected and `etaDays` 4 where 2 was expected.
 *
 * Follow `cart-read.service.spec.ts`'s `filteringHarness`: interpret the criterion, and **throw** on one
 * you do not recognise. That last part is what makes the `In`-versus-`Like` mutation fail here rather
 * than silently surviving.
 */
const service = () =>
  new PincodeService({
    find: jest.fn(({ where }: { where: { pincodePrefix: { _value?: string[] } } }) => {
      const candidates = where.pincodePrefix?._value;
      if (!Array.isArray(candidates)) throw new Error('harness: expected In(candidates) on pincodePrefix');
      return Promise.resolve(rows.filter((row) => candidates.includes(row.pincodePrefix)));
    }),
  } as never);

describe('PincodeService.resolve', () => {
  /**
   * Longest prefix wins, which is the entity's stated rule and the only one that lets an admin carve
   * an exception out of a region. `110001` is unserviceable *inside* a serviceable `110` inside a
   * serviceable `1` — three rows that all match, and the most specific has to be the answer.
   */
  it('prefers the most specific matching prefix', async () => {
    await expect(service().resolve('110001')).resolves.toMatchObject({ isServiceable: false });
    await expect(service().resolve('110002')).resolves.toMatchObject({
      isServiceable: true,
      etaDays: 2,
      shippingPaise: 4900n,
    });
    await expect(service().resolve('120002')).resolves.toMatchObject({ etaDays: 4, shippingPaise: 7900n });
  });

  /**
   * No matching row is **not serviceable**. Defaulting to deliverable would promise delivery to a
   * pincode nobody has said anything about, and the customer discovers it after paying.
   */
  it('treats an unknown pincode as not serviceable', async () => {
    await expect(service().resolve('555555')).resolves.toMatchObject({ isServiceable: false });
  });

  it('reports the seeded Delhi pincode as serviceable, which the Phase 1 mock did not', async () => {
    // Disagreement 1. `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/` refused prefix 1, and a smoke
    // test pinned that refusal. The seeded table says otherwise and the table is now the authority.
    const resolved = await service().resolve('110002');
    expect(resolved.isServiceable).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- pincode.service`
Expected: FAIL — `Cannot find module './pincode.service'`.

```ts
// backend/src/modules/checkout/pincode.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';

export interface PincodeVerdict {
  isServiceable: boolean;
  etaDays: number;
  shippingPaise: bigint;
  /** The row that answered, or null when nothing matched. Returned so a caller can log *why*. */
  matchedPrefix: string | null;
}

/**
 * Unserviceable, and cheap to state: an unknown pincode is a refusal rather than a default delivery.
 * The alternative promises a delivery nobody has planned, and the customer learns of it after paying.
 */
const NO_MATCH: PincodeVerdict = {
  isServiceable: false,
  etaDays: 0,
  shippingPaise: 0n,
  matchedPrefix: null,
};

@Injectable()
export class PincodeService {
  constructor(
    @InjectRepository(ServiceablePincode) private readonly pincodes: Repository<ServiceablePincode>,
  ) {}

  /**
   * The single source of both the ETA and the per-destination shipping charge.
   *
   * Four things currently claim to be the ETA — `checkPincode`'s digit-sum, `placeOrder`'s hardcoded
   * `+4 days`, this column, and a fourth `addDays(new Date(), 4)` rendered in the Shipping card — and
   * four claim to be the shipping charge. This row is the only one that is per-destination and
   * admin-editable, which is why it wins. Unifying the remaining copies is Milestone 8's.
   *
   * One query for every candidate prefix rather than six queries or a `LIKE`: a six-digit pincode has
   * exactly six possible prefixes, so `IN` fetches all of them and the longest is picked in memory.
   *
   * `LIKE` is wrong in the **opposite** direction to what an earlier version of this comment claimed. It
   * said `LIKE 'prefix%'` "would match longer rows too" — it cannot: the key is `varchar(6)` and the
   * pincode is six digits, so no longer row exists. What it actually does is **miss every shorter region
   * row**, which is the only kind the seeder writes. Measured against the real table:
   *
   *     IN ('1','11','110','1100','11000','110002')  -> matches '1'
   *     pincode_prefix LIKE '110002%'                -> matches nothing
   *
   * So with today's single-digit seed a `LIKE` returns zero rows and **every pincode becomes
   * unserviceable** — the whole shop stops delivering. The scan half of the claim is confirmed:
   * `EXPLAIN` gives `Seq Scan` for `LIKE` and a `Bitmap Index Scan` on the primary key for `IN`.
   */
  async resolve(pincode: string): Promise<PincodeVerdict> {
    const candidates = Array.from({ length: pincode.length }, (_, i) => pincode.slice(0, i + 1));
    const rows = await this.pincodes.find({ where: { pincodePrefix: In(candidates) } });
    if (rows.length === 0) return NO_MATCH;

    const best = rows.reduce((longest, row) =>
      row.pincodePrefix.length > longest.pincodePrefix.length ? row : longest,
    );

    return {
      isServiceable: best.isServiceable,
      etaDays: best.etaDays,
      shippingPaise: best.shippingPaise,
      matchedPrefix: best.pincodePrefix,
    };
  }
}
```

- [ ] **Step 3: Run, then ask what nothing pins**

Run: `npm run test -w backend -- pincode.service`
Expected: PASS — 3 tests.

Then mutate, and report what survives:

| Mutation | Should fail |
| --- | --- |
| pick the **first** row instead of the longest | *prefers the most specific matching prefix* |
| return `isServiceable: true` from `NO_MATCH` | *treats an unknown pincode as not serviceable* |
| build candidates from `slice(0, i)` (off by one) | *prefers the most specific* — check this, an off-by-one here silently drops the exact-match row |
| use `Like(\`${pincode}%\`)` instead of `In(candidates)` | **probably nothing**, because the double ignores the `where`. Say so if it survives; the query shape is proven in Task 10 against real Postgres, not here. |

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/checkout/pincode.service.ts backend/src/modules/checkout/pincode.service.spec.ts
git commit -F - <<'MSG'
feat(checkout): one answer about delivery, from the pincode table rather than four guesses
MSG
```

---

## Task 4: `CouponService.preview` — every rule the columns imply

`POST /checkout/coupon/preview` is read-only, so it can be built and proven before redemption exists.

**The frontend has no coupon logic at all.** `CheckoutForm.tsx:599-607`'s Apply button only flips local
state to reveal *"We will validate this code against your order before it ships."* — no request, no
discount line in the summary, and `mocks/orders.ts` sets `discount = 0` on all six fixtures. So this
endpoint has no existing behaviour to preserve, which is the easy part.

**The hard part: the table has eleven eligibility columns and zero rows.** Measured —
`SELECT count(*) FROM coupons` returns **0**, and there is no `coupons.seed.ts`. A coupon feature with a
complete schema and no data ships untestable by hand: the browser verification in Task 14 would have
nothing to type. So this task seeds three coupons chosen to exercise the branches that matter, and the
seeder is part of the task rather than an afterthought.

### The eight rules, and what each is for

Read from the entity's columns, because every one of them is a rule somebody will eventually rely on:

| Column | Refuses when |
| --- | --- |
| `isActive` | switched off — the admin's kill switch, checked first because it is the cheapest |
| `startsAt` / `expiresAt` | outside the window; either may be null, meaning "no bound" |
| `minOrderValuePaise` | the eligible subtotal is below it |
| `appliesTo` = `CATEGORY` + `categoryId` | no line belongs to that category |
| `channel` = `RETAIL` / `BULK` | the basket is the other channel |
| `firstOrderOnly` | this customer already has an order |
| `usageLimit` | total redemptions have reached it |
| `usageLimitPerUser` | this customer's redemptions have reached it |

Two rules deserve their reasoning stated, because both are easy to get subtly wrong:

- **`firstOrderOnly` counts *orders*, not redemptions.** A customer whose first order used no coupon has
  still had a first order. Counting redemptions would let them use a first-order coupon on their fifth
  purchase.
- **A guest has no order history**, so `firstOrderOnly` and `usageLimitPerUser` cannot be evaluated for
  one. Treat an anonymous checkout as *eligible* for `firstOrderOnly` — it is by definition their first —
  and as having zero personal redemptions. State it in the code, because the alternative reading (refuse
  what you cannot verify) silently blocks the exact customer a first-order coupon is aimed at.

### Discount arithmetic — already written, in `shared/src/money.ts`

**Do not implement this.** `applyPercent(amountPaise, percent, maxPaise?)` and `applyFlat(amountPaise,
flatPaise)` already do exactly what the paragraphs below describe, with half-up rounding and a clamp to
the amount, under nine tests of their own. They were imported by nothing before this task, which is
why an earlier version of this section read as a specification rather than a pointer. Call them.

The description is kept because it is what those functions guarantee, not because you should build it:

`PERCENT` takes `percentValue` of the eligible subtotal, capped by `maxDiscountPaise` when set. `FLAT`
takes `flatValuePaise`. **Both are then capped at the eligible subtotal**, because a ₹500 flat coupon on
a ₹300 order must not produce a negative total — and `Order.totalPaise` is a `bigint` column with no
check constraint stopping it.

All of it in paise, per §8. `percentValue` is `numeric(5,2)` and arrives as a **string**.

**Files:**
- Create: `backend/src/modules/checkout/coupon.service.ts`
- Create: `backend/src/modules/checkout/coupon.service.spec.ts`
- Create: `backend/src/database/seeds/coupons.seed.ts`
- Modify: `backend/src/database/seeds/seed.ts` — register it

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/checkout/coupon.service.spec.ts
import { CouponScope, CouponChannel, CouponType } from '../../entities/enums';
import { CouponService, type CouponBasket } from './coupon.service';

const coupon = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'cpn-1',
  code: 'WELCOME10',
  type: CouponType.PERCENT,
  percentValue: '10.00',
  flatValuePaise: null,
  minOrderValuePaise: null,
  maxDiscountPaise: null,
  appliesTo: CouponScope.ALL,
  categoryId: null,
  channel: CouponChannel.ALL,
  firstOrderOnly: false,
  usageLimit: null,
  usageLimitPerUser: null,
  startsAt: null,
  expiresAt: null,
  isActive: true,
  ...overrides,
});

/** A ₹1,000 retail basket of almonds. */
const basket: CouponBasket = {
  channel: 'retail',
  lines: [{ categoryId: 'cat-almonds', lineTotalPaise: 100_000n }],
  subtotalPaise: 100_000n,
};

function harness(
  row: ReturnType<typeof coupon> | null,
  counts: { total?: number; forUser?: number; ordersForUser?: number } = {},
) {
  return new CouponService(
    { findOne: jest.fn(() => Promise.resolve(row)) } as never,
    {
      count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('userId' in where ? (counts.forUser ?? 0) : (counts.total ?? 0)),
      ),
    } as never,
    { count: jest.fn(() => Promise.resolve(counts.ordersForUser ?? 0)) } as never,
  );
}

describe('CouponService.preview', () => {
  it('takes a percentage of the subtotal, in paise', async () => {
    const result = await harness(coupon()).preview('WELCOME10', basket, null);
    expect(result).toMatchObject({ eligible: true, discountPaise: 10_000n });
  });

  it('caps a percentage at maxDiscountPaise', async () => {
    const result = await harness(coupon({ maxDiscountPaise: 5_000n })).preview('WELCOME10', basket, null);
    expect(result.discountPaise).toBe(5_000n);
  });

  it('takes a flat amount when that is the type', async () => {
    const flat = coupon({ type: CouponType.FLAT, percentValue: null, flatValuePaise: 15_000n });
    const result = await harness(flat).preview('FLAT150', basket, null);
    expect(result.discountPaise).toBe(15_000n);
  });

  /**
   * A ₹500 flat coupon on a ₹300 order must not make the total negative. `Order.totalPaise` is a
   * bigint with no check constraint, so nothing downstream would catch it.
   */
  it('never discounts more than the basket is worth', async () => {
    const flat = coupon({ type: CouponType.FLAT, percentValue: null, flatValuePaise: 50_000n });
    const small: CouponBasket = { ...basket, subtotalPaise: 30_000n, lines: [{ categoryId: 'cat-almonds', lineTotalPaise: 30_000n }] };
    const result = await harness(flat).preview('FLAT500', small, null);
    expect(result.discountPaise).toBe(30_000n);
  });

  it('refuses an unknown code without saying whether it ever existed', async () => {
    const result = await harness(null).preview('NOPE', basket, null);
    expect(result).toMatchObject({ eligible: false, code: 'COUPON_INVALID' });
  });

  it('refuses an inactive coupon', async () => {
    const result = await harness(coupon({ isActive: false })).preview('WELCOME10', basket, null);
    expect(result.eligible).toBe(false);
  });

  it('refuses one outside its window, at both ends', async () => {
    const future = coupon({ startsAt: new Date(Date.now() + 86_400_000) });
    const past = coupon({ expiresAt: new Date(Date.now() - 86_400_000) });
    await expect(harness(future).preview('X', basket, null)).resolves.toMatchObject({ eligible: false });
    await expect(harness(past).preview('X', basket, null)).resolves.toMatchObject({ eligible: false });
  });

  it('refuses a basket under the minimum, and names the shortfall', async () => {
    const result = await harness(coupon({ minOrderValuePaise: 150_000n })).preview('X', basket, null);
    expect(result).toMatchObject({ eligible: false, code: 'COUPON_MIN_ORDER_VALUE' });
    // The customer can act on this one, so it carries the figure rather than a bare refusal.
    expect(result.minOrderValuePaise).toBe(150_000n);
  });

  it('refuses the wrong channel', async () => {
    const bulkOnly = coupon({ channel: CouponChannel.BULK });
    await expect(harness(bulkOnly).preview('X', basket, null)).resolves.toMatchObject({ eligible: false });
  });

  /**
   * A category coupon discounts only the lines in that category, not the whole basket — otherwise
   * "10% off almonds" takes 10% off the cashews sitting beside them.
   */
  it('discounts only the lines in its category', async () => {
    const almondsOnly = coupon({ appliesTo: CouponScope.CATEGORY, categoryId: 'cat-almonds' });
    const mixed: CouponBasket = {
      channel: 'retail',
      subtotalPaise: 150_000n,
      lines: [
        { categoryId: 'cat-almonds', lineTotalPaise: 100_000n },
        { categoryId: 'cat-cashews', lineTotalPaise: 50_000n },
      ],
    };
    const result = await harness(almondsOnly).preview('ALMOND10', mixed, null);
    expect(result.discountPaise).toBe(10_000n);
  });

  it('refuses a category coupon when no line qualifies', async () => {
    const almondsOnly = coupon({ appliesTo: CouponScope.CATEGORY, categoryId: 'cat-almonds' });
    const cashews: CouponBasket = {
      channel: 'retail',
      subtotalPaise: 50_000n,
      lines: [{ categoryId: 'cat-cashews', lineTotalPaise: 50_000n }],
    };
    await expect(harness(almondsOnly).preview('ALMOND10', cashews, null)).resolves.toMatchObject({
      eligible: false,
      code: 'COUPON_NOT_APPLICABLE',
    });
  });

  it('refuses when the global usage limit is spent', async () => {
    const result = await harness(coupon({ usageLimit: 5 }), { total: 5 }).preview('X', basket, 'u1');
    expect(result.eligible).toBe(false);
  });

  it('refuses when this customer has spent their own allowance', async () => {
    const result = await harness(coupon({ usageLimitPerUser: 1 }), { forUser: 1 }).preview('X', basket, 'u1');
    expect(result.eligible).toBe(false);
  });

  /**
   * `firstOrderOnly` counts **orders**, not redemptions. A customer whose first order used no coupon
   * has still had a first order; counting redemptions would let them spend a first-order coupon on
   * their fifth purchase.
   */
  it('refuses a first-order coupon to a customer who already has an order', async () => {
    const result = await harness(coupon({ firstOrderOnly: true }), { ordersForUser: 1 }).preview(
      'X',
      basket,
      'u1',
    );
    expect(result.eligible).toBe(false);
  });

  /**
   * A guest has no history, so this **is** their first order. The other reading — refuse what you
   * cannot verify — blocks precisely the customer a first-order coupon exists to attract.
   */
  it('allows a first-order coupon to a guest', async () => {
    const result = await harness(coupon({ firstOrderOnly: true })).preview('X', basket, null);
    expect(result.eligible).toBe(true);
  });

  it('is case-insensitive about the code, because the input is upper-cased on the way in', async () => {
    const findOne = jest.fn(() => Promise.resolve(coupon()));
    const service = new CouponService(
      { findOne } as never,
      { count: jest.fn(() => Promise.resolve(0)) } as never,
      { count: jest.fn(() => Promise.resolve(0)) } as never,
    );
    await service.preview('welcome10', basket, null);
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'WELCOME10' } }));
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- coupon.service`
Expected: FAIL — `Cannot find module './coupon.service'`.

Write `CouponService` with a `preview(code, basket, userId)` returning a discriminated result.

**Declare every field on both arms**, the absent ones as `?: undefined`. A literal
`{ eligible: true; discountPaise } | { eligible: false; code }` does **not** compile against the tests
above, which read `.discountPaise`, `.code` and `.minOrderValuePaise` off the union without narrowing —
three errors. Declaring both arms keeps the discrimination intact (assigning a `discountPaise` to a
refusal is still an error) while letting a test read either. The refusal `code`
values above (`COUPON_INVALID`, `COUPON_MIN_ORDER_VALUE`, `COUPON_NOT_APPLICABLE`) must all exist in
`ErrorCodes` (`backend/src/common/errors/domain-error.ts`); add any that do not, and add the same
compile-time membership guard the cart uses at `cart-read.service.ts` so this vocabulary cannot drift
from the registry.

Two implementation notes that are decisions rather than detail:

- **Check `isActive` first, then the window, then the *scope*, then the money, then the counts.** The
  counts are the only branches that query, so ordering them last means an inactive coupon costs one
  lookup rather than four.

  **Scope must come before the money, and an earlier version of this list had them the other way round.**
  The minimum is measured against the *eligible* subtotal, which for a `CATEGORY` coupon does not exist
  until the scope is resolved. Measured: comparing `basket.subtotalPaise` instead passes **all sixteen**
  tests above, because in every one of them the two figures are equal — and the live consequence is that
  "spend ₹1,500 on almonds" is satisfied by ₹1,000 of almonds sitting beside ₹500 of cashews.
- **Return the *reason*, not a boolean.** The customer can act on `COUPON_MIN_ORDER_VALUE` (add ₹500 and
  it works) and cannot act on `COUPON_INVALID`. A single "not valid" answer for both is the frontend's
  problem later, and there is no way to recover the distinction once it is thrown away.

- [ ] **Step 3: Seed three coupons**

Without these the endpoint is unusable by hand and Task 14 has nothing to type. Chosen to cover the
branches a person would actually try:

```ts
// backend/src/database/seeds/coupons.seed.ts — three rows, each exercising a different shape
// WELCOME10  PERCENT 10%, maxDiscount ₹200, firstOrderOnly       — the common case, and the cap
// BULK500    FLAT ₹500, minOrderValue ₹10,000, channel BULK      — channel and minimum together
// ALMOND15   PERCENT 15%, appliesTo CATEGORY (almonds), usageLimit 100
```

Register it in `seeds/seed.ts` after `catalog` — `ALMOND15` needs a `categoryId`, so it must run once
categories exist. Follow the existing seeders' `upsert(['code'])` shape so a re-run is idempotent, and
**do not** run `npm run seed` against the dev database as part of this task: it resets
`inventory.onHand` while leaving the append-only ledger, which breaks `SUM(delta) == onHand`. Prove the
seeder on the integration harness's own container instead.

**Four things this task deliberately does not settle, recorded so nobody assumes they are handled:**

- **`codEnabled` is read by nothing.** Seeded `true`. If an admin set it false, placement would still
  accept COD — and since `"online"` is refused unconditionally, *no* order could be placed at all.
- **The server does not require `companyName`/`gstin` for a bulk basket**, though `b2bCheckoutSchema`
  does. The DTO cannot see the cart, so a bulk order can be placed through the API with no GSTIN, while
  every seeded bulk order carries one. Belongs with Task 13.
- **`shared`'s `Address.email` docblock says the backend should populate email from the session and
  "never trust a client-supplied value"** — but the form collects it in the Contact section and a guest
  has no session. Snapshot the DTO's value and flag it; it needs settling somewhere explicit.
- **One condition in the guard chain is load-bearing for the typechecker and for no test.** `cart === null`
  narrows `cart` for a later `cart.id`, while a null cart and an empty cart reach the same refusal because
  `items = cart?.items ?? []`. Mutating it yields `TS18047` and `Tests: 0 total` — the preamble's false
  positive. Do not count it as a kill.

- [ ] **Step 4: Run, mutate, commit**

Run: `npm run test -w backend -- coupon.service`
Expected: PASS — 20 tests. Sixteen are listed above; four more close the gaps named in the mutation
list below, each of which survives all sixteen.

Mutate each rule out in turn — there are eight, and each should kill exactly the test named for it. Then
report two specifically:

- **The channel rule has no positive test, and needs one.** *refuses the wrong channel* only ever presents
  a mismatch, so an implementation that refuses **every** channel-scoped coupon —
  `if (row.channel !== CouponChannel.ALL) refuse` — passes all sixteen. That would make the seeded
  `BULK500` unusable on the bulk basket it exists for. Add the positive case.
- **Two rules this table does not cover.** `Coupon.category` is `ON DELETE SET NULL`, and the entity's own
  docblock says the resulting scope mismatch is for application validation to catch — nothing here does,
  and widening such a coupon to the whole basket passes all sixteen. And `firstOrderOnly` says nothing
  about order *status*: count **all** orders including cancelled ones, or place-then-cancel becomes a way
  to farm the coupon forever.
- Removing the **cap at the eligible subtotal** — does any other test catch it, or only *never discounts
  more than the basket is worth*? (Within this file, only its own test. The clamp itself lives in
  `shared/src/money.ts` and has two tests there.)
- Swapping `firstOrderOnly`'s order count for a **redemption** count — this passes every test except
  *refuses a first-order coupon to a customer who already has an order*, and only if that fixture sets
  `ordersForUser` without also setting `forUser`. Check that it does.

```bash
git add backend/src/modules/checkout/coupon.service.ts backend/src/modules/checkout/coupon.service.spec.ts backend/src/database/seeds/coupons.seed.ts backend/src/database/seeds/seed.ts
git commit -F - <<'MSG'
feat(checkout): preview a coupon against every rule its columns imply
MSG
```

---

## Task 5: `OrderStatusService` — transitions, and what each one does to stock

Spec §10.3: *"`OrderStatusService` owns the legal transitions; an illegal one is a `422`, not a silent
write."* And: *"Every transition appends an `OrderEvent` … which is exactly what `/account/orders/$id`
renders as the tracking timeline — so admin action and customer-visible tracking are the same data, not
two systems that can disagree."*

**The transition map already exists and is already tested. Do not write a second one.**
`shared/src/constants/order-status.ts` exports `nextStatuses(channel, from)`,
`canTransition(channel, from, to)` and `isTerminalStatus(channel, status)`, pinned by 16 cases in
`order-status.test.ts` — including that a **no-op transition is refused** (so a duplicate admin click is
not recorded twice) and that `isTerminalStatus` **throws** a `RangeError` on a cross-channel status
rather than answering. The same 14 values are mirrored as a check constraint on both `orders.status` and
`order_events.status`, with the migration's own comment: *"The canonical definition is the tuple in
@nutwala/shared; this mirrors it."*

So this service is a thin consumer: validate, append, and act on the stock consequence. A second
transition table anywhere in this plan is a defect, and the third copy of the vocabulary would be the
one that drifts.

**Nothing in the frontend imports those three functions today**, which is worth knowing before someone
"helpfully" wires the cancel button to a client-side check. The server is the authority; the button's
visibility is UX.

### The stock consequence, which is the part with teeth

§10.3: *"`cancelled` before dispatch writes a `CANCELLATION` transaction restoring `onHand`; `refunded`
writes a `RETURN` only when the admin marks the goods restockable, since returned food may not be
resellable."*

Two things follow that the spec does not spell out:

- **`cancelled` is reachable from four statuses** — `pending`, `confirmed`, `processing`, `packed` — and
  all four are "before dispatch", so cancellation always restores stock. There is no cancel-after-ship
  case to handle, because `RETAIL_TRANSITIONS` does not offer one.
- **`refunded` takes a parameter.** Restocking is a judgement about the goods, not a property of the
  status, so `transition()` needs an explicit `restock: boolean` for that one path and must **not**
  default it to `true`. Defaulting to restock would silently return spoiled food to sale; defaulting to
  `false` silently loses good stock.

  **But the test below calls `transition(…, 'refunded', {})` and expects success with nothing restocked,
  which *is* defaulting to false — so an earlier version of this paragraph ("requiring it at the call site
  is the only honest option") contradicted its own spec.** A genuinely required flag means a runtime 422
  or an overload demanding it, and the overload fails at compile time, reporting `Tests: 0`.

  Implement the test's behaviour, and record why the two errors are **not** symmetric: not restocking is
  recoverable — an admin writes an `ADJUSTMENT` and the ledger stays consistent — while spoiled food back
  on the shelf is not recoverable at all. That asymmetry is the actual argument for the default, and it is
  better than the appeal to symmetry it replaces.

Both consequences write through the same conditional-`UPDATE`-plus-ledger-row pair as Task 6's
decrement, in the same transaction as the event. A restore that succeeded while its ledger row failed
would break `SUM(delta) == onHand`, which `schema-invariants.integration.spec.ts` asserts and which is
currently clean at 0 mismatches.

**Files:**
- Create: `backend/src/modules/orders/order-status.service.ts`
- Create: `backend/src/modules/orders/order-status.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/modules/orders/order-status.service.spec.ts
import { HttpStatus } from '@nestjs/common';
import { InventoryTransactionType, OrderChannelEnum } from '../../entities/enums';
import { OrderStatusService } from './order-status.service';

interface Recorded {
  events: { orderId: string; status: string; note: string | null; actorUserId: string | null }[];
  ledger: { variantId: string; delta: number; type: InventoryTransactionType }[];
  stockUpdates: { variantId: string; delta: number }[];
  orderStatus: string | null;
}

function harness(order: { channel: OrderChannelEnum; status: string; items?: { variantId: string; qty: number }[] }) {
  const recorded: Recorded = { events: [], ledger: [], stockUpdates: [], orderStatus: null };

  const manager = {
    getRepository: (entity: { name: string }) => ({
      findOne: () =>
        Promise.resolve({
          id: 'ord-1',
          orderNumber: 'NN-2026-100000',
          channel: order.channel,
          status: order.status,
          items: order.items ?? [{ variantId: 'var-1', qty: 2 }],
        }),
      insert: (row: Record<string, unknown>) => {
        if (entity.name === 'OrderEvent') recorded.events.push(row as never);
        if (entity.name === 'InventoryTransaction') recorded.ledger.push(row as never);
        return Promise.resolve({ identifiers: [] });
      },
      update: (_criteria: unknown, patch: { status?: string }) => {
        if (patch.status) recorded.orderStatus = patch.status;
        return Promise.resolve({ affected: 1 });
      },
    }),
    // The conditional UPDATE. Returns 1 so the happy path proceeds; Task 6 proves the 0 case.
    query: (sql: string, parameters: unknown[]) => {
      if (/inventory/i.test(sql)) {
        recorded.stockUpdates.push({ variantId: String(parameters[1]), delta: Number(parameters[0]) });
      }
      return Promise.resolve([{ onHand: 120 }]);
    },
  };

  const dataSource = { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) };
  return { service: new OrderStatusService(dataSource as never), recorded };
}

describe('OrderStatusService.transition', () => {
  it('appends an event and moves the order when the transition is legal', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });

    await service.transition('NN-2026-100000', 'confirmed', { actorUserId: 'admin-1', note: 'Verified' });

    expect(recorded.orderStatus).toBe('confirmed');
    expect(recorded.events).toEqual([
      { orderId: 'ord-1', status: 'confirmed', note: 'Verified', actorUserId: 'admin-1' },
    ]);
  });

  /**
   * §10.3: an illegal transition is a 422, not a silent write. `shipped` cannot go back to `pending`,
   * and the order must be left exactly as it was — no event, no status change.
   */
  it('refuses an illegal transition with 422 and writes nothing', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'shipped' });

    await expect(service.transition('NN-2026-100000', 'pending', {})).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.events).toEqual([]);
    expect(recorded.orderStatus).toBeNull();
  });

  /**
   * A duplicate admin click. `canTransition` already refuses a no-op — `order-status.test.ts` pins it
   * — and this asserts the service does not work around that with an `if (from === to) return`.
   */
  it('refuses a transition to the status the order already holds', async () => {
    const { service } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });
    await expect(service.transition('NN-2026-100000', 'packed', {})).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  /**
   * A bulk order follows the bulk ladder. `processing → packed` is legal for retail and does not
   * exist for bulk, so passing the channel through is what stops the two vocabularies mixing.
   */
  it('judges a bulk order against the bulk ladder', async () => {
    const { service } = harness({ channel: OrderChannelEnum.BULK, status: 'processing' });
    await expect(service.transition('NN-2026-100000', 'packed', {})).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    const bulk = harness({ channel: OrderChannelEnum.BULK, status: 'processing' });
    await expect(bulk.service.transition('NN-2026-100000', 'shipped', {})).resolves.toBeDefined();
  });

  it('restores stock and writes a CANCELLATION row when an order is cancelled', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'processing',
      items: [{ variantId: 'var-1', qty: 2 }, { variantId: 'var-2', qty: 1 }],
    });

    await service.transition('NN-2026-100000', 'cancelled', { note: 'Customer changed their mind' });

    expect(recorded.stockUpdates).toEqual([
      { variantId: 'var-1', delta: 2 },
      { variantId: 'var-2', delta: 1 },
    ]);
    expect(recorded.ledger.map((r) => r.type)).toEqual([
      InventoryTransactionType.CANCELLATION,
      InventoryTransactionType.CANCELLATION,
    ]);
  });

  /**
   * §10.3 makes restocking a **judgement about the goods**, not a property of the status: returned food
   * may not be resellable. So `refunded` requires the flag explicitly. Defaulting it either way is
   * silently wrong in one direction — spoiled food back on sale, or good stock written off.
   */
  it('refunds without restocking unless told to restock', async () => {
    const plain = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await plain.service.transition('NN-2026-100000', 'refunded', {});
    expect(plain.recorded.ledger).toEqual([]);
    expect(plain.recorded.stockUpdates).toEqual([]);

    const restocked = harness({ channel: OrderChannelEnum.RETAIL, status: 'delivered' });
    await restocked.service.transition('NN-2026-100000', 'refunded', { restock: true });
    expect(restocked.recorded.ledger.map((r) => r.type)).toEqual([InventoryTransactionType.RETURN]);
  });

  /**
   * A status change with no stock consequence must not touch inventory at all. Without this, a
   * "restore on every transition" implementation passes the cancellation test and quietly inflates
   * stock on every step of a normal order's life.
   */
  it('leaves stock alone on an ordinary forward step', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'confirmed' });
    await service.transition('NN-2026-100000', 'processing', {});
    expect(recorded.stockUpdates).toEqual([]);
    expect(recorded.ledger).toEqual([]);
  });

  it('reports an unknown order number as 404, not as an illegal transition', async () => {
    // Two different failures need two different answers: an admin who mistyped a reference must not
    // be told the transition was illegal. Same shape as the inventory adjustment's 404-versus-409.
    const { service } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });
    await expect(service.transition('NN-2026-999999', 'confirmed', {})).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });
});
```

Note the last test needs the harness's `findOne` to answer `null` for an unknown number — extend it
rather than asserting against a fixture that always resolves.

- [ ] **Step 2: Run it, watch it fail, implement**

Run: `npm run test -w backend -- order-status.service`
Expected: FAIL — `Cannot find module './order-status.service'`.

The implementation is small because the rule lives in `shared`:

1. Load the order with its items, inside a transaction. `null` → 404.
2. `canTransition(channel, order.status, to)` — false → 422 `ILLEGAL_STATUS_TRANSITION` — the code the registry already has; `ORDER_TRANSITION_INVALID`
   does not exist and does not compile, since `ErrorCode` is a narrowed union — carrying
   `nextStatuses(channel, order.status)` in the details so a client can render what *is* allowed rather
   than guessing.
3. `UPDATE orders SET status = $to`, plus `cancelledAt`/`cancelReason` when cancelling.
4. Insert the `OrderEvent`.
5. The stock consequence: `cancelled` → `CANCELLATION` per line; `refunded` **and** `restock` → `RETURN`
   per line; anything else → nothing.

Two details that are decisions:

- **Channel comes from the order row, never from the caller.** A caller-supplied channel is a way to
  judge a retail order against the bulk ladder and slip `processing → shipped` past `packed`.
- **Lines are restored in ascending `variantId`**, the same order Task 6 decrements in. Two concurrent
  operations touching the same two variants in opposite orders is the textbook deadlock, and a
  cancellation racing a placement is exactly that.

**Three things the code above needs that no test in it reads, all measured:**

1. **Truncate the cancellation reason.** `order_events.note` is `varchar(300)` and
   `orders.cancel_reason` is `varchar(200)` — a hundred characters apart. An untruncated 300-character
   reason is a Postgres `22001` *after* every rule has passed, so a legitimate cancellation 500s. Keep the
   full text on the event and truncate the copy on the order.
2. **`OrderItem.variantId` is `string | null`**, because the variant FK is `ON DELETE SET NULL` — the
   harness types it as `string`, which is wrong. The naive handling is worse than the type error: a raw
   `UPDATE … WHERE variant_id = NULL` matches nothing, so a whole cancellation is refused over a variant
   deleted months ago. Skip those lines, and test it.
3. **Nothing reads `cancelledAt` or `cancelReason`.** Deleting both from the patch fails none of the
   tests above. Add a case.

**And one fact about the vocabulary that changes what this service means.** `B2B_ORDER_STATUSES` contains
neither `cancelled` nor `refunded` — measured: its eight values are `quote-requested`, `quote-sent`,
`quote-accepted`, `awaiting-payment`, `approved`, `processing`, `shipped`, `delivered`. So **a bulk order
can never be cancelled or refunded**, and the entire stock-consequence half of this service is retail-only
in practice. Neither §10.3 nor an earlier version of this task says so, and a reader would reasonably
assume B2B cancellation exists. Task 20 and the admin plan both need to know.

- [ ] **Step 3: Run, mutate, commit**

Run: `npm run test -w backend -- order-status.service`
Expected: PASS — **8** tests from the block above, not the 9 an earlier version claimed, plus the cases the
notes above add. (Relatedly: `order-status.test.ts` in `shared` has **14** cases, not the 16 stated here
and in the preamble. Both behaviours those counts were cited for — the no-op refusal and the cross-channel
`RangeError` — are genuinely present; the numbers were not.)

Mutations to run, with the one to watch:

| Mutation | Should fail |
| --- | --- |
| accept any transition | *refuses an illegal transition*, *refuses a no-op*, *bulk ladder* |
| write the event before validating | *refuses an illegal transition … and writes nothing* |
| take the channel from the caller | *judges a bulk order against the bulk ladder* |
| restore stock on every transition | *leaves stock alone on an ordinary forward step* |
| default `restock` to `true` | *refunds without restocking unless told to* |
| 404 → 422 for an unknown order | *reports an unknown order number as 404* |
| **restore in insertion order instead of sorted** | *nothing against the fixture above* — because that fixture's lines are **already ascending**, so sorted and unsorted are identical. Give one test lines arriving `[var-2, var-1]` and the mutation dies single-threaded. The **ordering** needs no concurrency to pin; only the **deadlock** it prevents does, and that is Task 7's. An earlier version of this row claimed nothing could catch it, which conceded too much. |

```bash
git add backend/src/modules/orders/order-status.service.ts backend/src/modules/orders/order-status.service.spec.ts
git commit -F - <<'MSG'
feat(orders): one place that knows which status changes are legal and what each does to stock
MSG
```

---

## Task 6: `CheckoutService.place` — one transaction

Everything before this task exists so that this one can be short. It is still the most consequential
code in the plan.

### The request does not carry the basket

**`POST /checkout/orders` reads the lines from the server's cart, not from its own body.** The body
carries the address, the payment method, the coupon code and the B2B fields — nothing that decides
money.

This is not a preference. Spec §13: *"Server recomputes subtotal, GST, shipping, discount and total from
the database; client-supplied money is ignored entirely."* A body that carried lines would let a client
name its own basket at checkout, and the cart it had been shown would become decorative. The cart is
already server-side and already priced by `CartPricingService` — placement re-reads it and re-prices it,
and the customer's own screen is the thing being confirmed rather than the thing being trusted.

A consequence worth stating: **placement therefore requires a cart**, so an empty one is a `422`, not an
order for nothing. And the guest path works unchanged, because a guest's cart is found by their
`nn_guest_token` cookie exactly as `GET /cart` finds it.

### Re-validate, even though the cart page just did

§10.1: stock is *"checked at add-to-cart for feedback and re-checked authoritatively at checkout."* The
gap between the two is real — Task 21 of the previous plan built `POST /cart/validate` precisely so a
customer sees a problem before paying — but a validate call is advisory and this one is binding. Every
gate the cart applies applies again here, from the same code:

- the line's product still exists and is **published** (the gate added in `3c56549`);
- the variant is still `isActive`;
- the product is not **`quoteOnly`** (the gate added in `5690650` — a quote-only product has no
  self-service price, and until that fix the server would happily have sold a ₹33,975 gift box);
- retail quantity is at or above the variant's `moq`, bulk weight at or above the product's `moqKg`;
- the bulk weight lands in a **priced** tier;
- and, the one only placement can decide, there is enough stock.

Reuse `CartReadService`'s `verdictFor` rather than restating any of it. If placement grows its own copy
of these rules, the cart page and the checkout will eventually disagree about the same basket — and the
customer meets the disagreement at the moment they are trying to pay.

### The money, in paise, per line

§8, and the same arithmetic `CartPricingService` already performs:

| Figure | From |
| --- | --- |
| `subtotalPaise` | sum of the line totals |
| `discountPaise` | `CouponService`, capped at the subtotal (Task 4) |
| `gstPaise` | **per line, then summed** — never a percentage of the aggregate |
| `shippingPaise` | **`CartPricingService`, which applies the free-shipping threshold to the pincode row's charge** — see below |
| `totalPaise` | `subtotal − discount + gst + shipping` |

**The shipping row is not simply the pincode charge, and an earlier version of this table said it was.**
Taken literally that overcharges. Measured:

```
settings          freeShippingThreshold = 999      flatShippingRate = 79
pincodes          every serviceable prefix carries shippingPaise = ₹79
seeded orders     ₹659 -> ₹79     ₹978 -> ₹79     ₹1,406 -> ₹0     ₹2,197 -> ₹0
```

`CartPricingService.totals` already returns `shipping: 0` at or above the threshold, and
`CheckoutForm.tsx:541`/`:624` print **"Free"** from that figure. So billing the pincode row unconditionally
charges ₹79 on a basket whose own checkout summary the customer has just read as free — and it contradicts
every seeded order. Delegate to `CartPricingService` rather than writing a fifth copy of the rule; the
pincode row supplies the *charge*, the threshold decides whether it applies.

**And the fallback to `flatShippingRate` is unreachable in placement**, so do not write it.
`PincodeService.resolve` returns `matchedPrefix: null` only together with `isServiceable: false`, and
placement refuses `!isServiceable` first — so a serviceable verdict always carries a matched row.
Preamble disagreement 4 describes the fallback as policy; in this code path it is dead. Say so in a
comment rather than shipping a branch that pretends to be a decision.

**GST is computed on the line, before the discount.** That is a decision, and the alternative is
defensible, so it is recorded rather than assumed: apportioning a basket-level discount across lines to
recompute tax needs a rounding rule for the remainder, and a wrong one makes the invoice's tax differ
from the sum of its lines' tax — the exact reconciliation failure §8 exists to prevent. Whoever
implements GST-on-discounted-value later owns that rounding rule; this plan does not invent one.

### Snapshots, because history must survive the catalogue

`OrderItem` carries `name`, `hsn`, `detail`, `size`/`grams`/`kg`, `unitPricePaise`, `gstRate` and
`gstAmountPaise` — all copies. `Order.addressSnapshot` is `jsonb`. The `Address` entity's own docblock
says *"Orders never reference this table."*

Fill every one of them. An invoice must reprint years later after the product has been renamed, the
price has changed and the address has been deleted — and `order_items.product_id` is `ON DELETE SET
NULL`, so the row survives the product by design. A snapshot left null is an invoice that cannot be
reissued.

**Files:**
- Create: `backend/src/modules/checkout/checkout.service.ts`
- Create: `backend/src/modules/checkout/checkout.service.spec.ts`
- Create: `backend/src/modules/checkout/dto/place-order.dto.ts`

- [ ] **Step 1: The DTO**

Mirror `CheckoutForm`'s validated fields exactly, because every one of them is currently validated and
then discarded (`CheckoutForm.tsx:132-141`) — that is disagreement 2's other half. The shipping address
block, `paymentMethod`, `couponCode?`, and the B2B set (`companyName`, `gstin`, `poNumber?`,
`billingSameAsShipping`, `billing?`, `specialInstructions?`).

Two rules the form already enforces and the server must not merely trust:

- `gstin` against `GSTIN_REGEX` — `/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/`, from `shared`.
- `pincode` against `PINCODE_REGEX` — `/^\d{6}$/`. Note this accepts `110001`, which the Phase 1 mock
  refused; see disagreement 1.

And one the form does not:

- `paymentMethod` is `@IsIn(['cod'])` **at the DTO**, not merely rejected in the service. §10.4 requires
  `"online"` to answer `422 PAYMENT_METHOD_UNAVAILABLE`, so the service still needs that branch for a
  caller that bypasses validation — but a DTO that accepts a value the service always rejects is a
  contract that lies about what it takes. Use `@ValidateIf` on the online branch if you want the clearer
  error message; do not silently accept it.

- [ ] **Step 2: Write the failing test for the parts a double can reach**

The transaction, the decrement race and the coupon race are Tasks 7, 8 and 10. What a unit spec *can*
prove is the composition: that placement refuses what it should, snapshots what it must, and computes the
money the way §8 says. Cover at least:

```
refuses an empty cart with 422, without allocating an order number
refuses an unserviceable pincode with 422, naming the pincode
refuses "online" with 422 PAYMENT_METHOD_UNAVAILABLE
refuses a basket containing a quoteOnly product          <- the gate from 5690650
refuses a basket containing an unpublished product        <- the gate from 3c56549
refuses a line whose quantity now exceeds available stock with 409, naming the item
computes GST per line and sums it, not as a percentage of the subtotal
applies a coupon discount, and never lets it exceed the subtotal
snapshots the address, and every OrderItem name/hsn/detail/gstRate
opens a Payment row PENDING for the order total
writes exactly one OrderEvent, with status pending and a null actorUserId
empties the cart only after the order is written
```

The last two carry reasoning:

- **The first event's `actorUserId` is null.** `OrderEvent`'s docblock says so — *"Null for a
  system-generated event such as the initial `pending`"* — and it matters because the timeline the
  customer sees is these rows. Attributing the order's creation to the customer as an *actor* would put
  their name against a step they did not perform.
- **The cart is emptied inside the transaction, after the order rows exist.** Emptying first loses the
  basket if placement then fails; emptying outside the transaction loses it if the process dies between
  the two. Both are recoverable for the business and infuriating for the customer.

- [ ] **Step 3: Implement, in this order**

```
1  open a transaction
2  load the cart for this owner, with products, variants, inventory and pricing tiers
3  empty cart            -> 422 CART_EMPTY
4  resolve the pincode   -> 422 PINCODE_NOT_SERVICEABLE (the code the registry has;
                          PINCODE_UNSERVICEABLE does not exist and will not typecheck)
5  paymentMethod online  -> 422 PAYMENT_METHOD_UNAVAILABLE
6  verdictFor each line  -> 409 / 422 naming the offending items, before anything is written
7  coupon                -> discount, or the refusal reason
8  money                 -> subtotal, discount, gst per line summed, shipping, total
9  nextOrderNumber(manager)
10 insert Order + OrderItem[] (cascade: ['insert'] is already on the relation)
11 decrement stock per line, ascending variantId          <- Task 7 proves this
12 insert one SALE InventoryTransaction per line, same transaction
13 redeem the coupon under FOR UPDATE                      <- Task 8 proves this
14 insert the Payment row, PENDING
15 append the first OrderEvent through OrderStatusService  <- or directly; see note
16 delete the cart items
17 return the order, mapped
```

**Two things settled by Task 5 that this task must not re-decide.**

- **There are now two spellings of "conditional `UPDATE` plus ledger row" in the codebase.**
  `InventoryService.adjust` uses `createQueryBuilder().update()` followed by a second read;
  `OrderStatusService` uses raw SQL with `RETURNING "onHand"`, one round trip, and sets `"updatedAt"` by
  hand because raw SQL bypasses `@UpdateDateColumn`. **Pick one of those two for step 11 rather than
  adding a third.** Prefer the `RETURNING` form: `balanceAfter` is then the value actually written rather
  than a value read back afterwards, which is the whole point of the ledger row.
- **Guard the order's own status write, not just the stock.** Task 5 found that reading a status and
  writing it are two statements, so two writers both read `pending`, both pass `canTransition`, and both
  append an event — the duplicate the no-op refusal exists to prevent, arriving by another route. Its
  `UPDATE orders … WHERE id = $1 AND status = $from` with `affected !== 1` is the fix, and placement's
  insert does not need it, but anything in this milestone that *moves* a status does.

**Step 15 is a judgement call, so make it deliberately.** `OrderStatusService.transition` validates
*from* a current status, and a brand-new order has none — `pending` is an initial state, not a
transition. Calling `transition()` for it means inventing a pseudo-status to come from, which corrupts
the map for everyone else. Insert the first event directly, and say so in a comment, so the next reader
does not "fix" the inconsistency by adding a fake `created → pending` edge to `shared`.

- [ ] **Step 4: Run, mutate, commit**

Report which of these survive, because several will:

| Mutation | Expectation |
| --- | --- |
| allocate the order number before validating | should fail *refuses an empty cart … without allocating* |
| GST as a percentage of the subtotal | should fail *computes GST per line* |
| skip the `quoteOnly` / `isPublished` gates | should fail their two tests |
| empty the cart before inserting the order | should fail *empties the cart only after* |
| decrement in insertion order | **dies, if your fixture is not already sorted.** A double cannot see a deadlock, but it sees the *sequence of statements* perfectly well — which is what the assertion pins. Task 5 made the same wrong prediction for the same reason. List one fixture's lines out of ascending order deliberately and say so in its docblock; with a pre-sorted fixture the mutation does go green, so check before concluding. |
| omit the `SALE` ledger rows | **dies** — a repository double sees an `insert` fine. What a double genuinely cannot reach is `SUM(inventory_transactions.delta) == inventory.onHand`, because no row reaches a real table. That is Task 10's. |

```bash
git add backend/src/modules/checkout/checkout.service.ts backend/src/modules/checkout/checkout.service.spec.ts backend/src/modules/checkout/dto/place-order.dto.ts
git commit -F - <<'MSG'
feat(checkout): place a COD order in one transaction, priced from the server's own cart
MSG
```

---

## Task 7: The decrement, proven against a real race

This is a separate task from Task 6 for one reason: **a single-threaded test proves nothing here.** A
decrement written as read-then-write passes every sequential test ever written for it and oversells the
moment two customers arrive together.

§10.2 states the mechanism precisely, and the wording is worth reading twice:

```sql
UPDATE inventory
   SET on_hand = on_hand - $qty, updated_at = now()
 WHERE variant_id = $variantId
   AND on_hand - reserved >= $qty
```

> *"Postgres serialises the concurrent writers on the row lock and **re-evaluates the `WHERE` against the
> committed value**, so two customers racing for the last bag produce exactly one order and one clear
> rejection."*

That re-evaluation is the whole safety property, and it is a property of **one statement**, not of the
isolation level. `SELECT` the stock, decide in JavaScript, then `UPDATE` — and there is a window between
the two that the other customer fits through. There is no retry loop to write and no serialisation
failure to handle, which is exactly why the statement has to stay one statement.

### Two proofs, and the second is the one that matters

**Proof A — the outcome.** Stock of 1, two placements at once, exactly one order and one 409.

**Proof B — the mechanism.** A deterministic test that the `WHERE` is re-evaluated against the
*committed* value rather than the value the transaction first saw. Proof A can pass by luck; this one
cannot.

Plan 2's Task 23 already learned how to do this, and its finding is directly reusable: **`Promise.all`
of two identical requests is not a reliable collision.** Against a mutant it caught the defect 3/3 on a
cold single-test run and **0/2 on a warm full-suite run**, because each request finished before the
next one's write was dispatched. The verdict depended on JIT temperature. So Proof B owns the timing
instead:

1. A rival connection opens a transaction and takes `SELECT … FROM inventory WHERE variant_id = $1 FOR
   UPDATE`, holding the row.
2. Placement fires. Its conditional `UPDATE` blocks on that lock.
3. Wait — do not sleep — until `pg_stat_activity` shows a connection with `wait_event_type = 'Lock'`.
   `cart.integration.spec.ts` has a `waitForABlockedWriter` helper that does exactly this; reuse it.
4. The rival now sets `onHand = 0` and commits.
5. Placement unblocks. If the statement is one conditional `UPDATE`, it re-evaluates against the
   committed `0`, affects zero rows, and the transaction rolls back with `409`. If it is
   read-then-write, it applies the decision it made against the stale value and oversells.

Step 3 is what separates this from a flaky test. Committing early would let a read-then-write
implementation see the committed value too, and the test would pass for the wrong reason — the exact
failure mode it exists to rule out.

**Files:**
- Modify: `backend/src/modules/checkout/checkout.service.ts` — the decrement, if Task 6 left it stubbed
- Create: `backend/test/integration/checkout-concurrency.integration.spec.ts`

Its own spec file, not an addition to Task 10's: these cases hold connections open and poll
`pg_stat_activity`, and mixing them into a suite of ordinary request tests makes an unrelated failure
look like a race.

- [ ] **Step 1: Write Proof A**

Set one variant's `onHand` to 1 via the **audited** endpoint or a direct `UPDATE` plus its ledger row —
never a bare column write, because `SUM(delta) == onHand` is asserted by
`schema-invariants.integration.spec.ts` and is currently clean at 0 mismatches. Two clients, each with
its own cart holding that variant at qty 1, place at once.

Assert, in this order, because the order tells you *how* it failed:

```
exactly one response is 201 and exactly one is 409
the 409 names the offending item, not a bare "out of stock"
SELECT count(*) FROM orders WHERE ... = 1
inventory.onHand = 0            -- not -1, which is what overselling looks like
SUM(inventory_transactions.delta) = onHand   -- still, for that variant
exactly one SALE row exists
```

`onHand = 0` rather than `-1` is the assertion that would catch overselling even if the response codes
happened to look right — and `ck_inventory_non_negative` should have made `-1` impossible, so if it
appears, two constraints have failed and that is worth knowing.

- [ ] **Step 2: Write Proof B**

The blocked-rival sequence above. Assert the placement answers `409` and `onHand` is `0` — the rival's
value, untouched by a decrement that should not have happened.

- [ ] **Step 3: Prove both can fail**

Mutate the implementation to read-then-write:

```ts
// the mutant: decide in JavaScript, then write unconditionally
const [{ available }] = await manager.query(
  'SELECT "onHand" - reserved AS available FROM inventory WHERE variant_id = $1',
  [variantId],
);
if (Number(available) < qty) throw outOfStock(variantId);
await manager.query('UPDATE inventory SET "onHand" = "onHand" - $1 WHERE variant_id = $2', [qty, variantId]);
```

Report what each proof does against it. **Expect Proof A to be unreliable** — that is the point of Proof
B existing, and if Proof A happens to catch it, run it inside the full suite as well as alone before
believing it. Restore byte-identically and re-verify with a checksum.

- [ ] **Step 4: The deadlock ordering, while two connections are already in hand**

Task 5 and Task 6 both order their line operations by ascending `variantId`, and Task 5's mutation table
predicted that no single-threaded double can see why. Here is where it is provable:

Two orders, each holding variants **A** and **B**, placed at once. Sorted, both lock A then B and one
waits. Unsorted — if one basket happens to iterate B then A — Postgres detects a deadlock and kills one
transaction with SQLSTATE `40P01`, which surfaces as a 500 rather than a clean rejection.

Assert that neither response is a 500 and that no `deadlock detected` appears. Then mutate the ordering
out in both services and confirm you can produce `40P01`. **If you cannot reproduce it, say so plainly
rather than asserting the ordering is proven** — a deadlock needs the two transactions to interleave
between their two statements, and that may need more than two clients to hit reliably.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/checkout/checkout.service.ts backend/test/integration/checkout-concurrency.integration.spec.ts
git commit -F - <<'MSG'
test(checkout): prove the decrement re-evaluates against the committed value
MSG
```

---

## Task 8: Coupon redemption, and why counting is not enough

§10.2 is explicit that the coupon needs a different mechanism from stock, and explains why:

> *"Coupon limits need a different mechanism, because counting redemptions then inserting **is** a
> read-then-write gap. The order transaction takes `SELECT … FOR UPDATE` on the `Coupon` row before
> counting, which serialises redemptions of the same coupon; the unique `(couponId, orderId)` constraint
> is the backstop."*

The distinction is worth holding onto. Stock is safe because the *condition* lives inside the writing
statement. A usage limit cannot work that way — the count is over a different table — so the safety has
to come from a lock taken **before** the count. `CouponService.preview` (Task 4) counts without a lock,
which is correct for a preview and useless for a redemption.

**The `usageLimit` count needs no new index.** Measured: `EXPLAIN SELECT count(*) FROM
coupon_redemptions WHERE coupon_id = …` gives a `Bitmap Heap Scan` with
`Recheck Cond: (coupon_id = …)`, because `uq_coupon_redemptions_coupon_order` is on
`(coupon_id, order_id)` and `coupon_id` leads it. `idx_coupon_redemptions_user` covers the per-user
count. Do not add a third.

**`CouponRedemption` already carries the backstop.** Its docblock names it:
`@Unique('uq_coupon_redemptions_coupon_order', ['couponId','orderId'])`, described as *"the backstop
against a retried checkout double-counting a use"* — verified in the live schema as a plain, non-partial
`UNIQUE INDEX … (coupon_id, order_id)`, so it binds on every row rather than a subset. Note what it does and does not protect: it stops the
**same order** redeeming twice. It does **not** stop two different orders exceeding `usageLimit`. That is
what the lock is for, and conflating the two is how a "we have a unique constraint" argument ends with a
coupon redeemed 400 times against a limit of 100.

**This task writes no implementation. It already exists — verified.** Task 6 built it as
**`CheckoutService.redeem`**, a *private* method at `backend/src/modules/checkout/checkout.service.ts:602`,
and its own docblock ends: *"That two connections actually serialise here is Task 8's to prove."* It
already takes the lock, already re-counts **both** limits under it, and already inserts the redemption.

Two differences from the sketch below, both improvements — keep them:

- The lock is **one statement, not two**: `SELECT "usageLimit", "usageLimitPerUser" FROM "coupons" WHERE
  "id" = $1 FOR UPDATE` (`:614`) both locks the row and reads the limits, where `SELECT id … FOR UPDATE`
  followed by a separate read would be two round trips for the same guarantee.
- It lives in `CheckoutService`, not `CouponService`, because it must enlist in the placement
  transaction's `manager`. **Do not move it** — `CouponService.preview` stays lock-free and advisory,
  which is the distinction §10.2 is drawing. Nothing in this task modifies `coupon.service.ts`.

Because `redeem` is **private**, the proofs cannot call it directly; they go through `place(owner, dto)`
with `dto.couponCode` set, the same entry point Task 7's proofs use.

**Precedence, settled while fixing the `firstOrderOnly` hole this task uncovered.** `redeem` now checks
`firstOrderOnly` **before** the two usage limits, matching `preview`'s order, because `domain-error.ts:36-40`
requires that refusal not surface as `COUPON_LIMIT_REACHED` — and one customer meeting one coupon must not
be told different reasons by the preview and the placement. The consequence for fixtures: seeded
`WELCOME10` carries **both** rules, so a race on it now refuses `COUPON_FIRST_ORDER_ONLY`, and a proof
about the per-user limit needs a coupon that carries only that. **Known gap: nothing races a coupon holding
both rules any more**, so a future reordering of those two checks would be caught only by unit
expectations. Worth a case if anyone touches that precedence.

**Two things about the fixtures, both measured.** No seeded coupon has `usageLimit: 1` — `ALMOND15`'s is
100 — so a limit proof must insert its own coupon rather than lean on the seeds. And
`coupon_redemptions.order_id` carries **no foreign key** to `orders`, in neither the entity nor the
migration: a redemption against a fabricated order id would not be refused, so a proof of the unique
constraint must use the real order id `redeem` just wrote, or it is proving nothing about the pair.

**The entity's `@Unique` decorator is inert in the integration suite.** The schema there is built by
`runMigrations` (`test/integration/helpers/test-database.ts:55`), never by `synchronize`, so deleting the
decorator leaves every test green — measured 0/2. Any mutation aimed at a constraint has to be made in the
migration.

**Files:**
- Modify: `backend/test/integration/checkout-concurrency.integration.spec.ts` — **the only file this task
  changes.** If you find yourself editing a service, stop and re-read the paragraph above.

- [ ] **Step 1: Read the implementation you are about to test**

Read `CheckoutService.redeem` (`checkout.service.ts:602-651`) and `refuseCoupon` beneath it. Confirm for
yourself, before writing a proof, that the `FOR UPDATE` precedes both counts — that ordering *is* the
mechanism, and it is what every mutation below attacks. The sketch the plan originally carried, kept for
the reasoning in its docblock:

```ts
/**
 * Redeems a coupon for an order. Must run inside the placement transaction.
 *
 * `FOR UPDATE` **before** the count, and the order is the mechanism: two placements racing the last
 * redemption of a limited coupon both count, both see room, and both insert. The lock serialises them so
 * the loser's count sees the winner's committed row.
 *
 * `preview()` deliberately does not lock — it is advisory, it must not block anyone, and a preview that
 * held a row lock on a popular coupon would serialise every checkout page that displayed it.
 */
async redeem(manager: EntityManager, couponId: string, orderId: string, userId: string | null, discountPaise: bigint) {
  await manager.query('SELECT id FROM coupons WHERE id = $1 FOR UPDATE', [couponId]);
  // ... re-count under the lock, re-check both limits, then insert the redemption
}
```

Re-checking under the lock is not belt-and-braces: `preview` ran earlier, outside any lock, possibly
minutes earlier on the checkout page. Its answer is stale by construction.

- [ ] **Step 2: Prove it, three ways**

1. **The limit holds under a race.** A coupon with `usageLimit: 1`, two placements at once — one order
   carries the discount, the other is refused, and `SELECT count(*) FROM coupon_redemptions` is 1. Use
   the blocked-rival technique from Task 7, for the same reason.
2. **The per-user limit holds.** `usageLimitPerUser: 1`, the same customer twice.
3. **The backstop is real.** Attempt two redemptions of one coupon against **one** `orderId` directly and
   assert the error names `uq_coupon_redemptions_coupon_order` — not merely that it failed. When an
   insert can violate two constraints, a proof that accepts either message passes with the one you care
   about absent; that trap has already been paid for twice on this project.

- [ ] **Step 3: Mutate**

Each mutation names the real code, since the implementation already exists. Delete outright —
never `if (false && …)`, which breaks narrowing and reports `Tests: 0 total`.

| Mutation | Where | Should fail |
| --- | --- | --- |
| drop `FOR UPDATE` from the lock | `checkout.service.ts:614` | proof 1 — **and the plain race is enough here, unlike Task 7's**; see the measurement below |
| move the `FOR UPDATE` read to *after* both counts | `:612-616` vs `:632-645` | proof 1 — the ordering is the whole mechanism |
| delete the `usageLimit` block, trusting `preview` | `:632-635` | proof 1 |
| delete the `usageLimitPerUser` block | `:637-645` | proof 2 |
| drop `uq_coupon_redemptions_coupon_order` | **the migration's `CREATE TABLE`**, `20260819120000-InitialSchema.ts:179` — *not* the entity's `@Unique` | proof 3 |

**Record which mutations the undeterministic race kills and which it does not**, as Task 7 did: it
measured 2/5 for the plain race against 5/5 for the blocked rival, and that number is the argument for
the technique.

**One more correction to the row above: "distinct variants" is not available here.** It was the right
diagnosis of *why* a same-variant proof fails and the wrong prescription — a signed-in customer has one
cart, so a proof about a per-user rule cannot give the two placements different lines. Use a bulk-only
basket instead, per **"Writing a concurrency proof that contends on the thing you meant"** in the preamble.

**Measured, and it inverted the prediction above — the finding is worth more than the guess was.** The
plain coupon race killed all four service mutations **3/3** cold and the no-lock mutation **2/2** on the
full warm suite, so the blocked-rival gate added **nothing** here. What is actually load-bearing is a
detail the mutation table never mentioned: **the two baskets must hold *distinct* inventory variants.**
With both on the same variant the placements serialise on the `inventory` row instead, the loser counts
after the winner has committed, and it refuses **for the right reason by accident** — measured, the no-lock
mutation *survives* **3/3** that way. So a proof written the obvious way is worthless, and the thing that
rescues it is variant selection, not the lock-wait gate. Keep the gate anyway, because it is what lets the
proof assert *which statement* the second backend was stopped in rather than only that it refused.

- [ ] **Step 4: Commit**

```bash
git add backend/test/integration/checkout-concurrency.integration.spec.ts
git commit -F - <<'MSG'
test(checkout): prove coupon redemption serialises on the coupon row
MSG
```

---

## Task 9: The checkout endpoints

Two routes, and the wiring problem Task 1 leaves behind.

**Files:**
- Create: `backend/src/modules/checkout/checkout.controller.ts`, `checkout.module.ts`
- Create: `backend/src/modules/checkout/checkout-idempotency.interceptor.ts`
- Create: `backend/src/modules/checkout/dto/preview-coupon.dto.ts`
- Modify: `backend/src/app.module.ts`

### One caveat inherited from Task 1

`claim()` returns `null` to mean "no replay", and `intercept` branches on `if (replay)` — truthiness, not
`!== null`. So a handler whose **entire** response body were `0`, `false` or `''` would store correctly
and then be replayed as though no claim existed, re-running the handler. Unreachable for
`POST /checkout/orders`, which returns the created order object, and deliberately left alone rather than
changed to `!== null`, which would be an untested behaviour change. **If you ever apply this interceptor
to a route that returns a scalar, fix that first.**

**And one inherited claim that is simply false — measured, and it changes what the hash means.**
`hashOf`'s docblock asserted that the body "has already been through `ValidationPipe` with
`whitelist: true`". **Nest runs interceptors *before* pipes**: in
`@nestjs/core/router/router-execution-context.js`, `fnApplyPipes` is wrapped inside `handler`, and
`handler` is passed *into* `interceptorsConsumer.intercept(...)` as its callback — so the interceptor's body
runs first and `request.body` at hash time is raw `express.json()` output. Two consequences: the hash is
**not canonical** (`{"a":1,"b":2}` and `{"b":2,"a":1}` are one request and hash differently), and the key is
claimed **before** validation. The docblock is corrected in place; the behaviour is left alone, because it
still does the job the mechanism exists for.

Also inherited: the two response-writing calls are fire-and-forget (`void this.keys.update(...)`,
`void this.keys.delete(...)`). Nothing awaits them, so a failed write is silent — the unit fake mutates
synchronously, which is why its tests see the effect, and real Postgres will not. Worth a look now that a
route depends on it.

**A third thing inherited, and this one is a defect you must fix in this task, because this task is what
makes it reachable.** The `Idempotency-Key` header is used unvalidated. `key` is
`` `${scope}:${clientKey}` `` and the column is `@PrimaryColumn({ type: 'varchar', length: 200 })`
(verified in `entities/ops/idempotency-key.entity.ts`), so with the `checkout:orders:` prefix eating 16
characters, **any client sending a key longer than 184 characters gets a 500.** The insert fails with
SQLSTATE `22001` (*value too long*), `claim()` only recognises `23505`, so it rethrows and the request dies
as an Internal Server Error — an alarm-worthy log line for what is plainly a client error. Express accepts
headers far longer than this by default, so it takes no malice to reach: **validate the header** (a length
cap, rejected as `400`) before it is concatenated into the key.

While you are there, note what was checked and is **not** a problem, so you do not spend the time twice:

- **The SQLSTATE check works against real Postgres.** `(error as { code?: string }).code` looks like it
  would only ever hold for a hand-rolled fake, but pg assigns `message.code = fields.C` as a plain own
  property (`pg-protocol/dist/parser.js:308`) and `QueryFailedError` spreads every own enumerable driver
  property except `name` onto itself (`typeorm/error/QueryFailedError.js`). So `.code` is genuinely there.
  Given the raw-`UPDATE` hazard in the preamble, assume nothing of this kind is safe unless someone has
  looked — for this line, someone has.
- **The scoping mechanism is real.** `key` is the primary key and `scope` is only a column, exactly as the
  interceptor's comment claims, so the uniqueness that serialises two concurrent requests comes from the
  composite string and the subclass-per-scope approach below is what keeps features apart.

### The interceptor cannot be applied as Task 1 wrote it

`IdempotencyInterceptor`'s constructor is `(keys: Repository<IdempotencyKey>, scope: string)`. Nest
cannot inject a plain string, so `@UseInterceptors(IdempotencyInterceptor)` will not resolve, and
`@UseInterceptors(new IdempotencyInterceptor(...))` has no repository to hand it. This is a real gap in
Task 1, discovered by trying to use it — do not work around it by making the scope a hardcoded constant
inside the interceptor, which would put every future feature in one namespace and defeat the column.

The small fix is a subclass per scope:

```ts
// backend/src/modules/checkout/checkout-idempotency.interceptor.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { IdempotencyInterceptor } from '../../common/http/idempotency.interceptor';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';

/**
 * `IdempotencyInterceptor` bound to spec §10.4's `checkout:orders` scope.
 *
 * A subclass rather than a factory provider because `@UseInterceptors()` takes a class or an instance,
 * and a string-token provider is neither. One of these per scope keeps the namespace explicit at the
 * route rather than hidden in a module.
 */
@Injectable()
export class CheckoutIdempotencyInterceptor extends IdempotencyInterceptor {
  constructor(@InjectRepository(IdempotencyKey) keys: Repository<IdempotencyKey>) {
    super(keys, 'checkout:orders');
  }
}
```

- [ ] **Step 1: The controller**

```
@Post('coupon/preview')  @HttpCode(200)  — read-only, so 200 not 201. Open to guests (@Public + @OptionalUser),
                                           because the checkout page is reachable anonymously.
@Post('orders')          @HttpCode(201)  — @Public + @OptionalUser for the same reason; a guest places
                                           orders. @UseInterceptors(CheckoutIdempotencyInterceptor).
```

Four decisions to get right, each of which has bitten this codebase already:

- **`@OptionalUser()`, never `@CurrentUser()`.** Both live in
  `common/auth/decorators/current-user.decorator.ts` — `CurrentUser` at `:11`, `OptionalUser` at `:33`, so
  the import is one path, not two. On a `@Public()` route the strict decorator **throws** —
  Plan 2's Task 20 measured it as a 500 on every guest request. And `JwtAuthGuard` returns before passport
  on a public route, so a signed-in customer's session is only recognised because that guard was fixed to
  attempt authentication and swallow only the failure. Both facts are load-bearing here: placement must
  find a signed-in customer by id and a guest by cookie.
- **Preview is `POST`, not `GET`** — it must not be cached, and it acts on the caller's server-side
  basket rather than on anything in the URL.

  **Correction, because the original reasoning here was unbuildable.** This said the request "carries the
  basket-derived category ids and channel". It cannot: `CartLine` carries `id, slug, mode, size?, grams?,
  kg?, qty` and **no price and no `categoryId`** — its own docblock says prices are resolved live on every
  read — so the client has a coupon code and nothing else. And it *must not* carry them even if it could:
  a client-supplied subtotal is what decides `minOrderValuePaise` eligibility and a client-supplied
  category is what decides which lines a `CATEGORY` coupon discounts, so accepting either lets a caller
  unlock a coupon against a basket they do not have — precisely what §13's *"client-supplied money is
  ignored entirely"* forbids. **`PreviewCouponDto` is `{ code }` alone**, and the basket comes from the same
  server-side cart `place` reads, so the preview and the placement measure one basket the same way.
- **The interceptor goes on placement only.** A replayed preview is harmless and costs nothing; a
  replayed placement is a second order.
- **`201` on placement.** The frontend's success route keys on the created order, and a `200` would make
  "created" and "already existed" indistinguishable — which the interceptor's replay makes a real
  distinction rather than a theoretical one.

  **But know what the replay actually restores, because it is less than the schema suggests.**
  `statusCode` is **written and never read**: the interceptor stores it in `tap.next`
  (`idempotency.interceptor.ts:72,79`) and `claim()` returns `existing.responseBody` alone, so a replayed
  request is answered by `of(replay)` and takes its status from the route's own `@HttpCode(201)`. For
  placement the two coincide, so nothing is broken today — but the column implies a guarantee the code does
  not provide, and **a test asserting "the replay returns the original 201" would pass without the stored
  value being consulted at all.** That is the plan's recurring failure mode, so if Task 10 wants to pin the
  replay, pin the **body** (the same order number, and exactly one order row), which is the thing the
  mechanism actually protects. Leave the column alone; it costs nothing and a later route may read it.

- [ ] **Step 1b: Make `codEnabled` mean something**

Task 6 found this and left it, correctly, as out of its scope. Measured: `codEnabled` is written by
`settings.seed.ts:34` as `true` and **read by nothing at all** — `grep -rn codEnabled backend/src
frontend/src shared/src` returns that one line. Meanwhile `onlinePaymentEnabled` is seeded `false` and
`"online"` is refused unconditionally by §10.4.

So the only payment method the shop accepts is governed by a switch with no effect. An admin who turns
COD off changes nothing, and believes they have stopped taking orders.

Read it, and refuse `cod` with `422 PAYMENT_METHOD_UNAVAILABLE` when it is false — the same code
`"online"` gets, because from the customer's side it is the same fact. `ErrorCodes` already carries that
code (`common/errors/domain-error.ts:44`) and `checkout.service.ts:146` already throws it for `"online"`,
so this adds a second reason, not a new code.

**Where to read it from, decided — because there is no obvious home and improvising one will be wrong.**
Verified: there is **no `SettingsService`**. The only reader of `Setting` rows is
`CartReadService.shippingSettings()` (`cart-read.service.ts:454`), and `CheckoutService` reaches it as
`this.cartRead.shippingSettings()` (`checkout.service.ts:442`). That method's own docblock explains why it
is public: *"reading the rows itself would be the third copy of the free-shipping threshold in this
codebase rather than the second."* That argument is about a duplicated **number**. It does not extend to a
payment flag, and a `codEnabled` read does not belong on the cart's read service.

So: **create `backend/src/modules/settings/settings.service.ts`** with one method —

```ts
async payment(): Promise<{ codEnabled: boolean; onlinePaymentEnabled: boolean }>
```

— reading both rows in one query and falling back the way `shippingSettings` does (`typeof row?.value ===
'boolean' ? row.value : fallback`; fall back to `codEnabled: true`, `onlinePaymentEnabled: false`, which is
the seeded state and the safe default in each direction: a lost row must not stop the shop taking COD, and
must not switch online payment on). Inject it into `CheckoutService` as a seventh collaborator.

**Do not move `shippingSettings()` in this task.** It is proven by Task 6's and Task 7's green suites and
migrating it would put cart tests in the blast radius of a checkout task for no gain today. Two settings
readers coexisting is recorded debt, not an oversight: **Milestone 8 folds `shippingSettings()` into
`SettingsService`**, alongside the hardcoded copies in `frontend/src/config/settings.ts` and
`PincodeChecker.tsx` that the same docblock already assigns to Milestone 8.

**One thing this deliberately does not fix.** `codEnabled` is seeded `isPublic: true`, but **no endpoint
exposes public settings** — verified: outside the entity, the migration and the seed, `isPublic` is read by
nothing in `backend/src`. So a client cannot discover that COD is off; it finds out by trying to check out
and receiving the 422. That is acceptable — the server refusal is the thing that actually matters, and it
is what this step adds — but **Task 13 must not invent a public-settings endpoint to hide the COD radio.**
The form keeps offering COD; the server is authoritative. A `GET /settings/public` is Milestone 8's.

**Both settings false is a coherent state, not a contradiction to guard against.** It means the business
is not taking orders, which is a legitimate thing for an admin to want — a supply failure, a holiday, a
pricing error being fixed. The important thing is that the *message* says so rather than the request
failing obscurely, and that the checkout page does not offer a method the server will refuse. Do not add
a rule forcing at least one method on; that would take the decision away from the person whose decision
it is.

Read both settings once per request, from the same `Setting` rows `CartPricingService` already reads —
not from a constant, and not from the DTO.

- [ ] **Step 2: Controller unit spec**

Hand-built controller tests cannot see decorators, which is how Plan 2 shipped a wishlist route with no
`@Get` at all — 349 unit and 155 integration tests green over a 404. So this spec reads Nest's metadata
directly, the way `wishlist.controller.spec.ts` now does:

```
declares POST checkout/orders and POST checkout/coupon/preview   — PATH_METADATA + METHOD_METADATA
placement carries the idempotency interceptor                     — INTERCEPTORS_METADATA
placement answers 201 and preview answers 200                     — HTTP_CODE_METADATA
both resolve an optional user, not a required one                  — ROUTE_ARGS_METADATA, run the factory
                                                                     against a user-less context
```

That last one is the only thing that can catch `@CurrentUser()` on a public route: `tsc` is silent
because a param decorator's return type is not the declared parameter type.

- [ ] **Step 3: Wire and verify**

`CheckoutModule` imports `TypeOrmModule.forFeature([...])` for what it injects, plus `CartModule`.
Register it in `app.module.ts`, which today registers eight feature modules and **neither a checkout nor an
orders module** — nothing Tasks 3 to 6 built is wired yet, so this is the task that first puts any of it
behind a URL.

**Two corrections to the sentence above, both of which would otherwise stop you at bootstrap.**

**`CartModule` does not export what `CheckoutService` injects.** Measured: it provides `CartService`,
`CartReadService` and `CartPricingService` but its `exports` array holds **`CartService` alone**
(`cart.module.ts`), while `CheckoutService`'s constructor takes all three. Importing `CartModule` therefore
resolves one of them and Nest refuses to start on the other two. **Add `CartReadService` and
`CartPricingService` to `CartModule`'s `exports`** — one line, and extend the module's docblock, which
currently explains only why `CartService` is exported. Do **not** re-provide them inside `CheckoutModule`:
that resolves too, by creating a second instance of each, which is the wrong fix and the kind that reads as
correct for years. (Task 7's probe module *did* re-provide them, deliberately, because a test module must
not mutate a production one to work — that is not a precedent for production wiring.)

**There is no `OrdersModule` to import, and the mapper does not need one.** `OrdersModule` is created in
Task 17, two milestones' worth of tasks later, so an import of it here cannot resolve. It is also
unnecessary: `order.mapper.ts` follows `cart-line.mapper.ts`, which exports **plain functions** —
`cart-read.service.ts:18` imports `{ cartLineId, toCartLine }` directly, with no DI — so `toAccountOrder`
is a function import, not a provider.

**And once it exists, do not hand it what `place()` returns.** Found while building the mapper, verified:
`place()` builds its draft with `items`, calls `save(draft)` (`checkout.service.ts:237`), inserts the first
`pending` `OrderEvent` **separately and afterwards**, and then `return order`. So the returned entity's
`events` is `undefined` — while TypeORM types `Order.events` as a non-optional `OrderEvent[]`, so
`toAccountOrder(await checkout.place(...))` **typechecks perfectly and answers with `timeline: []`**, and
`OrderTimeline.tsx` renders an empty `<ol>` without complaint. A brand-new order would show a confirmation
with no history at all. **Reload the order with its relations after placement** — or return the reloaded
entity from `place()` — rather than passing the `save()` result to the mapper. The mapper now throws on an
order whose `items` or `events` are unloaded, so this fails loudly rather than shipping a blank timeline;
that guard is the reason you will find out immediately, not the reason you can skip the reload.

**The mapper file must exist, so Task 16 has to run before this task.** `POST /checkout/orders`
answers with `PlaceOrderResult`, which is `AccountOrder` (Task 11), and the only thing that produces that
shape is Task 16's `toAccountOrder`. Execute **Task 16 immediately before Task 9**, then continue in
numeric order; the numbering is left alone because every cross-reference in this plan depends on it.

**Do not verify with `npx eslint .`** — there is no root config and ESLint 9 exits **0** when it cannot
find one, so it reports success while linting nothing. Use `npm run lint -w backend`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/checkout backend/src/app.module.ts
git commit -F - <<'MSG'
feat(checkout): expose coupon preview and idempotent order placement
MSG
```

---

## Task 10: Checkout integration tests

Everything above proven against real Postgres, over HTTP. Task 7's concurrency file stays separate; this
one is the ordinary-request suite.

**Files:**
- Create: `backend/test/integration/checkout.integration.spec.ts`

Copy the harness shape from `cart.integration.spec.ts` — verified line numbers, so you need not hunt:
`useIntegrationApp()`, the seeders in `beforeEach`, a `signedIn()` helper, the `guest()` helper at
**`:101`** that **primes with a `GET` first**, and the throttler reset at **`:68`**, which reaches
`ThrottlerStorage` and calls `onApplicationShutdown()`. All four exist there for reasons already paid for:

**Four things only an HTTP request can prove, all of them measured once by hand during Task 9 and then
deliberately thrown away so they would be written here as assertions rather than counted as coverage:**

```
POST /checkout/orders without X-CSRF-Token           -> 403, and no order row
the interceptor is actually mounted on the route     -> a replay returns the same order
an Idempotency-Key over the cap                      -> 400, naming the header, not a 500
DTO validation runs                                  -> forbidNonWhitelisted and @IsIn(['cod']) answer 400
```

The second is the subtle one. `checkout.module.spec.ts` proves the container *can* build the interceptor
and `checkout.controller.spec.ts` proves the decorator is *present*, but neither proves
`InterceptorsContextCreator` found it when the route was built — **that failure is silent by
construction**, and only a request through the router can see it. The fourth is unreachable in a controller
spec at all: calling a handler directly never runs a pipe.

**Re-prove the two concurrency outcomes over HTTP here.** Task 7's proofs call `place()` directly through
a probe module, with no controller, no guards and no interceptor in the path — so they establish that the
*service* serialises and say nothing about what a client actually receives. The oversell race in
particular must be re-run through `POST /checkout/orders` at least once, asserting **201 and 409** rather
than the service's `DomainError.getStatus()`; Task 7 explicitly could not assert a 201 because no HTTP
layer existed yet. This is also the first point at which the idempotency interceptor sits in front of the
decrement, so a replayed key must not decrement twice.

- **A cold write is a 403 and that is correct.** `CsrfGuard` needs a cookie *and* a matching header on
  every method but GET/HEAD/OPTIONS, and `csrfBootstrap` sets `nn_csrf` on the *response*. Nine of Plan
  2's drafted cases assumed otherwise and were 403s until fixed.
- **Login is 5 per 15 minutes per IP.** A spec that signs in repeatedly from 127.0.0.1 hits 429 around
  the fifth test; Plan 2 measured 4 failures from omitting the reset.

### Cases

**Placement, happy path**

```
places a COD order from the server's cart, and returns it
  -> 201, orderNumber matches /^NN-\d{4}-\d{6,}$/
  -> the order's money equals GET /cart's totals, field for field, minus the discount
  -> one OrderItem per cart line, each with name, hsn, detail and gstRate filled
  -> addressSnapshot holds what was posted
  -> exactly one OrderEvent, status pending, actorUserId null
  -> a Payment row, PENDING, amountPaise = totalPaise
  -> the cart is empty afterwards
  -> onHand fell by exactly the ordered quantity, and one SALE row exists per line
  -> SUM(inventory_transactions.delta) = onHand for every touched variant
```

The money assertion is the important one: compare against `GET /cart` rather than against numbers typed
into the test. Hardcoded figures pass while the server and the cart page disagree, which is the whole
class of bug §8 exists to prevent.

**And the same again with no session, because that is the ordinary retail path.** Neither `/checkout` nor
`/order-success/$id` is guarded in the frontend, so most orders this shop takes will be placed by someone
who never signed in:

```
places an order as a guest, carrying only the nn_guest_token cookie
  -> 201, and the stored order's userId is null
  -> the basket emptied is the one the cookie owns, not some other cart
  -> every field the confirmation screen renders is populated in the response body:
     items, timeline, status, subtotal, discount, gst, shipping, total, address
```

That last assertion is load-bearing rather than pedantic. Tasks 13 and 23 make a guest's confirmation
screen read the **placement response** — they have to, since a guest cannot re-fetch a `userId: null`
order — so a field the mapper leaves `undefined` is a broken confirmation for every guest, and the account
read that would otherwise have caught it is one a guest never reaches.

**Placement, refusals** — each naming what is wrong, not a bare failure

```
422 CART_EMPTY when there is no cart
422 PAYMENT_METHOD_UNAVAILABLE for "online"          <- and assert the DTO also refuses it
422 PINCODE_NOT_SERVICEABLE for a 0- or 9-prefixed pincode
422 for a quoteOnly product in the basket             <- corporate-gift-box
409 OUT_OF_STOCK naming the item when a line exceeds stock
   -> and assert nothing was written: no order, no ledger row, onHand unchanged
```

That last assertion is the one people skip. A transaction that half-committed would show a 409 *and* a
decrement, and only a row count catches it.

**Idempotency** — the four cases Task 1's unit spec could not reach

**Compare fields, never serialised bodies.** Measured live: the first response's keys come out in entity
order and the replay's come back in `jsonb` round-trip order (`{"id","email","channel",…}` versus
`{"id","gst","email","items",…}`). The two are semantically identical and byte-different, so
`JSON.stringify(a) === JSON.stringify(b)` fails for a reason that has nothing to do with idempotency.

```
the same Idempotency-Key replays the first order and creates no second
  -> both responses identical, SELECT count(*) FROM orders = 1, onHand fell once
the same key with a different body is 409
a different key places a second order
no key at all still works
```

The first is the whole reason the interceptor exists: a double-clicked Place Order must not decrement
stock twice.

**Coupon preview**

```
previews a percentage discount against the caller's own cart
refuses below the minimum, and the response carries the shortfall
refuses the wrong channel
a guest may preview a firstOrderOnly coupon        <- the decision recorded in Task 4
```

**Two traps inherited from Milestone 5's earlier tasks, both measured:**

- **`cleanDatabase`'s `TRUNCATE … RESTART IDENTITY` does not reset `order_number_seq`.** A standalone
  sequence is owned by no table, so values carry across `beforeEach`. Harmless until a test asserts a
  *specific* order number — then it passes alone and fails in suite order. Assert the **pattern**, or
  capture the number the response returns; never a literal.
- **No integration test observes the sequence at all** as of Task 2, and `schema-invariants` asserts on
  tables, columns, constraints and indexes but never on sequences — read rather than assumed. This suite
  is the first thing to exercise it.

- [ ] **Prove every case can fail.** Break the behaviour, capture the failure, restore byte-identically.
Two specifically worth reporting: whether the `SALE`-row assertion fails when the ledger insert is
removed, and whether the `nothing was written` assertion fails when the rollback is removed. Those two
are the invariant's only guards.

---

## Task 11: The placement wire types

`shared/src/types/order.ts` already holds `Address`, `SavedAddress`, `OrderEvent`, `OrderLine`,
`PaymentMethod`, `PaymentStatus`, `AccountOrder` and `OrderFilters`. **`AccountOrder`, `OrderEvent` and
`OrderLine` do not change** — the account screens and `OrderTimeline` already render them, and Milestone
6 returns exactly these.

Add only what placement needs:

```ts
/** What `POST /checkout/orders` accepts. Deliberately carries no lines and no money — see Task 6. */
export interface PlaceOrderRequest {
  shipping: Address;
  paymentMethod: PaymentMethod;
  couponCode?: string;
  companyName?: string;
  gstin?: string;
  poNumber?: string;
  billingSameAsShipping?: boolean;
  billing?: Address;
  specialInstructions?: string;
}

/** What it returns: the created order, in the same shape the account area already renders. */
export type PlaceOrderResult = AccountOrder;

/**
 * What `POST /checkout/coupon/preview` returns. A reason, never a bare boolean — see Task 4.
 *
 * **This is the shape Task 9 actually shipped, lifted verbatim** — the sketch that stood here before was
 * written ahead of the endpoint and had drifted from it in four ways: the eligible branch's field is
 * `couponCode`, not `code`; it also carries `eligibleSubtotal`; the refusal branch carries **no** code
 * field at all; and the reason is a six-value coupon vocabulary, not the three codes plus
 * `CartValidationCode` that were guessed. `CartValidationCode` is the *cart's* vocabulary and has no
 * business here.
 */
export type CouponRefusalCode =
  | 'COUPON_INVALID'
  | 'COUPON_EXPIRED'
  | 'COUPON_NOT_APPLICABLE'
  | 'COUPON_MIN_ORDER_VALUE'
  | 'COUPON_FIRST_ORDER_ONLY'
  | 'COUPON_LIMIT_REACHED';

export type CouponPreview =
  | {
      eligible: true;
      /** The coupon's canonical, stored spelling — `save10` typed, `SAVE10` returned. */
      couponCode: string;
      discount: number;
      /** What the discount was taken from: the whole subtotal, or a category's share of it. */
      eligibleSubtotal: number;
    }
  | {
      eligible: false;
      reason: CouponRefusalCode;
      /** Only on `COUPON_MIN_ORDER_VALUE`: the figure the customer has to reach, in rupees. */
      minOrderValue?: number;
    };
```

### Move `ORDER_NUMBER_PATTERN` here too — it is in the wrong workspace, and the frontend has already drifted

Found by auditing Task 2's committed code. The authoritative pattern lives in the **backend**
(`modules/orders/order-number.ts:10`) as `` /^NN-\d{4}-\d{6,}$/ ``, and the `{6,}` is a deliberate
decision with its reasoning recorded: *"the millionth order legitimately carries seven, and a pattern that
refused it would make the format claim expire silently rather than the number."* The sequence starts at
100000, so that is 900,000 orders away — distant, but the decision has already been contradicted.

Four other places spell the format out, and **one of them is a live assertion, not prose**:

| Where | Says | |
| --- | --- | --- |
| `modules/orders/order-number.ts:10` | `\d{6,}` | **authoritative** |
| `frontend/src/test/routes.smoke.test.tsx:1075` | `/^Order ID: NN-\d{4}-\d{6}$/` | **an assertion that will fail** where the backend deliberately succeeds |
| `shared/src/types/order.ts:55` | "`NN-{year}-{6 digits}`" | docblock on `AccountOrder.id` |
| `entities/commerce/order.entity.ts:29` | "`NN-{year}-{6 digits}`" | docblock |
| `modules/orders/mappers/order.mapper.ts:184` | "`NN-{year}-{6 digits}`" | docblock |

The root cause is structural rather than careless: the pattern sits where the frontend **cannot import
it**, so the smoke test had no option but to hand-write a regex, and hand-written copies drift. Move
`ORDER_NUMBER_PATTERN` into `shared` alongside these types, re-export or re-point the backend's uses, and
have Task 13 use the imported constant in that assertion instead of a literal. Correct the three docblocks
to "at least six digits" while you are there — they are the reason someone would write `{6}` again.

**Move the compile-time guard with the type, or moving it is a downgrade.** `coupon.service.ts` carries

```ts
const _refusalCodesExist: Record<CouponRefusalCode, ErrorCode> = { COUPON_INVALID: ErrorCodes.COUPON_INVALID, … };
void _refusalCodesExist;
```

which checks **both** directions: a code added to the union with no registry entry is a missing property,
and a registry rename is an unknown one. Without it a client branches on a string the server has stopped
sending and nothing fails. `ErrorCodes` lives in `backend/src/common/errors/domain-error.ts` and `shared`
cannot import it, so the guard **stays in the backend** while the type moves — keep it, re-pointed at the
`shared` import. The two declarations in `checkout.controller.ts` (`CouponPreviewResponse`) and
`coupon.service.ts` (`CouponRefusalCode`) both collapse into this one; `coupon.service.ts:36-37` says
explicitly that it is waiting for this task.

Two notes:

- **`PlaceOrderResult` is `AccountOrder`, not a new shape.** The success screen and the order-detail
  screen render the same order, so a separate "created order" type would be a second definition of the
  same thing — and the one that drifts. Task 23 depends on this.
- **Money on the wire is rupees**, per §8's boundary rule, so `discount` is a `number` here while
  `discountPaise` is a `bigint` in the service. The mapper is the only place that converts.

**Every field above was checked against the DTO Task 6 actually built, and they match** — all nine of
`PlaceOrderRequest` exist on `PlaceOrderDto`, including `poNumber` (`:128`) and `billingSameAsShipping`
(`:130`), which are easy to miss because that file mixes two declaration styles: most fields span several
lines, those two carry their decorators inline on one. `checkout.service.ts:219` and `:224` consume them.
`CartValidationCode` comes from `shared/src/types/cart.ts:87`, so this is a cross-file import.

Run `npm run build -w @nutwala/shared` after editing — both workspaces typecheck against `dist/`.

---

## Task 12: The pincode seam, and the smoke test that pins the wrong answer

Where disagreement 1 gets settled in the open.

**Files:**
- Modify: `frontend/src/features/checkout/api/index.ts` — `checkPincode` over `http`
- **Create: `frontend/src/test/checkout-api.stub.ts`**, exporting `handleCheckoutRequest`, and delegate to
  it from `auth-api.stub.ts` alongside the other three handlers — see **"There is no MSW"** in the
  preamble. **This task is the first to need it, not Task 13.** `checkPincode` is the first checkout seam
  to leave the mock, so without the stub the smoke suite fails with *"api stub received an unexpected
  request: POST /api/v1/checkout/pincode"* — which is the dispatcher working as designed, not a bug to
  hunt. Task 13 then extends the same file for placement and coupon preview.
- Modify: `frontend/src/test/routes.smoke.test.tsx`
- Create: `backend/src/modules/checkout/dto/check-pincode.dto.ts` and the route

**`POST /checkout/pincode`, not `GET /checkout/pincode/:pincode`.** Spec §6.1 line 361 lists it as a
`POST` — *"serviceability + ETA + shipping"* — and it is in the **public** block, which is right: the
checker sits on the product page, reachable anonymously. A `GET` with a path parameter would be more
natural for a six-digit lookup and would cache, and it is still not worth deviating: the spec is what the
admin repository's developers will read, `POST /checkout/coupon/preview` beside it is already a POST for
the same reason, and gratuitous divergence costs more than the elegance buys. If you do want the `GET`,
change §6.1 in the spec and record it there the way §5.3's `guest_token` deviation is recorded — do not
leave the two documents disagreeing.

`PincodeChecker.tsx` is the only consumer, and it is on the product page rather than checkout.

**The test that must change, and why it is a change rather than a fix.** The assertions are at
`routes.smoke.test.tsx:269` and `:274` (the test opens at `:261`):

```
:267  types 560001  ->  :269  /Delivers to 560001 in \d working days\./
:272  types 110001  ->  :274  "We don't deliver here yet."
```

There is a **second** `560001` at `:1065`, inside the checkout-form test rather than the product-page
checker. Only the pincode-checker assertions above are wrong; the checkout one is about the form's own
field and does not assert serviceability. Do not change it by search-and-replace.

The second assertion encodes `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/`, which refuses every Delhi
pincode. The seeded table says prefix `'1'` **is** serviceable at 4 days. Refusing to deliver to Delhi is
not a behaviour worth preserving, so the table wins and the assertion moves — to a `'9'`-prefixed
pincode, which the table genuinely refuses.

Record the change in the test's own docblock with both values, because a future reader finding a Delhi
pincode in a git blame needs to know it was deliberate. **Do not** change the seed to match the mock.

---

## Task 13: `CheckoutForm` sends what it validates

Where disagreement 2 gets settled. Today `onSubmit` validates seven fields and discards every one of
them: `couponCode`, `paymentMethod`, `companyName`, `gstin`, `poNumber`, `billing` and
`specialInstructions` are all checked and then dropped (`CheckoutForm.tsx:132-141`).

**Files:**
- Modify: `frontend/src/features/checkout/api/index.ts` — `placeOrder` posts, `saveOrder`/`getOrder` and
  the `sessionStorage` receipt are **deleted**
- Modify: `frontend/src/features/checkout/components/CheckoutForm.tsx`
- Modify: `frontend/src/features/checkout/schema.ts`
- Modify: `frontend/src/config/settings.ts` — the two payment flags, per the first step below
- Modify: `frontend/src/test/checkout-api.stub.ts` — **created in Task 12**, which needed it first for the
  pincode route. Add `POST /checkout/orders` and `POST /checkout/coupon/preview` to the same
  `handleCheckoutRequest`; do not add a second installer, for the reason in the preamble's **"There is no
  MSW"**.
- Modify: `frontend/src/test/routes.smoke.test.tsx`

- [ ] **Gate both payment cards on their settings — and read those settings from the frontend config,
  not from the server.** `onlinePaymentEnabled` is seeded `false` and `codEnabled` `true`, and Task 9
  makes the server enforce both. The form must not offer a method the server will refuse — a customer
  choosing Pay Online and meeting a 422 has been shown a door that was never open. And if an admin turns
  both off, the checkout page should say the shop is not taking orders rather than rendering an empty
  payment section.

  **But there is no endpoint to read them from, and you must not build one.** Verified: `isPublic` is read
  by nothing in `backend/src`, so no route exposes public settings, and `frontend/src/config/settings.ts`
  carries no payment fields either — `SiteSettings` has thirteen and none concern payment. So **add
  `codEnabled: boolean` and `onlinePaymentEnabled: boolean` to `SiteSettings`**, defaulting `true` and
  `false` to match the seed, and gate the cards on those. That is exactly what that file is for: its own
  docblock reads *"Values an admin will own in Phase 3. Nothing here may be hardcoded in a component"*,
  and `freeShippingThreshold: 999` already sits there as the same kind of placeholder for a row the
  database also holds. Milestone 8 swaps the config read for a real `GET /settings/public`; until then the
  server's 422 is the actual enforcement and this is only merchandising.

  **Type them as `boolean` on the interface, never as literals.** `settings` is annotated `: SiteSettings`,
  so `true` widens to `boolean` and the both-off branch stays reachable — which is what makes the "not
  taking orders" empty state testable instead of dead code a reader has to trust.

- [ ] **`cod` becomes the default.** Verified: `:113` reads `paymentMethod: "online"`, which spec §10.4
  requires the server to reject with 422. Today the field is discarded so the default is harmless; the moment it is sent, the
  happy path 422s. Gate the "Pay Online" card on the `onlinePaymentEnabled` setting — seeded `false` —
  rather than deleting it, so enabling online payment later is a settings change and not a form rewrite.

- [ ] **One `Idempotency-Key` per attempt, not per render.** `crypto.randomUUID()` held in a ref, reset
  only after a *successful* placement. Generating it inside `onSubmit` gives every click a fresh key and
  defeats the interceptor entirely — which is the failure this whole mechanism exists to prevent, arrived
  at from the other end.

- [ ] **Do not post the form object. Strip the empty-string optionals first, or every B2C order 400s.**
  This is the first thing that will break, and it will break the happy path, so deal with it before
  anything else. Verified on both sides:

  `CheckoutForm`'s `defaultValues` (`:110-119`) initialise **every** optional field to `""` —
  `couponCode`, `companyName`, `gstin`, `poNumber`, `specialInstructions`. And `@IsOptional()` in
  class-validator skips the remaining decorators only when a value is `undefined` or `null`; an empty
  string is a *present* value, so they all run. On `PlaceOrderDto` that means:

  | Field | Validators | `""` |
  | --- | --- | --- |
  | `companyName` | `@IsString() @MinLength(2) @MaxLength(160)` | **fails `MinLength(2)`** |
  | `gstin` | `@Matches(GSTIN_REGEX)` | **fails the pattern** |
  | `poNumber` | `@IsString() @MaxLength(60)` | passes |
  | `specialInstructions` | `@IsString() @MaxLength(2000)` | passes |

  **Corrected after measurement — the table above is right and the conclusion drawn from it was wrong.**
  The missing link is that `zodResolver` hands `onSubmit` zod's **parsed** output rather than the form's raw
  values (`values: i.raw ? … : …`, with `raw` defaulting false), and `z.object()` runs in **strip** mode.
  So under `b2cCheckoutSchema` — which declares only `shipping`, `couponCode` and `paymentMethod` — the
  B2B fields are stripped before `onSubmit` sees them, and a retail order **cannot** 400 on `companyName`
  or `gstin`. Measured with the spread applied: the retail body carried `shipping.line2: ""` and
  `couponCode: ""` and was accepted; the bulk body carried eight keys including three empty strings, also
  accepted, because `poNumber` and `specialInstructions` carry only `@MaxLength`.

  **The defect is real but narrower: what survives stripping is whatever the active schema declares.** So
  `line2: ""` and `couponCode: ""` do reach the server and *are stored* — `toSnapshot` omits only
  `undefined`, so an untouched second address line becomes an empty string on the invoice snapshot — and
  `billingSameAsShipping: true` is sent for a field the service reads only when it is `false`. Build the
  request by omitting every optional whose trimmed value is `""`, rather than spreading `values`.

  **Trim only where the result is an omission.** `addressSchema`'s `min(2)` accepts two spaces, so
  trimming a *required* field turns `"  "` into `""` against the DTO's `@MinLength(2)` and creates a 400
  the form does not predict — the opposite of the bug being fixed.

  Two smaller notes from the same comparison. `couponCode: ""` is safe by luck rather than design:
  `checkout.service.ts:462` explicitly treats an empty or whitespace code as no coupon. And `line2: ""`
  validates but is *stored*, because `toSnapshot` omits only `undefined` — so an untouched second address
  line becomes an empty string on the invoice snapshot instead of being absent. Strip it with the others.

  **The good news, also verified: the field sets match exactly**, so there is no `forbidNonWhitelisted`
  hazard here. `CheckoutFormValues` and `PlaceOrderDto` carry the same nine fields and their address
  objects agree field for field, which is *not* what happened with the cart — `cart-api.stub.ts`'s
  docblock records `id` and `grams` being rejected outright rather than stripped.

- [ ] **Seed the query cache with the placed order before navigating, or you break guest checkout.**
  This is not an optimisation. Verified: **`/checkout` has no route guard** — `requireCustomer` is used by
  `routes/account/route.tsx` and nowhere else, and `/order-success/$id` is unguarded too — so a guest
  placing an order is the ordinary retail path, not an edge case. Their order is written with
  `userId: null`, and `GET /account/orders/:orderNumber` (Task 17) is session-scoped, so a guest fetching
  their own confirmation gets a **401**. Nothing on the order identifies them either: there is no
  guest-token column on `orders`, so no server-side fix is available inside this milestone.

  What works, and costs nothing: the placement response **is** the order —
  `PlaceOrderResult = AccountOrder`, the exact shape the success screen renders. So after a successful
  `POST`, write it into the cache under the same key Task 23 reads, then navigate:

  ```ts
  queryClient.setQueryData(accountKeys.order(order.id), order);
  await navigate({ to: "/order-success/$id", params: { id: order.id } });
  ```

  **The factory already exists** — `accountKeys.order(id)` at `features/account/hooks/useAccount.ts:8`,
  part of the `accountKeys` object this codebase uses for every other feature (`catalogKeys`,
  `contentKeys`, `rfqKeys`, `wishlistKeys`, `reviewKeys`). Use it, and have Task 23 read the same
  function. Do **not** hand-write the array at either end: two literals that drift by one element give a
  silent cache miss, which for a guest is a 401 on their own confirmation — precisely the bug this exists
  to avoid.

  Note also that `CheckoutForm` currently has **no** `useMutation` and **no** `useQueryClient` — `onSubmit`
  is a plain async function calling `checkoutApi.placeOrder()` directly — so you are adding the client, not
  reaching for one that is already there.

- [ ] **The coupon Apply button calls the server.** Today it is `onClick={() => setCouponNote(true)}` —
  pure local state — and renders *"We will validate this code against your order before it ships."*
  Reassuring, and untrue: nothing validated anything. Call `POST /checkout/coupon/preview`, render the
  discount as a line in the summary on success, and render the *reason* on refusal, because a customer can
  act on `COUPON_MIN_ORDER_VALUE` and cannot act on `COUPON_INVALID`.

  **Six refusal reasons need customer-facing wording, and nothing maps them yet.** `CouponRefusalCode` is
  now in `@nutwala/shared` (commit `eaa51b7`) with six members. Declare a
  `Record<CouponRefusalCode, string>` the way `features/account/status.ts` declares
  `ORDER_STATUS_LABEL: Record<OrderStatus, string>` — typed as a `Record` so a seventh code added to
  `shared` becomes a compile error rather than a blank message. **`COUPON_MIN_ORDER_VALUE` is the one that
  cannot be a plain string**: it is the only arm carrying `minOrderValue`, and the whole reason it exists
  as a distinct code is to tell the customer the figure to reach, so it needs interpolation. The other
  five are constants.

- [ ] **Two lines of copy stop being true the moment this task lands, and one of them is a promise about
  money.** `CheckoutForm.tsx:575` reads *"Payments are simulated in this preview build."* under a
  padlock — accurate while `placeOrder` was a mock, and false as soon as the button places a real COD
  order against real stock. Reword it to what is now true: cash on delivery, nothing charged online.
  (`account/orders/$id.tsx:43`'s *"Available after Phase 2"* invoice tooltip is the other, and Task 19
  already owns it.) Both are the same class of defect as the docblocks this plan has been correcting —
  a statement that was true when written and that nothing fails when it stops being true.

- [ ] **The Shipping section's own ETA and charge, which disagreement 3 condemned and no task was given.**
  The preamble says of the four competing ETAs that *"the three client-side computations go"* — and the
  third of them lives here, at **`CheckoutForm.tsx:620`**: `format(addDays(new Date(), 4), "d MMM yyyy")`,
  a flat four days with no reference to the customer's pincode. Task 12 removes the mock's digit-sum ETA
  and Task 13 removes the mock `placeOrder`'s hardcoded `+4`, but this line had no owner until now.

  **It is about to become a visible contradiction rather than a latent one.** Every seeded prefix carries
  `etaDays: 4`, so today it agrees by coincidence. But that column is per-destination and admin-editable —
  that is the entire argument for its authority — and after this plan `order-success.$id.tsx:99` renders
  the order's *real* `estimatedDelivery`. So the first admin who gives a remote prefix a longer ETA makes
  the checkout page promise a date and the very next screen show a different one.

  The fix is cheap because Task 12 builds the endpoint: the form already collects a pincode, so call
  `POST /checkout/pincode` once it is valid and render the `etaDays` it returns — the same seam
  `PincodeChecker.tsx` already uses. If you would rather not add a request to this screen, delete the
  promise instead and let the confirmation be the first place a date appears; **an absent date is honest
  and a wrong one is not.** Do not leave the hardcoded four.

  **The charge in the same block has the same problem** (disagreement 4). `totals.shipping` comes from the
  cart's flat `flatShippingRate`, while placement bills the pincode row's `shippingPaise` — both ₹79 in
  the seed, and both per-pincode in principle. The same call settles both figures at once.

- [ ] **The summary gains a discount row.** There has never been one. Verified: `mocks/orders.ts:51`
  hardcodes `const discount = 0` in the one helper every fixture's totals go through — so it is a single
  line, not six — and `account/orders/$id.tsx` contains **no occurrence of the word at all**. Note the
  mock's formula is already `subtotal - discount + gst + shipping` (`:52`), so the arithmetic is right and
  only the display is missing. Both need it, or a discounted order displays a total that does not equal its own parts.

  **The order-detail half of this shipped untested, and could not have been otherwise.** Task 13 added
  both rows; deleting the one in `account/orders/$id.tsx` killed **0 of 221** frontend tests, because
  `mocks/orders.ts:51` hardcodes `discount = 0` and `fromReceipt` sets `discount: 0`, so **no fixture can
  express a discounted order** while the account seam is still the mock. Task 19 replaces that seam and
  therefore owns pinning it. Do not close the gap by editing the mock: that moves disagreement 5's
  `₹77,348`, which is Task 18's figure to record.

- [ ] **Keep `isB2b` as it is.** Verified verbatim at `CheckoutForm.tsx:102` —
  `lines.some((l) => l.mode === "bulk") || totals.hasQuoteLines` — and the existing comment
  about using `hasQuoteLines` rather than `hasUnpriceableLines` is correct and hard-won: the broad flag is
  also true for a sold-out pack, and routing that customer to the business track asks a retail buyer for a
  GSTIN. Do not "simplify" it.

The smoke test — *"rejects a bad phone and pincode, then places the order on valid input"*, opening at
`:1047` — pins `/^Order ID: NN-\d{4}-\d{6}$/` at `:1075` and then asserts **both** halves of the cart
emptying at `:1085-1086`: `lastCartWrite()` (the request the client sent) and `storedCart()` (the resulting
state). The order-ID pattern still holds — the sequence produces six digits. **The `lastCartWrite()` half
does not:**
the server now empties the cart inside the placement transaction, so the client no longer sends that
request. Change the assertion to check the cart is empty rather than that the client emptied it, and say
why in the docblock.

---

## Task 14: Milestone 5 verification

- [ ] **Step 1: Every suite**

```bash
cd /Users/kunal/Desktop/nutwala
npm run build -w @nutwala/shared && npm run test -w @nutwala/shared
npm run typecheck -w backend && npm run lint -w backend && npm run test -w backend
npm run test:integration -w backend
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
npm run format:check -w backend && npm run format:check -w frontend
npm run build -w frontend
npm audit --audit-level=high
```

Record what you observe rather than comparing against figures written days earlier. Two reference points,
both measured rather than remembered: the state **entering** this milestone was shared **61**, backend unit
**371**, backend integration **186**, frontend **211**; the state **after Task 10** was shared **61**,
backend unit **524 / 41 suites**, backend integration **194 / 10**, frontend **211 / 13**. The second is
what a regression here would show up against — but if your numbers are *higher*, that is Tasks 11 to 13
having added their own, not an error.

**`npm run build` at the root cannot be run** — it expands to `nest build`, and `nest-cli.json` sets
`deleteOutDir: true`, which deletes the `dist/` the dev server is serving from. Substitute
`npx tsc -p tsconfig.build.json --noEmit` from `backend/`.

- [ ] **Step 2: The migration chain still reverts**

A migration landed, so re-prove it on a **throwaway** container. Use a **literal** port and echo
`DB_PORT` before anything writes: `set -a && . ./.env` exports the dev `DB_PORT` and `PORT=4400` into
your shell, and a parameterised port has already pointed a migration at the user's node server once on
this project. Remember `NODE_ENV=test`, or `load-env.ts`'s `override: true` makes `.env` win.

Revert until nothing remains — a loop, not a fixed count — then confirm `tables=1`, `enums=0`, and
re-apply.

**Statically the chain is already symmetric, so know what a failure here would actually mean.** Checked
across all five migrations: every `CREATE TYPE`, `CREATE SEQUENCE`, `CREATE TABLE` and
`CREATE [UNIQUE] INDEX` in an `up()` has a matching `DROP` in the same migration's `down()` — all 18 enums
in `InitialSchema`, the `order_number_seq` the newest migration adds, and the raw partial index
`uq_addresses_one_default_per_user`. So if `enums=0` fails, the cause is **not** a forgotten `DROP TYPE`;
look instead for something a text comparison cannot see — a type Postgres created implicitly, a drop
ordering that leaves a dependency, or a migration that failed halfway and left the chain part-applied.
Run it regardless: a static check cannot prove Postgres accepts the sequence's `down()`, and this
milestone is the first to add a sequence to the chain at all.

- [ ] **Step 3: Place an order by hand**

The one check no suite performs. With the servers up, as a **guest**: add two bags, check out with a
Bangalore pincode, place a COD order, and confirm the order number, that the cart is empty, that
`SELECT count(*) FROM orders` grew by one, and that `SUM(delta) = onHand` still holds for the variants
you bought. Then click Place Order twice quickly and confirm exactly one order exists.

**Then reload the confirmation page, still signed out.** This is the one manual check that exercises the
guest hole this plan found late: the order carries `userId: null`, `GET /account/orders/:orderNumber` is
session-scoped, and the confirmation renders from the cache Task 13 seeded — so a reload has nothing to
read. Expect the honest third state (the order number, and a line about quoting it or signing in), **not**
"not found", and **not** a 401 rendered as an error. If you see either of those, Task 13's cache seeding or
Task 23's three-state branch is wrong, and no automated suite in this milestone covers it.

Capture the stock figures first and restore them with the audited adjustment endpoint afterwards.
**Never `npm run seed`** — it resets `inventory.onHand` while leaving the append-only ledger, which
breaks the invariant this milestone spends three tasks protecting.

- [ ] **Step 3b: One known gap to close or accept, from Task 10**

Task 10's implementing agent stalled before finishing its mutation matrix. Three mutations were run by
hand and each killed exactly the tests that name the behaviour — the `Idempotency-Key` cap (1/29),
`@UseInterceptors` on the route (6/29, including the replay racing a second client), and the `codEnabled`
gate (1/29). **The refusal and coupon-preview cases are green but unproven**: nothing has shown that
`CART_EMPTY`, `PINCODE_NOT_SERVICEABLE`, `QUOTE_REQUIRED`, `OUT_OF_STOCK` or the four preview cases can
fail. Given this plan's history — every one of the three ways a test here has turned out to prove nothing
was found by mutating, never by reading — either spend twenty minutes deleting each of those guards in
turn and recording the kill, or say plainly in the milestone record that they are unverified. Do not
leave the impression the matrix was completed.

- [ ] **Step 4: Record what actually happened**

Append a "Milestone 5 complete" section with the final counts and anything that turned out differently
from what this plan says. Plan 2's most useful artefact was the list of places its own plan had been
wrong; this one will have its own.

---

# MILESTONE 6 — Account and tracking

Goal: a customer sees the orders Milestone 5 can now create, watches them move, cancels one while that is
still allowed, and manages their own addresses and profile — every read scoped to its owner.

Read spec §6.3 and §13 before starting. The account **screens already exist and already render the right
shapes** — this milestone swaps four seams and deletes a receipt. If you find yourself designing a
screen, stop and re-read the inventory.

## Task 15: `OrdersService` reads, scoped to their owner

Spec §13's IDOR row is the whole of this task. The mock already understood it — `account/api/index.ts:99`
carries the warning verbatim:

> *"`OrderFilters` deliberately cannot carry an email, because a client able to filter by arbitrary
> address is the IDOR hole spec §13 rules out."*

So the wire filter type stays as it is: `OrderFilters { channel? }`. The owner comes from the session and
nowhere else.

**Files:**
- Create: `backend/src/modules/orders/orders.service.ts`, `orders.service.spec.ts`

Two reads:

```
list(userId, filters)          -> newest first, optionally filtered by channel
                                  ALSO loads items and events — see below
findOne(userId, orderNumber)   -> one order with items and events, or null
```

**`list` needs both relations too, which this signature used to imply it did not.** `GET /account/orders`
answers `AccountOrder[]`, `toAccountOrder` **throws** when handed an order whose `items` or `events` are
unloaded, and `OrdersTable.tsx:9` destructures `order.items` to headline the row. So both reads join both
relations. Note the cost this makes explicit: the list page never renders `timeline`, yet every row pays
for an `order_events` join — a real price of the one-mapper decision, and cheaper than the drift a second
summary shape would invite.

**`findOne` returns `null`; the 404 is Task 17's.** The two bullets below sit in tension — a service
returning `null` cannot choose a status code — and the resolution is that the *service* guarantees
indistinguishability (a stranger's order and a nonexistent one produce the identical `null`), so there is
nothing a controller could turn into a 403 even carelessly. Supporting evidence that this is the intended
reading: `ErrorCodes` contains **no `FORBIDDEN` member at all**.

Four things to pin, each of which is a way to get IDOR wrong:

- **`findOne` takes the `userId` in its `where`**, not a post-hoc check. `findOne({ where: { orderNumber } })`
  followed by `if (order.userId !== userId) throw` works and is one refactor away from someone dropping
  the check while the query still succeeds. Put the owner in the query.
- **A wrong owner is a 404, not a 403.** A 403 confirms the order exists, which turns the endpoint into an
  oracle for order numbers — and order numbers are sequential, so an attacker can walk them. The customer
  cannot tell the two apart and does not need to.
- **`orderNumber`, not `id`.** §6.3's route is `/account/orders/:orderNumber`, the column is uniquely
  indexed, and it is the reference a customer quotes to support. A uuid in the URL would be a second
  identifier for the same thing.
- **Guests have no orders.** A guest cart becomes an order owned by whoever placed it, and an anonymous
  placement has `userId: null` — so `list` for a guest returns nothing rather than everything. Assert it;
  a missing `userId` in a `where` clause is how "nothing" becomes "everything".

**`order_items` has no ordering guarantee, so `findOne` must impose one.** Verified: the entity carries no
`position` or `lineNumber` column, and `createdAt` is identical across the cascade insert that writes an
order's lines — so two reads of the same order can return its invoice lines in different orders, and the
only difference a customer sees is their receipt rearranging itself between visits. Add an explicit
`ORDER BY` on the items relation; `id` is the only stable candidate. The mapper deliberately does **not**
sort them, because there is no correct key to sort on at that layer — this is the query's job.

Order by `placedAt DESC`. The composite index `idx_orders_user_placed_at` exists for exactly this query
— verified in the live schema, alongside `idx_orders_status_placed_at` for the admin's filter — and the
entity's own comment says so. Do not add another.

- [ ] Prove the scoping test is load-bearing by giving `list` an empty `where` and confirming the
cross-customer case fails. Note the message it fails with — Plan 2 found a scoping test that failed on
`this.items.find is not a function` rather than on an assertion, which proves the right thing for the
wrong reason and misleads the next reader.

---

## Task 16: `order.mapper.ts` — two vocabularies, one place

> **Run this task before Task 9, not in numeric order.** `POST /checkout/orders` answers with
> `PlaceOrderResult` = `AccountOrder`, and `toAccountOrder` is the only thing that produces it, so the
> HTTP surface cannot be finished until this exists. Nothing else in Milestone 6 is a prerequisite for
> Milestone 5 — this one task is, and only because the placement response and the account read are
> deliberately the same shape. It needs nothing from Milestone 5 in return: the entities, the seeded
> orders and `toRupees` are all already there.

The entities and the wire disagree in two ways, deliberately, and the mapper is the only place that may
know:

| | Entity | Wire |
| --- | --- | --- |
| Money | `bigint` paise (`@PaiseColumn`) | `number` rupees |
| Channel / payment | `UPPERCASE` enums (`RETAIL`, `COD`) | lowercase (`retail`, `cod`) |
| Status | `varchar(24)`, already lowercase-hyphen | the same |

Note the asymmetry: `status` is *already* stored in the wire vocabulary — the check constraint mirrors
`shared`'s 14-value tuple — while `channel` and `paymentMethod` are enums that need lowering. Getting
that backwards produces `RETAIL` on the wire, which every frontend `status.ts` lookup then misses,
rendering an empty badge rather than an error.

**Only one direction of that asymmetry is observable, which is worth knowing before anyone tidies up.**
Measured: all 14 statuses already equal their own `toLowerCase()`, so calling `toLowerCase()` on `status`
is the identity function on every legal input and mutating it away changes nothing — it is killed only by
the *vocabulary check* the mapper performs, not by any value difference. **Uppercasing** is the harmful
direction and dies 18 cases out of 21. So the check that `status` is a member of
`B2C_ORDER_STATUSES ∪ B2B_ORDER_STATUSES` is not belt-and-braces: it is the only thing standing between a
`varchar(24)` column and an empty badge, and if it is ever removed, the lowercase mutation stops being
covered by anything.

**The frontend half of that worry is already closed, so do not add a runtime fallback for it.** Audited:
`features/account/status.ts` declares `ORDER_STATUS_LABEL` and `ORDER_STATUS_VARIANT` as
`Record<OrderStatus, …>`, both covering all fourteen values, and `features/account/types.ts` is a pure
re-export shim — `export type { OrderStatus } from "@nutwala/shared"` — so the exhaustiveness is checked
against the *authoritative* union rather than a local copy that could drift. A fifteenth status added to
`shared` fails to compile at both ends. So the two sides are consistent and both compile-enforced: the
mapper cannot emit a status the badge cannot render, and a `?? "Unknown"` added here would only hide the
compile error that is doing the work. Membership is tested against the **union**, not against the order's own channel — the
database constraint permits a bulk order carrying `packed`, and refusing to *read* a row admin already
saved would take a customer's page down over it.

**Files:**
- Create: `backend/src/modules/orders/mappers/order.mapper.ts`, `order.mapper.spec.ts`

`toAccountOrder(order): AccountOrder`. The pattern already exists — copy `cart-line.mapper.ts` and
`cart-pricing.service.ts`'s use of `toRupees`.

### Two fields the table above does not cover, and they are the two easiest to get wrong

**`AccountOrder.id` is the order *number*, not the primary key.** Its docblock in `shared` says so —
`` /** `NN-{year}-{6 digits}`. */ `` — and the entity carries both `id` (uuid) and `orderNumber`. Mapping
`order.id` typechecks perfectly, because both are `string`. What it produces: an order-success URL holding
a uuid, a `POST /account/orders/:orderNumber/cancel` (Task 20) looking up a value that is not an order
number, and the smoke test's `/^Order ID: NN-\d{4}-\d{6}$/` failing at `routes.smoke.test.tsx:1075`.
Note also that `AccountOrder` has **no field for the uuid** — deliberately. Nothing on the wire needs it,
so nothing on the wire gets it, and every customer-facing route is keyed by the human-readable number.

**`AccountOrder.email` comes from `addressSnapshot.email`, and it is the only source that works.** Traced:
the `orders` table has **no email column**, and `userId` is `nullable: true`
(`order.entity.ts:35-40`) because guest checkout is supported — so `order.user.email` is `undefined` for
exactly the orders a guest most needs to see. The address snapshot is where it lives:
`AddressSnapshot` declares `email: string` (`order.entity.ts:14`) and `toSnapshot`
(`checkout.service.ts:65-76`) copies it in field by field.

**That contradicts a docblock in `shared`, and this task fixes the docblock.** `Address.email` currently
reads *"The owning account's address. Populated by the backend from the session — never trust a
client-supplied value here."* That is not what happens and cannot be: `AddressDto.email` is
`@ApiProperty() @IsEmail()` and **required** (`place-order.dto.ts:39`), the client supplies it, and it must,
because a guest has no session to populate it from. What the sentence is *reaching for* is an
authorization rule, and it is a correct one badly expressed: **the email is data on the order, never a key
that grants access to it.** Rewrite it to say that, and note the consequence Task 17 depends on — a
signed-in customer's order email may legitimately differ from their account email (a gift sent to a
relative, a work address), so **order history is scoped by `userId`, never by matching email strings.**
Filtering by a client-supplied email is the IDOR hole §13 rules out, which is why `OrderFilters` cannot
carry one and why all four `useOrders({ email })` call sites drop the argument in Task 19.

### Three more things to pin

- **`timeline` is oldest first.** `OrderTimeline.tsx` treats the **last** entry as current and its
  docblock says *"The order's own history, oldest first — not a fixed nine-step ladder."* Sorting
  newest-first would render the timeline backwards with the *first* step marked current — and it would
  look plausible, which is worse than looking broken.
- **`AccountOrder.timeline`'s last entry must equal `status`.** `shared/src/types/order.ts:52-53` states
  it as an invariant. Assert it in the mapper's spec over all six seeded orders: 38 events across them,
  covering all 14 statuses, so a single test covers the whole vocabulary.
- **Do not synthesise events.** If an order has one event, the timeline has one entry. The mock's
  `fromReceipt` invented a two-event ladder and that is one of the things this milestone deletes.

---

## Task 17: `GET /account/orders` and `:orderNumber`

**Files:**
- Create: `backend/src/modules/orders/orders.controller.ts`, `orders.controller.spec.ts`
- Create: `backend/src/modules/orders/orders.module.ts`
- Modify: `backend/src/app.module.ts`

Both routes are **authenticated** — `@CurrentUser()` here, not `@OptionalUser()`, because there is no
such thing as a guest's order list and a route that answered `[]` for an anonymous caller would be
hiding a missing guard behind an empty array.

**The threat model needs stating accurately, because the obvious version of it is wrong for this handler
shape.** Swapping in `@OptionalUser()` alone does **not** leak anything: with the handler written as
`this.orders.list(user.id, query)`, a guest hits a `TypeError` on `user.id` and gets a 500. Ugly, but not a
disclosure. The leak arrives with the *repair* someone reaches for next — `user?.id ?? null` turns the 500
into a `200 []`, which is precisely the missing guard hidden behind an empty array; and
`user?.id ?? undefined` reaches TypeORM, where the criterion is dropped and the answer is **every order in
the table** (see the `where`-clause section in the preamble). So the mutation worth keeping in a spec is
not "does the lenient decorator throw" but "is the strict decorator still the one declared". **Tasks 20,
21 and 22 share this handler shape** and inherit the same reasoning.

The controller spec reads Nest's metadata for the same reason Task 9's does. Include the pairing that
Plan 2's missing-route incident makes worth stating: **`@Get(':orderNumber')` must be declared after any
literal `@Get('...')` sibling**, or the parameterised route swallows it. There is no literal sibling today
— which is precisely when someone adds one and cannot work out why it 404s.

`orders.module.ts` **exports `OrderStatusService`**, so the admin plan in the separate repository wires
its status screens to this implementation rather than writing a second one.

**Two things a module spec must do that the obvious version does not.**

`moduleRef.get(OrderStatusService)` **cannot** prove the export: `TestingModule.get` is non-strict by
default and reaches unexported providers of imported modules, so it passes with `exports` emptied. Prove
it by *consuming* the provider from a probe module that imports `OrdersModule` — that is the only
construct here that distinguishes exported from merely provided.

And assert that `AppModule` actually imports the module. Task 17 measured the gap: deleting
`OrdersModule` from `AppModule.imports` left `typecheck` clean, `eslint` clean and **all 568 unit tests
passing**, while both endpoints would 404 in production — because every routing-table assertion reads the
*controller's* metadata, and a controller Nest was never told about still carries it. That is the
`GET /wishlist/slugs` incident with the missing piece moved one file up. `Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)` closes it.

---

## Task 18: Order-read integration tests, and the figures that move

Where disagreement 5 is settled with numbers.

**Files:**
- Create: `backend/test/integration/orders.integration.spec.ts`

The seeder is the fixture: **six orders, 38 events, 14 distinct event statuses, one `Payment` each** —
verified against the live database, and re-checked against `orders.seed.ts` since: the file holds 44
`status:` literals, which is 38 timeline entries across its six `timeline:` arrays plus the six orders' own
`status` fields, and the 14 distinct values are exactly `B2C_ORDER_STATUSES` (9) ∪ `B2B_ORDER_STATUSES` (8),
which overlap on `processing`, `shipped` and `delivered`. So these tests need no new data, and the
whole-vocabulary claim Task 16 leans on is real rather than optimistic.

### Cases

```
the placement response equals the account read, field for field
                                                   <- one mapper, or the two paths drift
lists a customer's own orders, newest first        <- b2c sees exactly 4, b2b exactly 2
filters by channel, asserted in BOTH directions    <- see the warning below; one direction cannot fail
does not list another customer's orders            <- b2c cannot see the b2b orders
returns one order with its items and its full timeline
404s an order number belonging to someone else     <- not 403; see Task 15
404s an order number that does not exist           <- indistinguishable from the above, deliberately
401s an anonymous caller
the timeline's last entry equals the order's status, for all six seeded orders
every money field is rupees, and equals the paise column divided by 100
```

**The counts, measured, and one of them is a trap.** `b2c@demo.in` owns **four** orders — `005107`
(`out-for-delivery`), `004977` (`cancelled`), `004821` (`delivered`), `004650` (`refunded`) — and
`b2b@demo.in` owns **two**, `005042` (`shipped`) and `004488` (`delivered`). Assert those two numbers, not
six: Task 24's checklist originally expected six for the b2c customer, which is the cross-customer leak
this suite exists to catch, dressed as a pass.

**And every one of a customer's orders is the same channel**, which makes the channel filter
unfalsifiable if you test it the obvious way: all four b2c orders are `RETAIL` and both b2b orders are
`BULK`, so filtering b2c by `retail` returns 4 — exactly what it returns with the filter **deleted**.
Assert the other direction as well: b2c filtered by `bulk` must return **0**, which is the assertion that
actually distinguishes a working filter from an ignored one. This is the plan's most common failure mode
and the seeded data walks you straight into it.

The next case is the one that keeps Task 16 honest. Place an order as a **signed-in** customer, then read
it back through `GET /account/orders/:orderNumber`, and assert the two bodies are deep-equal. Both are
supposed to come from `toAccountOrder`, which is the entire argument for there being one mapper — and if
someone later hand-rolls a second shape on either side, nothing else in either suite notices. It has to be
the signed-in case because a guest's order cannot be read back at all.

### The two assertions that will move, and by how much

Two live frontend assertions are pinned to the **mock's** arithmetic, which rounds a single aggregate
(`Math.round(subtotal * 0.05)`), while the seeder and the server compute **GST per line and sum**. The
seeder's own comment acknowledges the divergence.

| Assertion | Today | Why it moves |
| --- | --- | --- |
| `routes.smoke.test.tsx:1476` — business dashboard spend `₹77,348` | mock's aggregate rounding over two bulk orders | server sums per-line GST |
| `routes.smoke.test.tsx:1511-1513` — `₹329 / ₹16 / ₹79` | `fromReceipt`'s 5% aggregate plus residual shipping | the receipt is deleted in Task 19 |

Both citations were off in the first draft and are corrected above — the spend assertion is at `:1476`, not
`:1468`, which is the sign-in step of the same test; and there is a second reference to `₹77,348` in a
docblock at **`:1255`** that has to move with it, or the comment will explain a number the file no longer
contains. The `₹424` total is described in a comment rather than asserted (`:1510`), so it is the comment
that needs the new arithmetic.

**Compute the new figures from the seeded rows, do not guess them:**

```sql
SELECT o."orderNumber",
       o."subtotalPaise", o."gstPaise", o."shippingPaise", o."totalPaise"
  FROM orders o ORDER BY o."orderNumber";
```

Then update the frontend assertions in Task 19 with **both** values recorded in the docblock — old and
new — so the next reader sees a deliberate change rather than a suspicious edit. **Do not adjust the
server to match the mock.** An invoice whose tax does not equal the sum of its lines' tax cannot be
reconciled, which is the entire reason §8 requires per-line GST.

---

## Task 19: The account seam, and the death of the receipt

Where disagreements 6 and 7 are settled, and the largest single deletion in the plan.

**Files:**
- Rewrite: `frontend/src/features/account/api/index.ts`
- Modify: `frontend/src/features/account/hooks/useAccount.ts`
- **Create: `frontend/src/test/account-api.stub.ts`**, exporting `handleAccountRequest` and
  `resetAccountStub`, and delegate to it from `auth-api.stub.ts` beside the four handlers already there —
  `handleCatalogRequest`, `handleCartRequest`, `handleWishlistRequest`, `handleCheckoutRequest`. **This
  task is the first to need it**, since `accountApi` is the seam it moves onto `http`; without it the smoke
  suite fails with *"api stub received an unexpected request: GET /api/v1/account/orders"*, which is the
  dispatcher working as designed rather than a bug in the new code. Do **not** add a second installer or
  reach for MSW — see **"There is no MSW"** in the preamble. Task 12 hit the identical gap for the pincode
  route and the fix is the same shape.
- Modify: `frontend/src/test/routes.smoke.test.tsx`
- **Keep unchanged:** `frontend/src/features/account/components/OrderTimeline.tsx`,
  `OrderStatusBadge.tsx`, `OrdersTable.tsx`, `status.ts`

### What goes

- **`fromReceipt` (`:17-52`), entirely.** It reconstructs an order from the sessionStorage receipt with a
  hardcoded 5% GST, shipping inferred as `amount − subtotal − gst` ("the residue is what shipping cost"),
  a hardcoded `status: "confirmed"`, and a synthetic two-event timeline whose `confirmed` event carries
  the note **"Payment received."** — on a COD order nobody has paid for. Every one of those is a guess
  that the real endpoint answers.
- **The `nn.order.${id}` sessionStorage key**, and `saveOrder`/`getOrder` with it.
- **The receipt-fallback case** — search for `nn.order.NN-2026-777777` rather than trusting a line number,
  since Task 13 added roughly 460 lines to that file and every citation in this plan for it is stale. It
  hand-writes a receipt payload and pins the reconstruction exactly, including `₹329 / ₹16 / ₹79 / ₹424` —
  figures **no server row produces**, since they come from `fromReceipt`'s own arithmetic. Disagreement 5
  is settled: those numbers do not move, this case is deleted. Replaced by a case that places an order through the real endpoint and opens it
  from `/account/orders/:orderNumber` — which is what the test was *trying* to prove ("so Track Order is
  not a dead end") and could not, because there was no server.
- **The `nn.addresses.v1` localStorage overlay** and its four functions (`readOverlay`, `writeOverlay`,
  `currentAddresses`, `commit`). Task 21 replaces them. `commit`'s rule — *"exactly one default, and never
  zero while the book has entries"* — moves to the database, where `uq_addresses_one_default_per_user`
  already enforces half of it.

### What stays, and must keep working

`OrderFilters` still cannot carry an email. `listOrders`' signature loses its `MockOrderFilters & { email }`
extension entirely — the server knows who is asking. All four call sites pass `{ email }` today — verified: `routes/account/index.tsx:105`,
`routes/account/orders/index.tsx:20`, `routes/business/orders.tsx:16` and `routes/business/index.tsx:41`.
All four drop it.

`getOrder(id)` becomes `getOrder(orderNumber)` over `http`. Its fallback to the receipt goes with the
receipt.

**Close the discount row Task 13 could not.** Task 13 added a discount row to `account/orders/$id.tsx`
and its mutation **survived 0/221**, because `mocks/orders.ts:51` hardcodes `discount = 0` and
`fromReceipt` sets `discount: 0`, so no fixture could express a discounted order. Replacing this seam is
what makes one expressible — the backend half is already pinned (Task 18 asserts ₹89.70 on the wire against
8,970 in the column). Pin the frontend half here, and **do not** close it by editing `mocks/orders.ts`:
that file's totals are what the business-dashboard assertion reads, and disagreement 5 has just been
settled by measurement against them.

---

## Task 20: `POST /account/orders/:orderNumber/cancel`

Needs Task 5's service and Task 17's read path both working, which is why it is here.

**Files:**
- Modify: `backend/src/modules/orders/orders.service.ts`, `orders.controller.ts`
- Modify: `backend/test/integration/orders.integration.spec.ts`
- Modify: `frontend/src/routes/account/orders/$id.tsx`

The service delegates the transition to `OrderStatusService` and adds exactly one thing: **the customer is
the actor, and the transition must be one a customer is allowed to make.**

**You do not need to add a lock, and adding one would be a downgrade.** Audited: `transition()` reads the
order, checks `canTransition`, and then writes with the status it read in the predicate —
`update({ id: order.id, status: from }, patch)` — so the condition lives *inside* the write, the §10.2
pattern the stock decrement uses. Two customers (or a customer and an admin) cancelling at once means the
second `UPDATE` blocks under `READ COMMITTED`, re-checks its `WHERE` against the committed row, matches
nothing, reports `affected !== 1` and raises a 409 **before** `applyStockConsequence` runs. So a double
cancellation cannot restock twice. Assert that outcome if you like — it is worth a test — but do not
restructure the service to get it.

- **A customer may cancel; a customer may not refund.** `RETAIL_TRANSITIONS` allows `delivered → refunded`,
  and `canTransition` would happily approve it. This endpoint hardcodes `to: 'cancelled'` rather than
  taking a target status from the request — a `POST .../cancel` that accepted a status is an admin endpoint
  with a misleading name.
- **The `OrderEvent`'s `actorUserId` is the customer.** Unlike placement's system-generated first event,
  a cancellation *was* performed by someone, and the timeline the admin reads must say who.
- **Confirm the cancellation actually puts the stock back, and treat this as a required assertion rather
  than a nicety.** `OrderStatusService.putStockBack` was outright broken until Task 7 (`4f06392`): the raw
  `UPDATE` returned `[rows, rowCount]`, so it threw `NOT_FOUND` on every call and **no cancellation could
  ever have succeeded**. Nothing pins the fix — Task 7's file is concurrency-only by charter and
  deliberately did not add a single-threaded case, so this task is where the regression test belongs.
  Assert the restored `onHand` *and* the compensating `InventoryTransaction` row — the entity is at
  `entities/catalog/inventory-transaction.entity.ts`, table `inventory_transactions`; there is no
  `InventoryLedger` in this codebase — because a restock that moves
  the counter without writing the ledger leaves the two disagreeing, and §10.2 makes the ledger the
  reconciliation record. See the raw-`UPDATE` hazard in the preamble before touching that statement.
- **Cancelling twice is a 422, not a second event.** `canTransition` refuses a no-op — pinned in
  `order-status.test.ts` — so this falls out of Task 5 provided nobody adds an early return.
- **A `shipped` order cannot be cancelled**, and the 422 must carry the legal next statuses under the
  details key **`allowed`** — that is the key Task 5 shipped, and the admin plan will read it, so do not
  rename it to `nextStatuses` after the function that computes the value — so the UI can say what
  *is* possible rather than "no".

Integration cases:

```
cancels a pending order, restores stock, writes a CANCELLATION ledger row and one event
refuses to cancel a shipped order with 422, and names what is allowed instead
refuses to cancel another customer's order with 404       <- not 403
refuses a second cancellation with 422 and writes no second event
SUM(delta) = onHand after the restore
```

Frontend: `$id.tsx` gains a Cancel button, rendered only when the order's status is one of the four
cancellable ones. Derive that from `nextStatuses(channel, status).includes('cancelled')` — importing
`shared`'s function, which **nothing in the frontend imports today**. That is the point: one map, two
consumers, and the button cannot drift from the server's answer.

---

## Task 21: The address book, server-side

Five endpoints, and one rule the database already half-enforces.

**Files:**
- Create: `backend/src/modules/addresses/` — service, controller, module, DTOs, specs
- Create: `backend/test/integration/addresses.integration.spec.ts`
- Modify: `frontend/src/features/account/api/index.ts`, `routes/account/addresses.tsx`

```
GET    /account/addresses
POST   /account/addresses
PATCH  /account/addresses/:id
DELETE /account/addresses/:id
POST   /account/addresses/:id/default
```

Four decisions:

- **`DELETE` is a soft delete.** `Address.deletedAt` exists for this (`address.entity.ts:51`). Filter
  `deletedAt IS NULL` on every read.

  **Be clear about why, because the obvious reason is the wrong one.** It is *not* to protect order
  history: the entity's own docblock says orders never reference this table — *"they store an
  `addressSnapshot` jsonb instead (spec §5.3), so deleting an address cannot rewrite where a past order was
  delivered"* — so a hard delete would leave no past order blank. The real reasons are restorability (the
  same docblock: *"Soft-deleted so a restore is possible"*) and that a deleted default must not wedge the
  unique index, which the partial predicate below handles. Do not add a join from orders to addresses in
  the belief that it protects anything; that coupling is exactly what the snapshot exists to avoid.
- **Exactly one default, enforced in a transaction.** `uq_addresses_one_default_per_user` stops *two*
  defaults; nothing stops *zero*. So setting a default clears the others and promoting the first address
  is automatic, both inside one transaction — and deleting the current default promotes another if any
  remain. The mock's `commit` already implemented this rule; it moves to the server rather than being
  reinvented.
- **The unique index is partial, and here it is** — measured, so you need not go looking:

  ```sql
  CREATE UNIQUE INDEX uq_addresses_one_default_per_user ON public.addresses
    USING btree (user_id) WHERE (("isDefault" = true) AND ("deletedAt" IS NULL))
  ```

  Two consequences. **Clear first, then set** — the index is checked per statement, not deferred, so
  clearing leaves zero rows matching the predicate and the subsequent set is safe, while setting first
  violates it immediately. And **a soft-deleted default does not block a new one**, because `deletedAt IS
  NULL` is in the predicate — which is what makes the soft delete above safe rather than something that
  quietly wedges the address book. `schema-invariants.integration.spec.ts:138` already pins the
  constraint.
- **Bound every string in the address DTO to its column width, and know that the form does not.** The
  same defect the `Idempotency-Key` cap fixed in Task 9: an unbounded client string reaching a `varchar`
  raises SQLSTATE `22001` inside the driver, which nothing catches, so the client gets a **500** for what
  is plainly a 400. `savedAddressSchema` (`AddressForm.tsx:23`) has `label: z.string().min(2)` with **no
  maximum at all**, and `addressSchema` bounds nothing else either — its rules are minimums and patterns.
  The columns, measured, are what the DTO must mirror:

  | Column | Width | | Column | Width |
  | --- | --- | --- | --- | --- |
  | `label` | **40** | | `city` | 80 |
  | `fullName` | 120 | | `state` | 80 |
  | `phone` | 15 | | `pincode` | `char(6)` |
  | `email` | 255 | | `line1` | 255 |
  | `line2` | 255, nullable | | | |

  `label` is the one to get right: 40 is the narrowest, and it is the one field with no client-side bound
  at all, so it is reachable with an ordinary long label rather than a crafted one.

- **`line2: ""` arrives from the form and will be stored as an empty string.** `AddressForm`'s
  `emptyValues` (`:30-42`) sets `line2: ""`, and an `@IsOptional()` on a `varchar(255)` accepts it —
  `@IsOptional()` skips its siblings only for `undefined` and `null`. So an untouched second line becomes
  `""` in the column rather than `NULL`, and `deletedAt IS NULL`-style queries are not affected but every
  address readback then distinguishes "no second line" from "no second line" in two ways. Normalise it to
  `null` in the service, and note Task 13 has the same problem in the *order* snapshot for the same reason.

- **`useAddresses(email)` drops its argument, for the same reason `useOrders({ email })` does.** In
  `features/account/hooks/useAccount.ts` — **search for the symbol, not a line number; every citation this
  plan carries for that file and for `routes.smoke.test.tsx` has gone stale at least once as earlier tasks
  grew them** — it takes an `email` and keys the query on it via
  `accountKeys.addresses(email)`, with two call sites — `routes/account/index.tsx:106` and
  `routes/account/addresses.tsx:67`. These endpoints are session-scoped, so the argument is at best dead
  and at worst a suggestion that a client picks whose address book it reads, which is the IDOR shape §13
  rules out and the reason `OrderFilters` cannot carry an email either. Drop it from the hook, from
  `accountKeys.addresses`, and from both call sites. Task 19 does the identical surgery on `useOrders` and
  names its four call sites; this is the piece that task does not reach.

- **Server-allocated ids.** `routes/account/addresses.tsx:80` fabricates
  `` `adr-${Date.now().toString(36)}` `` — verified verbatim — while `Address extends BaseEntity`, whose
  `id` is a generated uuid. Drop the fabrication. The collision it can cause (two addresses added in the
  same millisecond) is the *lesser* problem: `adr-mf3k2p` is **not a uuid**, so against `addresses.id` it
  is SQLSTATE **22P02** and a **500** — the same family as the `22001` the `label` cap prevents. Put
  `ParseUUIDPipe` on all three `:id` routes; measured without it, the response is `500` where `400`
  belongs.

---

## Task 22: `GET` and `PATCH /account/profile`

The smallest task, and the only place a customer edits their own `User` row — which is why it is its own
module rather than bolted onto `AuthModule`.

**Files:**
- Create: `backend/src/modules/profile/` — service, controller, module, DTO, specs
- Modify: `frontend/src/routes/account/profile.tsx`

`PATCH` accepts `name` and `phone` and **nothing else**. Three exclusions worth stating, because each is
a route someone would reasonably add:

- **Not `email`.** It is the login identifier; changing it is an account-recovery flow with verification,
  not a profile edit. `profile.tsx` renders the email input `readOnly disabled` — keep it that way.

  Note that **all three** inputs are currently `readOnly disabled` (`:61`, `:65`, `:69`), not just the
  email. So this task's change is to open two of them, and the email's disabled state is the one thing
  that stays — which reads the opposite way round from "it gains editable fields".
- **Not `role`.** Self-service privilege escalation. The upgrade path is `POST /auth/upgrade-to-business`,
  which exists.
- **Not `isActive`.** Deactivation is an admin action, and §9's login flow checks it *after* the bcrypt
  comparison specifically so it cannot be used as an oracle.

`phone` against `PHONE_REGEX` — `/^[6-9]\d{9}$/`, from `shared` (`constants/identifiers.ts:10`). That
pattern bounds the length by itself, so `phone` needs no `@MaxLength`; **`name` does.** `User.name` is
`varchar(120)` and `User.phone` is `varchar(15)` — measured — and an unbounded name would reach SQLSTATE
`22001` in the driver and answer **500** for what is a 400, which is the defect the `Idempotency-Key` cap
fixed in Task 9 and the address `label` repeats in Task 21. `@MinLength(2) @MaxLength(120)` on `name`, and
nothing else on this DTO.

The screen is read-only today. It gains editable name and phone; the email stays disabled with its
existing explanation.

---

## Task 23: `order-success` reads the order, not a receipt

Last, because it needs Task 17.

**Files:**
- Modify: `frontend/src/routes/order-success.$id.tsx`

Three defects in the current screen, all consequences of there being no server:

- **It renders a confirmation for any id.** Verified: the `<h1>Order Confirmed!</h1>` at `:37` and
  `Order ID: {id}` at `:42` are unconditional, taken from the URL param with no lookup — only the detail
  block below them is guarded on the receipt existing. `/order-success/NN-9999-999999` congratulates you on
  an order that does not exist. Now it reads the order, and a miss stops congratulating.

  **This screen has three states, not two, and conflating the last two is a live bug for every guest.**
  Neither `/checkout` nor this route is guarded (only `routes/account/route.tsx` uses `requireCustomer`),
  so a guest checkout is the ordinary retail path — and a guest's order carries `userId: null`, which
  Task 17's session-scoped read cannot return to them. So:

  1. **The order is in the cache** — Task 13 seeded it from the placement response on the way here.
     Render the confirmation. This is the normal path, for guests and signed-in customers alike, and it
     needs no request at all.
  2. **No cached order, and the visitor is signed in** — fetch it. A miss is genuinely *not found*.
  3. **No cached order, and the visitor is a guest** — a reload, a new tab, a shared link. **Do not fetch,
     and do not render "not found":** the order almost certainly exists, and a 401 rendered as a missing
     order tells a paying customer their order vanished. Show the order number with an honest line — quote
     it to support, or sign in with the email used at checkout — and no confirmation tick.

  Distinguishing 2 from 3 is a check on the auth state you already have, not on the response status.
- **It reads the receipt once, synchronously** — `useState(() => checkoutApi.getOrder(id))` — so a reload
  in a new tab, or on another device, shows the "details are not available in this browser session"
  branch. Fetching fixes that without any new UI: the same screen, backed by a real read.
- **It empties the cart in a mount effect.** The server now empties it inside the placement transaction,
  so this is at best redundant and at worst a second `PUT /cart` racing the mount `GET` — the shape of
  defect Plan 2 found on this very route and guarded with a generation counter. Delete the effect.

It also gains what it never had: a **totals breakdown** (subtotal, discount, GST, shipping) and the
**status badge**, both of which `AccountOrder` carries and this screen currently drops in favour of a bare
`Amount paid`. And item names become links, because `OrderItem.productSlug` is snapshotted — disagreement
6, which resolves itself here.

---

## Task 24: Milestone 6 verification

- [ ] **Step 1: Every suite**, as Task 14. Record observed figures rather than comparing to numbers
written days earlier.

- [ ] **Step 2: The journey, by hand** — the one thing no suite covers

As a guest: build a basket, place a COD order, and land on the confirmation. **Reload it** — it must
still render, which is the difference the receipt's deletion makes. Then sign in as `b2c@demo.in` and
confirm:

```
/account/orders                  lists exactly 4 orders, not 6 — see the table below
/account/orders/NN-2026-005107   renders 6 timeline entries, the status badge, and the totals
                                 breakdown (its discount is ₹0, so the row shows zero, not nothing)
no seeded order shows Cancel     every one of them is past the cancellable statuses
place one while signed in        it lands `pending`, and *that* is the order you cancel
cancel it                        the timeline gains an entry attributed to the customer,
                                 and stock is restored — with the ledger row to match
/account/addresses               add, edit, set default, delete — and the default is never zero
/account/profile                 change the name, reload, it persists; email stays disabled
```

**The seeded orders, measured — because the first draft of this checklist got all three numbers wrong in
ways that would have hidden real failures:**

| Order | Owner | Status | Events |
| --- | --- | --- | --- |
| `NN-2026-005107` | `b2c@demo.in` | `out-for-delivery` | 6 |
| `NN-2026-004977` | `b2c@demo.in` | `cancelled` | 3 |
| `NN-2026-004821` | `b2c@demo.in` | `delivered` | 7 |
| `NN-2026-004650` | `b2c@demo.in` | `refunded` | 7 |
| `NN-2026-005042` | `b2b@demo.in` | `shipped` | 7 |
| `NN-2026-004488` | `b2b@demo.in` | `delivered` | 8 |

Three corrections, and the first is the one that matters:

- **`b2c@demo.in` owns four of the six.** The old line said the list shows "the six seeded orders plus
  nothing of the b2b customer's", which is self-contradictory — and dangerous, because a verifier who
  expects six and *sees* six would record a pass while actually looking at **the IDOR failure this
  milestone exists to prevent**. Four is the pass. Six is the bug.
- **`NN-2026-005107` has six events, not seven.** The seven-event orders are `004821`, `004650` and the
  b2b `005042`. (The six counts sum to 38, which is the figure Tasks 16 and 18 assert against.)
- **`NN-2026-005042` is not the customer's order to look at.** It is `shipped`, so it genuinely cannot be
  cancelled, but it belongs to `b2b@demo.in` — a b2c session cannot see it at all, so it cannot
  demonstrate a hidden Cancel button.
- **Nothing seeded is cancellable.** The six statuses are `out-for-delivery`, `shipped`, `cancelled`,
  `delivered`, `refunded`, `delivered`, and `RETAIL_TRANSITIONS` offers `cancelled` only from `pending`,
  `confirmed`, `processing` and `packed`. So the cancellation check requires **placing a fresh order while
  signed in as `b2c@demo.in`** — not the guest order from the step above, which has no session and so no
  `/account` route to cancel from.

Capture any stock you disturb and restore it with the audited adjustment endpoint. **Never
`npm run seed`.**

- [ ] **Step 3: Record what happened**, including every place this plan turned out to be wrong.

---

## Definition of done

1. `npm run typecheck -w backend` and `-w frontend`, `lint` and `format:check` pass — note there is **no
   root `typecheck` script**, and `shared` has none either, since it typechecks via `build`; `npm run build -w frontend`
   and `npx tsc -p backend/tsconfig.build.json --noEmit` pass.
2. Every suite green: shared, backend unit, backend integration, frontend.
3. **Every route a client calls is reachable, asserted against Nest's routing metadata or over HTTP** —
   not against a hand-built handler call. Plan 2 shipped a controller missing a `@Get` with 349 unit and
   155 integration tests green; the same blind spot hid a 500-for-every-guest and a wrong status code.
4. No `.only`, `.skip`, `xit` or `fdescribe` anywhere.
5. The migration chain applies to an empty database, reverts leaving no orphaned enums or sequences, and
   re-applies. **Including the sequence** — a `DROP SEQUENCE` missing from `down()` is invisible until the
   next revert.
6. `SUM(inventory_transactions.delta) == inventory.onHand` for every variant, **after** a placement, a
   cancellation and a restocked refund.
7. Two customers racing for the last unit produce exactly one order and one `409`, proven against real
   Postgres by a test whose timing it controls rather than by `Promise.all`.
8. A repeated `Idempotency-Key` creates no second order and decrements no stock twice.
9. A coupon with `usageLimit: 1` is redeemed once under a race.
10. `quoteOnly` and unpublished products are refused at placement, not merely hidden in the catalogue.
11. No cart or order read returns another owner's rows; a wrong owner is a **404**, never a 403.
12. `POST /checkout/orders` rejects `paymentMethod: "online"` with `422 PAYMENT_METHOD_UNAVAILABLE`.
13. Every `OrderItem` carries its `name`, `hsn`, `detail` and `gstRate` snapshot, and every `Order` its
    `addressSnapshot` — an invoice must reprint after the product is renamed or deleted.
14. The timeline's last entry equals the order's status, for every order.
15. `sessionStorage` holds nothing. `nn.order.*` and `nn.addresses.v1` are gone, and
    `grep -rn "sessionStorage\|nn\.addresses" frontend/src` returns only test hygiene — which is
    **five `sessionStorage.clear()` calls** (`routes.coverage.test.tsx:135` and
    `routes.smoke.test.tsx:424`, `:849`, `:1126`, `:1262`) and nothing else. Measured today, the
    non-hygiene occurrences are `checkout/api/index.ts:63,68,76`, `account/api/index.ts:12,54`, and — the
    one easy to miss because it sits among the hygiene — the `sessionStorage.setItem` at
    **`routes.smoke.test.tsx:1484`**, which hand-writes a receipt payload and is the test Task 19
    replaces. A verifier counting six test hits and calling them all hygiene would pass this while the
    receipt lives on.
16. `features/checkout/api` and `features/account/api` import no `@/mocks/*` **and no
    `@/lib/mock-client`**. The second clause is the load-bearing one: measured today, `checkout/api`
    already imports no `@/mocks/*` at all — it is mocked entirely through `mockFetch` — so this gate was
    **already green before any of the work was done**, which makes it worth exactly nothing as written.
    `mock-client.ts`'s own docblock says *"Phase 2 deletes this file along with src/mocks/"*. Its four
    importers today are `checkout/api`, `account/api`, `content/api` and `rfq/api`; the last two
    legitimately keep it until Milestones 8 and 7, so the file itself cannot be deleted here — only these
    two seams' imports of it.
17. No `.env` is tracked and `npm audit --audit-level=high` is clean.

## Milestone 5 complete

Run by hand after the dispatched agent stalled — the third environment failure of the phase, so the
verification was done directly rather than re-dispatched.

### Final counts, all measured in one pass

| Suite | Tests | Suites |
| --- | --- | --- |
| `@nutwala/shared` | **61** | 4 |
| backend unit | **532** | 41 |
| backend integration | **230** | 11 |
| frontend | **221** | 13 |
| **total** | **1,044** | **69** |

`typecheck -w backend`, `typecheck -w frontend`, `lint -w backend`, `format:check`, `build -w frontend`
(964 ms) and `npm audit --audit-level=high` (**0 vulnerabilities**) all clean.

### Definition of done

Passing: 1 (both typechecks, lint, format, frontend build, `tsc -p tsconfig.build.json`), 2 (every suite
green), 3 (routes asserted against Nest's routing metadata *and* over HTTP), 4 (no `.only`/`.skip`/`xit`/
`fdescribe` anywhere), 5 (see below), 6, 7, 8, 9, 10, 11, 12, 13, 14, 17 (only `.env.example` tracked;
audit clean).

**Items 15 and 16 are Milestone 6 gates and correctly still fail.** The `sessionStorage` receipt lives at
`checkout/api/index.ts:219,227`, `ADDRESS_KEY` at `account/api/index.ts:54`, and the smoke test's
`setItem` at `:1940`; `account/api` still imports `@/mocks/addresses`, `@/mocks/orders` and
`mock-client`. Task 13 kept them deliberately — disagreement 7 assigns the receipt to Task 19 and
`order-success` to Task 23. **Item 16's checkout half is now genuinely satisfied**, importing neither
`@/mocks/*` nor `@/lib/mock-client`; before the gate was amended it was *vacuously* green, since
`checkout/api` had never imported `@/mocks/*` while being wholly mocked through `mockFetch`.

### Step 2 — the migration chain, run for real

Throwaway container on a **literal** port 55440 (55432 was occupied; the port was checked free with
`lsof` before use), `NODE_ENV=test` so `load-env`'s `override: true` could not substitute `.env`'s
port — the dev database on 5442 was never addressed. Observed:

- **apply:** 5 migrations in order → 35 tables, 18 enums, 2 sequences, `order_number_seq` present
- **revert:** a loop, not a count — 5 iterations in reverse order, then nothing left applied
- **after revert:** `tables=1` (`migrations` alone), `enums=0`, and the only surviving sequence is
  TypeORM's own `migrations_id_seq`. **`order_number_seq` is gone**, which is the specific thing item 5
  calls out: a `DROP SEQUENCE` missing from `down()` is invisible until the next revert, and this is the
  first milestone to add a sequence to the chain.
- **re-apply:** 5 again → 35 / 18 / 1. Container removed.

The earlier static check — every `CREATE` matched by a `DROP` in the same migration's `down()` — is now
confirmed against a real Postgres.

### Step 3 — a guest order placed by hand, over HTTP

Against the **dev** database and the running dev servers, as a guest holding only `nn_guest_token`:

```
PUT  /cart          2 retail lines -> subtotal ₹1147, gst ₹57.35, shipping ₹0 (over the ₹999 threshold)
POST /checkout/orders               -> 201, NN-2026-100003, total ₹1204.35 — equal to the cart, to the paise
                                       status pending, 2 items, timeline ['pending'], eta 4 days
POST same Idempotency-Key again     -> 201, the SAME order number
```

Then, in the database: `orders` **9 → 10**, so the replay created nothing; `user_id` **NULL**, so it was
genuinely a guest order; the guest cart emptied to 0 items; stock 120→118 and 120→119, exactly the
quantities ordered; two `SALE` ledger rows with matching `balanceAfter`; and
`SUM(delta) = onHand` **for every variant**. Stock was then restored with `PATCH /admin/inventory/:id`
(two audited `ADJUSTMENT` rows, reason recorded), never `npm run seed`, and the invariant re-checked.

**What this established that no suite does:** the paise-precision GST (₹57.35) surviving the wire, the
timeline being populated on a *brand-new* order — the `place()` returns `events: undefined` defect, fixed
in Task 9 by reloading, confirmed against the real database — and the idempotent replay working through
the real middleware stack rather than a testcontainer.

**What it did not establish.** No browser was driven, so the rendered confirmation screen and, critically,
**the reload-while-signed-out check remain unverified**. That is the one exercise of the guest hole — the
order carries `userId: null`, the account read is session-scoped, and the confirmation renders from a
cache a reload does not have. Task 13 implemented the three-state branch and its cache seeding is pinned
by a mutation (`0/221 → 1/221`), but *no automated or manual check has yet watched a human reload that
page*. It stays on Task 24's list.

### Step 3b — Task 10's unfinished mutation matrix, decided

Four mutations run against the checkout integration suite. Every one a deletion or replacement of real
code, each restored and verified byte-identical by `shasum`:

| Mutation | Result |
| --- | --- |
| delete the `PINCODE_NOT_SERVICEABLE` guard | **2/43 killed** |
| delete the `refuseBrokenLines` call (`QUOTE_REQUIRED`, sold-out) | **2/44 killed** |
| delete the `CART_EMPTY` guard outright | **invalid — `Tests: 0 total`**, see below |
| narrow `CART_EMPTY` to `cart === null` | **0/43 — SURVIVED**, gap found and closed |

**Two findings worth more than the kills.**

The preamble blames `if (false && …)` for collapsing a suite into `Tests: 0 total`. **A plain deletion does
it too**, whenever the deleted code was doing the narrowing: removing the `cart === null || items.length
=== 0` block leaves `cart` typed `Cart | null` at every later use, so the file does not compile and jest
reports zero tests — a false kill by the same mechanism, reached without the banned construct. The rule is
not "avoid `if (false)"; it is **"a mutation must still compile, and `Tests: 0 total` is never a kill."**

Rewritten to preserve narrowing, that mutation **survived 43 of 43 tests** — and the reason is a real hole.
The existing case is named *"when the caller has no basket at all"* and is honest: it exercises only
`cart === null`. Nothing covered the other arm, a `carts` row that exists holding no `cart_items` — which
is what a customer who fills a basket and then empties it leaves behind. Without that half of the guard,
their checkout **places an order carrying no lines at all, priced at nothing but the shipping charge.**
A case was added (fill, empty, place) and the survivor now dies **1/44**.

**Still unmutated, and stated rather than implied:** the four coupon-preview cases and the single-threaded
`OUT_OF_STOCK` refusal. The latter is covered from the other direction by Task 7's concurrency proofs,
which killed a read-then-write decrement 5/5 with the blocked-rival technique; the preview cases are
green and unproven.

### Things that turned out differently from this plan

Recorded through the milestone as they were found, and collected here because Plan 2's most useful
artefact was exactly this list. Seven were errors in the plan's own text: the preview DTO that could not
be built from `CartLine`; the `{6}` versus `{6,}` order-number drift; disagreement 1's instruction, which
described an **empty set** of pincodes; the "guaranteed 400" that `zodResolver`'s stripping makes
impossible; Task 24's checklist, which would have recorded a **pass on the IDOR leak** it exists to catch;
Task 18's channel filter, whose expected value was identical with the filter deleted; and definition-of-done
item 16, which was green before any work started. Two were defects in shipped code that no unit test could
see — the raw-`UPDATE` `[rows, rowCount]` hazard that made every decrement report a sell-out and every
cancellation 404, and the `firstOrderOnly` limit that was never re-checked under the coupon lock. Four
were things that look wrong and are right, audited so nobody re-derives them.

## Milestone 6 complete — and with it Plan 3

Run by hand, as Milestone 5's was: four of the nine agent dispatches in this milestone were lost to
environment failures (two stalls, the machine sleeping, and a session limit), and verification is
measurement rather than construction.

### Final counts, one pass

| Suite | Tests | Suites |
| --- | --- | --- |
| `@nutwala/shared` | **61** | 4 |
| backend unit | **749** | 53 |
| backend integration | **324** | 14 |
| frontend | **233** | 13 |
| **total** | **1,367** | **84** |

Entering Plan 3 the totals were 61 / 371 / 186 / 211 = **829**. `typecheck` both workspaces, `lint`
both, `format:check`, `npm run build -w frontend` (1.02 s), `npx tsc -p tsconfig.build.json --noEmit`,
and `npm audit --audit-level=high` (**0 vulnerabilities**) all clean.

### Definition of done — all seventeen pass

Items 15 and 16 were correctly failing at Milestone 5 and now pass: `grep -rn "sessionStorage|nn\.order|
nn\.addresses" frontend/src` returns only docblocks explaining the absence and tests' own `clear()`
hygiene, and neither `features/checkout/api` nor `features/account/api` imports `@/mocks/*` or
`@/lib/mock-client`. Item 4 clean, item 17 clean (`.env.example` alone tracked).

Items 6, 11 and 14 measured against the live database rather than inferred: **zero** variants where
`SUM(inventory_transactions.delta) <> inventory.onHand`, **zero** orders whose last event disagrees with
`status`, and every non-empty address book holding exactly one default while the empty one holds zero.

### The migration chain, run for real

Throwaway container, literal port 55450 checked free with `lsof` first, `NODE_ENV=test` so
`load-env`'s `override: true` could not substitute `.env`'s port — the dev database on 5442 was never
addressed. Applied 5 → 35 tables / 18 enums / 2 sequences. Reverted in a **loop**, five iterations in
reverse order, to `tables=1` (`migrations` alone), `enums=0`, and the only surviving sequence TypeORM's
own `migrations_id_seq`. Re-applied → 35 / 18. Container removed.

### The account journey, by hand over HTTP

No browser was driven, so this exercised the wire rather than the rendered pages. What it established:

```
GET  /account/orders                      4 orders, newest first — never 6
     ?channel=retail / ?channel=bulk      4 / 0   <- falsifiable in both directions
     ?channel=gold                        400     <- the @IsIn the plan required
GET  /account/orders/NN-2026-005042       404     <- b2b's order, indistinguishable from
GET  /account/orders/NN-9999-999999       404     <- one that does not exist
POST /account/orders/NN-2026-005107/cancel
                                          422 ILLEGAL_STATUS_TRANSITION, allowed: ["delivered"]
```

Then the full cancellation cycle, which is the one path that **could not have worked at all** before
Task 7's CTE fix: placed a fresh order (stock 120 → 117), cancelled it (**200**, status `cancelled`,
timeline `["pending","cancelled"]`), and read the consequences off the database — `onHand` back to
**120**, ledger rows `SALE -3 / CANCELLATION +3` with `balanceAfter` matching each, the cancellation
attributed to the customer while placement's own event carries no actor, and a repeated cancel refused
**422**. No stock restoration was needed: the cancellation is what restored it.

Profile: `GET` returns six fields and none of `passwordHash`, `isActive`, `lastLoginAt`, `updatedAt`; a
name change persists; and `email`, `role`, `isActive` and a whitespace-only name are each **400**.

Addresses: a create on a book that already had a default returned a **server-allocated uuid** and left
**exactly one** default; a 41-character label answered **400** and a non-uuid id answered **400** — the
two defects Task 21 fixed, each of which used to be a 500; and deleting the default **promoted another**.
Crucially, `b2b@demo.in` still held exactly its own default after all of that: the cross-tenant
demotion Task 21 found is closed in practice, not only in tests.

**What this did not establish.** The rendered pages. In particular the **reload-the-confirmation-while-
signed-out** path is now covered by three frontend cases, each shown to fail against a mutation
(collapsing state 3 into state 2 kills 1/233; making the guest fetch anyway kills 1/233; the original
unconditional confirmation kills 3/233) — but no human has watched it in a browser, and that is the last
manual check worth doing before this goes near real customers.

### What Plan 3 got wrong about itself

Twelve errors in the plan's own text were found by the tasks executing it, which is the artefact worth
keeping. The three that would have caused real harm: **Task 24's own checklist expected six orders for a
customer who owns four**, so a verifier following it would have recorded a pass on the cross-customer
leak this milestone exists to prevent; **Task 18 was told to move two frontend money assertions that must
not move**, since per-line GST equals aggregate GST on every seeded order and `inr()` rounds away what
little differs; and **disagreement 1's instruction described an empty set of pincodes**, so the assertion
it asked for would have passed with the seam reverted to the deleted mock.

The rest: a preview DTO that could not be built from `CartLine`; a "guaranteed 400" that `zodResolver`'s
stripping makes impossible; `CartModule` exporting one of the three providers `CheckoutService` injects,
which would not have booted; `OrdersModule` imported before it existed; an ETA that disagreement 3
condemned and no task was given; a test stub three tasks needed and no Files list mentioned; a claim that
a transaction enforces exactly-one-default when two concurrent creates 500 on the index; an
`undefined`-in-a-`where` hazard over-generalised to `update`, which refuses an empty criteria outright;
`InventoryLedger` for `InventoryTransaction`; and definition-of-done item 16, which was green before any
work started.

Four defects in **shipped code** were found the same way, none of which any unit test could see: the raw
`UPDATE` returning `[rows, rowCount]`, which made every stock decrement report a sell-out and every
cancellation 404 through 458 green tests; `firstOrderOnly` never re-checked under the coupon lock, so a
double-click discounted two orders; `clearDefault` unscoped, which demoted **every customer in the
database** while 91 unit and 34 integration cases passed; and `CheckoutController.reload` missing an
`ORDER BY`, so one order's invoice lines came back in different sequences from two screens.

## What this plan deliberately leaves undone

- **The admin console.** §7.1 puts it in a separate application and repository; its 18 screens and the 27
  `@Roles(ADMIN)` endpoints of §6.4 get their own plan there. This plan exports `OrderStatusService` so
  those screens wire to a tested implementation.
- **`AuditInterceptor`.** §13 requires an `AuditLog` row per admin mutation and §16 schedules it in
  Milestone 9. This milestone adds no admin mutation, so the debt does not grow — but Milestone 9's
  order-status writes are the ones that most need it, and the spec now records that it should land before
  them.
- **Online payment.** §10.4's `PAYMENT_METHOD_UNAVAILABLE` is the whole of it. Enabling it later is a
  settings change plus a provider module, which is why the form keeps the card rather than deleting it.
- **Nothing rate-limits order placement beyond the global default, and placement consumes real
  inventory.** Measured: `POST /checkout/orders` is `@Public()`, carries no `@Throttle()`, and the global
  throttler is `{ ttl: 60_000, limit: 120 }` (`app.module.ts:183`) — so one IP may place around 120 COD
  orders a minute. Each decrements `onHand`, writes a ledger row, and creates an order somebody has to
  cancel; the visible effect is a shop showing SOLD OUT to real customers. CSRF raises the bar by one
  request (an attacker must `GET` for the cookie first) and not meaningfully further.

  The asymmetry with the spec's own reasoning is what makes this worth recording. §13 gives registration
  **3/hour per IP** on the argument that *"a rate limit is the only control"* for an endpoint that leaks
  whether an address exists — while placement, which spends stock, inherited the 120/minute default
  unexamined. Nobody decided that; it is simply what no decorator gets.

  **The cheap mitigation is a dedicated `@Throttle()` on placement**, and it needs a real number rather
  than a reflex, because a tight per-IP limit is more dangerous here than it looks: carrier-grade NAT is
  ordinary on Indian mobile networks, so a shared egress IP can legitimately carry many distinct customers
  and a 5/hour rule would refuse genuine orders. Options worth weighing together: a moderate per-IP cap;
  a cap on guest order **value or quantity** rather than frequency; or requiring sign-in for checkout,
  which is a product decision that contradicts the guest path this milestone deliberately supports.
  Belongs to Milestone 10's hardening pass, but the number is a business call, not a technical one.

- **Four unbounded query strings on the public catalogue, of which one matters slightly.** Swept every
  DTO for the defect the `Idempotency-Key` cap and the address `label` both turned out to be:
  `product-query.dto.ts` leaves `category`, `q`, `origin` and `grade` with no `@MaxLength`. Three of them
  are compared against columns, so an over-long value simply matches nothing — harmless. **`q` is the
  exception**: `catalog.service.ts:270` wraps it as `` `%${term}%` `` and feeds it to **five** `ILIKE`
  comparisons across a join (`:264-268`). Leading-wildcard `ILIKE` cannot use an index, the endpoint is
  public, and the global throttle allows 120 requests a minute, so the input is bounded only by Node's URL
  limit of roughly 8KB. At 27 products this costs nothing measurable and it is **not** worth widening this
  plan for — but a `@MaxLength` on `q` is free, and unbounded client input reaching a pattern match belongs
  on Milestone 10's hardening list next to the placement rate limit. Recorded rather than fixed because it
  is Milestone 3's code and no part of this milestone touches it.

- **GST is computed on the pre-discount subtotal, and whether that is right is a tax question, not a code
  question — so it is flagged rather than changed.** Verified arithmetic in `place()`: `gstPaise` is summed
  from the per-line GST of the **undiscounted** line totals (`:203`), and the discount is then subtracted
  from the total (`:219`), as `subtotalPaise - discountPaise + gstPaise + shippingPaise`. Spec §8 is silent
  on the interaction — it fixes per-line rounding and says "an invoice must equal the sum of its lines",
  but an order-level coupon sits outside the per-line computation entirely — so this is a **gap in the
  spec**, not a deviation from it.

  Concretely, with the seeded `BULK500` (₹500 off, ₹10,000 minimum) on a ₹10,000 bulk basket at 5%: today
  GST is ₹500 and the total is ₹10,000. Charging GST on the discounted ₹9,500 instead gives ₹475 and a
  ₹9,975 total. The per-order difference is just *the GST rate times the discount* — small, but systematic,
  and it is printed on an invoice whose tax figure then does not correspond to its own taxable value.

  The standard reading of CGST §15(3)(a) is that a discount given at or before the time of supply **and
  recorded in the invoice** is excluded from the taxable value, which a checkout coupon shown on the
  invoice is — so GST on the post-discount amount. **That reading needs confirming by whoever owns tax
  treatment for this business, because the fix is not free:** an order-level discount has to be apportioned
  across lines pro-rata to recompute each line's GST, and lines can carry 5%, 12% and 18%, so the
  apportionment interacts directly with the round-per-line rule. Nothing is broken today — every seeded
  order carries `discountPaise: 0n`, so no existing test or row exhibits it. It bites the first real
  discounted order.

- **The idempotency claim is released fire-and-forget, and there is now a reachable way to wedge a key.**
  `error: () => void this.keys.delete({ key })` is not awaited, so a failed delete is silent. Combined with
  the pipeline ordering above — the key is claimed *before* `ValidationPipe` runs — the sequence is
  ordinary: a client posts an invalid body, the key is claimed, validation rejects it, the client fixes the
  body and retries **with the same key**, the hash now differs, and it meets
  `409 "This Idempotency-Key was already used with a different request body"` — permanently, if that delete
  failed. The fix is to make the release part of the stream rather than a side effect:
  `catchError(e => from(this.keys.delete({ key })).pipe(switchMap(() => throwError(() => e))))`. Left
  undone deliberately: it is a behaviour change to code Task 1 proved, and Task 13 mints a fresh key per
  attempt so the intended client never reaches it. Whoever adds a second route to this interceptor should
  do it first.

- **`WELCOME10` cannot be used in any suite that seeds orders**, and nothing said so until Task 18 hit it.
  It carries `firstOrderOnly: true`, and `CouponService` counts **orders** rather than redemptions — so
  every seeded customer already has a first order and the coupon answers
  `COUPON_FIRST_ORDER_ONLY`. `checkout.integration.spec.ts` gets away with it because its customers place
  their first order inside the test. Any suite reading the seeded history must use `ALMOND15` instead.

- **`coupon_redemptions.order_id` has no foreign key**, and this one is small enough that it should be
  done before Milestone 9 rather than drifting. Found while proving the unique constraint in Task 8. The
  entity's other two links are carefully reasoned, each with a docblock arguing its delete semantics —
  `coupon` is `@ManyToOne(… { onDelete: 'RESTRICT' })` so that `DELETE /admin/coupons/:id` cannot wipe
  redemption history, and `user` is `SET NULL` so an erasure request does not make a coupon's usage
  under-count. `orderId` is a bare `@Column({ type: 'uuid', name: 'order_id' })` (`:60-61`) with no
  relation at all, which reads as an omission rather than a decision. The consequence is precise:
  `uq_coupon_redemptions_coupon_order` promises one redemption per *(coupon, order)* pair while the order
  half can name a row that does not exist, so a redemption against a fabricated id is accepted. `RESTRICT`
  is the semantic to use, for the same reason the coupon link uses it — nothing hard-deletes an order in
  this system. **The table holds no seeded rows, so this needs no backfill**, which is exactly why it is
  cheap now and awkward later. Do it in whichever task next writes a migration, and not during an
  integration-test run, since a new migration changes the schema the testcontainer builds.

- **`POST /auth/register` accepts a whitespace-only name and stores an empty one.** Found by Task 22 while
  closing the same hole on the profile. `RegisterDto` has `@MinLength(2) @MaxLength(120)` on `name`
  (`register.dto.ts:45-47`), class-validator measures the **untrimmed** string, and `auth.service.ts:76`
  trims *after* validation — so `"  "` passes and `users.name` (a `NOT NULL varchar(120)` with no check
  constraint) ends up `''`. The profile DTO closes it with a `@Transform` trim before validation; the same
  one line fixes registration, and Task 22 deliberately left it because auth is not this plan's. Worth
  doing before Milestone 9 shows admin a list of blank customer names.

- **No address mutation surfaces its own failure.** Found by Task 21 and deliberately left: `save`,
  `remove` and `setDefault` in `useAddressMutations` each pass an `onSuccess` and **no `onError`**, so a
  400, 404 or 403 is swallowed — no toast, nothing on screen, the form still populated as though the edit
  took. It is reachable today: the *Address name* input carries no `maxLength` while phone and pincode do,
  so a 41-character label is a silent no-op. Not fixed here because a `maxLength={40}` on one input would
  mask a page-wide gap rather than close it, and closing it properly is a UI change no task asked for.
  Whoever next touches that page should add the `onError` handlers first.

- **Guest order tracking after the confirmation screen closes.** A guest's order has `userId: null` and
  the `orders` table has no guest-token column, so once the placement response is out of the cache there is
  nothing that proves ownership. Task 23 handles this honestly rather than pretending, but the real fix is
  a deliberate choice for later, and there are two: a `guest_token` column on `orders` populated from the
  cart's cookie, which is small but ties an order to one browser; or a `GET /orders/lookup` taking order
  number **and** email, which is the pattern most shops use and works from any device. The second is
  better for customers and adds public surface that can be walked — order numbers are sequential, which is
  why Task 15 refuses to distinguish 404 from 403 — so it needs throttling and a deliberate decision, not
  a late addition to this milestone.

- **Invoices.** `$id.tsx`'s Download Invoice button stays disabled. Its tooltip currently says "Available
  after Phase 2", which will be false the moment this plan lands — Task 19 updates the wording.
- **Shipments.** The `Shipment` entity exists and nothing writes it. Courier integration and
  `POST /admin/orders/:id/shipment` are Milestone 9's.
- **Notifications.** No email or WhatsApp is sent on placement. `Notification` rows have no sender, and
  §9 already records that the absence of a mailer is what keeps register an enumeration oracle.
- **The `>60` catalogue lookup, and its consequence is a money discrepancy rather than a cosmetic one.**
  `WHOLE_CATALOGUE = 60` against the listing DTO's `@Max(60)` means that past 60 products, a basket line
  whose product falls outside the fetched page cannot be resolved. Traced through what that actually does:
  `lineTotal` returns `null` for an unknown slug, `cartTotals` sets `hasUnpriceableLines` and **skips the
  line's money**, and `CheckoutForm` renders *"Some items are unavailable and are not included in this
  total"* — but its Place Order button is `disabled={submitting}` and nothing else, so the order goes
  through. The server, which reads the cart from the database and knows every product, charges the full
  amount. **So the customer is shown a total lower than the one they are charged** — precisely the failure
  `cart-pricing.service.spec.ts` calls out as "a customer being charged more than the basket showed them",
  arriving by a route that spec has no visibility of.

  Eight components fetch the catalogue this way, `CheckoutForm.tsx:93` among them, so this is on the
  checkout path and not only the cart page. Not urgent — the catalogue is 27 products, so there is better
  than two-fold headroom, and nothing is wrong today. But the trigger is ordinary business growth rather
  than any code change, which is an unusually quiet way for a money bug to arrive. The real fix is the one
  already identified: resolve basket lines server-side (`POST /cart/validate`, or simply the priced lines
  `GET /cart` already returns) instead of re-pricing a basket from a client-side copy of the catalogue.
- **The bulk-cart screen shows client-computed money, and the docblock that says it does not is stale.**
  `CartProvider.tsx:166` reads *"`cartTotals` is used for the optimistic window and **nowhere else**. The
  server's figures are authoritative — it computes per-line GST in paise while this accumulates float
  rupees, so the two can differ by a rupee … Do not delete `cart-math.ts` as dead code, and do not start
  trusting it."* The reasoning is right and the containment argument is right *for the cart page*, where
  every server reply overwrites the guess. But "nowhere else" is no longer true: **`bulk-cart.tsx:34`**
  calls `cartTotals` over the bulk slice of the basket and renders the result, and nothing overwrites it,
  because no endpoint returns totals for half a basket.

  Worth knowing exactly how the client's arithmetic differs, since spec §8 claims `cart-math.ts` "is
  corrected to match the server" and it is not: the frontend accumulates `gst += total * rate / 100` as a
  float and calls `Math.round(gst)` **once, on the aggregate, to whole rupees** — so it can never display
  the server's ₹5.01, and on the backend's own three-line ₹33.33 fixture it reports ₹5.00 against the
  server's ₹5.01. On the bulk screen the exposure is small in practice, since bulk lines are usually
  quote-required and carry no price at all, and the binding number is the order's. **Milestone 7 owns
  this** — either that screen asks the server for its figures, or it states plainly that they are
  indicative. Correct the `CartProvider` docblock either way; a "nowhere else" claim that has stopped
  being true is worse than no claim.

- **`order_items` has no `position` column, so a customer's invoice lines are stably but arbitrarily
  ordered.** Task 15 imposes `ORDER BY items.id`, which stops the receipt rearranging itself between
  reads — the actual bug — but `id` is a v4 uuid generated client-side, so the resulting sequence has no
  relationship to the order the customer built the basket in and never will. It is visible, not internal:
  `OrdersTable.tsx:9` renders `order.items[0].name` plus *"+N more"*, so **which product headlines a
  customer's order-list row is decided by a random uuid**. Only a `position` column on `order_items`,
  written at placement from the cart's own line order, fixes it. No task in this plan adds one; it is a
  small migration and belongs with whoever next touches that table.

- **Milestone 7's tier-segment precondition.** `toProductRules` applies no segment filter while the
  product mapper filters to `DEFAULT`, so the page and the cart resolve prices from different tier sets.
  They agree only because one tier shape exists. That must be settled **before** any non-`DEFAULT` tier is
  inserted, not as part of Milestone 7.
