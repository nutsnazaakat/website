# Milestone 11 Task 3 — Admin coverage audit

**Question:** for everything the system treats as dynamic, can an admin actually change it from the
admin console?

**Repos read (read-only, nothing written to any git repo):**

- `/Users/kunal/Desktop/nutwala-backend` — NestJS + TypeORM, plus `shared/` and `e2e/`
- `/Users/kunal/Desktop/nutwala-client` — storefront
- `/Users/kunal/Desktop/nutwala-admin` — console

Every claim below carries a `file:line`. Where a search came up empty, the search is stated.

**Headline:** the console is a complete cover of the backend's admin surface — **every** admin write
endpoint has a screen, and the settings screen edits all 16 seeded keys including the three
array-valued ones. The gaps live almost entirely on the *other two* seams:

- **Console → storefront is cut in two places.** The storefront does not read the settings the
  console edits (`config/settings.ts:38-53` is a hardcoded constant — **G1**) and does not read the
  blog posts the console publishes (`features/content/api/index.ts:1-2` serves
  `src/mocks/posts.ts` — **G2**). Both backend endpoints exist and are correct; nobody wired the
  client to them.
- **Five persisted things have no admin route.** `product_images` (**G9**), `businesses.segment` and
  `businesses.assigned_salesperson_id` (**G4**), `serviceable_pincodes` (**G10**), `users.isActive`
  and `users.role` (**G13**), and `reviews.verifiedPurchase` (**G6**). Three of those columns are
  documented in their own entity as admin-set — `business.entity.ts:36`,
  `serviceable-pincode.entity.ts:5` — so the schema promises an editor the API never grew.

`RolesGuard` was checked for the fail-open case and is **clean** (§4). The `catalog.seed.ts` footgun
is **real for pricing tiers and a false alarm for product images** — §6 and §9 give the four searches
that settle it.

---

## 0. Two corrections to the brief for this task

**There are 16 seeded settings, not 17.** `backend/src/database/seeds/settings.seed.ts:24-54`
declares 15 rows with `isPublic: true` (the fifteen named in the task) and exactly **one** with
`isPublic: false` — `business.timezone`
(`settings.seed.ts:53`, key from `modules/settings/business-timezone.ts:15`). Its own comment calls
itself "**The first `isPublic: false` row in this table**" (`settings.seed.ts:42`). Searches run for
a second private row: `grep -rn "isPublic" backend/src` (only hit outside this file is the unrelated
`IS_PUBLIC_KEY` auth decorator), and `grep -rn "settings" backend/src/database/migrations` — the
initial schema creates the table (`20260819120000-InitialSchema.ts:32`) and inserts no rows. **Not
found: a 17th setting.**

**The `RolesGuard` fail-open concern is clean.** Reported in full at §4 below — no finding, but the
check was run and the evidence is recorded because a null result here is worth as much as a hit.

---

## 1. Table A — backend admin write endpoints → console screen

Enumerated from `grep -rn "@Controller\|@Roles\|@Get\|@Post\|@Patch\|@Put\|@Delete"
backend/src/**/*.controller.ts`. Fifteen `admin-*.controller.ts` files plus
`modules/inventory/inventory.controller.ts`, which is `@Controller('admin/inventory')`
(`inventory.controller.ts:44`) despite not carrying the `admin-` filename prefix — the only route
group the filename convention would have missed.

| Endpoint | Console screen | Client call | Status |
|---|---|---|---|
| `GET /admin/dashboard` (`admin-dashboard.controller.ts:29`) | `_console/index.tsx` | `features/dashboard/api/dashboard.ts:24` | OK |
| `GET /admin/audit-logs` (`admin-audit-logs.controller.ts:37`) | `_console/audit-logs/index.tsx` | `features/audit/api/audit-logs.ts:52` | OK |
| `GET /admin/products` (`admin-products.controller.ts:63`) | `_console/products/index.tsx` | `features/products/api/products.ts:52` | OK |
| `GET /admin/products/:id` (`:69`) | `_console/products/$id.tsx` | `products.ts:56` | OK |
| `POST /admin/products` (`:75`) | `_console/products/new.tsx` | `products.ts:136` | OK |
| `PATCH /admin/products/:id` (`:84`) | `_console/products/$id.tsx` | `products.ts:141` | OK |
| `DELETE /admin/products/:id` (`:101`) | `_console/products/$id.tsx:252` | `products.ts:156` | OK |
| `POST /admin/products/:id/publish` (`:119`) | `_console/products/$id.tsx` | `products.ts:167` | OK |
| `POST /admin/products/:id/unpublish` (`:129`) | `_console/products/$id.tsx` | `products.ts:171` | OK |
| `POST /admin/products/:id/variants` (`:145`) | `features/products/variant-editor.tsx` | `products.ts:234` | OK |
| `PATCH /admin/variants/:id` (`admin-variants.controller.ts:38`) | `variant-editor.tsx` | `products.ts:244` | OK |
| `DELETE /admin/variants/:id` (`:50`) | `variant-editor.tsx:433` | `products.ts:254` | OK |
| `GET /admin/categories` (`admin-categories.controller.ts:28`) | `_console/categories/index.tsx` | `features/categories/api/categories.ts:21` | OK |
| `POST /admin/categories` (`:34`) | `features/categories/category-form.tsx` | `categories.ts:67` | OK |
| `PATCH /admin/categories/:id` (`:45`) | `category-form.tsx` | `categories.ts:72` | OK |
| `GET /admin/inventory` (`inventory.controller.ts:48`) | `_console/inventory/index.tsx` | `features/inventory/api/inventory.ts:54` | OK |
| `GET /admin/inventory/:variantId/transactions` (`:56`) | `features/inventory/stock-panel.tsx` | `inventory.ts:78` | OK |
| `PATCH /admin/inventory/:variantId` (`:65`) | `stock-panel.tsx` | `inventory.ts:107` | OK |
| `PATCH /admin/inventory/:variantId/threshold` (`:85`) | `stock-panel.tsx` | `inventory.ts:134` | OK |
| `GET /admin/pricing-tiers` (`admin-pricing-tiers.controller.ts:49`) | `_console/pricing/index.tsx` | `features/pricing/api/pricing.ts:57` | OK |
| `POST /admin/pricing-tiers` (`:67`) | `features/pricing/tier-form.tsx` | `pricing.ts:106` | OK |
| `PATCH /admin/pricing-tiers/:id` (`:85`) | `tier-form.tsx` | `pricing.ts:115` | OK |
| `GET /admin/orders` (`admin-orders.controller.ts:61`) | `_console/orders/index.tsx` | `features/orders/api/orders.ts:59` | OK |
| `GET /admin/orders/:orderNumber` (`:74`) | `_console/orders/$orderNumber.tsx` | `orders.ts:66` | OK |
| `POST /admin/orders/:orderNumber/status` (`:94`) | `features/orders/order-writes.tsx` | `orders.ts:91` | OK |
| `POST /admin/orders/:orderNumber/payment/collect` (`:114`) | `order-writes.tsx:238` | `orders.ts:119` | OK |
| `POST /admin/orders/:orderNumber/shipment` (`:136`) | `order-writes.tsx:312` | `orders.ts:146` | OK |
| `GET /admin/rfqs` (`admin-rfqs.controller.ts:68`) | `_console/rfqs/index.tsx` | `features/rfqs/api/rfqs.ts:64` | OK |
| `GET /admin/rfqs/:rfqNumber` (`:81`) | `_console/rfqs/$rfqNumber.tsx` | `rfqs.ts:68` | OK |
| `PATCH /admin/rfqs/:rfqNumber` (`:105`) | `features/rfqs/rfq-writes.tsx` | `rfqs.ts:104` | Partial — see G7 |
| `POST /admin/rfqs/:rfqNumber/notes` (`:131`) | `rfq-writes.tsx:247` | `rfqs.ts:119` | OK |
| `GET /admin/coupons` (`admin-coupons.controller.ts:49`) | `_console/coupons/index.tsx` | `features/coupons/api/coupons.ts:47` | OK |
| `POST /admin/coupons` (`:55`) | `features/coupons/coupon-form.tsx` | `coupons.ts:75` | OK |
| `PATCH /admin/coupons/:code` (`:74`) | `coupon-form.tsx` | `coupons.ts:80` | OK |
| `DELETE /admin/coupons/:code` (`:91`) | `_console/coupons/index.tsx:263` | `coupons.ts:93` | OK |
| `GET /admin/reviews` (`admin-reviews.controller.ts:49`) | `_console/reviews/index.tsx` | `features/reviews/api/reviews.ts:44` | OK |
| `POST /admin/reviews/:id/approve` (`:65`) | `_console/reviews/index.tsx` | `reviews.ts:60` | OK |
| `POST /admin/reviews/:id/reject` (`:76`) | `_console/reviews/index.tsx` | `reviews.ts:73` | OK |
| `GET /admin/posts` (`admin-posts.controller.ts:49`) | `_console/blog/index.tsx` | `features/blog/api/posts.ts:48` | OK (dead-ends — G2) |
| `POST /admin/posts` (`:55`) | `features/blog/post-form.tsx` | `posts.ts:75` | OK (dead-ends — G2) |
| `PATCH /admin/posts/:slug` (`:65`) | `post-form.tsx` | `posts.ts:85` | OK (dead-ends — G2) |
| `DELETE /admin/posts/:slug` (`:82`) | `_console/blog/index.tsx` | `posts.ts:97` | OK (dead-ends — G2) |
| `GET /admin/support/tickets` (`admin-support-tickets.controller.ts:56`) | `_console/support/index.tsx` | `features/support/api/tickets.ts:74` | OK |
| `GET /admin/support/tickets/:ticketNumber` (`:62`) | `_console/support/$ticketNumber.tsx` | `tickets.ts:84` | OK |
| `PATCH /admin/support/tickets/:ticketNumber` (`:68`) | `_console/support/$ticketNumber.tsx` | `tickets.ts:119` | Partial — see G7 |
| `POST /admin/support/tickets/:ticketNumber/notes` (`:91`) | `_console/support/$ticketNumber.tsx:338` | `tickets.ts:137` | OK |
| `GET /admin/customers` (`admin-customers.controller.ts:43`) | `_console/customers/index.tsx` | `features/customers/api/customers.ts:56` | OK |
| `GET /admin/customers/:id` (`:61`) | `_console/customers/$id.tsx` | `customers.ts:62` | OK |
| `GET /admin/businesses` (`admin-businesses.controller.ts:40`) | `_console/businesses/index.tsx` | `features/businesses/api/businesses.ts:65` | OK |
| `GET /admin/businesses/:id` (`:55`) | `_console/businesses/$id.tsx` | `businesses.ts:71` | OK |
| `GET /admin/settings` (`admin-settings.controller.ts:29`) | `_console/settings/index.tsx` | `features/settings/api/settings.ts:40` | OK |
| `PUT /admin/settings` (`:46`) | `_console/settings/index.tsx` | `settings.ts:36` | OK |

**Result: zero orphaned endpoints.** Every admin route the backend exposes is reached by a console
screen. Nothing the client paid for on the backend is unreachable from the console. The brief's
fourteen `/admin/*` pages (`docs/client-brief.md:59-61`) all exist in
`nutwala-admin/src/routes/_console/`, plus two the brief did not ask for (`/audit-logs`, `/support`)
and four detail screens (`features/shell/navigation.ts:44-94`).

---

## 2. Table B — the settings keys: which can an admin actually edit?

The screen is not a whitelist. It renders **every row `GET /admin/settings` returns**
(`_console/settings/index.tsx:100`), groups the known ones
(`features/settings/catalogue.ts:18-57`), and sweeps anything else into an "Other" panel that is
still editable (`settings/index.tsx:168-186`, `catalogue.ts:121-123`). The control is chosen at
runtime from the *current* value's JSON type, not from a hardcoded field list
(`features/settings/api/settings.ts:75-81`, `settings/index.tsx:283`).

That is why the array-valued keys work. `certifications`, `social` and `addressLines` seed as `[]`;
`isStringList([])` is `true` (`settings/api/settings.ts:71-73` — `Array.prototype.every` on an empty
array), so `kindOf` returns `"list"` and the row renders a **`<Textarea rows={3}>`, one value per
line** (`settings/index.tsx:315-322`), decoded back to `string[]` on save with blank lines dropped
(`settings/index.tsx:73-82`). **Not a text input.** The wire accepts it: `SettingEntryDto.value` is
`unknown` with only `@IsDefined()`, deliberately so it can carry "a string, a number, a boolean or
an array" (`modules/settings/dto/replace-settings.dto.ts:22-40`).

| Key | `isPublic` | Seeded value | Control rendered | Editable today? |
|---|---|---|---|---|
| `brandName` | true | `'Nuts & Nazaakat'` | `<Input>` (text) `settings/index.tsx:331` | **Yes** — group "Brand" `catalogue.ts:38` |
| `tagline` | true | a sentence | `<Input>` | **Yes** — `catalogue.ts:38` |
| `whatsappNumber` | true | `''` | `<Input>` | **Yes** — `catalogue.ts:27`, hint at `:62` |
| `supportEmail` | true | `''` | `<Input>` | **Yes** — `catalogue.ts:27` |
| `supportPhone` | true | `''` | `<Input>` | **Yes** — `catalogue.ts:27` |
| `freeShippingThreshold` | true | `999` | `<Input inputMode="decimal">` `settings/index.tsx:334` | **Yes** — `catalogue.ts:44` |
| `bulkPromptThresholdGrams` | true | `5000` | numeric `<Input>` | **Yes** — `catalogue.ts:46` |
| `gstin` | true | `''` | `<Input>` | **Yes** — group "Compliance and trust" `catalogue.ts:33` |
| `fssaiLicence` | true | `''` | `<Input>` | **Yes** — `catalogue.ts:33`, hint at `:86` |
| `certifications` | true | `[]` | **`<Textarea>`, one per line** `settings/index.tsx:315-322` | **Yes** |
| `social` | true | `[]` | **`<Textarea>`, one per line** | **Yes, but wrong shape** — see G3 |
| `addressLines` | true | `[]` | **`<Textarea>`, one per line** | **Yes** |
| `codEnabled` | true | `true` | `<input type="checkbox">` `settings/index.tsx:305-314` | **Yes** — `catalogue.ts:47` |
| `onlinePaymentEnabled` | true | `false` | checkbox | **Yes** — `catalogue.ts:48` |
| `flatShippingRate` | true | `79` | numeric `<Input>` | **Yes, but only half-effective** — see G5 |
| `business.timezone` | **false** | `'Asia/Kolkata'` | `<Input>` | **Yes** — group "Operations" `catalogue.ts:55` |

**All 16 are editable. Zero settings gaps on the console side.**

### The `gstin` / `fssaiLicence` / `certifications` question, answered directly

**Yes — an admin can fill them in when the real registration numbers arrive, without a developer.**
The rows already exist (seeded empty at `settings.seed.ts:32-34`), and `PUT /admin/settings` writes
existing keys — it refuses an *unknown* key with a 404 rather than inserting
(`features/settings/api/settings.ts:14-18`), which is exactly the case that does not apply here. The
console renders all three under a "Compliance and trust" panel whose blurb quotes the requirement:
*"Brief §26: certification information must be editable from Admin"* (`catalogue.ts:32`), and the
screen leads with a panel explaining that blank is a deliberate answer
(`settings/index.tsx:214-222`). `fssaiLicence`'s hint spells out why it seeds empty
(`catalogue.ts:86`).

This satisfies the brief. `docs/client-brief.md:199-202` (§26): *"Certification information must be
editable from Admin."* And `:193-197` (§25): *"Do NOT make unsupported claims. Do not claim
certifications unless configured by Admin."* Both hold. The seed's own docblock states the same
reasoning (`settings.seed.ts:12-14`).

**The catch is on the other side of the seam** — see G1. Typing an FSSAI number into the console
today writes the database row and changes nothing on the storefront.

---

## 3. Table C — storefront → console: what the site renders vs. what an admin can edit

Storefront server calls enumerated from `grep -rn "http\.(get|post|put|patch|delete)<"
nutwala-client/src`.

| What the storefront renders | Source | Admin screen |
|---|---|---|
| Products, variants, prices, bulk tiers | `GET /catalog/products*` (`features/catalog/api/index.ts:34-45`) | `/products`, `/pricing` — OK |
| Categories | `GET /catalog/categories` (`catalog/api/index.ts:47-50`) | `/categories` — OK (no delete, G8) |
| Reviews + summary | `GET /catalog/products/:slug/reviews` (`features/reviews/api/index.ts:18-19`) | `/reviews` — OK except `verifiedPurchase` (G6) |
| Cart totals, GST, shipping | `GET /cart` (`features/cart/api/index.ts:49`) | `/settings` (thresholds) + `/pricing` — OK, with G5 |
| Wishlist | `GET /wishlist` (`features/wishlist/api/index.ts:19-21`) | derived — n/a |
| Coupons | `POST /checkout/coupon/preview` (`features/checkout/api/index.ts:144`) | `/coupons` — OK |
| Orders, addresses, profile | `/account/*` (`features/account/api/index.ts:81-183`) | `/orders`, `/customers` — OK |
| Business profile, stats, orders | `/business/*` (`features/business/api/index.ts:20-30`) | `/businesses` (read-only, G4) |
| RFQs | `/rfqs` (`features/rfq/api/index.ts:84-95`) | `/rfqs` — OK |
| **Product image gallery** | `product.mapper.ts:38-40` serves `ProductImage.url` | **GAP — G9.** No route writes it, and no admin type even carries the field (`grep -n "images" shared/src/types/admin.ts` → no output) — the console cannot display it, let alone edit it |
| **Pincode serviceability, ETA, shipping** | `POST /checkout/pincode` (`checkout/api/index.ts:131`) | **GAP — G10** |
| **Combo box contents, occasion, blurb, savings** | `GET /catalog/combos` (`catalog/api/index.ts:52`) | **GAP — G11** |
| **Site settings (all 15 public keys)** | **hardcoded — `config/settings.ts:38-53`** | **GAP — G1** |
| **Blog posts** | **mocks — `features/content/api/index.ts:1-2`** | **GAP — G2** |
| Homepage editorial copy | hardcoded in components | **GAP — G12** |

---

## 4. Security check — `RolesGuard`: no finding, and here is the evidence

`RolesGuard` does fail open: `if (!required || required.length === 0) return true`
(`common/auth/roles.guard.ts:36`). And there are two role vocabularies — the token carries the
database enum `ADMIN` (`entities/enums.ts:2-6`), an auth response body carries the wire `admin`
(`modules/users/admin-customer.mapper.ts:31`). So a missing or lowercase `@Roles()` on an admin
route would be a live hole.

**Every one of the sixteen admin route groups carries class-level `@Roles(UserRole.ADMIN)` with the
correct enum:**

`admin-settings.controller.ts:23` · `admin-categories.controller.ts:23` ·
`admin-products.controller.ts:55` · `admin-variants.controller.ts:33` ·
`admin-rfqs.controller.ts:59` · `admin-businesses.controller.ts:35` ·
`admin-audit-logs.controller.ts:25` · `admin-dashboard.controller.ts:24` ·
`admin-posts.controller.ts:43` · `admin-coupons.controller.ts:44` ·
`inventory.controller.ts:43` · `admin-customers.controller.ts:38` ·
`admin-orders.controller.ts:52` · `admin-pricing-tiers.controller.ts:36` ·
`admin-reviews.controller.ts:43` · `admin-support-tickets.controller.ts:51`

Corroborating checks:

- `grep -rn "@Roles('admin')\|@Roles(\"admin\")" backend/src` — **no hits.** No lowercase usage.
- `grep -rn "@Public()" backend/src` — hits only in `settings.controller.ts:34`,
  `auth.controller.ts:64/84/102`, `health.controller.ts:19`, `catalog.controller.ts`,
  `content.controller.ts`, and guard files. **No `@Public()` on any `admin/*` controller.**
- No handler-level `@Roles()` overrides a class-level one anywhere (handler metadata would win —
  `reflector.getAllAndOverride` at `roles.guard.ts:32-35`).
- Guard order is correct: `CsrfGuard` → `JwtAuthGuard` → `RolesGuard`, all `APP_GUARD`
  (`app.module.ts:289-292`).

One honest caveat already recorded in the code: the `isUserRole` narrowing at
`roles.guard.ts:57` is described in its own comment as **"currently unobservable"** — both branches
throw the identical message and nothing logs which fired (`roles.guard.ts:51-56`). That is a
diagnosability limitation, not an access-control hole.

---

## 5. `verifiedPurchase` — confirmed hardcoded, and nothing can set it

**Where:** `backend/src/modules/reviews/reviews.service.ts:157`

```ts
// Server-derived, never client-supplied. See the doc comment above; becomes a real lookup
// against delivered orders in the checkout plan.
verifiedPurchase: false,
```

**The docblock's justification is now stale.** `reviews.service.ts:118-124` reads:

> `verifiedPurchase` is **not** taken from the client — it is derived from whether this user has a
> delivered order containing this product. […] **Orders do not exist until the next plan, so this
> resolves to `false` today**, with the query written and commented where it belongs rather than
> left as a client-controlled field to be tightened later.

Orders exist. `modules/orders/`, `modules/checkout/`, `entities/commerce/order.entity.ts` and
`OrderStatus.DELIVERED` are all shipped (Milestone 9.2). The promised lookup was never written — and
the comment says "the query written and commented where it belongs", but **there is no query**:
`grep -rn "verifiedPurchase" backend/src` returns no `SELECT`, no join against `orders` or
`order_items`, only the literal `false` at `:157`, the read-side mapper (`review.mapper.ts:36`), the
aggregate counter (`reviews.service.ts:43`), and the seed's fixture values
(`content.seed.ts:47-177`).

**Can the console set it? No.** `AdminReviewsController` has exactly three handlers — `GET`,
`POST :id/approve`, `POST :id/reject` (`admin-reviews.controller.ts:49,65,76`). Neither write DTO
mentions the field: `dto/reject-review.dto.ts` carries a reason only, and approve takes no body
(`admin-reviews.controller.ts:68-71`). `grep -n "verifiedPurchase" backend/src/modules/reviews/
admin-reviews.service.ts` — **no hits.** The console displays it read-only, with a tooltip that is
now misleading: *"The server sets this; it cannot be claimed by the author"*
(`nutwala-admin/src/routes/_console/reviews/index.tsx:257-262`) — true as far as it goes, but the
server sets it to `false`, always.

**Net effect:** every review written by a real customer through `POST
/catalog/products/:slug/reviews` is permanently unverified. The only `true` rows in the database are
the twelve the seeder wrote (`content.seed.ts:47-177`). The storefront renders the badge
(`nutwala-client/src/features/reviews/components/ReviewList.tsx:111`), so after the seed data is
cleared the badge disappears from the site forever and no admin can bring it back.

Contradicts `docs/client-brief.md:204-207` (§27): *"Users can give a rating, write a review, upload
an image. Admin can approve/reject. **Show Verified Purchase.**"* and `:109` (§10): *"Reviews:
rating, **verified purchase**, customer review, review image."*

---

## 6. The seeder footgun — precisely what a re-run destroys

`backend/src/database/seeds/catalog.seed.ts`. The file names the problem itself, at lines 642-652:

> Images and pricing tiers have no natural key of their own, so they are replaced wholesale. Both are
> owned entirely by this seeder today, so nothing else can lose a row.
>
> **That ownership expires the moment admin product-editing ships:** `npm run seed -- catalog` would
> then silently destroy hand-edited images and tiers […] neither `ProductImage` nor `PricingTier` has
> any unique index, so a real upsert is not even expressible yet. Whoever adds that admin screen has
> to pick one: add natural unique keys […] so seeding becomes non-destructive, or **make this seeder
> refuse to run when it finds rows it did not write.**

Admin product editing shipped. Neither option was taken — **but the docblock's two nouns have
diverged, and only one of them is now a live footgun.**

**Pricing tiers: ownership expired, and the seeder is destructive.** `POST /admin/pricing-tiers`
ships (`admin-pricing-tiers.controller.ts:67`), so the seeder is no longer the only writer, and its
`delete` takes rows it did not write.

**Product images: ownership did NOT expire, and the seeder is not a footgun.** Nothing outside the
seeder can write `product_images`, so a re-run destroys no admin work. Verified four ways:

- `grep -rn "image\|Image\|photo\|gallery" backend/src/modules/catalog/dto/*.ts` — the only hit in
  `save-product.dto.ts` is `SeoDto.ogImage` at `:59`. **No `images` array on `CreateProductDto`**
  (`:87-217`), and `UpdateProductDto` is `PartialType(CreateProductDto)` (`:217`). (The `image` hits
  in `save-product.dto.spec.ts:213-242` test `CreateCategoryDto.image`, `save-category.dto.ts:53` —
  a category hero image, a different column, and that one *is* admin-editable.)
- `grep -n "Image\|image" backend/src/modules/catalog/admin-products.service.ts` — three hits, none a
  write: a docblock listing cascade tables (`:323`) and two read-side
  `leftJoinAndSelect('product.images', 'image')` (`:468`, `:486`).
- `grep -rn "ProductImage\|product_images" backend/src` (exhaustive, whole backend) — the **only**
  writer in the codebase is `catalog.seed.ts:653,655`. Everything else is the migration, the entity,
  the `@OneToMany` on `product.entity.ts:90-91`, and two docblocks.
- `grep -n "images" backend/shared/src/types/admin.ts` — **no output.** No admin wire type carries an
  images field at all, so `admin-catalog.mapper.ts` drops what `baseQuery` loaded.

So the `product_images` `delete`-then-`insert` at `catalog.seed.ts:653-662` is a **false footgun** —
recorded in §9. What it *is* instead is the proof of a different and larger gap: **G9**, below.

### Is it guarded? No.

- `catalog.seed.ts` — **no `NODE_ENV` check, no confirmation, no `--force`.**
- `database/seeds/seed.ts:61-79` — `main()` calls `dataSource.initialize()` and runs the seeders. No
  environment check anywhere in the runner.
- `grep -ln "NODE_ENV\|SEEDABLE" backend/src/database/seeds/*.ts` → **`users.seed.ts` only.**

That asymmetry is the sharpest evidence: the codebase already has the guard pattern.
`users.seed.ts:259-269` refuses to run unless `NODE_ENV` is positively in
`['development', 'test']`, with a docblock explaining that an allowlist is used because a
`=== 'production'` denylist *"fails open"* (`users.seed.ts:243-255`). **Six of the seven other
seeders never got it.**

### Precisely which admin-editable columns a re-run overwrites

**Destroyed outright (delete-then-insert, no key, no filter):**

| Table | Code | What is lost |
|---|---|---|
| `pricing_tiers` | `catalog.seed.ts:665` `delete({ productId })`, then `:667-676` inserts 5 `DEFAULT` rows | **Every tier for that product — including segment-scoped and business-scoped ones.** The delete filters on `productId` **only**, not on `segment` or `businessId` (`:665`) |
| ~~`product_images`~~ | `catalog.seed.ts:653` `delete({ productId })`, then `:655-662` inserts 3 fixed rows | **Nothing an admin did — no admin route writes this table.** Rows are replaced with `[seed.image, placeholder, placeholder]`, `alt` = product name, `sortOrder` 0-2 (`:654-661`), which is identical to what was there. False footgun — see §9 and G9 |

The `pricing_tiers` case is **worse than the docblock admits.** Because the delete is unfiltered, a
re-run destroys the negotiated `RETAILER` / `DISTRIBUTOR` / `HORECA` ladders and every
customer-specific rung an admin created through `POST /admin/pricing-tiers` with a `businessId`
(`dto/save-pricing-tier.dto.ts:86-88`, `_console/pricing/index.tsx` + `features/pricing/tier-form.tsx:235-246`).
Those are exactly brief §31's deliverables (`docs/client-brief.md:227-230`). They are replaced by
five `segment: DEFAULT, businessId: null` rows (`catalog.seed.ts:673-674`). A B2B customer's
negotiated price silently reverts to list, and because `resolveTiers` returns the first non-empty
rung outright (`modules/pricing/pricing.resolver.ts:68-80`) the reversion is total and immediate on
the next page load. **And there is no `DELETE /admin/pricing-tiers/:id`
(`admin-pricing-tiers.controller.ts:26-28`), so an admin cannot even clean up the five rows the
seeder left behind.**

**Overwritten by `upsert` (admin edits reverted to seed values):**

| Table | Code | Columns reverted |
|---|---|---|
| `products` | `:602-631`, conflict on `slug` | `name`, `categoryId`, `subtitle`, `description`, `badge`, `origin`, `grade`, `processing`, `shelfLife`, `storage`, `ingredients`, `hsn`, `gstRate`, `moqKg`, `quoteOnly`, `seo`, and two that matter more: **`isPublished` forced `true`** (`:620`) — an unpublished product is republished to the storefront — and **`publishedAt` forced `null`** (`:623`), clearing the timestamp `POST /admin/products/:id/publish` set |
| `categories` | `:563-571`, conflict on `slug` | `name`, `image`, `blurb`, `description`, `sortOrder`, **`isPublished` forced `true`**, **`seo` reset to `{}`** (`:568`) |
| `product_variants` | `:680-683`, conflict on `sku` | `size`, `grams`, `channel`, `pricePaise`, `mrpPaise`, `moq`, **`isActive` forced `true`** (`:681`) — a deliberately deactivated pack goes back on sale |
| `inventory` | `:691-699`, conflict on `variantId` | `onHand` reset to 120 retail / 40 bulk (`:60-63`), `lowStockThreshold` reset to 10 (`:64`), **and `reserved` reset to `0`** (`:695`) — stock held by open, unshipped orders is released, so the same units can be sold twice |

**Correctly guarded (the one thing that is):** `inventory_transactions`. The opening ledger row is
inserted only where absent, keyed on `(variantId, reason='Opening stock (seed)')`
(`:588-594`, `:702-718`). The seeder's own comment concedes the consequence: resetting `onHand`
while leaving the ledger alone *"will break that invariant"* — `SUM(delta) = onHand`
(`:55-58`).

### A footgun the task did not ask about, found on the way

`settings.seed.ts:56-62` is an unconditional `repository.upsert({ ...setting }, ['key'])` over
`{key, value, isPublic}`. It resets **every one of the 16 settings** to its seed value — which means
`gstin`, `fssaiLicence`, `whatsappNumber`, `supportEmail`, `supportPhone` back to `''`, and
`certifications`, `social`, `addressLines` back to `[]`. Everything §2 of this report says an admin
can configure, wiped.

`settings` is the **first** entry in `SEEDERS` (`seed.ts:27`), and `users` — the only guarded one —
is second (`:28`). So a bare `npm run seed` against a production `DATABASE_URL` runs `settings` to
completion, **then** throws at `users`. The guard fires *after* the compliance data is gone. And
`updatedByUserId` is not in the upsert payload, so the console keeps showing "last changed by
<admin>" (`settings/index.tsx:346-347`) next to the seed's blank value.

---

## 7. Console → backend: does any screen read or write something not persisted?

Checked by diffing each screen's form state against the DTO it posts to, and by grepping the console
for gap markers. **No screen writes a field the backend drops.** Two examples verified in full:
the coupon form's fourteen fields (`features/coupons/coupon-form.tsx:78-92`) map 1:1 onto
`SaveCouponDto` (`modules/coupons/dto/save-coupon.dto.ts:76-180`) — brief §36's nine levers all
present; the product form's SEO trio (`features/products/product-form.tsx:158-161`) maps onto
`SeoDto` (`modules/catalog/dto/save-product.dto.ts:42-59`).

The contract cannot have drifted: `nutwala-admin/src/contract/types/*.ts` is a generated copy
(`contract/SOURCE.md:1-11`), and `diff` against `backend/shared/src/types/` reports **all twelve
files identical**.

What the console *reads* and cannot write is real, and the console says so itself in every case —
which is the right behaviour, but they are still gaps:

- `businesses.segment` and `businesses.assigned_salesperson_id` — read-only, no endpoint
  (`_console/businesses/$id.tsx:17-24`, `:186-188`; `_console/businesses/index.tsx:254`;
  `features/businesses/api/businesses.ts:10-14`). See G4.
- `users.isActive` — read-only, *"has no write path anywhere in the service yet"*
  (`_console/customers/$id.tsx:22`). See G13.
- `reviews.verifiedPurchase` — read-only (`_console/reviews/index.tsx:257-262`). See G6.
- Shipment tracking number after dispatch — *"a tracking number cannot be added afterwards […]
  There is no route"* (`features/orders/order-writes.tsx:312-313`). See G14.

---

## 8. Prioritised gaps

The **severity label on each heading governs**; the `G` numbers are stable identifiers referenced
from the tables above, so they are not renumbered when a severity is revised. G9 was raised from
Medium-High to High after the `AdminProduct` wire type was checked (§6), which is why it sits below
two Mediums. §10 gives the actual recommended order of work.

### G1 — The storefront does not read the settings the console edits. **Critical.**

`nutwala-client/src/config/settings.ts:38-53` is a module-level constant. All fifteen public keys are
literals in TypeScript. There is **no `GET /settings` call anywhere in the storefront**:
`grep -rn "/settings" nutwala-client/src` returns only imports of `@/config/settings` (24 files) and
docblock mentions. The file's own comment (`:1-4`) says *"Values an admin will own in Phase 3"*, and
`:16-17` says *"Milestone 8 swaps this read for a real `GET /settings/public`."* Milestone 8 built
the endpoint — `settings.controller.ts:30-40`, public, filtered on `isPublic`
(`settings.service.ts:75`) — and nobody swapped the read.

Consumers rendering the frozen values: `SiteFooter.tsx:99-106` (GSTIN, FSSAI, brand name),
`TrustSection.tsx:64-69` (certifications), `ContactDetails.tsx:12-36,71,83`
(email, phone, WhatsApp, address, social), `CartDrawer.tsx:24`, `routes/cart.tsx:42-43`,
`PincodeChecker.tsx:25,68`, `CheckoutForm.tsx:154-155,185,859`, `LegalPage.tsx:35`, and every route
`<title>`.

`entities/ops/setting.entity.ts:4-6` states the table's whole purpose: *"Backs
`frontend/src/config/settings.ts`. Brief §26 and §37 require the WhatsApp number, contact details and
certification text to be admin-editable and never hardcoded."* The table is admin-editable. The
storefront still hardcodes.

**Who it hurts, and when.** Two different injuries, and the brief treats them differently.

The typo-at-2am case: an admin fixes the brand name or the tagline, sees "Settings saved", reloads
the storefront, and the old text is still there. They will assume the console is broken, and they
will be *right* about the symptom and wrong about the cause. There is no workaround available to
them at any hour — the fix is a code change and a redeploy.

The FSSAI case is a different order of problem. `docs/client-brief.md:265-268` (§37) is explicit:
*"**Do not hardcode a fake number** — make it configurable from Admin Settings."* And §26 (`:199-202`):
*"Certification information must be editable from Admin."* A food business in India is legally
required to display its FSSAI licence number. When the registration arrives, the admin will type it
into the console — the console is built correctly and will accept it — and **the storefront will
still show nothing.** The legal obligation stays unmet, the console reports success, and nobody
learns otherwise until someone compares the two screens. The same applies to the GSTIN, which §49
(`:349`) and the invoice footer both want.

Same for `whatsappNumber`: §37's *"Talk to Bulk Sales"* and *"Ask About Bulk Pricing"* CTAs are the
B2B funnel's entry point, and `ContactDetails.tsx:26-31` renders the CTA only when the number is
non-empty — so today, with the constant at `""`, **the storefront shows no WhatsApp CTA at all**, and
filling the setting in will not create one.

### G2 — The storefront's blog reads mocks, not the posts the console publishes. **High.**

`nutwala-client/src/features/content/api/index.ts:1-2` imports `posts` from `@/mocks/posts` and
serves them through `mockFetch` (`:19,27,36,42`). `lib/mock-client.ts:1-4` says *"Simulates network
latency […] **Phase 2 deletes this file along with src/mocks/**."* It was not deleted for content.
`features/content/hooks/useContent.ts:15,19,24` are the only consumers, and `routes/blog/index.tsx`
and `routes/blog/$slug.tsx` are the only readers.

The backend side is complete and unused: `GET /content/posts`, `/content/posts/:slug`,
`/content/posts/:slug/related` (`content.controller.ts:35,45,52`), backed by
`admin-posts.controller.ts:49-88` and reachable from `_console/blog/index.tsx` with a full editor
including SEO (`features/blog/post-form.tsx:127-130`).

**Who it hurts, and when.** Whoever the client hired to write content, on their first day. They will
draft a post in the console, publish it, and it will not appear on `/blog`. Nothing tells them why.
The four posts the storefront *does* show are `src/mocks/posts.ts` fixtures that no admin can edit,
correct or unpublish — so a factual error or a stale price in a mock post is permanent until a
developer edits source. Directly against `docs/client-brief.md:209-214` (§28), and §39 (`:276-280`)
*"Every product, category and blog post supports SEO title, meta description, slug, OG image"* —
the console captures all four, and the site renders none of them.

### G3 — `social` has two incompatible shapes. **High** (blocked behind G1, but will bite the moment G1 is fixed).

The seed types `social` as `string[]` (`settings.seed.ts:22,35`), so the console renders it as a
newline list and writes `string[]` (`settings/index.tsx:73-82`). The storefront's declared type is
`social: { label: string; url: string }[]` (`config/settings.ts:34`), and
`ContactDetails.tsx:83-91` reads `s.label` and `s.url`.

**Who it hurts, and when.** Nobody today — nothing reads the setting (G1). The day G1 is fixed, an
admin who has already typed three social URLs into the console gets a footer with three empty links
and `key={undefined}` React warnings. The failure surfaces on the *storefront*, hours or weeks after
the console save that caused it, which is the worst possible time to discover a shape mismatch.
`brief §49` (`:349`) — *"Social links configurable"* — is unmet either way. Fix the shape before
fixing G1, not after.

### G4 — `businesses.segment` has no write route, so three of brief §31's four price bands are dead. **High.**

`entities/identity/business.entity.ts:32-42` — the column's own docblock:

> Brief §31. The price band this business buys at […] **Admin-set**, not derived from `businessType`
> […] `DEFAULT` for every business **until Milestone 9's `PATCH /admin/businesses/:id` exists**,
> which is what makes this migration change nobody's prices.

That route does not exist. `AdminBusinessesController` has two handlers, both `@Get`
(`admin-businesses.controller.ts:40,55`). `grep -rn "Patch\|Put\|Post" backend/src/modules/business/
admin-businesses.controller.ts` — **no hits.** The console records the gap in as many words:
*"`PATCH /admin/businesses/:id` does not exist. Backend design spec §6.4 lists it; nothing
implements it"* (`_console/businesses/$id.tsx:17-24`).

**Why it makes real configuration dead.** `resolveTiers` reads the *business's* `segment` to pick
the middle rung (`modules/pricing/pricing.resolver.ts:72-74`), and the viewer's segment comes
straight off the row (`catalog.service.ts:393`, `cart-read.service.ts:317`). An admin can create a
`RETAILER` ladder on the pricing screen (`features/pricing/tier-form.tsx:208-217`,
`segments.ts:12-17`) — and **no business will ever resolve to it**, because every business is
`DEFAULT` and nothing can move them. Only the fourth of §31's bands works, customer-specific
pricing, because a `businessId`-scoped rung is matched directly (`pricing.resolver.ts:69-70`).

**Who it hurts, and when.** The sales desk, on the first wholesale negotiation. They agree retailer
pricing with four shops, build the retailer ladder in the console, and all four shops keep seeing
list prices. The workaround — a per-business ladder for each of the four — is more work, does not
scale, and cannot be undone because there is no tier delete (G8). Directly against
`docs/client-brief.md:227-230` (§31): *"Configure MOQ, price/kg, quantity tiers, **retailer pricing,
distributor pricing, HORECA pricing**, customer-specific pricing."*

Same route would carry `assigned_salesperson_id`, an indexed, foreign-keyed column
(`20260819120000-InitialSchema.ts:71,74,271`) that **nothing writes** — the seed sets it `null`
(`users.seed.ts:234`) and `grep -rn "assignedSalesperson" backend/src/modules/business/` returns
nothing. Against §35 (`:255-258`), which lists *"assigned salesperson"* as a B2B profile field.

### G5 — `flatShippingRate` is editable but only changes what the cart *quotes*, not what the order *charges*. **High.**

Two different figures decide shipping, and an admin can edit only one of them.

- The **cart** reads the `flatShippingRate` and `freeShippingThreshold` settings
  (`modules/cart/cart-read.service.ts:517-524`, `cart-pricing.service.ts:71-75`). Console-editable.
- The **order** charges the `serviceable_pincodes` row's `shippingPaise`
  (`checkout.service.ts:234`, `:617-626`). **Not console-editable — see G10.**

This is deliberate and documented (`checkout.service.ts:600-615`): the pincode row wins *"because it
is the only one of the four candidate figures that is per-destination and admin-editable."* Which
would be right — if it were admin-editable. It is not.

**Who it hurts, and when.** Both figures are ₹79 today (`settings.seed.ts:40`,
`pincodes.seed.ts:26`), so nothing is wrong yet. The day an admin lowers shipping to ₹49 for a
promotion, the cart page and the checkout summary quote ₹49 and the order bills ₹79. That is a
customer-facing pricing discrepancy created by a legitimate, single-field console edit, with no
warning on the screen and no second screen to keep in step. The admin cannot fix it; only a
developer running `npm run seed -- pincodes` after editing source can.

### G6 — `verifiedPurchase` is permanently `false` and no screen can set it. **High.**

Full evidence at §5. Contradicts `docs/client-brief.md:204-207` (§27) *"Show Verified Purchase"* and
`:109` (§10).

**Who it hurts, and when.** The client, on the day they notice. Verified-purchase badges are the
single highest-leverage trust signal on a product page for a food business selling ₹3,499/kg Mamra
almonds — it is why §10 and §27 both name it. Right now the storefront shows badges on twelve
*seeded* reviews and will show them on zero real ones. The failure is invisible: the badge simply
never appears, so nobody files a bug, and the fix (a delivered-order lookup) is backend work no
admin can substitute for. The moderator is left with a review from a genuine customer that they can
*see* is genuine — they are looking at the order in the next tab — and no way to say so.

### G7 — No endpoint lists operator accounts, so RFQs and tickets can only be assigned to "me" or "nobody". **Medium.**

`features/rfqs/rfq-writes.tsx:123-128`: *"There is no salesperson picker, because there is no
endpoint that lists salespeople. […] Anything else needs `GET /admin/salespeople`, which §6.4 never
specced."* `GET /admin/customers` deliberately excludes admins (`rfq-writes.tsx:125`,
`features/customers/api/customers.ts:34-37`). Same limitation on support:
`_console/support/$ticketNumber.tsx:258`.

**Who it hurts, and when.** A two-person sales desk, immediately. Priya cannot hand an RFQ to Rahul;
she can only claim it or release it. With one admin account (see G13) the question is moot, which is
why it is Medium rather than High — but it becomes the daily friction point the moment the client
hires a second salesperson. Against `docs/client-brief.md:249-253` (§34), which names *"assigned
salesperson"* as an RFQ management field.

### G8 — No `DELETE` for pricing tiers or categories. **Medium.**

`admin-pricing-tiers.controller.ts:26-28`: *"**No `DELETE`.** §6.4 lists exactly these three verbs."*
Console echoes it: *"A tier cannot be deleted; there is no such route. A rung created against the
wrong…"* (`_console/pricing/index.tsx:475`). Categories likewise — `GET`, `POST`, `PATCH` only
(`admin-categories.controller.ts:28,34,45`), console at `_console/categories/index.tsx:235`.

**Who it hurts, and when.** The admin who fat-fingers a tier — wrong product, wrong band — and now
has a permanent wrong rung in the ladder. Because `resolveTiers` returns the first non-empty rung
outright (`pricing.resolver.ts:68-80`), one stray business-scoped rung silently overrides that
customer's whole ladder and cannot be removed. The tier overlap check refuses a *fix* on top
(`admin-pricing-tiers.controller.ts:63`, `409 PRICING_TIER_OVERLAP`), so the only recovery is
`PATCH`-ing the mistake into something harmless. Categories are less urgent — brief §7 fixes them at
twelve — but an unpublish toggle exists (`save-category.dto.ts:77-79`) which covers most of the
need.

### G9 — Product images are not admin-editable at all — the console cannot even see them. **High.**

The storefront renders a gallery from `product_images`: `product.mapper.ts:38-40` sorts by
`sortOrder` and emits the urls, and `docs/client-brief.md:100-101` (§10) puts it top-left on the
product page — *"Left: large image gallery (placeholders)."* **The seeder is the only writer in the
codebase, and the admin wire does not carry the field at all.** Four independent checks, all listed
in §6:

- No `images` field on `CreateProductDto` / `UpdateProductDto`
  (`modules/catalog/dto/save-product.dto.ts:87-217`; the only image-shaped field is `SeoDto.ogImage`
  at `:59`).
- `admin-products.service.ts` never writes an image row — only reads
  (`:468`, `:486` `leftJoinAndSelect('product.images', 'image')`).
- `grep -rn "ProductImage\|product_images" backend/src` — sole writer is `catalog.seed.ts:653,655`.
- `grep -n "images" backend/shared/src/types/admin.ts` — **no output.** No `AdminProduct` images
  field, so `baseQuery` loads the relation and `admin-catalog.mapper.ts` throws it away.

That last point is the sharp one, and it is worse than "an admin cannot edit the images": **the
console cannot display them either.** `GET /admin/products/:id` does not return them, so an operator
looking at a product in the console has no way to know what pictures the storefront is showing.

**Three distinct consequences.**

1. **Every product the client creates has an empty gallery, permanently.** `POST /admin/products`
   creates no image rows (nothing does), and `catalog.seed.ts` only touches its own 27 seeded slugs
   (`PRODUCT_SEEDS`, `:195-486`, upserted by `slug` at `:630`). So a 28th product added through the
   console renders with **zero images** on the storefront, and there is no route, screen or reseed
   that will give it one. This is the harm that fires first and is entirely invisible from the
   console.
2. **The 27 seeded products are frozen at `[seed.image, placeholder, placeholder]`**
   (`catalog.seed.ts:654`). Real photography cannot be attached without a developer editing
   `IMAGES` in `seed-context.ts` and re-running the seeder — which, per §6, also reverts every other
   admin edit on those products and destroys the pricing ladders.
3. **The form looks like it already does this.** `features/products/product-form.tsx:377-382`
   offers an "Open Graph image" input. That writes `products.seo.ogImage`, a social-preview URL that
   never appears on the product page. An operator will reasonably believe they have just set the
   product image.

**Who it hurts, and when.** The client, the first time they add a product themselves — which is the
whole point of shipping a product-management screen. They fill in the twelve fields, set the OG
image, publish, and the storefront shows a product card and product page with no picture. Nothing in
the console indicates a missing image, because the console never had the field. For a business
selling ₹3,499/kg Mamra almonds on visual appeal, an imageless product page is not a cosmetic defect
— it is an unsellable listing, and the only workaround is a developer-run reseed that costs them
their pricing tiers.

**Why it is High and not Critical.** Brief §50 (`:359`) says *"Placeholder images only"*, so shipping
Phase 1 with placeholders was correct and this is not a spec violation. It becomes a launch blocker
the moment the client adds their first product or their first real photograph — both of which happen
before go-live, not after.

### G10 — `serviceable_pincodes` is documented as "admin-editable" and has no admin route. **Medium-High.**

`entities/commerce/serviceable-pincode.entity.ts:4-10`:

> **Admin-editable delivery rules**, keyed by pincode prefix. […] Longest-prefix match wins, so a
> single '1' row can cover a whole region and a specific '110001' row can override it.

`grep -rn "ServiceablePincode" backend/src` → the entity, `pincodes.seed.ts` (the only writer,
`:19,37`), `pincode.service.ts` (read-only, `:31`), and module wiring. **No `admin/pincodes`
controller exists**; `find backend/src -name "*pincode*"` returns no admin file. The seed writes ten
prefix rows — `1`-`8` serviceable, `0` and `9` not — all with `etaDays: 4` and `shippingPaise:
toPaise(79)` (`pincodes.seed.ts:13-34`), and its comment claims the design is *"admin-editable as
spec §5.3 requires"* (`:9`).

**Who it hurts, and when.** Three separate operational needs, all unmeetable:

1. **Suspending delivery.** A courier drops a region, or a flood closes a route. The admin needs to
   mark it unserviceable *today* and cannot. Orders keep being accepted for an address nobody can
   reach.
2. **Per-region shipping and ETA.** Every pincode in India currently quotes ₹79 and 4 working days
   — including 50kg bulk consignments to the far northeast. `docs/client-brief.md:106-107` (§10)
   requires the pincode checker to show *"estimated delivery date, shipping charges"*, and both are
   flat constants an admin cannot vary.
3. **Fixing G5.** The pincode row is the figure that actually bills the customer. Making
   `flatShippingRate` editable in the console while leaving `shippingPaise` seed-only is what turns
   G5 from a theoretical inconsistency into a live one.

### G11 — Combo compositions are a source-code constant. **Medium.**

`modules/catalog/combo-composition.ts:26` is a `const` array. Its own docblock (`:1-16`) is candid:

> **Why this is a constant and not a table.** Spec §5 designs no combo-composition entity […]
> **Deferred decision, owned by the admin plan:** when admin can create a combo, this needs a real
> entity — `ComboComponent(comboProductId, componentProductId, size, sortOrder)`.

The admin plan shipped without it. `GET /catalog/combos` (`catalog.controller.ts:117-120`) serves the
six boxes and the storefront renders them (`features/catalog/api/index.ts:52`).

**Who it hurts, and when.** Merchandising, at the first festive season. The six boxes' contents,
occasion labels and blurbs are frozen. An admin can change the *box product's* price and badge
through `/products` — and because savings are derived live from catalogue prices
(`combo-composition.ts:13-14`) the arithmetic stays honest — but they cannot swap a component,
retire a box, or add a seventh. Against `docs/client-brief.md:182-185` (§23), which names the six
by name; the six exist, so this is a "cannot change" rather than a "does not exist".

### G12 — Homepage editorial content has no schema and no screen. **Medium.**

`docs/client-brief.md:44-45` (§3) lists the admin's remit as *"…blog, **homepage content**, website
settings."* `grep -rni "homepage\|hero\|banner\|content_block" backend/src` returns two irrelevant
hits (`app.module.ts:106`, an asset path at `seed-context.ts:34`). `find backend/src/entities -name
"*.entity.ts"` lists 34 entities and **none for homepage content or content blocks**. The homepage's
copy is JSX in `nutwala-client/src/routes/index.tsx`.

**Who it hurts, and when.** The client, every time they want a seasonal banner or a changed hero
line. Unlike G1 and G2 this is not a broken wire — it is a feature that was never designed, so the
console cannot be blamed for not having a screen. It is listed because §3 promises it. Sitewide
strings that *do* have settings rows (`brandName`, `tagline`) are covered — badly, by G1.

### G13 — No user administration at all: cannot suspend a customer, cannot add a second admin. **Medium.**

`AdminCustomersController` has two handlers, both `@Get` (`admin-customers.controller.ts:43,61`).
`grep -n "Post\|Patch\|Put\|Delete"` on that file → **no hits.**

- **`users.isActive`** is a real, enforced column: login refuses an inactive user
  (`auth.service.ts:45`, `if (!matches || !user.isActive)`), and it is displayed in the console
  (`admin-customer.mapper.ts:70`, `_console/customers/$id.tsx:22`). **Nothing sets it false.**
  `dashboard.service.ts:217` states it plainly: *"`isActive` is deliberately not filtered. It is set
  false by nothing in this codebase today."*
- **`users.role`** changes in exactly one place: `users.service.ts:63`,
  `update({ id, role: CUSTOMER }, { role: BUSINESS })` — the customer's own self-service upgrade via
  `POST /auth/upgrade-to-business` (`auth.controller.ts:169`). No admin route promotes, demotes, or
  creates a user of any role.
- **The only `ADMIN` account is the seed's.** `users.seed.ts:52-54` creates `admin@demo.in` with the
  hardcoded `DEV_PASSWORD = 'Password123!'` (`:25`), and `seedUsers` refuses to run outside
  `development`/`test` (`:259-269`).

**Who it hurts, and when.** Two moments, both bad.

*Day one of production.* The seed that creates the only admin account is correctly barred from
running in production (`users.seed.ts:263`), and no route creates one. So provisioning the client's
first real admin login requires a manual `INSERT` with a bcrypt hash, by a developer, against the
production database. There is no supported path.

*The first abusive customer.* Someone spams fake reviews or places fraudulent COD orders. The admin
can reject the reviews and cancel the orders, one at a time, forever. They cannot stop the account.
The column that would stop it exists and is enforced at login — it is one `PATCH` away from working,
and that `PATCH` was never written.

### G14 — Shipments cannot be corrected, and `Shipment.status` / `deliveredAt` never move. **Low-Medium.**

`POST /admin/orders/:orderNumber/shipment` (`admin-orders.controller.ts:136`) creates a shipment with
`status: DISPATCHED`, `shippedAt: now`, `deliveredAt: null`
(`admin-orders.service.ts:372-379`), and no route ever updates one:
`grep -rn "Shipment" backend/src/modules/orders/` shows one `.save` and one status write, both in
`createShipment`. The service concedes it: *"`deliveredAt` stays null throughout this plan: nothing
writes it"* (`:350`). `create-shipment.dto.ts:22-27` records the same. Console:
*"A second dispatch cannot be recorded, and a tracking number cannot be added afterwards […] There
is no route"* (`features/orders/order-writes.tsx:312-313`).

**Who it hurts, and when.** Warehouse staff, most days. The AWB usually arrives from the courier
*after* the parcel leaves. An operator who dispatches now and gets the tracking number an hour later
has nowhere to put it, and the customer's order page shows a courier with no number — a support
ticket per shipment. Separately, `shipments.status` stays `DISPATCHED` even after the order moves to
`delivered`, so the two tables permanently disagree and any future delivery report reads wrong. Not
customer-money-affecting, hence Low-Medium.

### G15 — `notifications` rows are written and nobody can read them. **Low.**

`NotificationsService.queue` persists a row per event and marks it `SENT`/`FAILED` from the bound
driver (`modules/notifications/notifications.service.ts:41-70`); the driver this milestone is a log
line (`:20-22`). There is no `admin/notifications` route and no console screen.

**Who it hurts, and when.** Support, when a customer says "I never got the confirmation". The row
that says whether it was sent, and the `error` column that says why not
(`notification.entity.ts:39-40`), are only reachable by SQL. `docs/client-brief.md:270-274` (§38)
asks for *"architecture supports"* and *"Email / WhatsApp integrations configurable"* — the
architecture is genuinely there, so this is a visibility gap, not a missing feature. Also noted:
§20's *"Configurable: online payment, manual approval, quote-based order, credit terms"*
(`:170`) — `onlinePaymentEnabled` exists and is editable; **manual approval, quote-based order and
credit terms have no settings key.** `grep -rn "manualApproval\|creditTerms\|quoteBased"
backend/src` → **not found.**

---

## 9. False gaps — things that look missing and are deliberately absent

**`gstin`, `fssaiLicence` and `certifications` being blank.** Not a gap. `settings.seed.ts:12-14`
seeds them empty because *"Brief §25 and §26 forbid claims that have not been configured, and a
placeholder FSSAI number would be precisely the unsupported claim the brief rules out."* The console
says the same on-screen so an operator does not read blank as broken
(`_console/settings/index.tsx:214-222`), and each key carries a hint explaining it
(`catalogue.ts:82,86,90`). They are editable (§2). The only real problem is G1 — the storefront not
reading them — which is a different defect at a different layer.

**`isPublic` not being editable.** Deliberate, and correct. `replace-settings.dto.ts:53-59`:
*"Making it editable would put 'publish this to every anonymous visitor' one mistyped field away from
a routine settings save, on a table that holds a GSTIN."* The console shows the flag as a badge with
a tooltip and no input (`settings/index.tsx:292-301`).

**`PUT /admin/settings` refusing unknown keys.** Deliberate. A typo like `whatsapNumber` would
otherwise create a permanent row that *"looks saved, is returned by `GET /admin/settings`, and is
read by nothing"* — and there is no delete route, so it would never go away
(`features/settings/api/settings.ts:14-18`). The console renders the 404's key list rather than a
generic failure (`settings/index.tsx:224-237`). Does not obstruct G1's fix: all 16 rows already
exist.

**Stock not editable in the variant editor.** Not a gap — it moved, not vanished.
`features/products/variant-editor.tsx:425` points the operator at the stock screen, where
`PATCH /admin/inventory/:variantId` takes a signed `delta` and a mandatory `reason` and writes a
ledger row (`inventory.controller.ts:65-75`, `dto/adjust-stock.dto.ts:15-30`). Editing `onHand` as a
form field would bypass the append-only ledger. Brief §32 (`:232-235`) is fully met, threshold
included (`inventory.controller.ts:85`).

**No `GET /admin/posts/:slug` and no `GET /admin/coupons/:code`.** Real absences, not gaps. Both
editors work from rows already in the list, and both screens say so and offer a way to reach the row
(`_console/blog/index.tsx:148`, `_console/coupons/index.tsx:155`). The only cost is paging to find a
row, on collections of a few dozen.

**Product `slug` immutable after create; coupon `code` immutable.** Deliberate.
`UpdateProductDto` inherits `slug` as optional (`save-product.dto.ts:217`) but the coupon code is
addressed by path and snapshotted onto orders (`features/coupons/coupon-form.tsx:450`). Changing
either would orphan links and audit rows.

**Products that have been ordered cannot be deleted.** Deliberate — history-preserving refusal
(`_console/products/$id.tsx:300`, `features/products/api/products.ts:145-156`). Unpublish is the
intended path.

**Support notes not visible to the customer.** Deliberate and disclosed
(`_console/support/$ticketNumber.tsx:338`). Belongs with G15, not with a missing screen.

**`inventory_transactions` not resettable by the seeder.** Correct by design — append-only, keyed on
`(variantId, 'Opening stock (seed)')` (`catalog.seed.ts:585-594,702-718`). The gap is in the six
seeders around it that *are* destructive, not in this one.

**The seeder replacing `product_images` on every re-run.** **False footgun, and I checked because I
was told it was a real one.** `catalog.seed.ts:653-662` does `delete({ productId })` then insert —
but it destroys nothing an admin did, because **no admin route has ever written that table.** The
seeder's own justification at `:643-644` — *"Both are owned entirely by this seeder today, so nothing
else can lose a row"* — has expired for `pricing_tiers` (admin tier writes shipped) and **has not
expired for `product_images`** (no image write ever shipped). The four verifying searches are listed
in §6; the decisive one is `grep -n "images" backend/shared/src/types/admin.ts` returning nothing,
so the field is not even on the wire. Reporting "the seeder destroys admin-edited images" would be a
finding about work that cannot exist. The real defect the same code proves is **G9** — that images
are not editable in the first place — which is a larger problem than the one it was mistaken for.

**The unthrottled `POST /checkout/orders`.** Out of scope — accepted in
`docs/known-issues.md:173-234`. Not re-litigated.

**`shared/src/types/admin.ts` declaring `PublicSettings = Record<string, unknown>`.** Out of scope
per the task; a Task 2 item. Noted only because it is the type G1's fix will have to consume.

---

## 10. What to fix first

1. **G1** — wire `config/settings.ts` to `GET /settings`. Unblocks §26, §37 and §49, and makes the
   console's best screen actually do something. Fix **G3** in the same change (pick one `social`
   shape, and pick it in `settings.seed.ts`).
2. **The seeder** — put `users.seed.ts:259-269`'s environment allowlist into `seed.ts:61`, so it
   covers all seven seeders including `settings` and `catalog`. One guard, one place, and it closes
   both real footguns in §6 (the `settings` wipe and the `pricing_tiers` delete). Adding the
   `(product_id, min_kg, segment, business_id)` unique index `catalog.seed.ts:650` names is the
   better long-term fix but is a migration; the guard is a day's work and stops the bleeding.
   Note the `product_images` half of that docblock needs no action — §9 explains why.
3. **G6** — write the delivered-order lookup `reviews.service.ts:118-124` promised. Small, isolated,
   and the badge is on every product page.
4. **G4** — `PATCH /admin/businesses/:id` with `segment` and `assignedSalespersonId`. Turns three
   dead price bands live and unblocks part of G7.
5. **G13** — user administration. `isActive` first (one `PATCH`, and the enforcement already exists at
   `auth.service.ts:45`); admin provisioning second.
6. **G2** — swap `features/content/api/index.ts` from mocks to `/content/posts` and delete
   `lib/mock-client.ts`, as its own comment instructs.
7. **G9** — product images. Needs three changes, not one: an `images` field on `SaveProductDto`, an
   `images` field on `AdminProduct` so the console can *see* the current gallery at all, and a
   gallery editor on the product form. Sequence it against the launch date rather than this list —
   §50's *"Placeholder images only"* (`:359`) means it is not a spec violation today — but it has to
   land before the client adds their first product, because that product will ship with an empty
   gallery and nothing in the console will say so.
8. **G10** — `admin/pincodes` CRUD. Also the correct way to close **G5**.
