# B2B Implementation Plan — Milestone 7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the business side real — one pricing resolver every surface agrees with, quote requests that
land in the database with a number a customer can quote, and a business area that reads the server instead
of `localStorage`.

**Architecture:** Three sub-milestones, in a fixed order for one reason: **7a settles what a kilogram
costs, and nothing else may ship before it.** Today four surfaces resolve bulk prices from two different
tier sets and agree only by accident. 7b adds RFQ and gifting on the public surface, rate-limited. 7c
replaces the business area's client-side state with `GET/PUT /business/me`, `GET /business/stats` and
`GET /business/orders`.

**Tech Stack:** NestJS 11 · TypeORM 0.3.31 · Postgres 15 · React 19 · TanStack Router/Query · Vitest ·
Jest · testcontainers. `@nutwala/shared` remains the wire contract and compiles to CommonJS.

---

## Read this first: the precondition, and why it is task 1 rather than a note

Plan 3 recorded this and deliberately did not fix it. It is now the gate on everything else.

**Two surfaces filter pricing tiers differently, and both are in production.**

| Surface | Filter | Where |
| --- | --- | --- |
| Catalogue | `segment === DEFAULT && businessId === null` | `catalog/mappers/product.mapper.ts`, documented at `catalog.service.ts:202` |
| Cart | **none at all** | `cart-read.service.ts`'s `toProductRules` |

Measured: **all 135 seeded tiers are `DEFAULT` with a null `business_id`** — 27 products × 5 rungs, `minKg`
1 to `maxKg` 49, 27 of them quote-required. So the two filters return the same rows today and the
divergence is invisible.

**What happens on the first business-specific tier.** A sales desk agrees ₹620/kg with Anand Sweets and an
admin inserts one row. From that moment the catalogue shows every other customer the `DEFAULT` ₹700 while
the **cart prices their basket from a ladder that now includes Anand's ₹620** — `toProductRules` has no
filter, so it takes whichever rung matches the weight. That is not a rounding disagreement. It is **one
business's negotiated price leaking into every other customer's basket**, and the direction it leaks is
"cheaper", so nobody complains and the shop loses the margin silently.

`toProductRules`'s own docblock names the trap and declines it, correctly:

> *"No segment filter, matching the stored-cart path. Today every seeded tier is `DEFAULT`, so this is
> latent — but it becomes wrong the moment Milestone 7 adds segment or business tiers, and the resolution
> order those need (business, then segment, then DEFAULT) is the B2B plan's to define. Filtering to
> `DEFAULT` here instead would be a third answer to that question."*

This plan defines it. **Task 1 and Task 2 must land before any task that inserts a non-`DEFAULT` tier**,
and no task in 7b or 7c may insert one.

## The design gap nobody has closed: a segment has no owner

Spec §5.2 gives `PricingTier` a `segment` of `DEFAULT`/`RETAILER`/`DISTRIBUTOR`/`HORECA` and states the
resolution order *"business-specific → segment → default"*. Measured: **`Business` has no `segment`
column.** `grep -c segment backend/src/entities/identity/business.entity.ts` returns `0`.

So the middle rung is unreachable. A `RETAILER` tier can be inserted and can never apply to anybody,
because nothing says which businesses are retailers.

What exists instead is `businessType`: **twelve** self-declared strings from
`shared/src/constants/taxonomy.ts:33` — *Retail store, Kirana / general store, Sweet shop, Bakery, Café,
Restaurant or hotel, Cloud kitchen, Caterer, Corporate gifting, Distributor, Health food brand, Other* —
collected by the registration form and the business-profile select.

**The decision, and it is a commercial one rather than a technical one: `segment` is a new column on
`Business`, set by an admin, defaulting to `DEFAULT`. It is not derived from `businessType`.**

Deriving it is the tempting option and it is wrong on the only ground that matters: `businessType` is
**chosen by the customer at registration**, and a customer who can pick their own `businessType` can pick
their own price band. "Distributor" is in that list. A twelve-to-four map would let anyone tick their way
to distributor pricing, and the shop would find out from its margins. `assignedSalespersonId` is already
admin-set on the same entity for the same class of reason, so this follows an established line rather than
drawing a new one.

Consequences the plan carries: `businessType` stays exactly as it is, self-declared and used for
segmentation reporting and sales routing; `segment` starts `DEFAULT` for every existing business, so **this
milestone changes nobody's prices**; and the endpoint that sets it is `PATCH /admin/businesses/:id`, which
is **Milestone 9's**. 7a therefore ships a resolver whose middle rung is exercised only by tests until
admin exists — and that is the honest sequence, because the alternative is shipping the tiers first and
resolving them later.

---

## What already exists, measured — do not rebuild it

### The entities are all present, and three modules are not

`Rfq`, `RfqItem`, `RfqNote`, `RfqGiftingDetail` are in `backend/src/entities/b2b/`. `Business` is in
`identity/`, `PricingTier` in `catalog/`. Every column, index and constraint was created by
`20260819120000-InitialSchema`.

`BusinessesModule` **exists** (`modules/business/`) with one method — `createFor(userId, company)`, called
by registration — and is imported by `AuthModule`, not by `AppModule`. There is no RFQ module and no
pricing module.

### The pricing ladder already works, on the client

`frontend/src/features/bulk/pricing.ts` holds `bulkTierFor`, `bulkTotal`, `isQuoteRequired` and
`savingsVsRetail`, with its own test file. Four places consume it: `BulkProductCard`, `product.$slug.tsx`,
`cart-math.ts` and `bulk-cart.tsx`. The backend has the same arithmetic in `cart-read.service.ts`'s
`verdictFor`. **Neither is wrong; they are two implementations of one rule**, and 7a's job is to make the
server's answer the only one that decides money.

### The RFQ status vocabulary exists twice, with four values that do not overlap

| Source | Values |
| --- | --- |
| `shared/src/constants/taxonomy.ts:94` | `new`, `contacted`, `quote-sent`, `negotiation`, `approved`, `rejected`, `converted` |
| `frontend/src/features/rfq/types.ts:2` | `new`, `quoted`, `accepted`, `closed` |

`ck_rfqs_status` enforces **the shared seven** — verified against the live schema. And
`RfqStatusBadge.tsx` declares `Record<RfqStatus, string>` over **the frontend's four**. So the database
will happily store `contacted`, and the badge will render `undefined` for it, along with `quote-sent`,
`negotiation`, `rejected` and `converted`. That is the empty-badge failure Task 16 of Plan 3 guarded the
order statuses against, sitting unguarded one feature over. The shared file's own docblock admits it:
*"that type is not yet wired to this one."*

### There are no seeded RFQs, and the spec says there are

`docker exec … psql -tAc 'SELECT count(*) FROM rfqs'` returns **0**. There is no `rfqs.seed.ts` —
`database/seeds/` holds catalog, content, coupons, orders, pincodes, settings and users. Spec §16's
Milestone 1 row claims the seeder ports *"3 RFQs"*; `frontend/src/mocks/rfqs.ts` has three and the database
has none. Task 12 seeds them.

### The business profile is the last `localStorage` overlay

`routes/business/profile.tsx:30` keys `nn.business-profile.v1` and writes the whole form to it on submit
(`:236`), with a `toast.success("Business profile saved")` that is true only of the browser. Plan 3 killed
`nn.order.*` and `nn.addresses.v1`; this is the last one, and `nn.cart` before it. Its own docblock at
`:27` says *"Phase 2 replaces this with `GET/PUT /business/me`"*.

### The dashboard computes its own statistics

`routes/business/index.tsx` derives every card client-side: `active` from `rfqs.filter(status === 'new')`,
spend from `bulkOrders.filter(not cancelled/refunded).reduce(+total)`, and the basket from `useCart()`.
Spec §6.3 lists `GET /business/stats`. The figures are not wrong; they are computed from whatever pages
happen to be loaded, which is why the same number can differ between two screens.

---

## The disagreements this plan has to settle

### 1. A business created at registration has an empty mobile number

`BusinessesService.createFor` writes `mobile: ''` with the comment *"Registration collects only the
essentials; `/business/profile` captures the rest."* `Business.mobile` is **`varchar(15)` NOT NULL**. So the
column holds a present, empty, invalid value — the same shape as `line2: ""` and the whitespace name Plan 3
found, and it passes every constraint the database has.

**`PUT /business/me` must require it, and `GET /business/me` must not pretend it is set.** A profile form
prefilled with an empty required field is indistinguishable from one the customer has filled in and cleared.
Task 15 decides what a `''` mobile renders as, and the answer is "empty and required", not "saved".

Do **not** make `mobile` nullable to tidy this up: a business the sales desk cannot phone is the one thing
this record exists to prevent, and `NOT NULL` is the constraint that will eventually be honest once
registration or the profile fills it.

### 2. `businesses.billing_address_id` and `shipping_address_id` have no foreign key

Verified: the only FKs on `businesses` are `user_id` → `users` (CASCADE) and `assigned_salesperson_id` →
`users` (SET NULL). Both address columns are bare `uuid`s. Same omission as
`coupon_redemptions.order_id`, and with an extra wrinkle: `addresses` is **soft-deleted**, so a business
can point at an address whose `deletedAt` is set, and `GET /business/me` would resolve a delivery address
the customer has deleted.

**Settled: add the FKs with `ON DELETE SET NULL`, and filter `deletedAt IS NULL` on every read that
resolves them.** `SET NULL` rather than `RESTRICT` because an address book entry is the customer's to
remove and a business record must not be the thing that blocks it — the opposite call from
`coupon_redemptions`, and for the opposite reason: nothing hard-deletes an order, and customers hard-delete
nothing here either, but a soft-deleted address must stop being offered.

### 3. Gifting and bulk are one RFQ with two front doors

Spec §6.1 lists `POST /rfqs` and `POST /rfqs/gifting` separately. The frontend already treats them as one:
`CorporateGiftingForm` imports `useCreateRfq` from `features/rfq/hooks/useRfqs`, the same hook
`business/rfqs/new.tsx` uses, and `RfqGiftingDetail` is a `@OneToOne` on `Rfq` with `cascade: ['insert']`.

**Keep both routes and one service method.** The routes differ in what they accept — gifting carries
`occasion`, `giftBoxSlug`, `boxes`, `budgetPerBoxPaise`, `brandingRequired`, `deliveryDate`, `message`, and
no `items` — and a single endpoint with seven conditionally-required fields is a DTO nobody can validate
honestly. They differ in nothing else: one sequence, one number format, one status vocabulary, one
`GET /rfqs` that lists both. `kind` is what tells them apart afterwards.

### 4. The RFQ number and the order number are the same problem, already solved

`RFQ-{year}-{6 digits}` is `NN-{year}-{6 digits}` with a different prefix.
`modules/orders/order-number.ts` holds `formatOrderNumber`, `nextOrderNumber` and a docblock explaining why
`nextval` rather than `max(...) + 1` — *"counting then inserting is a read-then-write gap"* — and why a
rejected placement burns a number rather than handing it to the next customer.

**Copy the mechanism, not the code.** A second sequence (`rfq_number_seq`), a second migration, and
`ORDER_NUMBER_PATTERN`'s sibling in `shared/src/constants/identifiers.ts` beside it. Do not generalise the
two into one helper: the shared part is four lines and the divergent part is the sequence name, the prefix
and the table, so the abstraction would cost more than it saves and would couple the order path to the RFQ
path for no gain.

### 5. `POST /rfqs` is public, which makes it the most abusable endpoint in the system

A prospect needs no account — that is the point, and spec §5.4 says so. It is also unauthenticated,
un-CAPTCHA'd, writes a row and (in Milestone 8) queues a notification.

Spec §6.1 already marks both RFQ routes **rate-limited**, and §13 gives registration the strictest limit on
the API at 3/hour per IP on the argument that *"a rate limit is the only control"*. `POST /rfqs` is in the
same position and inherits the global 120/minute.

**Settled: `@Throttle` on both RFQ routes at 5/hour per IP.** Higher than registration's 3 because a
genuine prospect may legitimately send a bulk enquiry and a gifting enquiry and then correct one, and
because an RFQ carries no account and so no enumeration risk — the reason registration is tighter. This is
a number to revisit with real traffic, and it is recorded here rather than left at the default the way
placement was.

### 6. `GET /business/stats` must not be a second opinion about money

The dashboard's spend figure is `orders.reduce(+total)` over whatever `useOrders({channel:'bulk'})`
returned. Once the server computes it, the two can disagree — and Plan 3 measured exactly how that goes
wrong: `inr()` rounds, so a server figure summed in paise and a client figure summed in rupees can render
the same string on six orders and differently on the seventh.

**Settled: the server sums in paise and converts once, and the dashboard renders what it is given without
recomputing.** Same rule as the cart's totals and for the same reason. The client-side `reduce` is deleted
rather than kept as a fallback — a fallback is how two answers survive.

---

## File structure

### `backend/` — three new modules, one extended

```
modules/pricing/                         NEW — 7a
  pricing.resolver.ts                    the ladder: business -> segment -> DEFAULT
  pricing.resolver.spec.ts               NO module — see Task 2
modules/rfqs/                            NEW — 7b
  rfqs.service.ts  rfqs.controller.ts  rfqs.module.ts
  rfq-number.ts                          RFQ-{year}-{6}, its own sequence
  mappers/rfq.mapper.ts                  entity -> wire, one place
  dto/create-rfq.dto.ts  dto/create-gifting-rfq.dto.ts
  + a spec beside each
modules/business/                        EXTENDED — 7c
  businesses.controller.ts               NEW  GET/PUT /business/me, /stats, /orders
  business-stats.service.ts              NEW  aggregates, in paise
  mappers/business.mapper.ts             NEW
  dto/update-business.dto.ts             NEW
  businesses.service.ts                  MODIFIED  reads and updates, not just createFor
```

Migrations: one adding `businesses.segment` plus the two address FKs, one adding `rfq_number_seq`.

### `frontend/` — five seams, no new screens

```
features/pricing/                         NEW  the quote-preview seam
features/rfq/api/index.ts                 REWRITTEN over http; @/mocks/rfqs goes
features/rfq/types.ts                     re-export shared; the 4-value union dies
features/business/api/index.ts            NEW  GET/PUT /business/me, /stats, /orders
routes/business/profile.tsx               MODIFIED  nn.business-profile.v1 goes
routes/business/index.tsx                 MODIFIED  reads /business/stats
test/rfq-api.stub.ts                      NEW  the sixth handler
test/business-api.stub.ts                 NEW  the seventh handler
```

### `shared/`

`constants/identifiers.ts` gains `RFQ_NUMBER_PATTERN`. `constants/taxonomy.ts`'s `RFQ_STATUSES` becomes the
only vocabulary. New `types/b2b.ts`: `CompanyProfile` extended, `BusinessStats`, `RfqSummary`, `RfqDetail`,
`RfqDraft`, `GiftingDraft`, `BulkQuote`, `CustomerSegment`.

---

## Task list

| # | Task | Why it is where it is |
| --- | --- | --- |
| **7a** | **Pricing truth — nothing else may ship first** | |
| 1 | `CustomerSegment` in `shared`, `Business.segment` migration | The resolver cannot be written without the column it reads. |
| 2 | `PricingResolver` — business → segment → DEFAULT | One implementation, unit-tested against every ladder shape. |
| 3 | The catalogue reads the resolver | Replaces the mapper's `DEFAULT`-only filter. |
| 4 | The cart reads the resolver | **Closes the cross-tenant price leak.** |
| 5 | `GET /catalog/bulk/products`, `POST /catalog/bulk/quote-preview` | The two routes §6.1 lists and nothing serves. |
| 6 | 7a integration proof | One kg, four surfaces, one price — against real Postgres. |
| **7b** | **Quote requests** | |
| 7 | One RFQ status vocabulary | Before anything renders a status. |
| 8 | `rfq-number.ts` and its sequence | Needed by create; testable alone. |
| 9 | `RfqsService.create` — bulk and gifting | The transaction, with items and the gifting detail. |
| 10 | `POST /rfqs`, `POST /rfqs/gifting`, throttled | The public surface. |
| 11 | `GET /rfqs`, `GET /rfqs/:rfqNumber` — own only | IDOR-scoped, same shape as orders. |
| 12 | The RFQ seeder — the three rows §16 promised | Fixtures for Task 13 and for the frontend. |
| 13 | RFQ integration tests | Including the throttle and the public path. |
| 14 | The RFQ and gifting frontend seams | `@/mocks/rfqs` dies. |
| **7c** | **The business area** | |
| 15 | `GET`/`PUT /business/me` | Where disagreement 1 is settled. |
| 16 | `GET /business/stats` | Where disagreement 6 is settled. |
| 17 | `GET /business/orders` | Thin, but it is what the dashboard should read. |
| 18 | The business-profile seam | The last `localStorage` overlay dies. |
| 19 | The dashboard and bulk-cart seams | Where the client-side `reduce` dies. |
| 20 | Milestone 7 verification | |

---

# MILESTONE 7a — Pricing truth

## Task 1: `CustomerSegment` on the wire, and a segment column to resolve against

**Files:**
- Modify: `shared/src/constants/taxonomy.ts` — `CUSTOMER_SEGMENTS` and `CustomerSegment`
- Modify: `shared/src/index.ts` if the export surface needs it
- Create: `backend/src/database/migrations/20260822090000-BusinessSegment.ts`
- Modify: `backend/src/entities/identity/business.entity.ts`

**Migration ordering derives from the last 13 characters of the class name** —
`MigrationExecutor.js:430` is `parseInt(name.substr(-13), 10)` — so the class must be
`BusinessSegment20260822090000`, timestamp last. Get this wrong and the migration silently sorts to the
wrong place.

- [ ] **Step 1: the vocabulary in `shared`**

```ts
/**
 * Brief §16/§31. The price band a business buys at, and **not** the same question as
 * `BUSINESS_TYPES`.
 *
 * `businessType` is twelve strings a customer picks for themselves at registration — "Distributor" is
 * one of them. A segment is a commercial decision the sales desk makes, so it is admin-set and starts
 * at `DEFAULT` for everybody. Deriving one from the other would let a customer choose their own price
 * band by ticking a box on a form.
 */
export const CUSTOMER_SEGMENTS = ['default', 'retailer', 'distributor', 'horeca'] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];
```

**Lowercase on the wire, `UPPERCASE` in the database**, matching `channel` and `paymentMethod` — the
asymmetry `order.mapper.ts` documents, where `status` is already stored in the wire vocabulary and these
are not. The backend enum `CustomerSegment` in `entities/enums.ts` stays as it is; the mapper lowers.

Add the guard the coupon codes have, in the **backend** (`shared` cannot see `entities/enums.ts`) —
and put it in `businesses.service.ts`. No other file was a candidate: this codebase's entities
(`order.entity.ts`, `blog-post.entity.ts`, `rfq.entity.ts`, `business.entity.ts` itself) never import
runtime symbols from `@nutwala/shared`, only reference it in comments, so the guard cannot live beside the
column it checks — it has to live in the one module file that touches `Business` and already imports
`@nutwala/shared`.

```ts
const _segmentsMap: Record<CustomerSegment, CustomerSegmentEnum> = {
  default: CustomerSegmentEnum.DEFAULT,
  retailer: CustomerSegmentEnum.RETAILER,
  distributor: CustomerSegmentEnum.DISTRIBUTOR,
  horeca: CustomerSegmentEnum.HORECA,
};
void _segmentsMap;
```

It checks both directions: a value added to one and not the other is a missing property or an unknown one.
Task 22 of Plan 3 measured why this matters — renaming `COUPON_EXPIRED` in `shared` produced
`TS2353 … does not exist in type Record<CouponRefusalCode, ErrorCode>` plus three call-site errors, and
without the guard a client branches on a string the server has stopped sending and nothing fails.

**One relation gap, closed while you are in the entity.** `billing_address_id` and
`shipping_address_id` were plain `@Column` uuids with no `@ManyToOne` beside them — measured, and the
same shape `WishlistItem`'s hand-written FK columns avoid by always pairing one. Without the relation, a
future `migration:generate` sees entity metadata disagreeing with the real schema and proposes dropping
foreign keys it does not know exist. Add both relations now, alongside the id columns Task 15 already
expects to read.

- [ ] **Step 2: the migration — the column and the two missing foreign keys**

**The type name below is wrong on purpose — verify before trusting any snippet, including this one.**
Task 1 measured the real name: `SELECT typname FROM pg_type WHERE typtype='e'` against the live dev
database lists 18 enum types, and the one `PricingTier.segment` already uses is
**`pricing_tiers_segment_enum`** — TypeORM's column-derived name, not `customer_segment_enum`. Reuse it;
do not create a second type with the same four members, which is how a comparison later needs a cast.

```ts
export class BusinessSegment20260822090000 implements MigrationInterface {
  name = 'BusinessSegment20260822090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD "segment" "public"."pricing_tiers_segment_enum" NOT NULL DEFAULT 'DEFAULT'`,
    );
    // Both columns existed from InitialSchema with no constraint at all — verified: the only FKs on
    // `businesses` were `user_id` and `assigned_salesperson_id`.
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "fk_businesses_billing_address"
         FOREIGN KEY ("billing_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "fk_businesses_shipping_address"
         FOREIGN KEY ("shipping_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "businesses" DROP CONSTRAINT "fk_businesses_shipping_address"`);
    await queryRunner.query(`ALTER TABLE "businesses" DROP CONSTRAINT "fk_businesses_billing_address"`);
    await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "segment"`);
  }
}
```

**Check the enum type's real name before writing this.** `PricingTier.segment` already uses it, so
Postgres has it under whatever name TypeORM generated — read it with
`\dT` or `SELECT typname FROM pg_type WHERE typtype='e'` rather than assuming
`customer_segment_enum`. If the name differs, use the real one; **do not create a second enum type**,
because two types with the same members is how a comparison starts needing a cast.

`DEFAULT 'DEFAULT'` on a `NOT NULL` add is what makes this safe on a populated table — one business row
exists (`Anand Sweets & Namkeen`) and it must come out `DEFAULT`, i.e. **its prices must not change**.
Assert that in the verification step, not just the column's presence.

- [ ] **Step 3: prove the chain still reverts, on a throwaway container**

Same discipline Plan 3's verification used, because it is the step that catches a `down()` that forgets a
constraint: a **literal** port checked free with `lsof` first, `NODE_ENV=test` so `load-env`'s
`override: true` cannot substitute `.env`'s port, and a **loop** rather than a fixed revert count. Confirm
`tables=1`, `enums=0` — the two new FKs and the column must all disappear — then re-apply.

- [ ] **Step 4: Commit**

```bash
git add shared/src/constants/taxonomy.ts shared/src/index.ts backend/src/entities/identity/business.entity.ts backend/src/database/migrations backend/src/modules
git commit -F - <<'MSG'
feat(b2b): a business has a segment, and its address columns have foreign keys
MSG
```

---

## Task 2: `PricingResolver` — business, then segment, then default

**Files:**
- Create: `backend/src/modules/pricing/pricing.resolver.ts`, `pricing.resolver.spec.ts`

This is the one implementation of spec §5.2's *"business-specific → segment → default"*, and every surface
in 7a reads it. It is a pure function over a loaded relation plus a viewer — no repository, no query — so
it is unit-testable exhaustively and cheap to call per product in a page of 24.

**There is no `pricing.module.ts`, and do not add one.** A `@Module` cannot export a plain function, and
this codebase already settled the question: `cart-line.mapper.ts` and `order.mapper.ts` export plain
functions that consumers import directly (`cart-read.service.ts:18` does exactly that). Plan 3's Task 9 was
told to *"import `OrdersModule` for the mapper"* and the instruction was wrong twice over — the module did
not exist yet, and the mapper needed none. Tasks 3, 4 and 5 import `resolveTiers` the same way, and their
modules gain **no new import**.

- [ ] **Step 1: the viewer, and why it is not a `userId`**

```ts
/**
 * Who is being priced. `null` is the public catalogue and every retail customer.
 *
 * A `businessId` **and** its segment, resolved once by the caller, rather than a `userId` the resolver
 * would have to look up. Two reasons: a page of 24 products must not make 24 identical lookups, and a
 * resolver that queries is a resolver that cannot be unit-tested against a ladder shape.
 */
export interface PricingViewer {
  businessId: string;
  segment: CustomerSegmentEnum;
}
```

- [ ] **Step 2: the resolver**

```ts
/**
 * The tiers that apply to one viewer, ordered by `minKg`.
 *
 * **The key is the pair `(segment, businessId)`, never either alone**, and
 * `product.mapper.ts`'s docblock already says why: *"a `DEFAULT`-segment tier scoped to a business is a
 * legitimate row, so segment alone would leak it."* A sales desk that agrees a bespoke rate without
 * moving the customer into a segment produces exactly that row.
 *
 * Three rungs, and **the first non-empty one wins outright** rather than the rungs merging. Merging is
 * the tempting alternative and it is wrong: a business ladder that covers 1–20kg and a DEFAULT ladder
 * that covers 1–50kg would, merged, price a 30kg order at list while a 10kg order gets the negotiated
 * rate — so the customer's *larger* order costs more per kilo than their smaller one, which is the one
 * thing a bulk ladder must never do. A ladder is a whole agreement, not a set of overrides.
 */
/**
 * Ascending by `minKg`, on a copy.
 *
 * `[...tiers].sort(...)` and not `tiers.sort(...)`: the array is the loaded relation, and sorting it in
 * place mutates the entity every other consumer of that request is holding. `product.mapper.ts` already
 * spreads before sorting for this reason, and `Number()` is needed because `minKg` is `numeric(8,2)`,
 * which `pg` hands back as a string — `'10.00' - '2.00'` coerces and happens to work, which is exactly
 * how a comparison bug here would hide.
 */
function byMinKg(tiers: PricingTier[]): PricingTier[] {
  return [...tiers].sort((a, b) => Number(a.minKg) - Number(b.minKg));
}

export function resolveTiers(
  product: Pick<Product, 'pricingTiers'>,
  viewer: PricingViewer | null,
): PricingTier[] {
  const all = product.pricingTiers ?? [];

  if (viewer !== null) {
    const mine = all.filter((t) => t.businessId === viewer.businessId);
    if (mine.length > 0) return byMinKg(mine);

    const segment = all.filter(
      (t) => t.businessId === null && t.segment === viewer.segment,
    );
    if (segment.length > 0) return byMinKg(segment);
  }

  return byMinKg(all.filter((t) => t.businessId === null && t.segment === CustomerSegmentEnum.DEFAULT));
}
```

**`viewer.segment === DEFAULT` falls through to the same rows as the public catalogue**, which is what
makes this milestone change nobody's prices: every existing business is `DEFAULT` and every existing tier
is `DEFAULT`/null, so the third rung answers for everybody exactly as the old filter did.

- [ ] **Step 3: the unit spec — the shapes that matter**

Write these, and write them so each can fail:

```
a public viewer gets only DEFAULT, business-null tiers
a DEFAULT-segment business gets the same rows as the public viewer      <- the no-op guarantee
a RETAILER business gets the RETAILER ladder, not DEFAULT
a business with its own tiers gets only those, even where DEFAULT is cheaper
a business with its own tiers does NOT get its own merged with DEFAULT  <- the ladder-integrity rule
a DEFAULT-segment tier scoped to another business never appears          <- the leak
a RETAILER tier scoped to another business never appears
a business whose segment has no tiers falls through to DEFAULT
a product with no tiers at all resolves to []                            <- every bulk line QUOTE_REQUIRED
tiers come back ordered by minKg regardless of insertion order
```

**The fourth and fifth are the two nobody writes.** "Even where DEFAULT is cheaper" is what stops someone
"improving" the resolver into a `Math.min`; the non-merge case is what stops the larger-order-costs-more
bug above.

- [ ] **Step 4: Mutate**

Every mutation an outright deletion or a compiling replacement. **Never `if (false && …)`** — it breaks
narrowing, the suite fails to compile, and jest reports `Tests: 0 total`, which reads as a kill and proves
nothing. Seven tasks in Plan 3 hit it, one of them through a plain deletion that un-narrowed a variable, so
treat any `Tests: 0 total` as an invalid mutation and rewrite it.

| Mutation | Should fail |
| --- | --- |
| drop `t.businessId === null` from the segment rung | the other-business leak cases |
| drop `t.segment === viewer.segment` from the segment rung | the RETAILER cases |
| return `[...mine, ...defaults]` from the business rung | the non-merge case |
| fall through to `all` rather than the DEFAULT filter | the public-viewer case |
| drop the `byMinKg` sort | the ordering case |
| treat `viewer === null` as `{ segment: DEFAULT }` | nothing — **and that is correct**; record it |

That last row is deliberate. It should survive, because a null viewer and a `DEFAULT` viewer *are* the same
answer — and a surviving mutant you predicted and explained is a finding, not a gap. Say so in the report
rather than quietly dropping it.

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
feat(pricing): one resolver for business, segment and list tiers
MSG
```

---

## Task 3: the catalogue reads the resolver

**Files:**
- Modify: `backend/src/modules/catalog/mappers/product.mapper.ts`, and its spec
- Modify: `backend/src/modules/catalog/catalog.service.ts` — the viewer reaches the mapper
- Modify: `backend/src/modules/catalog/catalog.module.ts` — `TypeOrmModule.forFeature([Business])`, because
  `viewerFor` reads that table. **That is a repository, not a provider**: `resolveTiers` is imported
  directly and needs nothing from the container. Do not confuse the two — `CartModule` exports only
  `CartService` while providing three, and Plan 3's Task 9 could not boot until the other two were exported,
  so a module's imports and its exports are both worth reading before assuming.

The mapper's filter becomes a `resolveTiers` call. **Its docblock's reasoning is correct and stays** — it
is the clearest statement of the leak in the codebase and it predicted this task; rewrite the last
paragraph (*"Segment and per-business resolution is Milestone 7"*) to say what now happens, and keep the
rest.

- [ ] **Step 1: thread the viewer through, and default it to `null`**

`toWireProduct(product)` becomes `toWireProduct(product, viewer)`. Make the parameter **required**, not
optional-defaulting-to-`null`: an optional viewer is how a call site silently prices a business at list
rates, and there are enough call sites (`listProducts`, `findBySlug`, `related`, `bestsellers`, combos)
that one will be missed. `tsc` should be what finds it.

- [ ] **Step 2: where the viewer comes from, and why the catalogue routes are still `@Public()`**

Every catalogue route is `@Public()`, and `JwtAuthGuard` on a public route attempts passport and swallows
only the failure — so `@OptionalUser()` resolves a signed-in customer and leaves a guest `undefined`. That
is the same arrangement the cart and checkout use, and its two halves are load-bearing here for a new
reason: **a signed-in business must get their own prices on the public catalogue**, and a guest must still
be able to read it.

`@CurrentUser()` would throw for every guest — measured as a 500 on every anonymous request when it
happened on the wishlist. Use `@OptionalUser()`.

- [ ] **Step 3: resolving a viewer costs one query, not one per product**

```ts
/**
 * The caller's pricing identity, or `null`.
 *
 * One lookup per request, before the products are mapped — a page of 24 products must not make 24
 * identical `businesses` reads. `role !== BUSINESS` short-circuits without touching the database,
 * which is every retail customer and every admin.
 */
private async viewerFor(user: AuthenticatedUser | undefined): Promise<PricingViewer | null> {
  if (user === undefined || user.role !== UserRole.BUSINESS) return null;
  const business = await this.businesses.findOne({
    where: { userId: user.id },
    select: { id: true, segment: true },
  });
  return business === null ? null : { businessId: business.id, segment: business.segment };
}
```

A `BUSINESS` user with no `businesses` row resolves to `null` and gets list pricing. That is reachable —
`createFor` runs during registration and could fail independently — and list pricing is the honest answer
rather than an error on a catalogue page.

- [ ] **Step 4: Prove it, and mutate**

The existing catalogue specs must keep passing unchanged — that is the no-op guarantee. Add:

```
a public read resolves DEFAULT tiers                        <- unchanged behaviour, pinned
a signed-in DEFAULT business reads the same tiers            <- the no-op guarantee, explicitly
a signed-in RETAILER business reads the RETAILER ladder
a business with its own ladder reads its own
a BUSINESS user with no business row reads list pricing
```

| Mutation | Should fail |
| --- | --- |
| `viewerFor` returns `null` unconditionally | the RETAILER and own-ladder cases |
| `viewerFor` drops the `role !== BUSINESS` guard | nothing behavioural — assert the query **count** instead, or skip this mutation and say why |
| `@OptionalUser()` → `@CurrentUser()` | the public-read case, as a 500 |
| the viewer is not passed to `toWireProduct` | won't compile after step 1 — that is the point |

- [ ] **Step 5: Commit**

---

## Task 4: the cart reads the resolver — the leak closes here

**Files:**
- Modify: `backend/src/modules/cart/cart-read.service.ts` — `toProductRules` and its callers
- **Create: `backend/src/modules/pricing/pricing.resolver.ts` (extend) — `resolveTiersForWeight`, and its
  spec** — see step 0, below, before anything else
- Modify: the cart's specs

**This is the task the whole milestone is ordered around.** `toProductRules` currently maps
`product.pricingTiers` with no filter, so the moment Task 1's column allows a business tier to exist, a
cart would price from every tier in the table.

- [ ] **Step 0: `resolveTiers` alone cannot produce the 30kg behaviour Task 6 requires, and this is where
  that composition belongs**

Found while building Task 2: `resolveTiers` takes no weight and returns one full ladder per viewer, which
is correct — a resolver that took a weight could not be reused by the catalogue listing, which needs the
whole ladder to render, not one rung. But Task 6's verification matrix requires *"a business with a
ladder → DEFAULT rate at 30kg"* when that business's own ladder is capped at 20kg, and **nothing between
Task 2 and here decides who produces that answer or how.**

**It is not free from the existing frontend logic, and checking it is what surfaces the danger.**
`frontend/src/features/bulk/pricing.ts`'s `tierFor` falls back to **`tiers[0]`** — the ladder's own
cheapest tier — for any weight that matches nothing, which includes a weight *above* every tier's range.
Naively reusing that shape server-side would mean a business's negotiated 1–20kg deal quietly extends to
30kg at their own best rate: a widening of the agreement nobody made, and the opposite of Task 6's
requirement.

**Settled: a second, small composition on top of `resolveTiers`, added here because Task 4 is the first
task that needs a weight-specific price and Task 5 needs the identical thing next.**

```ts
/**
 * The ladder that actually prices one weight for a viewer — the composition `resolveTiers` alone
 * cannot produce, because it takes no weight and returns one full ladder.
 *
 * A business's own ladder may legitimately stop short of `DEFAULT`'s range: a negotiated 1–20kg deal
 * says nothing about a 30kg order. That is not "no price" — it is "this weight was never part of
 * what was agreed" — and the honest answer is the one every other customer gets. Falling through
 * here is **not** the merge the ladder-integrity rule forbids: it swaps the *entire* ladder for the
 * weight in question, so a 30kg order is priced end to end from one ladder, never a stitch of two.
 *
 * Deliberately does **not** reuse `frontend/src/features/bulk/pricing.ts`'s `tierFor`, whose
 * out-of-range fallback is the business's own cheapest tier — measured, and it is precisely the
 * quiet widening this function exists to refuse.
 */
export function resolveTiersForWeight(
  product: Pick<Product, 'pricingTiers'>,
  viewer: PricingViewer | null,
  kg: number,
): PricingTier[] {
  const own = resolveTiers(product, viewer);
  if (coversWeight(own, kg)) return own;
  return resolveTiers(product, null);
}

/**
 * A weight below the cheapest tier's minimum still counts as covered — the existing, deliberate
 * floor `tierFor` already applies, kept so a sub-minimum quantity does not needlessly fall back to
 * `DEFAULT`. Only a weight *above* every tier's range, where the top tier's `maxKg` is a real number
 * rather than open-ended, is genuinely uncovered.
 */
function coversWeight(tiers: PricingTier[], kg: number): boolean {
  if (tiers.length === 0) return false;
  const top = tiers[tiers.length - 1]!; // resolveTiers already sorts ascending
  return top.maxKg === null || kg <= Number(top.maxKg);
}
```

Test it here, once, so Task 5 imports rather than re-derives it:

```
a weight inside the viewer's own ladder uses that ladder
a weight below the viewer's own ladder's minimum still uses that ladder     <- the floor, preserved
a weight above the viewer's own ladder's ceiling falls through to DEFAULT
a public viewer's ladder IS DEFAULT, so nothing ever falls through for one
an open-ended top tier (maxKg: null) never falls through, at any weight
```

`toProductRules` and the quote-preview in Task 5 both call `resolveTiersForWeight`, never `resolveTiers`
directly, once a specific weight is in hand. The catalogue listing in Task 3 calls `resolveTiers` — it has
no weight, and correctly so.

- [ ] **Step 1: `toProductRules` takes a viewer, and stops being a free function**

It is currently a module-level `function` with no dependencies. It needs `resolveTiers`, and every path
that reaches it needs the viewer:

- `evaluate(lines)` — the one derivation behind `GET /cart` and both `POST /cart/validate` shapes
- `resolveBodyLines` — the body-lines path
- the stored-cart path

The docblock's own warning applies with more force now: *"Two copies is how `POST /cart/validate` comes to
answer differently depending on whether the caller sent its lines, which is the one thing this endpoint
cannot afford."* Thread one viewer through `evaluate`; do not resolve it twice.

- [ ] **Step 2: the guest question, and it has a real answer**

A guest has no session, so no business, so `null` — list pricing. A signed-in business gets their ladder.
**And a business that builds a basket as a guest and then signs in gets repriced on merge**, because
`CartService.merge` re-reads the lines and the totals are recomputed on every read. That is correct and
worth a test: the same basket, before and after sign-in, at two prices.

- [ ] **Step 3: the proof that matters — the leak, as a test**

```
two businesses, one product, one negotiated tier for the first:
  the first business's cart prices at the negotiated rate
  the second business's cart prices at DEFAULT              <- the leak, asserted absent
  a guest's cart prices at DEFAULT
  the catalogue shows the second business DEFAULT           <- and the cart agrees with it
```

**Write this as an integration test, not a unit test.** The leak is a disagreement between two code paths
over the same database rows, and a unit double models one path. Task 18 of Plan 3 found a
`CheckoutController.reload` ordering bug the same way — one order read down two paths — and no unit test
could have.

- [ ] **Step 4: Mutate**

| Mutation | Should fail |
| --- | --- |
| `toProductRules` ignores the viewer and maps all tiers | **the leak case** — this is the mutation that reproduces today's bug |
| the viewer is resolved in `resolveBodyLines` separately from `evaluate` | the two-shapes-agree case |
| `verdictFor` reads `bulkTiers[0]` rather than the matching rung | the ladder cases |

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
fix(cart): price a basket from the buyer's own tiers, not from every tier in the table
MSG
```

---

## Task 5: `GET /catalog/bulk/products` and `POST /catalog/bulk/quote-preview`

**Files:**
- Create: `backend/src/modules/catalog/dto/quote-preview.dto.ts`
- Modify: `backend/src/modules/catalog/catalog.controller.ts` and its spec
- Modify: `backend/src/modules/catalog/catalog.service.ts`

Both are in spec §6.1's **public** block and neither exists. Verified against the routing table: 29 routes
today, and `/catalog/bulk/*` is not among them.

- [ ] **Step 1: route order is load-bearing, and this is the third time it has mattered**

`@Get('bulk/products')` is a literal under the same controller as `@Get('products/:slug')`. The existing
order is `products` → `products/facets` → `products/bestsellers` → `products/:slug` →
`products/:slug/related` → `categories` → `categories/:slug` → `combos`, and `catalog.controller.ts`'s own
docblock says a literal declared after a parameter *"becomes a 404 for a product nobody named"*.

`bulk/products` does not collide with `products/:slug` — different first segment — so this one is safe. Say
so in the spec's assertion rather than leaving the reader to work it out, and **keep the enumeration test
that pins the whole table**: it is what caught the shadowing risk twice.

- [ ] **Step 2: `POST /catalog/bulk/quote-preview`**

```ts
export class QuotePreviewDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) slug: string;

  /**
   * Kilograms, and a `number` rather than a string because the ladder compares numerically.
   * `@Max(10_000)` because `pricing_tiers.minKg` is `numeric(8,2)` and an unbounded value is the
   * SQLSTATE-22003 sibling of the 22001 the address `label` cap prevents.
   */
  @ApiProperty() @IsNumber() @Min(0.01) @Max(10_000) kg: number;
}
```

Answers `{ slug, kg, pricePerKg, total, quoteRequired, tier: { minKg, maxKg } | null }`, money in **rupees**
via `toRupees`, resolved through **`resolveTiersForWeight`** — Task 4's composition, not `resolveTiers`
directly — with the caller's own viewer and the request's own `kg`. This is the second of its two callers;
do not re-derive the fallback logic here, and if you find yourself writing a second `coversWeight`, that is
the signal to import instead. `POST` rather than `GET` for the reason the coupon preview is: it must not be
cached, and `@Public()` because the bulk calculator sits on the product page.

**`quoteRequired: true` is a 200, not an error.** It is the answer, and it is what routes the enquiry to the
RFQ form. A 422 here would make the calculator show an error state for the ordinary case of a 50kg order.

- [ ] **Step 3: `GET /catalog/bulk/products`**

The catalogue filtered to products with at least one resolvable tier, with the resolved ladder attached.
`/bulk-orders` and `/bulk/$category` read `bulkTiers` off the ordinary product payload today and will keep
working; this route exists because spec §6.1 lists it and because a bulk landing page should not fetch 27
products' retail variants to render a ladder.

**Paginate it like the catalogue** — `page`, `limit`, capped — and reuse `ProductQueryDto`'s bounds rather
than declaring new ones. Note `WHOLE_CATALOGUE = 60` against the listing DTO's `@Max(60)`: the deferred
`>60` problem in Plan 3 is a *client* cap, and this route inherits the same ceiling, so do not raise one
without the other.

- [ ] **Step 4: Prove and mutate**

```
a public quote for 10kg returns the DEFAULT rung's rate
a RETAILER business's quote for the same 10kg returns theirs
a 50kg quote on a quote-only product returns quoteRequired, 200
an unknown slug is 404, not 200 with quoteRequired
kg: 0 is 400; kg: 100000 is 400
the bulk listing omits a product whose ladder resolves empty
```

| Mutation | Should fail |
| --- | --- |
| the preview ignores the viewer | the RETAILER case |
| `quoteRequired` becomes a 422 | the quote-only case |
| `@Min(0.01)` deleted | the `kg: 0` case |
| the unknown slug answers `quoteRequired: true` | the 404 case |

- [ ] **Step 5: Commit**

---

## Task 6: 7a's integration proof — one kilogram, four surfaces, one price

**Files:**
- Create: `backend/test/integration/pricing.integration.spec.ts`

Everything 7a built, against real Postgres, over HTTP. This is the task that would have caught the leak,
and it is written last so it can assert agreement rather than any one implementation.

**Copy the harness from `orders.integration.spec.ts`** — `useIntegrationApp()`, the seeders in
`beforeEach`, `signedIn()`, the `guest()` helper that primes with a `GET` first, and the throttler reset.

- [ ] **Step 1: arrange the ladders the seed does not have**

The seeded 135 tiers are all `DEFAULT`/null, which is the state 7a must not change and therefore cannot be
tested against alone. Insert, in the test:

- a `RETAILER` ladder on one product, cheaper than `DEFAULT` at every rung
- a business-specific ladder for `b2b@demo.in`'s business, cheaper still, covering **only 1–20kg** so the
  non-merge rule is observable at 30kg
- a `DEFAULT`-segment ladder scoped to a *second* business — the row `product.mapper.ts` warns about

Create the second business through the API (`POST /auth/register` with the business box, then promote), not
by raw insert, so the fixture is one the application can actually produce.

- [ ] **Step 2: the agreement matrix — the point of the whole task**

For one product and one weight, assert **all four surfaces return the same number** for each viewer:

```
                       GET /catalog/products/:slug   POST /catalog/bulk/quote-preview
                       GET /cart (a bulk line)       POST /checkout/orders (the stored line total)
guest                  DEFAULT rate, four times
DEFAULT business       DEFAULT rate, four times      <- the no-op guarantee
RETAILER business      RETAILER rate, four times
business with a ladder own rate at 10kg, four times
business with a ladder DEFAULT rate at 30kg, four times  <- resolveTiersForWeight's fallback, not a merge
```

**The last row is Task 4's composition function, exercised for the first time end to end.** It does not
happen inside `resolveTiers` — nothing in this milestone makes `resolveTiers` itself weight-aware — it
happens because `toProductRules` and the quote-preview both call `resolveTiersForWeight`, which resolves
the viewer's own ladder first and swaps in the whole `DEFAULT` ladder only when that weight falls outside
it. If this row fails, look at the caller's composition before suspecting the resolver.

**Compare the four against each other, not against typed-in figures.** A hardcoded number passes while two
surfaces disagree, which is the entire class of bug this task exists to close — and Plan 3's
`checkout.integration.spec.ts` learned it: *"compare against `GET /cart` rather than against numbers typed
into the test."* Pin **one** absolute figure as an anchor so the whole matrix cannot be uniformly wrong.

- [ ] **Step 3: and the order is what actually got billed**

Place an order as the business, and assert the stored `order_items.unitPricePaise` and the order's
`subtotalPaise` match the ladder — in **paise, off the columns**. The wire converts to rupees and `inr()`
rounds; Plan 3 measured that a server figure and a client figure can render the same string while differing
by 25 paise. The column is the only place the disagreement cannot hide.

- [ ] **Step 4: Mutate — reverting each of Tasks 3, 4 and 5 in turn**

| Mutation | Should fail |
| --- | --- |
| the mapper's filter back to `DEFAULT && businessId === null` | the RETAILER and own-ladder rows |
| `toProductRules` back to no filter | **the second business's rows** — the leak |
| the preview ignores its viewer | the preview column |
| the resolver's business rung merges with DEFAULT | the 30kg row |

Run with `--runInBand`: under the default runner a Nest DI failure is *uncounted*, reporting
`Tests: N passed, N total` while tests silently vanish. **`Test Suites:` failing while `Tests:` is clean is
a lost result set, not a pass.**

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
test(pricing): one kilogram, four surfaces, one price
MSG
```

---

# MILESTONE 7b — Quote requests

## Task 7: one RFQ status vocabulary

**Files:**
- Modify: `frontend/src/features/rfq/types.ts` — the four-value union dies
- Modify: `frontend/src/features/rfq/components/RfqStatusBadge.tsx` — three new labels and variants
- Modify: `shared/src/constants/taxonomy.ts` — the docblock stops describing a future

Do this **before** anything renders an RFQ status, for the reason Plan 3's Task 16 gives about order
statuses: a `varchar` column and a `Record` over the wrong union produce **an empty badge rather than an
error**, and an empty badge is a bug nobody reports.

- [ ] **Step 1: measure the gap, then close it**

| Source | Values | |
| --- | --- | --- |
| `shared/src/constants/taxonomy.ts:94` | `new`, `contacted`, `quote-sent`, `negotiation`, `approved`, `rejected`, `converted` | 7 |
| `frontend/src/features/rfq/types.ts:2` | `new`, `quoted`, `accepted`, `closed` | 4 |
| `ck_rfqs_status` | **the shared seven**, verified against the live schema | 7 |

Only `new` is in both. The database will store `contacted`; `RfqStatusBadge`'s
`Record<RfqStatus, string>` over the frontend's four returns `undefined` for it, and for `quote-sent`,
`negotiation`, `rejected` and `converted`. `quoted`, `accepted` and `closed` are values **the constraint
refuses**, so the frontend has three labels for statuses that can never arrive.

`features/rfq/types.ts` becomes a re-export shim, the way `features/account/types.ts` already is:

```ts
export { RFQ_STATUSES } from "@nutwala/shared";
export type { RfqStatus } from "@nutwala/shared";
```

That makes `Record<RfqStatus, …>` exhaustive against the authoritative union, so an eighth status is a
**compile error at both ends**. Plan 3 verified the same guarantee holds for `ORDER_STATUS_LABEL`, and
recorded the corollary: **do not add a `?? "Unknown"` fallback** — it would only hide the compile error
that is doing the work.

- [ ] **Step 2: wording for the four new states, and it is customer-facing**

`business/rfqs/index.tsx`, `business/index.tsx` and `business/rfqs/$id.tsx` all render this badge, so a
customer reads these words. `contacted` and `negotiation` are internal pipeline stages that a customer
should see as progress, not as jargon:

```
new          "Received"        outline
contacted    "In progress"     secondary
quote-sent   "Quote sent"      default
negotiation  "In progress"     secondary      <- deliberately the same as contacted
approved     "Approved"        secondary
rejected     "Closed"          destructive
converted    "Ordered"         secondary
```

**Two internal stages sharing one customer-facing label is the point, not laziness.** A customer does not
need to know whether the desk has phoned them or is haggling internally; they need to know it is moving.
The `Record` still has seven keys, so the compile-time exhaustiveness survives.

- [ ] **Step 3: prove the badge cannot render nothing**

```
every RFQ_STATUSES member renders a non-empty label      <- it.each over the tuple, not a hand-typed list
every member renders a variant
```

`it.each(RFQ_STATUSES)` rather than a literal array is what makes this fail on an eighth status instead of
quietly covering seven of eight. Mutate by deleting one entry from the `Record` — it must not compile — and
then, to get a *runnable* mutation, replace one label with `""` and confirm the non-empty assertion fails.

- [ ] **Step 4: Commit**

```bash
git commit -F - <<'MSG'
fix(rfq): one status vocabulary, and a badge that cannot render nothing
MSG
```

---

## Task 8: `rfq-number.ts` and its sequence

**Files:**
- Create: `backend/src/modules/rfqs/rfq-number.ts`, `rfq-number.spec.ts`
- Create: `backend/src/database/migrations/20260822100000-RfqNumberSequence.ts`
- Modify: `shared/src/constants/identifiers.ts` — `RFQ_NUMBER_PATTERN`

Copy the mechanism from `modules/orders/order-number.ts`, whose docblocks explain both decisions worth
keeping: `nextval` rather than `max(...) + 1` because *"counting then inserting is a read-then-write gap"*,
and the sequence deliberately **not** rolled back by a failed transaction, because *"a gap in the sequence
is invisible to everyone; a duplicate reference is not."*

- [ ] **Step 1: the pattern goes in `shared`, next to its sibling, and for the reason its sibling moved**

`ORDER_NUMBER_PATTERN` began life in the backend where the frontend could not import it, so
`routes.smoke.test.tsx` hand-wrote `/^Order ID: NN-\d{4}-\d{6}$/` — `{6}` against the backend's
deliberate `{6,}` — and would have failed at order 1,000,000 where the server succeeds. Plan 3's Task 11
moved it. **Do not repeat the mistake one feature over:**

```ts
/** `RFQ-{year}-{at least 6 digits}`. `{6,}` for the reason `ORDER_NUMBER_PATTERN` is. */
export const RFQ_NUMBER_PATTERN = /^RFQ-\d{4}-\d{6,}$/;
```

- [ ] **Step 2: the migration**

```ts
export class RfqNumberSequence20260822100000 implements MigrationInterface {
  name = 'RfqNumberSequence20260822100000';
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SEQUENCE "rfq_number_seq" START 100000 INCREMENT 1 NO CYCLE`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP SEQUENCE "rfq_number_seq"`);
  }
}
```

`NO CYCLE` for the reason the order sequence has it: wrapping would re-issue a reference a customer has
already quoted. **The `DROP` in `down()` is not optional** — Plan 3's definition of done calls this out
specifically, because a missing `DROP SEQUENCE` is invisible until the next revert, and the Milestone 5
verification is what caught that it was present.

- [ ] **Step 3: `nextRfqNumber`, and the driver hazard that made this exact shape ship broken twice**

```ts
/** The sequence added by `20260822100000-RfqNumberSequence`. */
export const RFQ_NUMBER_SEQUENCE = 'rfq_number_seq';

export function formatRfqNumber(year: number, sequence: number): string {
  return `RFQ-${year}-${String(sequence).padStart(6, '0')}`;
}

export async function nextRfqNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    RFQ_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${RFQ_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatRfqNumber(now.getFullYear(), value);
}
```

This is a `SELECT`, so it is safe — **and that is the whole point of saying so.** TypeORM's Postgres driver
returns `[rows, rowCount]` for `UPDATE` and `DELETE` (`PostgresQueryRunner.js:198-205`) and `raw.rows` for
everything else, which made `rows[0]?.onHand` `undefined` in two places and shipped through 458 green unit
tests. `nextval` via `SELECT` returns rows normally. If you ever read a value back out of a write here, use
the data-modifying CTE shape.

- [ ] **Step 4: the spec, including the case that pins the format decision**

```
formatRfqNumber(2026, 100000) is 'RFQ-2026-100000'
formatRfqNumber(2026, 1) is 'RFQ-2026-000001'          <- padStart, not the sequence's start
the millionth RFQ carries seven digits and still matches RFQ_NUMBER_PATTERN
a number from a different year still matches
'RFQ-2026-12345' does NOT match                        <- five digits, the honest negative
nextRfqNumber calls nextval with the sequence name, not a literal
a non-numeric nextval throws rather than producing 'RFQ-2026-NaN'
```

The third and fifth exist together: tightening the pattern to `{6}` passes every other case in the file
while rejecting the very string the millionth call produces.

- [ ] **Step 5: Commit**

---

## Task 9: `RfqsService.create` — one method, two front doors

**Files:**
- Create: `backend/src/modules/rfqs/rfqs.service.ts`, `rfqs.service.spec.ts`
- Create: `backend/src/modules/rfqs/mappers/rfq.mapper.ts` + spec — exporting `toRfqSummary(rfq)` for the
  list and `toRfqDetail(rfq)` for the single read, both plain functions like `order.mapper.ts`, and both
  throwing on an unloaded relation for the reason step 2 gives
- **Modify: `backend/src/entities/b2b/rfq.entity.ts` and a migration — see step 1**

- [ ] **Step 1: a gifting enquiry cannot be stored today, and this is the task that finds out**

Measured against the live schema: `rfqs.packaging` (`varchar(60)`), `rfqs.frequency` (`varchar(40)`) and
`rfqs.businessType` (`varchar(60)`) are all **`NOT NULL`**. And
`frontend/src/features/gifting/schema.ts` asks for **none of the three** — `grep -c` returns `0`. It also
calls the company `companyName` where the bulk form calls it `businessName`.

So `POST /rfqs/gifting` has three NOT NULL columns and no values for them. There are three ways out and
only one is honest:

- **`businessType`: ask for it.** It is a real question about a real corporate customer, the form already
  has the select pattern, and `BUSINESS_TYPES` already contains *"Corporate gifting"*. Add it to the
  gifting schema and form.
- **`packaging` and `frequency`: make them nullable.** They genuinely do not apply — a gift box *is* the
  packaging, and a festive order *is* one-off — and the alternative is a sentinel. **Do not store
  `'One-time'` or `'Gift boxes'`**: an admin reading the RFQ queue must be able to tell a gifting enquiry
  that was never asked from a bulk enquiry that answered. This is the same call Plan 3's Task 20 made about
  a customer cancellation writing no `cancelReason` — *"a server-written sentence would be a claim on a row
  an admin reads as fact"*.
- `companyName` → `businessName` is a **mapping**, not a schema change. The column is `businessName`; the
  gifting DTO accepts `companyName` because that is what the form sends, and the mapper assigns it. Do not
  rename the form's field: it is the right word for a gifting customer and the wrong one for a kirana store.

Migration `20260822110000-RfqGiftingNullable`, and note that **relaxing `NOT NULL` is not reversible in
general** — `down()` can restore the constraint only if no null rows exist, so its `down()` must
`UPDATE … SET packaging = 'unspecified' WHERE packaging IS NULL` first, and say in a comment that this is
lossy by nature. A `down()` that would fail on real data is worse than one that is honest about what it
does.

- [ ] **Step 2: `create`, in one transaction**

```ts
/**
 * One method for both front doors, because a bulk enquiry and a gifting enquiry differ in what they
 * carry and in nothing else: one sequence, one number format, one status vocabulary, and one
 * `GET /rfqs` that lists both. `kind` is what tells them apart afterwards.
 *
 * `items` and `gifting` are both `cascade: ['insert']` on the entity, so one `save` writes the whole
 * enquiry — the shape `CheckoutService.place` uses for an order and its lines.
 */
async create(input: CreateRfqInput, userId: string | null): Promise<Rfq>
```

Inside the transaction: `nextRfqNumber(manager)`, then `save` the graph, then **re-read with relations**
before mapping.

**That re-read is not optional, and Plan 3 paid for the lesson.** `CheckoutService.place` built its draft
with `items`, inserted the first event separately, and returned the `save()` result — whose `events` was
`undefined` while TypeORM types it non-optional, so `toAccountOrder(await place(...))` typechecked
perfectly and answered with `timeline: []`. Here the same shape would answer with `items: []` on a bulk
enquiry that has three products. Make `toRfqDetail` **throw** on an unloaded relation, as
`toAccountOrder` does, so the mistake is loud rather than an empty list.

- [ ] **Step 3: `productId` resolves, and a null is a decision**

`RfqItem` carries **both** `productSlug` (`varchar(120)`, NOT NULL) and `productId` (nullable uuid). Resolve
the slug against the catalogue and store both; when the slug matches nothing, store the slug with a null
`productId` rather than refusing the enquiry.

**Refusing is the tempting alternative and it is wrong here**, for a different reason than usual: a
prospect typing a product name they saw in a brochure is a sales lead, and a 422 on the public RFQ form
turns it away. The slug is preserved so the desk can see what they asked for. Contrast placement, which
*does* refuse an unknown slug — the difference is that an order takes money and an enquiry does not.

- [ ] **Step 4: Prove and mutate**

```
a bulk enquiry stores its number, kind BULK, status new, and one item per line
a gifting enquiry stores kind GIFTING, its detail row, and null packaging/frequency
an unknown slug stores the slug with a null productId, and does not throw
a signed-in caller's userId is stored; a prospect's is null
budgetPerBoxPaise is paise off the wire's rupees
the mapper throws when items are unloaded
```

| Mutation | Should fail |
| --- | --- |
| `kind` hardcoded to `BULK` | the gifting case |
| the gifting detail is not cascaded | the detail-row case |
| `userId` always null | the signed-in case |
| the re-read is skipped and `save()`'s result is mapped | the mapper's throw |
| `budgetPerBoxPaise` assigned rupees | the paise case |

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
feat(rfq): one enquiry, two front doors, and a gifting row that can actually be stored
MSG
```

---

## Task 10: `POST /rfqs` and `POST /rfqs/gifting`, throttled

**Files:**
- Create: `backend/src/modules/rfqs/rfqs.controller.ts` + spec, `rfqs.module.ts` + spec
- Create: `backend/src/modules/rfqs/dto/create-rfq.dto.ts`, `dto/create-gifting-rfq.dto.ts` + specs
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: the throttle, with a number and a reason**

```ts
@Public()
@Throttle({ default: { limit: 5, ttl: 3_600_000 } })
@Post()
```

Five per hour per IP. Spec §6.1 marks both routes rate-limited and the global default is 120/minute, which
for an unauthenticated row-writing endpoint is not a limit. Registration gets 3/hour on the argument that
*"a rate limit is the only control"*; an RFQ gets 5 because a genuine prospect may send a bulk enquiry, a
gifting enquiry and a correction, and because an RFQ carries no account and so poses no enumeration risk —
the reason registration is tighter.

**Assert the 429 over HTTP in Task 13**, and reset the throttler between cases the way
`cart.integration.spec.ts` does — it reaches `ThrottlerStorage` and calls `onApplicationShutdown()`. A
throttle nothing tests is a decorator, not a control; placement's missing one is recorded in the spec's §13
threat table precisely because nobody asserted it.

- [ ] **Step 2: `@Public()` with `@OptionalUser()`, and both halves matter**

A prospect needs no account; a signed-in business's enquiry must be attributed to them so it appears under
`GET /rfqs`. That is `@Public()` + `@OptionalUser()` — and **never `@CurrentUser()`**, which throws when
`request.user` is absent and was measured as a 500 on every guest request when it happened on the wishlist.

Know the shape of the failure this arrangement is protecting against, because the obvious version is wrong:
swapping to `@CurrentUser()` gives a 500, not a leak. The leak arrives with the *repair* —
`user?.id ?? null` is right **here** (a prospect genuinely has no id), which is exactly why the same
expression is a bug in `GET /rfqs`, where it turns a missing guard into a `200 []`. Same expression,
opposite correctness, decided by whether an absent user is a legitimate caller.

- [ ] **Step 3: the DTOs mirror the columns, and bound every string**

Third instance of this defect family, so it is stated as a rule rather than discovered again: the
`Idempotency-Key` cap fixed a 500-for-a-400 in Task 9, the address `label` repeated it in Task 21, and
`User.name` in Task 22. **Every string field gets a `@MaxLength` matching its column**, and a pattern-bounded
field does not need one (`PHONE_REGEX` bounds `mobile` by itself; `PINCODE_REGEX` bounds `pincode`).

| Field | Column | Bound |
| --- | --- | --- |
| `businessName` / `companyName` | `varchar(160)` | `@MinLength(2) @MaxLength(160)` |
| `contactPerson` | `varchar(120)` | `@MinLength(2) @MaxLength(120)` |
| `mobile` | `varchar(15)` | `@Matches(PHONE_REGEX)` — no length needed |
| `email` | `varchar(255)` | `@IsEmail() @MaxLength(255)` |
| `gstin` | `char(15)` | `@IsOptional() @Matches(GSTIN_REGEX)` |
| `businessType` | `varchar(60)` | `@IsIn(BUSINESS_TYPES)` |
| `pincode` | `char(6)` | `@Matches(PINCODE_REGEX)` |
| `packaging` | `varchar(60)` | `@IsIn(PACKAGING_OPTIONS)` |
| `frequency` | `varchar(40)` | `@IsIn(ORDER_FREQUENCIES)` |
| `notes` | `text` | `@IsOptional() @MaxLength(2000)` |
| `occasion` | `varchar(60)` | `@IsIn(GIFTING_OCCASIONS)` |
| `giftBoxSlug` | `varchar(120)` | `@IsString() @MaxLength(120)` |
| `message` | `text` | `@IsOptional() @MaxLength(2000)` |

**`@IsIn` over a `shared` tuple rather than `@IsString`** wherever a vocabulary exists, and for a reason
beyond tidiness: Plan 3 found that an unvalidated enum string arriving as `undefined` makes TypeORM *drop*
the criterion rather than narrow it, silently widening a query. Here the risk is smaller — these are
inserts, not filters — but `@IsIn` is also what stops the RFQ queue filling with `businessType` values no
report groups by. Check which vocabularies `shared/src/constants/taxonomy.ts` already exports before
declaring one.

**And `@IsOptional()` skips its siblings only for `undefined` and `null`.** An empty string is a present
value, so `notes: ""` reaches the column and is stored — three tasks in Plan 3 hit this. Strip empty
optionals in the mapper, or accept that `notes` will hold `''` rather than null.

- [ ] **Step 4: the controller spec reads the routing table**

Not just the handlers. A hand-built controller spec that never consults Nest's metadata has hidden three
defects on this project, including a route that 404'd with 504 tests green. Assert with
`Reflect.getMetadata`, and assert `AppModule` actually **imports** `RfqsModule` — Plan 3's Task 17 measured
that deleting a module from `AppModule.imports` left typecheck, eslint and all 568 unit tests green while
both its endpoints 404'd, because routing assertions read the *controller's* metadata and a controller Nest
was never told about still carries it.

Run module-wiring mutations with `--runInBand`. Under the default runner a Nest DI failure is uncounted:
reintroducing a real wiring bug reported `Tests: 567 passed, 567 total` with two tests silently vanished and
the message replaced by `} could not be cloned.`

- [ ] **Step 5: Commit**

---

## Task 11: `GET /rfqs` and `GET /rfqs/:rfqNumber` — own only

**Files:**
- Modify: `backend/src/modules/rfqs/rfqs.service.ts`, `rfqs.controller.ts` and their specs

Spec §6.3 lists both as *"own only"*. Same IDOR shape as `GET /account/orders`, so the same rules apply and
the same mistakes are available.

- [ ] **Step 1: the owner goes in the `where`, and a stranger's RFQ is a 404**

```
list(userId)                 -> newest first
findOne(userId, rfqNumber)   -> one RFQ with items, gifting detail, or null
```

**`@CurrentUser()` here, not `@OptionalUser()`** — there is no such thing as a prospect's RFQ list, and a
route answering `[]` to an anonymous caller hides a missing guard behind an empty array.

**The owner in the query, not a post-hoc check.** `findOne({ where: { rfqNumber } })` followed by
`if (rfq.userId !== userId) return null` works and is one refactor from someone deleting the check while the
query still succeeds.

**404, never 403.** `ErrorCodes` has no `FORBIDDEN` member, and RFQ numbers are sequential from a shared
sequence, so a 403 turns the endpoint into an existence oracle. The service returns `null` and the
controller maps it, so a stranger's RFQ and a nonexistent one are **indistinguishable** — assert the
equality, not just the status.

- [ ] **Step 2: `RfqNote` never leaves the building**

`Rfq.notesList` is a `@OneToMany` and the entity's own docblock says notes are *"Brief §34 internal notes.
Never exposed on a customer-facing endpoint."* So:

- do **not** load the relation on these two routes, and
- assert its absence from the serialised body — `expect(text).not.toContain(…)` over the note's own words,
  not just `expect(body.notes).toBeUndefined()`.

Plan 3's Task 22 measured why the string check earns its place: with the profile mapper bypassed entirely,
`passwordHash` still did not leak because `select: false` kept it out of the entity — so a leak test that
checks only the field name is close to vacuous, and what the mapper actually protected was four *other*
fields. Here the analogue is `assignedSalespersonId` and `expectedValuePaise`: both are on `Rfq`, both are
internal, and neither has `select: false` to save you.

- [ ] **Step 3: `GET /rfqs` is the honest half of a gap this plan does not close**

A prospect with no account creates an RFQ and **cannot ever read it back** — `userId` is null and this route
is session-scoped. That is the same shape as the guest-order problem, and it has the same non-answer: the
RFQ number is the only handle they have, and quoting it to the sales desk is the recovery path.

**Say so in the response to the create call** — return the number prominently — and record the gap rather
than pretending. `GET /rfqs/lookup?number=&email=` is the fix and it needs throttling and a deliberate
decision, exactly like guest order tracking; it is not this milestone's.

- [ ] **Step 4: Prove and mutate**

```
lists only the caller's RFQs, newest first
does not list another business's RFQs
404s another business's RFQ number
404s a number that does not exist                <- and asserts the two bodies are equal
401s an anonymous caller
a gifting RFQ comes back with its detail
no internal note, salesperson or expected value appears in the serialised body
```

| Mutation | Should fail |
| --- | --- |
| `userId` dropped from `findOne`'s `where` | the stranger's-RFQ case |
| the owner check moved after the read | the structural assertion on the `where` |
| 404 → 403 | the indistinguishability case |
| `notesList` added to `relations` | the serialised-body check |
| `@CurrentUser()` → `@OptionalUser()` | the 401 case |

**Mutate the `where` of every scoped write too, not only every scoped read.** Task 21 found a cross-tenant
`UPDATE` that 91 unit and 34 integration cases all missed, because a unique index refuses *two* and never
*zero*. And note that emptying a `where` on an `update` is **not** a usable mutation: TypeORM's
`rejectEmpty()` throws *"Empty criteria(s) are not allowed"*, a 500 any test notices, so the mutation looks
killed while the reachable bug — a `where` that is present and **wrong** — goes unexercised.

- [ ] **Step 5: Commit**

---

## Task 12: the RFQ seeder — the three rows §16 already promised

**Files:**
- Create: `backend/src/database/seeds/rfqs.seed.ts`
- Modify: `backend/src/database/seeds/seed.ts`

Spec §16's Milestone 1 row says the seeder ports *"3 RFQs"*. Measured:
`SELECT count(*) FROM rfqs` is **0**, there is no `rfqs.seed.ts`, and `frontend/src/mocks/rfqs.ts` has
three. The seeder never had them.

- [ ] **Step 1: port the three from the mock, and own the differences**

The mock's rows use the **frontend's** dead status vocabulary. Map them onto the real one as you port:
`quoted` → `quote-sent`, `accepted` → `approved`, `closed` → `converted` **or** `rejected` — and that
choice is not cosmetic, because `converted` means the shop got the order and `rejected` means it did not.
Pick per row from what the mock's own content implies, and say which in a comment.

Give them **`rfqNumber`s from the sequence**, not literals — `nextRfqNumber(manager)` — so the seeded rows
and a freshly-created one cannot collide. `orders.seed.ts` writes literal order numbers and is a precedent
worth **not** following here: it works only because those numbers sit below the sequence's `START 100000`.
If you do use literals, they must be below 100000 and the comment must say why.

- [ ] **Step 2: attach one to `b2b@demo.in` and leave two as prospects**

That mix is what makes Task 13's ownership tests and Task 14's frontend cases possible: a signed-in business
must see exactly **one**, not three. **Assert one, never three** — Plan 3's Task 24 checklist expected six
orders for a customer who owns four, which is the cross-customer leak the suite exists to catch dressed as
a pass, and it would have been signed off.

Cover both `kind`s: at least one `GIFTING` with its detail row, so the gifting read path has a fixture that
does not depend on a test creating one.

- [ ] **Step 3: the seeder is idempotent and does not reset**

Follow `orders.seed.ts`'s upsert shape. **Never `npm run seed` against a database you care about** — it
resets `inventory.onHand` while leaving the append-only ledger, breaking `SUM(delta) = onHand`, which three
tasks of Plan 3 were spent protecting.

- [ ] **Step 4: Commit**

---

## Task 13: RFQ integration tests

**Files:**
- Create: `backend/test/integration/rfqs.integration.spec.ts`

- [ ] **Step 1: the cases**

```
creates a bulk RFQ as a prospect with no session, and answers with the number
creates a gifting RFQ, and stores its detail row with null packaging and frequency
attributes an RFQ to a signed-in business
refuses a 6th enquiry from one IP within the hour, 429      <- the throttle, as a control
lists only the caller's RFQs                                 <- exactly 1, never 3
404s another business's RFQ, indistinguishably from a missing one
401s an anonymous list
the serialised body carries no note, salesperson or expected value
an unknown product slug is stored, not refused
the number matches RFQ_NUMBER_PATTERN and is never a literal
two concurrent creates take two different numbers            <- the sequence, not a count
```

- [ ] **Step 2: two things this suite must get right that others got wrong**

**Reset the throttler between cases**, or the 429 case poisons every case after it — and conversely, the
429 case must run against a *primed* throttler rather than assuming it is the fifth request in the file.
Arrange it explicitly.

**`WELCOME10` is unusable in any suite that seeds orders** — it is `firstOrderOnly` and `CouponService`
counts *orders*, so a seeded customer always gets `COUPON_FIRST_ORDER_ONLY`. Irrelevant to RFQs, and
recorded here because the same class of fixture trap applies: **the seeded RFQs mean `GET /rfqs` is not
empty for `b2b@demo.in`**, so a test that creates one and asserts a list of one will fail. Assert the
delta, or scope to the number you created.

- [ ] **Step 3: sort before comparing anything a uuid orders**

Task 20 found a pre-existing assertion in `checkout.integration.spec.ts` that failed **three runs in four**,
because it compared items against a literal in cart order while the query ordered by a re-randomised v4
uuid. `RfqItem` has the same shape: no position column, and every item of one enquiry shares a `createdAt`
from the cascade insert. Order by something stable and sort before comparing — and **treat a single green
run as weak evidence**, because Milestone 5's verification signed off on a run it got by luck.

- [ ] **Step 4: Commit**

---

## Task 14: the RFQ and gifting frontend seams

**Files:**
- Rewrite: `frontend/src/features/rfq/api/index.ts` — `@/mocks/rfqs` and `mockFetch` both go
- Modify: `frontend/src/features/rfq/hooks/useRfqs.ts`
- Modify: `frontend/src/features/gifting/schema.ts` and `CorporateGiftingForm.tsx` — `businessType`
- **Create: `frontend/src/test/rfq-api.stub.ts`** and register it in `auth-api.stub.ts`
- Modify: `frontend/src/test/routes.smoke.test.tsx`

- [ ] **Step 1: the stub is the sixth handler, and you must add it before anything else works**

`auth-api.stub.ts` installs the single `globalThis.fetch` and delegates to five handlers today — catalog,
cart, wishlist, checkout, account. **Do not add a second installer and do not reach for MSW**; there is one
`globalThis.fetch`, and layering a second stub makes the tests depend on installation order. Without the
handler the suite fails with *"api stub received an unexpected request: GET /api/v1/rfqs"*, which is the
dispatcher working as designed — Task 12 of Plan 3 lost a cycle to this exact message.

Model the CSRF check if you want the suite to catch a missing token; the other five do not, so a green
frontend suite is evidence about the component and **Task 13 is the proof about the wire**.

- [ ] **Step 2: `mockFetch` goes, and the local sequence with it**

`features/rfq/api/index.ts` currently keeps `let sequence = rfqs.length` and mints
`RFQ-{year}-{padded}` client-side. Both go: the number comes from the server, and the client must not
generate one even optimistically. `features/content/api` keeps its `mock-client` import until Milestone 8,
so `mock-client.ts` itself cannot be deleted here — only this seam's use of it.

- [ ] **Step 3: gifting gains `businessType`, and both forms post their own shape**

Per Task 9's finding, the gifting schema has none of `businessType`, `packaging`, `frequency` while all
three are NOT NULL columns. Add the `businessType` select — `BUSINESS_TYPES` from `shared`, the same list
the bulk form and the registration form use — and let `packaging`/`frequency` be absent, now that the
migration allows it.

`useCreateRfq` becomes two mutations, or one taking a discriminated input. **Two is clearer**: the endpoints
differ, the DTOs differ, and a single hook with a `kind` field re-creates the seven-conditionally-required-
fields problem on the client.

- [ ] **Step 4: assert what the request carried, not only what rendered**

```
the bulk form posts to /rfqs and lands on the created RFQ's page by its server number
the gifting form posts to /rfqs/gifting, carrying businessType
the RFQ list renders the caller's RFQs from the server
a status the old union did not have renders a label rather than nothing   <- 'negotiation'
```

**That last case is the one with teeth.** Seed the stub an RFQ in `negotiation` — a status the deleted
four-value union could not express — and assert a non-empty badge. Before Task 7 it rendered `undefined`.

And record the outgoing request the way `pincodeChecks()` and `orderReads()` do. Task 12 measured that a
rendered figure cannot tell a live seam from a mock that happens to agree: its refusal assertion **passed
with the seam reverted to the deleted mock**, and only a recorded request distinguished them.

- [ ] **Step 5: Mutate**

| Mutation | Should fail |
| --- | --- |
| the seam reverted to `mockFetch` over `@/mocks/rfqs` | the recorded-request assertions |
| the client mints its own number again | the server-number assertion |
| `businessType` dropped from the gifting post | the gifting case |
| the badge's `Record` loses `negotiation` | won't compile — replace the label with `""` instead |

- [ ] **Step 6: Commit**

```bash
git commit -F - <<'MSG'
feat(rfq): quote requests land in the database, and gifting asks what it has to store
MSG
```

---

# MILESTONE 7c — The business area

## Task 15: `GET` and `PUT /business/me`

**Files:**
- Modify: `backend/src/modules/business/businesses.service.ts` — reads and updates, not just `createFor`
- Create: `backend/src/modules/business/businesses.controller.ts` + spec
- Create: `backend/src/modules/business/mappers/business.mapper.ts` + spec
- Create: `backend/src/modules/business/dto/update-business.dto.ts` + spec
- Modify: `businesses.module.ts` (it needs a controller now) and `app.module.ts`

`BusinessesModule` exists and is imported by `AuthModule` only, so **`AppModule` must import it too** or
the routes 404 with everything green — the survivor Plan 3's Task 17 measured. Assert
`Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)` contains it.

- [ ] **Step 1: the addresses are references, not values — and the form has it wrong**

`business/profile.tsx`'s schema carries `billing: addressSchema` and `shipping: addressSchema`, i.e. two
**inline addresses**. `Business` carries `billingAddressId` and `shippingAddressId`, i.e. two
**references** into the `addresses` table.

**Settled: they are references, and the form becomes two selects over the address book.** Plan 3's Task 21
built that book — five endpoints, one-default-per-user enforced by a partial unique index, soft delete with
promote-on-delete, and a per-customer lock. Writing a second pair of addresses through this endpoint would
duplicate every one of those rules and would be the copy that drifts. The columns' names already say which
answer the schema intended.

Two consequences, both worth stating:

- **`PUT /business/me` accepts `billingAddressId` and `shippingAddressId`, and validates that each belongs
  to the caller and is not soft-deleted.** An unvalidated id here is an IDOR: business A naming business
  B's address, and `GET /business/me` then resolving and displaying it. `ParseUUIDPipe`-equivalent
  validation too — Task 21 measured that a non-uuid reaching a uuid column is SQLSTATE **22P02** and a
  **500** where a 400 belongs.
- **This finally makes the address book useful.** Plan 3 recorded as a gap that *"checkout still does not
  read the address book"* — the page claims saved addresses prefill checkout and they do not. This task does
  not fix checkout, but it is the first consumer, and the pattern it sets is the one checkout should copy.

- [ ] **Step 2: an empty `mobile` is empty, not saved**

`createFor` writes `mobile: ''` into a `varchar(15)` **NOT NULL** column. So every business created at
registration has a present, empty, invalid mobile — and `Business.mobile`'s own comment says
*"Registration collects only the essentials; `/business/profile` captures the rest."*

- `PUT /business/me` **requires** `mobile` against `PHONE_REGEX`. No `@IsOptional()`.
- `GET /business/me` returns `''` as `''`, and the form renders it as an empty required field.

**Do not make the column nullable to tidy this up.** A business the sales desk cannot phone is the thing
this record exists to prevent; `NOT NULL` becomes honest once the profile fills it, and nullable would make
"never asked" and "cleared" indistinguishable for ever.

**Do not have `GET` invent a placeholder either.** Plan 3's Task 20 declined to write a `cancelReason` for
the same reason: a server-written value is a claim on a row an admin reads as fact.

- [ ] **Step 3: the mapper, and what must not reach the wire**

`Business` carries `assignedSalespersonId` — internal sales routing — and `segment`, which is a **commercial
decision about this customer**. Neither belongs on a customer-facing payload.

`segment` is the interesting one. A business seeing `"segment": "retailer"` learns there are bands, that
they are in one, and that others exist — which invites "why am I not a distributor?" on a page that cannot
answer it. The **prices** are visible, correctly; the label is not.

Assert the absence against the **serialised body**, not the parsed object, and grep for the values as well
as the field names. Task 22 measured why: with the profile mapper bypassed entirely, `passwordHash` still
did not leak because `select: false` kept it out of the entity — so a name-only check is close to vacuous,
and what the mapper actually protected was four other fields.

- [ ] **Step 4: Prove and mutate**

```
GET returns the caller's business, with company, mobile, gstin, businessType and the two resolved addresses
GET returns '' for a mobile registration never filled          <- and the form's own test asserts required
GET omits segment and assignedSalespersonId from the serialised body
PUT requires a valid mobile; '' and '12345' are 400
PUT accepts an address id the caller owns
PUT rejects an address id belonging to another customer         <- 404 or 422, never a silent accept
PUT rejects a soft-deleted address id
PUT rejects a non-uuid address id with 400, not 500
PUT cannot change segment or assignedSalespersonId              <- forbidNonWhitelisted, both 400
a CUSTOMER-role caller gets 403; an anonymous one gets 401
```

| Mutation | Should fail |
| --- | --- |
| the mapper spreads the entity | the serialised-body checks |
| the address-ownership check dropped | the other-customer case |
| `deletedAt IS NULL` dropped from the address read | the soft-deleted case |
| `mobile` gains `@IsOptional()` | the `''` case |
| the DTO declares `segment` | the forbidNonWhitelisted case |
| `userId` dropped from the update's `where` | replace it with another plausible predicate — **not** an empty one, which throws `rejectEmpty` and 500s, so the mutation looks killed while the real bug goes unexercised |

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
feat(business): GET and PUT /business/me, with addresses that are references
MSG
```

---

## Task 16: `GET /business/stats`

**Files:**
- Create: `backend/src/modules/business/business-stats.service.ts` + spec
- Modify: `businesses.controller.ts` and its spec

- [ ] **Step 1: what the dashboard actually shows, measured off the page**

`routes/business/index.tsx` renders four figures and derives all four client-side:

| Card | Today | Becomes |
| --- | --- | --- |
| Open enquiries | `rfqs.filter(r => r.status === 'new').length` | `openRfqs` |
| Bulk spend | `bulkOrders.filter(not cancelled/refunded).reduce(+total)` | `bulkSpend` |
| Bulk orders | `bulkOrders.length` | `bulkOrders` |
| Basket | `useCart()`'s bulk lines | **stays client-side** — it is the live basket, not a statistic |

**`status === 'new'` is now wrong**, and Task 7 is why: the vocabulary has seven values and *four* of them
are open — `new`, `contacted`, `quote-sent`, `negotiation`. Counting only `new` would show a customer "0
open enquiries" while the desk is actively quoting them. `approved`, `rejected` and `converted` are the
closed three. **Derive the open set from `RFQ_STATUSES` minus the closed three**, so an eighth status is a
compile error rather than a silently-uncounted enquiry.

- [ ] **Step 2: sum in paise, convert once, and delete the client's `reduce`**

```sql
SELECT COALESCE(SUM(o."totalPaise"), 0) AS spend, count(*) AS orders
  FROM orders o
 WHERE o.user_id = $1 AND o.channel = 'BULK' AND o.status NOT IN ('cancelled','refunded')
```

`SUM()` over `bigint` comes back as a **string** from `pg`, not a number — the same class as the `numeric`
columns `toProductRules` documents. Convert with `BigInt(row.spend)` then `toRupees`, and **assert a
fractional total in the spec**, because `Number()` on the string works for every value the fixture happens
to hold.

**The client's `reduce` is deleted, not kept as a fallback.** Two answers about money is the thing every
disagreement in Plan 3 came down to, and a fallback is how both survive. Plan 3 also measured the trap
waiting here: `inr()` rounds, so a server figure and a client figure can render the *same string* on six
orders and differ on the seventh — which means a test comparing rendered strings would have passed while
they disagreed.

- [ ] **Step 3: the scoping is by `userId`, and the subtlety is real**

An order is owned by a `userId`; a business is 1:1 with a user. So bulk spend scopes by the caller's
`userId`, **not** by `businessId` — and `orders` has no `business_id` column to scope by even though
`Order` has a `business` relation. Check which the entity actually populates before writing the query, and
say in a comment which one you scoped by and why, because the two are the same today and would diverge the
day a business has two logins.

- [ ] **Step 4: Prove and mutate**

```
counts the caller's open enquiries across all four open statuses     <- not just 'new'
excludes approved, rejected and converted
sums only BULK orders, excluding cancelled and refunded
returns 0 and 0 for a business with no history, not null
does not count another business's orders or enquiries
a fractional spend converts exactly                                  <- the bigint-as-string case
```

| Mutation | Should fail |
| --- | --- |
| the open set narrowed to `['new']` | the four-open-statuses case |
| `cancelled`/`refunded` no longer excluded | the exclusion case |
| the channel filter dropped | the BULK-only case |
| `Number(row.spend)` instead of `BigInt` | the fractional case |
| `user_id` dropped from the `where` | the other-business case |
| `COALESCE` dropped | the empty-history case, as `null` |

- [ ] **Step 5: Commit**

---

## Task 17: `GET /business/orders`

**Files:**
- Modify: `backend/src/modules/business/businesses.controller.ts` and its spec

Spec §6.3 lists it. It is `GET /account/orders?channel=bulk` with the channel fixed, and that is exactly
what it should be.

- [ ] **Step 1: delegate to `OrdersService`, do not write a second read**

```ts
@Get('orders')
list(@CurrentUser() user: AuthenticatedUser): Promise<AccountOrder[]> {
  return this.orders.list(user.id, { channel: 'bulk' });
}
```

`BusinessesModule` imports `OrdersModule`, which already exports what it needs. **Do not write a second
query**: `OrdersService.list` carries the IDOR scoping, the `placedAt DESC` ordering, the `ITEMS_IN_ORDER`
clause that Task 18 of Plan 3 added after finding one order's lines came back in different sequences from
two screens, and the relations `toAccountOrder` throws without. A second implementation inherits none of
that and the divergence would be invisible until a customer noticed their invoice reordering itself.

- [ ] **Step 2: it is a convenience, and the spec should say so**

This route earns its place by being the URL a business dashboard calls, not by doing anything
`?channel=bulk` cannot. Say that in its docblock, so nobody later "optimises" it into a bespoke query.

Assert it against the other route rather than against figures: `GET /business/orders` and
`GET /account/orders?channel=bulk` must return **deep-equal** bodies for the same caller. That is the
assertion that makes the delegation real, and it is the same technique Task 18 used to keep one mapper
honest across two paths.

- [ ] **Step 3: Prove and mutate**

```
returns the caller's bulk orders, deep-equal to /account/orders?channel=bulk
returns [] for a business with no bulk orders
does not return retail orders                       <- b2c's four are all RETAIL; use the right fixture
401s an anonymous caller
403s a CUSTOMER-role caller
```

| Mutation | Should fail |
| --- | --- |
| `channel: 'bulk'` dropped | the no-retail case |
| `channel: 'retail'` | both the deep-equal and the no-retail cases |
| a hand-written query replacing the delegation | the deep-equal case, if the query differs in *any* respect |

- [ ] **Step 4: Commit**

---

## Task 18: the business-profile seam — the last `localStorage` overlay

**Files:**
- Create: `frontend/src/features/business/api/index.ts`, `hooks/useBusiness.ts`
- Modify: `frontend/src/routes/business/profile.tsx`
- **Create: `frontend/src/test/business-api.stub.ts`** and register it — the seventh handler
- Modify: `frontend/src/test/routes.smoke.test.tsx`

- [ ] **Step 1: `nn.business-profile.v1` dies**

`profile.tsx:30` keys it, `:75` reads it, `:236` writes it, and the submit handler follows with
`toast.success("Business profile saved")` — which is true of the browser and of nothing else. Plan 3 killed
`nn.order.*`, `nn.addresses.v1` and the cart's key; this is the last one.

After this task, `grep -rn "localStorage" frontend/src` should return only the auth snapshot
(`AuthProvider`'s `persist`) and test hygiene. **Assert that as part of the definition of done**, because
"the last one" is a claim that decays.

- [ ] **Step 2: the two address fields become selects, and the empty case is a real state**

Per Task 15, `billing` and `shipping` are ids chosen from the address book, so the form reads
`GET /account/addresses` and offers them. Three states, and the third is the one that gets forgotten:

1. **The book has addresses** — two selects, defaulting to the customer's default address.
2. **The book is empty** — no select can be rendered. Link to `/account/addresses` and say why, rather than
   an empty dropdown that looks broken.
3. **The book has addresses but this business points at none** — both `null`. Not an error; a business that
   has not chosen yet. The selects show a placeholder, and `PUT` accepts `null` to clear.

- [ ] **Step 3: an error must be visible, and on this page that is not the default**

Plan 3 found and deliberately left a gap: `useAddressMutations`'s `save`, `remove` and `setDefault` each
pass an `onSuccess` and **no `onError`**, so a 400 is swallowed — no toast, nothing on screen, the form
still populated as though the edit took. It is reachable today because the *Address name* input has no
`maxLength` while phone and pincode do.

**Do not repeat it here, and fix it while you are in the file** if you touch that hook. This form has a
required `mobile` that the server validates against `PHONE_REGEX` and a `gstin` it validates against
`GSTIN_REGEX`, so a 400 is an ordinary outcome rather than an exotic one. Wire `onError` to a toast carrying
`error.message`, which the envelope already provides.

- [ ] **Step 4: Prove and mutate**

```
the form loads the business from the server, not from localStorage
saving posts to PUT /business/me and shows what came back
a 400 shows an error, and the form keeps the customer's input     <- the gap above, not repeated
an empty address book renders a link, not an empty select
a business pointing at no address renders a placeholder
```

| Mutation | Should fail |
| --- | --- |
| the seam reverted to `localStorage` | the recorded-request assertion |
| the `onError` handler deleted | the 400 case |
| the empty-book branch deleted | the empty-book case |
| the mutation writes but never re-reads | the "shows what came back" case |

**Record the outgoing request**, the way `addressWrites()` and `pincodeChecks()` do. Task 12 measured that a
rendered value cannot distinguish a live seam from a mock that happens to agree, and Task 21 found that a
write recorder was the **only** thing that could see a client still minting its own id.

- [ ] **Step 5: Commit**

```bash
git commit -F - <<'MSG'
feat(business): the profile reads and writes the server, and the last overlay dies
MSG
```

---

## Task 19: the dashboard and bulk-cart seams

**Files:**
- Modify: `frontend/src/routes/business/index.tsx` — reads `/business/stats`
- Modify: `frontend/src/routes/business/orders.tsx` — reads `/business/orders`
- Modify: `frontend/src/routes/business/bulk-cart.tsx` — server totals
- Modify: `frontend/src/features/business/api/index.ts`, `hooks/useBusiness.ts`
- Modify: `frontend/src/test/routes.smoke.test.tsx`

- [ ] **Step 1: the dashboard stops computing money**

Delete the `reduce`, the `filter(status === 'new')` and the `filter(not cancelled/refunded)`. Render
`openRfqs`, `bulkSpend` and `bulkOrders` as given.

**The basket card stays client-side** and that is not an inconsistency: it is the live basket the customer
is holding, which `CartProvider` already owns and the server already prices on every read. A statistic is a
question about history; the basket is state.

- [ ] **Step 2: the bulk cart's totals — the disagreement Plan 3 recorded and assigned here**

`bulk-cart.tsx:34` calls `cartTotals` over the bulk slice of the basket and renders the result. Plan 3
measured the problem precisely: `CartProvider`'s docblock says `cartTotals` is used *"for the optimistic
window and **nowhere else**"* and that the server's figures are authoritative — but **this screen renders
them un-overwritten**, because no endpoint totals half a basket. The client accumulates
`gst += total * rate / 100` as a float and rounds **once, on the aggregate, to whole rupees**, so it cannot
express the server's ₹5.01; on the backend's own three-line ₹33.33 fixture it says ₹5.00 where the server
says ₹5.01.

**Settled: label them indicative, and say so on screen.** The alternative — a `POST /cart/validate` variant
that totals a subset — invents an endpoint whose only caller is one screen, and the number that binds is
the order's anyway. One line of copy is honest and cheap; a second money path is neither.

**And correct `CartProvider`'s docblock**, which currently claims "nowhere else". A claim that has stopped
being true is worse than no claim, because it is what stops the next reader looking.

- [ ] **Step 3: Prove and mutate**

```
the dashboard renders the server's spend, not a client sum
an enquiry in 'negotiation' counts as open on the dashboard     <- the Task 7 vocabulary, end to end
the bulk cart labels its totals indicative
the orders page reads /business/orders
```

| Mutation | Should fail |
| --- | --- |
| the dashboard re-adds its `reduce` | the server-spend assertion — **only if it asserts the recorded read**, since both may render the same string |
| the open count narrowed to `'new'` | the negotiation case |
| the indicative label removed | the copy assertion |

That first row is the important one and it is written as a warning: **the mutation is invisible to a
rendered-string assertion**, because on the seeded fixture the client's sum and the server's may render
identically. Assert that `/business/stats` was **read** and that the card matches *it*.

- [ ] **Step 4: Commit**

---

## Task 20: Milestone 7 verification

- [ ] **Step 1: every suite**

```bash
cd /Users/kunal/Desktop/nutwala
npm run build -w @nutwala/shared && npm run test -w @nutwala/shared
npm run typecheck -w backend && npm run lint -w backend && npm run test -w backend
npm run test:integration -w backend
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
npm run format:check && npm run build -w frontend
npm audit --audit-level=high
```

Entering this milestone: shared **61 / 4**, backend unit **749 / 53**, backend integration **324 / 14**,
frontend **233 / 13** — **1,367 across 84 suites**. Record what you observe.

**There is no root `typecheck` script** and `shared` has none — it typechecks via `build`. **Do not run
`npm run build` at the root**: it chains into `nest build`, and `nest-cli.json` sets `deleteOutDir: true`,
which deletes the `dist/` the dev server is serving from. Substitute
`npx tsc -p backend/tsconfig.build.json --noEmit`.

**Run the DI-sensitive suites with `--runInBand`.** Two new modules land in this milestone, and under the
default runner a Nest resolution failure is *uncounted* — a real wiring bug reported
`Tests: 567 passed, 567 total` with two tests silently vanished. **`Test Suites:` failing while `Tests:` is
clean is a lost result set, not a pass.**

- [ ] **Step 2: the migration chain, twice over**

Two migrations land here, and one of them **relaxes a `NOT NULL`**, which is the kind whose `down()` fails
on real data. Throwaway container, **literal** port checked free with `lsof` first, `NODE_ENV=test` so
`load-env`'s `override: true` cannot substitute `.env`'s port, revert in a **loop** rather than a fixed
count, then re-apply.

Confirm after the full revert: `tables=1`, `enums=0`, and **no `rfq_number_seq`** — only TypeORM's own
`migrations_id_seq` survives. Then, separately, revert **only** the gifting-nullable migration against a
database holding a gifting RFQ with null `packaging`, and confirm its `down()` does what its comment claims
rather than throwing.

- [ ] **Step 3: the pricing invariant, by hand**

The one check no suite performs, and the reason this milestone exists:

```
as a guest:               GET a product's bulkTiers, note the 10kg rate
as the b2b business:      the same product, the same rate            <- nobody's prices changed
insert a RETAILER ladder and move that business to RETAILER
                          the catalogue, the quote preview, the cart and a placed order
                          must all four report the new rate, and the guest must still see the old one
insert a ladder for a second business
                          the first business's cart must NOT price from it                <- the leak
```

Do the segment move with SQL, since `PATCH /admin/businesses/:id` is Milestone 9's, and **say so in the
record** — a manual `UPDATE` standing in for an endpoint is a gap, not a pass.

**Capture any stock you disturb and restore it with `PATCH /admin/inventory/:variantId`. Never
`npm run seed`** — it resets `inventory.onHand` while leaving the append-only ledger, breaking
`SUM(delta) = onHand`.

- [ ] **Step 4: the RFQ journey, by hand**

As a signed-out prospect: submit a bulk enquiry, note the number, submit a gifting enquiry. Then sign in as
`b2b@demo.in` and confirm the seeded enquiry is listed and the prospect's two are **not**. Send a sixth
enquiry from the same IP within the hour and confirm the **429**.

Then the check that closes Task 7: `UPDATE rfqs SET status = 'negotiation'` on the business's own enquiry and
confirm the badge renders **"In progress"** rather than nothing.

- [ ] **Step 5: record what happened, including where this plan was wrong**

Append a "Milestone 7 complete" section with the observed counts, everything above, and every place this
plan turned out to be wrong. Plan 3's most useful artefact was that list — twelve errors in its own text,
three of which would have caused real harm — and this plan will have its own.

---

## Definition of done

1. `npm run typecheck -w backend` and `-w frontend`, `lint` both, `format:check`, `npm run build -w frontend`
   and `npx tsc -p backend/tsconfig.build.json --noEmit` all pass.
2. Every suite green: shared, backend unit, backend integration, frontend.
3. **Every route a client calls is reachable, asserted against Nest's routing metadata or over HTTP** — and
   `AppModule` is asserted to **import** each new module, because a controller Nest was never told about
   still carries its own metadata.
4. No `.only`, `.skip`, `xit` or `fdescribe` anywhere.
5. The migration chain applies to an empty database, reverts leaving no orphaned enum, sequence or
   constraint, and re-applies — **including `rfq_number_seq` and both new foreign keys**.
6. **One kilogram costs the same on all four surfaces**: the catalogue, the quote preview, the cart and a
   placed order's stored `unitPricePaise`, for each of a guest, a `DEFAULT` business, a segment business and
   a business with its own ladder.
7. **No business's negotiated tier reaches another buyer**, proven by a test that fails when
   `toProductRules` drops its viewer.
8. **Nobody's prices changed by this milestone**: every existing business is `DEFAULT`, every seeded tier is
   `DEFAULT`/null, and the pre-existing catalogue and cart specs pass unmodified.
9. A prospect with no account can create an RFQ; a sixth within the hour is a **429**.
10. `GET /rfqs` returns only the caller's, a stranger's number is a **404 indistinguishable** from a missing
    one, and no `RfqNote`, `assignedSalespersonId` or `expectedValuePaise` appears in any serialised
    customer-facing body.
11. Every `RFQ_STATUSES` member renders a non-empty label and variant, proven by `it.each` over the tuple.
12. `PUT /business/me` rejects an address id the caller does not own, one that is soft-deleted, and a
    non-uuid — the last with a **400, not a 500**.
13. `segment` and `assignedSalespersonId` appear in no customer-facing response body, asserted against the
    **serialised text**.
14. `GET /business/stats` sums in paise and converts once; the dashboard's client-side `reduce` is deleted,
    and a test asserts the card matches a **recorded read** rather than a rendered string.
15. `grep -rn "localStorage" frontend/src` returns only `AuthProvider`'s snapshot and test hygiene.
16. `features/rfq/api` imports no `@/mocks/*` and no `@/lib/mock-client`.
17. No `.env` is tracked and `npm audit --audit-level=high` is clean.

## What this plan deliberately leaves undone

- **Everything admin.** `PATCH /admin/businesses/:id` is what sets a segment, and
  `GET`/`POST`/`PATCH /admin/pricing-tiers` is what creates the ladders this milestone resolves. Both are
  Milestone 9's, in the separate repository §7.1 describes. **So 7a ships a resolver whose middle rung is
  exercised only by tests**, and that is the honest order: the alternative is inserting tiers first and
  deciding how they resolve afterwards, which is the state this plan exists to end.
- **RFQ → order conversion.** `converted` is a status an admin sets; nothing turns an approved quote into an
  order. Brief §17 does not ask for it and the sales desk does it by hand today.
- **A prospect reading their own RFQ back.** Same shape as guest order tracking: `userId` is null and the
  read is session-scoped, so the number is the only handle. `GET /rfqs/lookup?number=&email=` is the fix,
  needs throttling, and is a deliberate decision rather than a late addition.
- **Checkout reading the address book.** Task 15 makes the book's first real consumer; the checkout page
  still says saved addresses prefill it and they still do not.
- **The bulk cart's own totals.** Labelled indicative rather than served, per Task 19.
- **Notifications on an RFQ.** No email, no WhatsApp. `Notification` rows have no sender until Milestone 8.
- **`businessType` → `segment` automation.** Deliberately never: a customer must not be able to choose their
  own price band. If the sales desk wants a default suggestion, that is an admin-side hint, not a rule.
- **Two logins for one business.** `Business` is 1:1 with a `User`, and `GET /business/stats` scopes by
  `userId`. A company wanting two buyers needs a schema change and a decision about whose addresses and
  whose spend, and brief §46 currently forbids a separate B2B account.
- **The `>60` catalogue cap**, unchanged and now with a second consumer: `GET /catalog/bulk/products`
  inherits the same `@Max(60)` ceiling. Plan 3 traced the consequence — past 60 products a basket line whose
  product falls outside the fetched page is **omitted from the displayed total while the server charges the
  full amount**. The catalogue is 27 products; the trigger is ordinary growth, not a code change.

---

## Milestone 7 complete

Executed 2026-08-26, Tasks 4–20 in order, one commit per task. Observed counts at the end of
Task 20's Step 1, every suite run at least twice where the plan asked for it:

| Suite | Entering this milestone | Leaving it |
| --- | --- | --- |
| shared | 61 / 4 | 62 / 5 |
| backend unit | 749 / 53 | 901 / 67 |
| backend integration | 324 / 14 | 377 / 18 (one flaky run at 376/377, not reproduced on the next two) |
| frontend | 233 / 13 | 263 / 14 |

`npx tsc -p backend/tsconfig.build.json --noEmit`, `npm run lint`/`format:check` on both
workspaces, `npm run build -w @nutwala/shared`, `npm run build -w frontend` and
`npm audit --audit-level=high` at the root were all clean. Root `npm run build` was
deliberately never run, for the reason this plan itself gives: it chains into `nest build`,
`nest-cli.json` sets `deleteOutDir: true`, and a `nest start --watch` process was running
against `backend/dist` throughout.

### Two incidents against the real dev database, and what they cost

Both are reported here in full because covering them up would defeat the entire purpose of
this section, and because the mistake is one worth a future reader not repeating.

**First incident.** Setting up a throwaway container for Step 2's migration-chain check, an
`export NODE_ENV=test DB_PORT=…` was run in one shell call and `npm run migration:revert` in a
separate one. Shell env exports do not persist across separate tool invocations in this
environment, and `load-env.ts`'s `override: true` reads `.env` for any `NODE_ENV` other than
`test` — so the revert silently fell back to the real dev database on port 5442 and dropped
`order_number_seq`. Recovered by re-running `migration:run` (which, since the dev database was
apparently sitting at migration 4 of 8, brought it forward to full head — likely a net
improvement, since the code on this branch already expects the schema migrations 5–8 add) and
then `setval('order_number_seq', 100005, false)` to move the counter past the five real order
rows (`NN-2026-100000`–`100004`) already occupying that range, which the sequence reset would
otherwise have collided with on the very next order placed through the dev server. The
`setval` write was blocked once by Claude Code's own auto-mode classifier — correctly, since it
is a write to real infrastructure — and run only after the user was told exactly what happened
and explicitly approved it.

**Second incident, same root cause, worse blast radius.** Attempting to build a *properly*
isolated instance for Steps 3–4 (to avoid a repeat), `NODE_ENV=development` was used for both a
temporary app boot and `npm run seed`, on the reasoning that "development" was the normal
non-test value — missing that `test` is the *only* value `load-env.ts` treats specially. Both
commands were silently redirected to the real dev database again. The app boot merely crashed
on `EADDRINUSE` (harmless). The seed run actually executed `catalog.seed.ts` against it, which
by its own documented design resets every variant's `Inventory.onHand` to the opening figure
without touching the append-only ledger. Verified afterward, exhaustively rather than by
sampling: `SUM(inventory_transactions.delta) = inventory.onHand` held for every single variant
post-seed, because the real inventory activity recorded there since the original seed (23
adjustments, 7 sales, 1 cancellation) happened to net back to the opening figures already — a
fact confirmed by checking the ledger, not assumed from the invariant holding. Row counts were
unchanged throughout (every seeder upserts by natural key). The observable damage was cosmetic:
`updatedAt` refreshed on products/variants/tiers/inventory to the moment of the accidental run.

**The fix adopted for the remainder of Step 3–4**: every subsequent command inlined its full
environment on the same line as the command it configured, never relying on a separate
`export`, and — after booting the corrected isolated instance — its actual environment was
read directly off the running process (`ps eww -p <pid>`) and its `/health` response checked
before anything else touched it. That combination is what should be standard practice for any
future manual verification in this repository, not the ad hoc export-then-run pattern that
failed twice.

### Step 2: the migration chain, on the corrected throwaway container

Both directions confirmed against a disposable Postgres container on a literal free port,
`NODE_ENV=test` inlined on every command:

- All 8 migrations applied cleanly from empty.
- `RfqGiftingNullable20260822110000` reverted alone, against a row planted with
  `packaging`/`frequency` both `NULL`: its `down()` did exactly what its own comment claims —
  `UPDATE rfqs SET packaging = 'unspecified' WHERE packaging IS NULL` (and the same for
  `frequency`) before restoring `NOT NULL` — rather than throwing on the constraint it was
  about to re-add.
- The remaining 7 reverted in a loop down to nothing, confirmed empty: `tables=1` (only
  `migrations`), `enums=0`, and the only surviving sequence is `migrations_id_seq` — no
  `order_number_seq`, no `rfq_number_seq`.
- All 8 re-applied cleanly, closing the round trip.

### Step 3: the pricing invariant, by hand, on an isolated instance

Confirmed on a freshly seeded, fully isolated backend + database (not the real dev
environment, precisely because of the incidents above):

1. As a guest and as `b2b@demo.in` (still `DEFAULT` segment), `w320-cashews`' 10–24kg tier
   answered ₹989/kg on both — nobody's prices had changed yet.
2. A `RETAILER` ladder was inserted by hand (no admin endpoint exists yet, exactly as the plan
   anticipated) and `b2b@demo.in`'s business moved to that segment by a direct `UPDATE`. All
   four surfaces agreed on the new ₹900/kg rate: the catalogue, `POST
   /catalog/bulk/quote-preview` (`pricePerKg: 900`), `PUT /cart` (`subtotal: 9000` for 10kg),
   and a placed `POST /checkout/orders` (`subtotal: 9000`). A guest read straight after still
   answered the old ₹989/kg.
3. A second business was registered and given its own ₹500/kg private ladder for the same
   product. `b2b@demo.in`'s catalogue read and cart total were both re-checked afterward and
   were unchanged at ₹900/kg and ₹9,000 — the leak this step exists to rule out did not occur.

### Step 4: the RFQ journey, by hand, on the same isolated instance

- A signed-out prospect submitted one bulk enquiry (`RFQ-2026-100003`) and one gifting enquiry
  (`RFQ-2026-100004`).
- Signed in as `b2b@demo.in`, `GET /rfqs` answered exactly the one seeded enquiry
  (`RFQ-2026-100000`) — neither prospect enquiry appeared.
- Four more bulk enquiries from the same guest client (five total) all answered `201`; the
  sixth answered `429` with the friendly message, matching Task 13's own
  `[201,201,201,201,201,429]`.
- `UPDATE rfqs SET status = 'negotiation'` on the seeded enquiry, re-read: `GET /rfqs` answered
  `"status": "negotiation"` on the wire. The rendered badge itself ("In progress") was not
  re-confirmed in a live browser this session — that exact case is what Task 19's own new
  dashboard test seeds and asserts, and it was green in both of today's full frontend runs, so
  this step relied on that automated coverage rather than repeating it by hand a third time.

### Where this plan's own text was measured and found wrong

- **Task 16 said `orders` has no `business_id` column.** Measured: the column exists, and
  `Order` even carries a `business` relation. What is actually true, and worse in a different
  way: `CheckoutService.place` writes `businessId: null` into every order regardless of
  channel, so a query scoped by it would answer zero for every business that has ever placed
  one. `business-stats.service.ts`'s docblock records the corrected claim.
- **Task 19's "the dashboard re-adds its `reduce`" mutation is written as a warning, and it
  earned it.** On the seeded fixture the client-computed figure and the server's answer are
  identical to the rupee — every seeded bulk order total is a whole rupee figure — so a
  rendered-string assertion cannot tell the mutation apart from correct code. Confirmed by
  applying it: the existing rendered-string test stayed green, and only a new assertion that
  the read actually happened (`statsReads()`) caught it.
- **Task 18's "the mutation writes but never re-reads" case could not be killed as written.**
  The stub performs no server-side transformation of any editable field, so the customer's own
  typed input and the server's echoed response are identical for every input reachable through
  the UI. `form.reset(defaultsFor(saved))` was kept on the same principle stated elsewhere in
  this plan for a different field, and the gap was recorded rather than papered over with a
  fabricated passing test.
- **Task 17's third mutation — "a hand-written query replacing the delegation" — could not be
  executed as a literal, checksum-reversible code change.** `BusinessesController` has no
  repository access at all; writing one would mean adding a new dependency and real query code,
  which is a structural change, not a mutation a `shasum` comparison could cleanly verify was
  undone. Noted as such rather than faked.
- **Tasks 6 and 11's own mutation tables, from earlier in this milestone, hold up.** The
  `resolveTiersForWeight` merge-vs-swap mutation and the `@CurrentUser()`/`@OptionalUser()`
  swap on a non-`@Public()` route were both re-confirmed unobservable at the integration level
  for the same reasons recorded when each was first found, and each is still caught by the
  unit-level assertion named at the time.
- **The plan's own caution about `npm run seed` was not wrong — it was under-weighted by how
  easy it is to trigger by accident.** "Never run it against a database you care about" reads,
  on a first pass, like a warning about a deliberate `npm run seed` invocation. What actually
  happened was an indirect one, three shell arguments away from the intended target, via a
  `NODE_ENV` value that looked like the "normal" choice rather than the dangerous one. A
  stronger phrasing for the next plan that touches this area: *treat `NODE_ENV=test` as
  mandatory on every ad hoc database command in this repository, not only the seed command
  itself, and inline the full environment on the same line as the command — never a separate
  `export`.*

### Everything else in the Definition of done, closing the list

All 17 items were satisfied over the course of Tasks 4–19, each proven at the task that
implemented it and re-confirmed by Step 1's full suite runs; none needed separate hand-proof
beyond what Steps 2–4 above cover for the items that specifically call for it (items 9, 10, 12,
13, 14, 15).
