# Nuts & Nazaakat — Backend & Admin Design Spec (Phase 2)

**Date:** 2026-08-19
**Phase:** 2 of 2
**Supersedes:** the three-phase framing in the Phase 1 spec §12, which scheduled the admin
portal as a separate Phase 3. The user has asked for everything in this phase, so backend
and admin are delivered together and there is no Phase 3.
**Status:** Draft — awaiting review

---

## 1. Purpose

Replace every mock in the Phase 1 frontend with a real, persistent, secure backend, and
build the admin panel that operates the business.

Phase 1 built 34 routes against `src/mocks/` behind a deliberate API seam
(`features/*/api/`). Phase 2 changes only the bodies of those seven seam modules, stands up a
NestJS + Postgres service behind them, and builds the admin console as a **separate application in
its own repository** — see §7.1.

### Scope decision

The user's stated minimum was: login/logout, admin-managed stock with sold-out on the
storefront, cart, COD checkout, order tracking, admin order visibility, and support
queries. When asked whether B2B/RFQ/reviews/blog should follow in a later phase, the answer
was explicit: **everything in this phase.**

So this spec covers the full client brief backend — all 24 models of brief §45 — plus the
complete admin surface of brief §29–§36. Nothing from the brief is deferred.

This is a large phase. It is broken into 11 milestones (§16), each ending in a working,
tested, committed state, so progress is observable rather than a single big-bang landing.

### Out of scope

| Excluded | Why |
|---|---|
| Online payment gateway | COD only for now, per the user. `ONLINE` exists in the enum and is rejected at the API with 422; a settings flag gates the UI. |
| Real email / WhatsApp delivery | Brief §38 asks the architecture to *support* notifications. `Notification` rows are persisted and a no-op driver logs them. Swapping in a provider is a driver change, not a redesign. |
| Image upload pipeline | Brief §1 forbids generated images; placeholders and remote URLs only. Admin stores URLs. |
| Server-side rendering | Frontend stays an SPA. Re-evaluated separately. |
| Courier API integration | Pincode serviceability and ETA come from an admin-editable `ServiceablePincode` ruleset, not a live courier. |

---

## 2. Non-negotiable constraints

Carried forward from the client brief and Phase 1, plus this phase's additions.

| Constraint | Source |
|---|---|
| No generated images — placeholders only | Brief §1 |
| No unsupported quality or certification claims; certifications admin-configurable | Brief §25, §26 |
| One account serves retail and bulk — no separate B2B login | Brief §46 |
| Price transparency: MRP, selling price, discount, per-kg always available | Brief §47 |
| No hardcoded WhatsApp number or contact detail — served from `Setting` | Brief §37 |
| Order status vocabularies used verbatim from brief §33 | Brief §33 |
| Payment method is COD only until explicitly enabled | User, this phase |
| Server is authoritative for every price, total, and stock decision | This spec §13 |
| No secret committed to the repository | This spec §13 |

---

## 3. Technology

Chosen to match the existing `larkfinserv/cug` and `larkfinserv/mf-lenders-gateway`
services, so this codebase reads like the others.

| Concern | Choice | Matches |
|---|---|---|
| Runtime | Node 22, TypeScript 5.7 | CUG CI (`node-version: 22`) |
| Framework | NestJS 11 on `@nestjs/platform-express` | Both |
| Global prefix | `api/v1` | Gateway |
| Database | PostgreSQL 15 | Gateway (asserts 15+ at boot) |
| ORM | TypeORM 0.3.28, schema-scoped | Both |
| Migrations | `src/database/migrations/`, date-prefixed, `migrationsTransactionMode: 'each'`, `migrationsRun` opt-in | Both |
| Validation | class-validator 0.14 + class-transformer, global `ValidationPipe({ whitelist, transform, forbidNonWhitelisted })` | Both |
| Auth libs | `@nestjs/jwt`, passport-jwt, bcrypt (cost 10) | CUG |
| Guards | `JwtAuthGuard` + `RolesGuard`, `@Public()` / `@Roles()` decorators | CUG |
| Rate limiting | `@nestjs/throttler` | CUG |
| Security headers | `helmet` | CUG |
| Logging | winston 3 + AsyncLocalStorage request context + recursive PII redaction | Both |
| API docs | `@nestjs/swagger` at `/api-docs` behind `express-basic-auth` | CUG |
| Config | `@nestjs/config` + `registerAs('app', …)`, fail-closed secrets | CUG |
| Testing | Jest + ts-jest; unit / integration (`maxWorkers: 1`) / e2e configs | Both |
| Integration DB | testcontainers `postgres:15-alpine` + TRUNCATE CASCADE cleaner + `test/factories/` | CUG |
| Browser E2E | Playwright | New — neither repo has a browser surface |
| TS strictness | `strict: true` | CUG (Gateway is partial) |
| Package manager | npm | Both |
| Formatting | Prettier `singleQuote`, `trailingComma: 'all'`, `printWidth: 100` | Both |
| Money storage | `bigint` paise + `BigInt.prototype.toJSON` polyfill | Gateway |
| Idempotency | Interceptor + `@IdempotencyScope()` decorator persisting to `idempotency_keys` | Gateway |

### 3.1 Deliberate departures from CUG/Gateway conventions

Five, each with a reason. Everything else follows the existing repos.

**1. Session in an httpOnly cookie, not a 24h JWT in the `Authorization` header.**
Same libraries and the same guard shapes — only the transport changes. CUG's pattern suits
a partner API whose callers are server-side. This is a public browser SPA: a long-lived
token readable by JavaScript turns any single XSS into account takeover, and a stateless
JWT cannot be revoked. Design in §9.

**2. One consistent success envelope, enforced globally.**
CUG returns `{ success, data }` from 65 files but bare DTOs from its auth endpoints;
Gateway returns raw payloads with no envelope. Clients today must handle both. Greenfield,
this service emits `{ success: true, data, message? }` from a global `TransformInterceptor`,
uniformly. The error envelope is CUG's richer `GlobalExceptionFilter` shape.

**3. Validation rules live in `shared/`, consumed idiomatically by both sides.**
The backend convention is class-validator; the Phase 1 frontend is zod. Duplicating
`PHONE_REGEX` / `GSTIN_REGEX` / `PINCODE_REGEX` and the order-status lists in two languages
guarantees drift the first time one is corrected. Instead `shared/` owns the *rules* and
each side applies its own validator: `@Matches(PHONE_REGEX)` in a DTO, `.regex(PHONE_REGEX)`
in zod. Both conventions stay intact; there is one definition.

**4. Integration tests run the real migration chain, not `synchronize: true`.**
CUG's testcontainer helper uses `synchronize` with an inline note that the migration set has
ordering issues. Starting clean, running migrations in tests means the migrations themselves
are exercised on every run and that problem is never inherited.

**5. `.env` is gitignored; `.env.example` carries placeholders only.**
Both existing repos have working `.env` files committed, and CUG's `.env.example` contains
real-looking third-party tokens. This service gets a zod-validated env module that throws at
boot on a missing or malformed secret, and nothing resembling a credential enters git.

### 3.2 Departure from the brief's model list

Brief §45 lists `AdminUsers` as its own model. This spec collapses it into
`User.role = ADMIN`. Brief §46 requires one account across retail and bulk; a second
identity table would mean two authentication paths, two session mechanisms, and two places
to get authorization wrong. Role-on-user with server-enforced RBAC is the smaller, safer
surface. The Phase 1 frontend already types `Role = "b2c" | "b2b" | "admin"`, so this also
matches what the UI expects.

Brief §45's `GiftOrders` becomes `RfqGiftingDetail`. The Phase 1 frontend already models a
gifting enquiry as `Rfq.kind = "gifting"` carrying a `gifting` detail object (brief §24), so
gifting lands in the same numbered sales queue rather than a parallel entity with its own
status vocabulary.

---

## 4. Repository architecture

npm workspaces, added at the repo root. The existing `frontend/` does not move — churning
its paths would invalidate every reference in the Phase 1 plan and spec for no benefit.

```
nutwala/
├── package.json               # workspaces: ["shared", "backend", "frontend", "e2e"]
├── docker-compose.yml         # postgres:15-alpine (dev), separate test port
├── .env.example
├── shared/                    # @nutwala/shared — the contract both sides compile against
│   └── src/
│       ├── constants/         # regexes, INDIAN_STATES, CONTACT_TOPICS, BUSINESS_TYPES,
│       │                     # BLOG_CATEGORIES, order-status tuples, transition maps
│       ├── types/             # API response types: Product, AccountOrder, Rfq, Review, …
│       ├── money.ts           # paise ↔ rupee conversion (TDD)
│       └── index.ts
├── backend/
├── frontend/                  # the customer app. Unchanged location; only seam bodies change.
│                             # Contains no /admin route — enforced by
│                             # frontend/src/test/no-admin-routes.test.ts
├── e2e/                       # @nutwala/e2e — Playwright specs, fixtures, page objects
└── docs/
```

### 4.1 Why `shared/` is the load-bearing piece

The Phase 1 frontend already holds the canonical definitions of the domain — `Variant` with
`stock`, `AccountOrder` with a `timeline[]`, the two order-status tuples taken verbatim from
brief §33, the three Indian identifier regexes. Those are the contract. Moving them into
`shared/` and having the backend compile against them means a response shape the frontend
cannot consume is a **build failure**, not a runtime surprise found during E2E.

Migration of the constants is mechanical: `frontend/src/features/checkout/schema.ts` keeps
its zod schemas but imports the regexes and `INDIAN_STATES` from `@nutwala/shared`;
`features/account/types.ts` re-exports the status tuples from `@nutwala/shared`. No
component changes.

### 4.2 Backend module structure

Modular-by-feature at the top level of `src/`, following Gateway's convention rather than
CUG's legacy `services/` umbrella. Each module owns its controller, service, DTOs, entities
and tests. Deleting a folder deletes a feature.

```
backend/src/
├── main.ts                    # bootstrap; imports './load-env.js' first (Gateway pattern)
├── load-env.ts
├── app.module.ts
├── data-source.ts             # CLI-only DataSource mirror
├── common/
│   ├── auth/                  jwt.strategy, jwt-auth.guard, roles.guard, csrf.guard,
│   │                          decorators (@Public, @Roles, @CurrentUser)
│   ├── config/                app.config.ts, env.schema.ts, winston.config.ts
│   ├── db/                    transaction.helper.ts, postgres-version-assertion.service.ts
│   ├── filters/               global-exception.filter.ts
│   ├── interceptors/          transform.interceptor.ts, audit.interceptor.ts
│   ├── idempotency/           interceptor, service, idempotency-key.entity.ts
│   ├── logging/               winston-logger.service.ts, pii-redactor.ts, request-context.ts
│   ├── middleware/            request-tracking.middleware.ts
│   ├── money/                 money.ts re-export + TypeORM bigint transformer
│   └── pagination/            page-query.dto.ts, paginate.ts
├── database/
│   ├── migrations/            date-prefixed TypeORM migrations
│   └── seeds/                 seed.ts (flag-driven, CUG pattern) + per-domain seeders
├── modules/
│   ├── users/        auth/          sessions/     addresses/
│   ├── catalog/      inventory/     pricing/      cart/
│   ├── checkout/     orders/        coupons/      payments/
│   ├── shipping/     reviews/       business/     rfq/
│   ├── support/      content/       settings/     notifications/
│   └── admin/                       # dashboard aggregates + audit-log read + admin façades
└── types/express.d.ts
```

`modules/admin/` holds only what is genuinely admin-specific: the dashboard aggregates, the
audit-log reader, and thin `@Roles(ADMIN)` controllers that delegate into the same domain
services the storefront uses. Business rules are never duplicated between a customer path
and an admin path — that divergence is how a rule ends up enforced on one and not the other.

---

## 5. Data model

33 entities. Twenty-three of them cover all 24 models of brief §45 — the count differs
because `AdminUsers` collapses into `User.role` (§3.2). Ten more are required by this
design: `Session`, `Cart`, `CartItem`, `OrderEvent`, `CouponRedemption`, `RfqNote`,
`SupportTicket`, `SupportTicketNote`, `ServiceablePincode`, `WishlistItem` and `IdempotencyKey`.

### 5.1 Identity and access

| Entity | Key fields | Notes |
|---|---|---|
| `User` | id (uuid), name, email (unique, lowercased), phone, passwordHash, role (`CUSTOMER`/`BUSINESS`/`ADMIN`), isActive, createdAt | Brief §46: one account, role decides capability. Email uniqueness is case-insensitive. |
| `Session` | id, userId, familyId, refreshTokenHash, userAgent, ip, expiresAt, revokedAt, revokedReason | Server-side so logout genuinely invalidates and admin can force-logout. Only the hash is stored. `familyId` and `revokedReason` are what §9's reuse detection needs: the family is the unit that gets revoked, and the reason distinguishes an ordinary `rotated`/`logout` from a `reuse-detected` theft signature. An earlier version of this row omitted both. |
| `Business` | id, userId (unique), companyName, contactPerson, mobile, gstin?, businessType, billingAddressId?, shippingAddressId?, assignedSalespersonId? | 1:1 with a `BUSINESS` user. Brief §19. |
| `Address` | id, userId, label, fullName, phone, email, line1, line2?, city, state, pincode, isDefault, deletedAt? | Soft-deleted. Orders never reference it — see §5.3. |

### 5.2 Catalog and stock

| Entity | Key fields | Notes |
|---|---|---|
| `Category` | id, slug (unique), name, image, blurb, description, sortOrder, isPublished, seo{title,description,ogImage} | |
| `Product` | id, slug (unique), categoryId, name, subtitle, description, badge?, origin, grade, processing, shelfLife, storage, ingredients, hsn, gstRate, moqKg, quoteOnly, isPublished, publishedAt, ratingAvg, reviewCount, seo{…} | `ratingAvg`/`reviewCount` are denormalised aggregates recomputed on review moderation — the Phase 1 `Product` type already carries them. |
| `ProductImage` | id, productId, url, alt, sortOrder | |
| `ProductVariant` | id, productId, sku (unique), size, grams, channel (`RETAIL`/`BULK`), pricePaise, mrpPaise, moq, isActive | Matches Phase 1 `Variant` exactly, minus `stock`. |
| `Inventory` | variantId (pk), onHand, reserved, lowStockThreshold, updatedAt | Split out so stock writes never contend with catalog reads or admin product edits. `available = onHand − reserved` (brief §32). |
| `InventoryTransaction` | id, variantId, delta (signed), type (`RECEIPT`/`SALE`/`ADJUSTMENT`/`RETURN`/`CANCELLATION`), reason, orderId?, actorUserId?, balanceAfter, createdAt | Brief §32's history: added / sold / adjusted, with reason, date and admin. Append-only. |
| `PricingTier` | id, productId, minKg, maxKg?, pricePerKgPaise? (null ⇒ quote required), segment (`DEFAULT`/`RETAILER`/`DISTRIBUTOR`/`HORECA`), businessId? | Brief §16, §31. Resolution order: business-specific → segment → default. |

**Stock is a denormalised column plus an append-only ledger, not a ledger-only sum.**
The column is what the race-safe conditional update in §10.2 operates on and what the
storefront reads; the ledger is the audit trail. An integration test asserts
`SUM(delta) == onHand` per variant, so the two can never silently diverge.

### 5.3 Commerce

| Entity | Key fields | Notes |
|---|---|---|
| `Cart` | id, userId? (null ⇒ guest), guestToken?, updatedAt | Persisted for signed-in users so brief §38's abandoned-cart notification has something to read. **The anonymous-owner column is `guest_token`, not `guestKey`** — see the note below the table. |
| `CartItem` | id, cartId, productId, variantId?, mode (`RETAIL`/`BULK`), size?, grams?, kg?, qty | Mirrors Phase 1 `CartLine`. No price column — prices are always resolved live. |
| `Coupon` | id, code (unique, upper), type (`PERCENT`/`FLAT`), value, minOrderValuePaise?, maxDiscountPaise?, appliesTo (`ALL`/`CATEGORY`), categoryId?, channel (`ALL`/`RETAIL`/`BULK`), firstOrderOnly, usageLimit?, usageLimitPerUser?, startsAt?, expiresAt?, isActive | Brief §36. |
| `CouponRedemption` | id, couponId, userId, orderId, discountPaise, createdAt | Unique `(couponId, orderId)`; per-user limits enforced by counting rows inside the order transaction, so two concurrent checkouts cannot both consume the last use. |
| `Order` | id, orderNumber (unique, `NN-2026-000123`), userId?, businessId?, channel, status, paymentMethod, paymentStatus, subtotalPaise, discountPaise, gstPaise, shippingPaise, totalPaise, couponCode?, addressSnapshot (jsonb), billingSnapshot? (jsonb), companyName?, gstin?, poNumber?, specialInstructions?, placedAt, estimatedDelivery, cancelledAt?, cancelReason? | |
| `OrderItem` | id, orderId, productId?, variantId?, productSlug, name, detail, size?, grams?, kg?, qty, unitPricePaise, lineTotalPaise?, gstRate, gstAmountPaise | |
| `OrderEvent` | id, orderId, status, note?, actorUserId?, createdAt | The tracking timeline. Phase 1 `AccountOrder.timeline` maps to this directly. |
| `Payment` | id, orderId, method, status (`PENDING`/`COLLECTED`/`FAILED`/`REFUNDED`), amountPaise, collectedAt?, reference? | COD opens `PENDING` and moves to `COLLECTED` when admin records collection on delivery. |
| `Shipment` | id, orderId, courier?, trackingNumber?, status, shippedAt?, deliveredAt? | |
| `ServiceablePincode` | pincodePrefix (pk), etaDays, shippingPaise, isServiceable | Replaces Phase 1's `/^[2-8]\d{5}$/` heuristic with admin-editable rules. |
| `WishlistItem` | id, userId?, guestToken?, productId, createdAt | **Added after the fact.** Brief §8 lists "Wishlist" on the product card and an earlier version of this spec omitted it entirely, while `ProductCard.tsx` shipped a heart button backed by `useState` that forgot on every navigation. One flat table rather than a parent/child pair, because a wishlist has no attributes of its own: it is a set of products per owner. Exactly one of `userId`/`guestToken` is set, enforced by a check constraint, with a partial unique index per owner so the same product cannot be saved twice. Merged into the account on sign-in by the same mechanism as the cart. |

**Deviation, recorded during Plan 2: the anonymous-owner column is `guest_token`, not `guestKey`.**

This spec named it `guestKey` and the implementation plan followed, until it was measured against the
real `redact()` in `backend/src/common/logging/pii-redactor.ts`:

```
redact({ guest_key:   'SECRETVALUE' })  ->  { guest_key:   'SECRETVALUE' }     leaks
redact({ guestKey:    'SECRETVALUE' })  ->  { guestKey:    'SECRETVALUE' }     leaks
redact({ guest_token: 'SECRETVALUE' })  ->  { guest_token: '[REDACTED]'  }
redact({ guestToken:  'SECRETVALUE' })  ->  { guestToken:  '[REDACTED]'  }
```

The redactor scrubs a value whose *key* contains `token` and holds no list of this application's field
names. The value here is a bearer credential: whoever presents it can read and replace that visitor's
basket and their wishlist. Under `guestKey`, any log line that serialises a `Cart` or `WishlistItem` row
writes it in plaintext — an error path dumping the entity, a debug line, TypeORM query logging — nested
occurrences included.

This is the same failure §3.1 already records for `nn_rt`, one layer down: that fix renamed the *cookie*
and left the *column* named after this spec. The cookie (`nn_guest_token`) and the column now share a
name, which is honest — they hold the same value.

**The wishlist and the cart share one anonymous-visitor key.** Both need to attribute rows to a
visitor with no account and then fold them into the account on sign-in, so there is one
`nn_guest_token` cookie rather than one per feature. Two cookies would mean two merge paths, two
places to get the owner-exclusivity constraint right, and a visitor who signed in keeping one list
and losing the other.

**Orders snapshot everything.** `OrderItem` stores the name, unit price and GST rate as they
were at purchase; `Order` stores the delivery address as jsonb. Editing a product price,
renaming a product, or deleting an address in admin therefore cannot retroactively rewrite a
customer's order history or their invoice total. This is the single most common
e-commerce data defect and it costs nothing to prevent at schema time.

### 5.4 B2B, content and operations

| Entity | Key fields | Notes |
|---|---|---|
| `Rfq` | id, rfqNumber (unique, `RFQ-2026-000123`), userId?, kind (`BULK`/`GIFTING`), businessName, contactPerson, mobile, email, gstin?, businessType, pincode, packaging, frequency, notes?, status, assignedSalespersonId?, expectedValuePaise?, createdAt | Brief §17, §34. Public creation — a prospect need not have an account. |
| `RfqItem` | id, rfqId, productId?, productSlug, kg | |
| `RfqNote` | id, rfqId, authorUserId, body, createdAt | Brief §34 internal notes. Never exposed on a customer-facing endpoint. |
| `RfqGiftingDetail` | rfqId (pk), occasion, giftBoxSlug, boxes, budgetPerBoxPaise, brandingRequired, deliveryDate, message | Brief §24. |
| `Review` | id, productId, userId?, author, rating, body, imageUrl?, verifiedPurchase, status (`PENDING`/`APPROVED`/`REJECTED`), moderatedByUserId?, moderatedAt?, rejectionReason?, createdAt | Brief §27. |
| `BlogPost` | id, slug (unique), title, category, excerpt, image, author, body, publishedAt?, isPublished, seo{…} | Brief §28. `readingMinutes` stays derived, not stored. |
| `SupportTicket` | id, ticketNumber (unique, `SUP-2026-000123`), userId?, name, email, phone?, topic, orderNumber?, message, status (`NEW`/`OPEN`/`WAITING`/`RESOLVED`/`CLOSED`), priority, assignedToUserId?, createdAt, resolvedAt? | The user's "help support queries". Fed by the existing contact form. |
| `SupportTicketNote` | id, ticketId, authorUserId, body, isInternal, createdAt | |
| `Notification` | id, userId?, channel (`EMAIL`/`WHATSAPP`), template, payload jsonb, status (`QUEUED`/`SENT`/`FAILED`), sentAt?, error?, createdAt | Brief §38. Persisted; dispatched by a logging no-op driver. |
| `Setting` | key (pk), value jsonb, updatedByUserId, updatedAt | Backs `frontend/src/config/settings.ts`. Brief §26, §37. |
| `AuditLog` | id, actorUserId, action, entity, entityId, before jsonb?, after jsonb?, ip, userAgent, createdAt | Every admin mutation. |
| `IdempotencyKey` | key (pk), scope, requestHash, responseBody jsonb, statusCode, createdAt | Gateway's pattern, applied to order placement. |

`Setting` is seeded with the exact keys `SiteSettings` already declares — `brandName`,
`tagline`, `whatsappNumber`, `supportEmail`, `supportPhone`, `freeShippingThreshold`,
`bulkPromptThresholdGrams`, `gstin`, `fssaiLicence`, `certifications`, `social`,
`addressLines` — plus `codEnabled`, `onlinePaymentEnabled`, `freeShippingThreshold` and
`flatShippingRate`. The last two were omitted from this list and are seeded (`settings.seed.ts`) and read
by the cart (`cart-read.service.ts`'s `shippingSettings`), so an exhaustive list that leaves them out
reads as though the shipping rules are hardcoded. Certification fields seed
**empty**, because brief §25/§26 forbid claims that have not been configured.

---

## 6. API surface

REST under `api/v1`. Success: `{ success: true, data, message? }`. Error: the
`GlobalExceptionFilter` envelope. Lists are paginated (`page`, `limit`, capped) and return
`{ items, total, page, limit }` in `data`.

### 6.1 Public

```
GET    /catalog/products              filters + sort + pagination (Phase 1 ProductFilters, verbatim)
GET    /catalog/products/:slug
GET    /catalog/products/:slug/related
GET    /catalog/products/bestsellers
GET    /catalog/products/facets       filter facets for the shop page — added during Plan 2
GET    /catalog/categories
GET    /catalog/categories/:slug
GET    /catalog/combos
GET    /catalog/bulk/products         bulk catalog with resolved tiers
POST   /catalog/bulk/quote-preview    { slug, kg } → server-resolved tier price or quoteRequired
GET    /catalog/products/:slug/reviews
GET    /catalog/products/:slug/reviews/summary
GET    /content/posts                 ?category
GET    /content/posts/:slug
GET    /content/posts/:slug/related
GET    /settings                      public subset only
POST   /checkout/pincode              serviceability + ETA + shipping
POST   /support/tickets               rate-limited; the contact form
POST   /rfqs                          rate-limited; prospects need no account
POST   /rfqs/gifting                  rate-limited
```

**Route order is load-bearing wherever a literal sits beside a parameter, and nothing in the framework
enforces it.** `/catalog/products/facets` and `/catalog/products/bestsellers` must be declared **above**
`/catalog/products/:slug`, or Express matches the literal as a slug and every request becomes a 404 for a
product nobody named. Verified in the implementation: `facets` and `bestsellers` are declared at
`catalog.controller.ts:29` and `:36`, ahead of `:slug` at `:43`, and `categories` ahead of
`categories/:slug`. `/wishlist/slugs` is placed above the `:slug` patterns for the same reason even though
no `GET /wishlist/:slug` exists yet. There is no decorator that expresses this: the controller specs read
Nest's routing metadata to pin the order, which is the only thing that keeps it. **Any new route added to
this table needs the same check** — a shadowed route 404s while every unit test stays green, which has
already happened once on this project.

### 6.2 Authentication

```
POST   /auth/register                 → sets cookies, returns User
POST   /auth/login                    → sets cookies, returns User
POST   /auth/refresh                  → rotates refresh token
POST   /auth/logout                   → revokes session, clears cookies
GET    /auth/me                       → current User, or 401
POST   /auth/upgrade-to-business       CUSTOMER → BUSINESS (brief §46)
```

### 6.3 Authenticated customer

```
GET    /wishlist                      POST /wishlist/:slug        DELETE /wishlist/:slug
GET    /wishlist/slugs                saved slugs only — added during Plan 2
GET    /cart                          PUT /cart          POST /cart/merge
POST   /cart/validate                 stock + live repricing; also open to guests
POST   /checkout/coupon/preview
POST   /checkout/orders               idempotent; COD only
GET    /account/orders                GET /account/orders/:orderNumber
POST   /account/orders/:orderNumber/cancel
GET    /account/addresses             POST /account/addresses
PATCH  /account/addresses/:id         DELETE /account/addresses/:id
POST   /account/addresses/:id/default
GET    /account/profile               PATCH /account/profile
POST   /catalog/products/:slug/reviews
GET    /support/tickets               own tickets only
GET    /rfqs                          GET /rfqs/:rfqNumber        own only
GET    /business/me                   PUT /business/me
GET    /business/orders               GET /business/stats
```

### 6.4 Admin — `@Roles(ADMIN)`, every route

```
GET    /admin/dashboard                                    brief §29 cards + charts
GET    /admin/products                POST /admin/products
GET    /admin/products/:id            PATCH /admin/products/:id      DELETE /admin/products/:id
POST   /admin/products/:id/publish    POST /admin/products/:id/unpublish
POST   /admin/products/:id/variants   PATCH /admin/variants/:id      DELETE /admin/variants/:id
GET    /admin/categories              POST /admin/categories         PATCH /admin/categories/:id
GET    /admin/inventory                                    current / reserved / available / low / out
PATCH  /admin/inventory/:variantId                         delta + reason → ledger row
GET    /admin/inventory/:variantId/transactions

**Deviation, recorded during Plan 2: the adjustment is `PATCH /admin/inventory/:variantId`, not
`POST /admin/inventory/:variantId/adjust`.** The row above has been corrected to the shipped spelling.
This matters more than a URL usually would, because §7.1 puts the admin console in a **separate
application and repository**: its developers will read this table, write the `POST …/adjust` form, get a
404, and have nothing telling them which document is authoritative. The implementation is the one with
18 integration cases against it (`backend/test/integration/inventory.integration.spec.ts`), so the spec
moved rather than the code.

The other two rows in this block are **not** missing work — §16 assigns all 27 `@Roles(ADMIN)` endpoints
to Milestone 9, and Milestone 4 committed only to "admin adjust". §14's E2E journey 3 depends on
`GET /admin/inventory`, so Milestone 9 owes it.
GET    /admin/orders                  GET /admin/orders/:id
POST   /admin/orders/:id/status                            validated transition + timeline event
POST   /admin/orders/:id/payment/collect                   COD collected
POST   /admin/orders/:id/shipment
GET    /admin/customers               GET /admin/customers/:id
GET    /admin/businesses              GET /admin/businesses/:id
GET    /admin/rfqs                    GET /admin/rfqs/:id
PATCH  /admin/rfqs/:id                POST /admin/rfqs/:id/notes
GET    /admin/pricing-tiers           POST /admin/pricing-tiers      PATCH /admin/pricing-tiers/:id
GET    /admin/coupons                 POST /admin/coupons            PATCH /admin/coupons/:id
DELETE /admin/coupons/:id
GET    /admin/reviews                 POST /admin/reviews/:id/approve   POST /admin/reviews/:id/reject
GET    /admin/posts                   POST /admin/posts              PATCH /admin/posts/:id
DELETE /admin/posts/:id
GET    /admin/settings                PUT  /admin/settings
GET    /admin/support/tickets         GET /admin/support/tickets/:id
PATCH  /admin/support/tickets/:id     POST /admin/support/tickets/:id/notes
GET    /admin/audit-logs
```

**Three further `:id` corrections, recorded by plan 9.4** — the same class of deviation this section
already carries for `PATCH /admin/inventory/:variantId`, and that plan 9.2 recorded for
`:orderNumber`. §7.1 puts the admin console in a separate application and repository, so its
developers read this table, write the `:id` form, get a 404, and have nothing telling them which
document is authoritative. The implementations each have integration coverage against them, so the
spec moves rather than the code. Appended rather than edited into the rows above so a concurrently
running plan's merge stays trivial.

| The table says | Shipped | Why the natural key won |
| --- | --- | --- |
| `PATCH`/`DELETE /admin/coupons/:id` | **`:code`** | `CouponService.preview` looks a coupon up by code and by nothing else, `orders.couponCode` snapshots it as the permanent record of which coupon an order used, and `uq_coupons_code` makes it unique. The code is therefore **immutable** — `UpdateCouponDto` omits it. |
| `PATCH`/`DELETE /admin/posts/:id` | **`:slug`** | The slug is the live URL that `GET /content/posts/:slug` serves, and `uq_blog_posts_slug` makes it unique. Unlike a coupon code it **is** mutable, because brief §39 makes the slug an editable SEO field; a rename writes a `post.update` row carrying both spellings. |
| `GET`/`PATCH /admin/support/tickets/:id` | **`:ticketNumber`** | `TICKET_NUMBER_PATTERN` is a committed, tested contract in `shared/`, `uq_support_tickets_ticket_number` makes it unique, and `ST-2026-000123` is the reference the customer was given. Consistent with `:orderNumber` and `:rfqNumber`. |

`POST /admin/reviews/:id/approve` and `.../reject` **are** the uuid, exactly as spelled above: a
review has no human-readable alternate key, so it is the one resource in plan 9.4 where this table
was already right.

**§6.1 was owed four public routes, not one.** Plan 9.4 was scoped to build `GET /settings`, which
had never existed despite `Setting.isPublic`'s docblock describing its response. While building
`/admin/posts` it emerged that **`GET /content/posts`, `/content/posts/:slug` and
`/content/posts/:slug/related` had never been built either** — there was no `content` controller
anywhere in the service, so `blog_posts` carried eight seeded posts from Milestone 3 that nothing
could read. All four now exist. **`GET /support/tickets` in §6.3 — "own tickets only" — still does
not**, and is the remaining known gap of this kind.

---

## 7. Frontend rewiring

The seam holds: no component changes and **no route changes at all** in the customer app. The admin
console is a separate application in its own repository (§7.1), so nothing is added here.

| Seam module | Phase 1 source | Phase 2 |
|---|---|---|
| `features/catalog/api/` | `mocks/products`, `categories`, `combos` | `GET /catalog/*` |
| `features/content/api/` | `mocks/posts` | `GET /content/*`, `POST /support/tickets` |
| `features/account/api/` | `mocks/orders`, `addresses`, localStorage | `GET /account/*` |
| `features/checkout/api/` | sessionStorage receipt | `POST /checkout/*` |
| `features/rfq/api/` | `mocks/rfqs` | `POST/GET /rfqs` |
| `features/reviews/api/` | `mocks/reviews` | `GET/POST` review endpoints |
| `features/auth/api/` | `mocks/users` | `POST /auth/*` |
| **New:** `features/business/api/` | localStorage in `routes/business/profile.tsx` | `GET/PUT /business/me` |

There is deliberately **no `features/admin/api/`** in the customer app. It appeared in an earlier
version of this table, when the admin panel was to be a route group here. It consumes `/admin/*` from
the separate admin repository instead.

Three deletions and four real changes beyond the seam bodies:

- `src/mocks/` is deleted entirely, along with `src/lib/mock-client.ts`. The
  `no-restricted-imports` lint rule guarding it becomes unnecessary and is removed.
- `src/config/settings.ts` becomes a typed default that `GET /settings` hydrates, so the
  admin-configurable values of brief §26/§37 come from the database.
- `AuthProvider` stops reading a user out of localStorage. With an httpOnly cookie the
  session is not JS-readable, so it hydrates from `GET /auth/me` on mount. Route guards in
  `beforeLoad` currently read localStorage synchronously; they keep a **non-sensitive display
  snapshot** there for first-paint routing only, and the server remains the sole authority.
  A tampered snapshot changes what the UI optimistically renders and nothing else.
- `CartProvider` becomes server-backed **for guests as well as customers**, and its `localStorage`
  store is deleted rather than kept for guests. This deviates from an earlier version of this bullet
  and is what Milestone 4 built: an anonymous visitor gets an opaque key in the httpOnly
  `nn_guest_token` cookie and a real `carts` row, so a basket survives a device reload and a guest who
  signs in keeps it. A second copy in `localStorage` would be a cache nobody invalidates — a basket
  reappearing after checkout is exactly that bug.

  The merge is **server-side, inside `POST /auth/login` and `POST /auth/register`**, not a client call
  to `POST /cart/merge`. A customer whose browser closes the instant they sign in still keeps their
  basket, which a client-driven merge cannot promise. `POST /cart/merge` still exists as a manual
  recovery path and as the integration suite's direct handle on the merge, but no client calls it.

  `POST /cart/validate` runs on the cart and checkout pages so stock and price changes surface before
  payment rather than after.

`features/bulk/pricing.ts` and `features/cart/cart-math.ts` stay in the frontend for
display, but the server re-derives every figure independently at checkout (§13). The shared
tier-resolution and GST rules move to `shared/` so both sides compute from one definition
and a divergence becomes a failing test.

### 7.1 The admin console — a separate application in its own repository

**Decided by the user during Plan 2, replacing this section's original design.** The admin panel was
specified here as an `/admin/*` route group inside the customer app, lazily loaded. It is now a
**separate frontend application in a separate repository**, consuming the same `/api/v1` backend.

Brief §4 enumerates 14 admin routes; this phase builds **18**. The four additions are the detail routes
the list screens must link to (`products/$id`, `orders/$id`, `rfqs/$id`) and `/admin/support`, which the
brief's page list omits even though §38 and the contact form require it. That is an intentional addition,
not drift. Paths are unchanged; only where they live has changed:

```
/  /products  /products/new  /products/$id  /categories
/inventory  /orders  /orders/$id  /customers  /businesses
/rfqs  /rfqs/$id  /pricing  /coupons  /reviews
/blog  /support  /settings
```

Served from the admin app's own root rather than under an `/admin` prefix, since the whole application
*is* the admin console. The backend's routes keep their `/admin/*` prefix regardless — that prefix is
about authorisation scope (`@Roles(ADMIN)`), not about which app calls them.

**Why separate.** Lazy loading keeps admin code out of the customer *bundle*; it does not keep it off
the customer *origin*. Two applications on one origin share cookies, CSP, service worker scope and
deploy cadence, so a customer-facing regression can take the operator's tooling down with it, and an XSS
anywhere in the storefront runs with whatever the admin session can reach. A separate origin also means
the console can sit behind network restrictions the storefront cannot.

**What the customer app must therefore not contain.** No route file under an admin path, no
`createFileRoute("/admin…")`, and nothing matching `/admin` in the generated route tree. This is
enforced, not remembered: `frontend/src/test/no-admin-routes.test.ts` fails the build otherwise. The
`admin` member of `Role` **stays** in `frontend/src/features/auth/storage.ts` — the API returns it, and a
snapshot that could not parse it would sign an admin out on every reload.

An administrator who signs in to the customer app is routed away rather than shown the customer
dashboard, in both directions:

- through the sign-in form, by `LoginForm` reading `isAdmin(user.role)`;
- by direct navigation or a pre-existing session, by `requireCustomer` on the `/account` layout guard.
  `requireAuth` answers "is someone signed in", not "who", so the redirect alone was not enough.

Both send them to `VITE_ADMIN_APP_URL` as a **full page navigation** when that variable is configured —
a router `navigate()` would appear to work and then render nothing, because this app has no `/admin`
route and never will. When it is unset, which is the normal case while only the customer app runs
locally, they get an explanation on the sign-in form and the storefront home on the guard path; there is
no screen in this app that could explain more, and pretending they are signed out would be false.

**Shared contract, not shared code.** Both apps depend on `@nutwala/shared` for wire types and money
rules. That package is the seam: publish it, or vendor it, but do not let the admin repo redeclare
`Product`, `AccountOrder` or the paise conversions — a second definition is how the two drift while both
still compile. Distributing `@nutwala/shared` to a second repository is an explicit early task of the
admin plan, not an afterthought.

The admin app guards its own routes on `role === "admin"` for UX. Authorisation remains entirely the
server's `RolesGuard`; a separate origin changes nothing about that.

---

## 8. Money

Every monetary column is `bigint` paise, matching Gateway. `shared/src/money.ts` owns the
conversion and is built test-first:

- `toPaise(rupees: number): bigint` — rejects non-finite and sub-paise input
- `toRupees(paise: bigint): number`
- `gstOn(basePaise: bigint, ratePercent: number): bigint` — half-up rounding, applied
  per line then summed, so a total never disagrees with the sum of its lines
- `applyPercent`, `applyFlat` for coupon arithmetic, each clamped at zero

API responses convert to rupee numbers at the boundary, so the Phase 1 `price: number`
contract is untouched. The `BigInt.prototype.toJSON` polyfill from Gateway prevents Nest's
serialiser throwing on a stray bigint.

GST rounding is fixed by one rule, tested: **round per line, then sum.** Phase 1's
`cartTotals` rounds the aggregate. That is a genuine one-rupee divergence, and the server
does not bend to the frontend — an invoice must equal the sum of its lines.

**Two corrections to this section, both measured during Milestone 5.**

The sentence above used to claim `cart-math.ts` "is corrected to match the server". It was not, and as
of Milestone 5 it still is not: the frontend accumulates `gst += total * rate / 100` as a float and
calls `Math.round` **once, on the aggregate, to whole rupees**, so it cannot even express the server's
₹5.01 — on the three-line ₹33.33 fixture the server charges ₹5.01 and the client shows ₹5.00. This is
contained rather than fixed: `CartProvider` uses those figures only for the optimistic window and every
server reply overwrites them. The one screen that renders them un-overwritten is the B2B bulk cart
(`bulk-cart.tsx`), which totals half a basket, and Milestone 7 owns resolving it.

**This section is silent on how a coupon discount interacts with GST, and the implementation charges tax
on the pre-discount subtotal.** `place()` sums per-line GST from the undiscounted line totals and then
subtracts the discount from the total. The standard reading of CGST §15(3)(a) — a discount given before
supply and recorded in the invoice is excluded from the taxable value — points instead at taxing the
post-discount amount, which would mean apportioning an order-level discount across lines pro rata and
recomputing each line's GST, across lines that may carry 5%, 12% or 18%. **That is a tax-treatment
decision, not a coding one, and it is open.** Nothing is broken today: every seeded order carries
`discountPaise: 0`, so the question first bites the first genuinely discounted order.

---

## 9. Authentication and sessions

**Access token** — JWT, 15-minute TTL, `{ sub, role, sessionId }`, delivered in an
httpOnly `Secure` `SameSite=Lax` cookie. Short enough that a revoked session dies quickly
without a per-request database read.

**Refresh token** — 30-day opaque random token, httpOnly, `SameSite=Strict`, scoped to
`/api/v1/auth/refresh`. Only its SHA-256 hash is stored on `Session`.

**Rotation with reuse detection** — every refresh issues a new token and revokes the old.
Presenting an already-revoked token revokes the whole session family and logs a security
event: that is the signature of a stolen refresh token.

**Logout** is real — the `Session` row is revoked, so the refresh token is dead immediately
and the access token expires within 15 minutes. Admin can revoke any user's sessions.

**Session fixation** is prevented by issuing a fresh session on every login rather than
reusing one.

**CSRF** — `SameSite` blocks the common case; a double-submit token (`csrfToken` cookie
readable by JS, echoed in `X-CSRF-Token`) covers state-changing requests, verified by a
`CsrfGuard`. Safe methods are exempt.

**Passwords** — bcrypt cost 10, matching CUG. Minimum 8 characters and **maximum 72 bytes**,
checked against a small list of the most common passwords.

The maximum is not an arbitrary limit: bcrypt truncates its input at 72 bytes, so without it two
different passwords sharing a 72-byte prefix authenticate interchangeably. Measured — a hash of
`'A'x72 + 'ZZZZZZZZZZ'` verifies against `'A'x72 + 'QQQQQQQQQQ'`. Rejecting over-long input is
honest about the primitive's limit instead of silently ignoring everything the user typed past
byte 72. Count **bytes, not characters**: an emoji or a Devanagari name can spend four bytes per
character, so a 30-character password can exceed the limit while `String.length` says otherwise.
(NUL bytes are not a problem here — node bcrypt 6 was checked and does not truncate at one.) Never logged: `password`, `passwordHash`, `token`,
`refreshToken`, `authorization`, `cookie` are all in the winston redaction list.

**Rate limits** — login 5 attempts / 15 min per email+IP, register 3 / hour per IP, refresh
10 / min, contact and RFQ 5 / hour per IP. CUG's lockout is an in-process `Map` and so is
per-worker; this uses `@nestjs/throttler` with a shared store, which survives clustering.

**No user enumeration — on login.** The Phase 1 mock returns *"No account found with that
email address."*, which tells an attacker exactly which emails are registered. Login returns a
single generic `Invalid email or password.` for all three failure cases — unknown email, wrong
password, and deactivated account — with timing equalised by always running one bcrypt
comparison, against a dummy hash when the user is absent. The `isActive` check deliberately runs
*after* the comparison so it cannot short-circuit.

**Register remains an enumeration oracle, and this is a deviation from an earlier version of
this section.** That version required register to "return the same success shape whether or not
the email already existed, with the collision handled out of band". That is not implementable in
this phase, and the reason is structural rather than effort: register **auto-signs-in**, returning
a session cookie and a CSRF token. A generic success for an address you have not authenticated
cannot issue a session, so honouring the original requirement means register stops signing the
user in and always answers "check your email" instead — which needs email delivery (no mailer
exists yet; `Notification` rows have no sender) and changes the registration UX, the frontend's
`AuthProvider`, and the guest-to-customer checkout flow.

So this phase ships the honest 409 and records the gap rather than pretending it is closed. What
closes it: **email-verified signup**. Whoever builds that owns this row. Until then, register
carries the strictest limit on the API — 3/hour per IP — because a rate limit is the only control
actually standing between this oracle and a bulk address-list test.

Forgot-password, when it arrives, is the same oracle and needs the same decision made
deliberately rather than by default.

---

## 10. Stock, sold-out, and the order lifecycle

### 10.1 Sold-out semantics

`available = onHand − reserved`, per **variant**, so `1kg` can be sold out while `250g`
is in stock — which is what brief §11's per-variant stock requires and what the admin
inventory screen edits.

- Product list and detail responses include `available` and a derived `soldOut` per variant,
  plus a product-level `soldOut` that is true only when every active variant is at zero.
- The storefront renders **SOLD OUT** and disables Add to Cart at variant level; the
  existing `inStockOnly` shop filter starts filtering real data.
- Adding to cart reserves nothing — the same behaviour as Amazon and Flipkart. Stock is
  checked at add-to-cart for feedback and re-checked authoritatively at checkout.
- `POST /cart/validate` returns per-line `availableQty` so a cart holding more than remains
  shows the problem before checkout rather than failing at the last step.

**One derivation, reused everywhere.** `soldOut` is a derived field on the wire, which means the
server must produce it identically at every site that assembles a `Product` or `Variant` — the
listing endpoint, the detail endpoint, the bulk catalogue, the admin list, and anything that
warms a cache later. TypeScript enforces that the field is *present*; nothing enforces that its
*value* agrees with `available`. A second assembly site that reimplements the rule slightly
differently compiles cleanly and ships a stale flag, so a listing says in stock while the product
page says sold out.

So: one exported derivation helper, called by every mapper, never recomputed inline. The catalog
task that builds those mappers must include a test asserting, over every seeded fixture, that
`variant.soldOut === (variant.available === 0)` and that `product.soldOut` equals
`variants.every(v => v.available === 0)` across active variants. That test is what converts the
duplication risk into a build failure.

### 10.2 Race-safe decrement

Order placement runs in one transaction at Postgres's default `READ COMMITTED`. The safety
comes from the statement itself, not the isolation level — each line decrements with a
single conditional `UPDATE` that has no read-then-write gap to lose:

```sql
UPDATE inventory
   SET on_hand = on_hand - $qty, updated_at = now()
 WHERE variant_id = $variantId
   AND on_hand - reserved >= $qty
```

Zero rows affected means insufficient stock: the transaction rolls back and the API returns
`409 OUT_OF_STOCK` naming the offending items. Postgres serialises the concurrent writers on
the row lock and re-evaluates the `WHERE` against the committed value, so two customers
racing for the last bag produce exactly one order and one clear rejection — never oversold
inventory, and no serialisation-failure retry loop to get wrong. An integration test drives
concurrent placements against a stock of 1 and asserts precisely one success.

Coupon limits need a different mechanism, because counting redemptions then inserting *is* a
read-then-write gap. The order transaction takes `SELECT … FOR UPDATE` on the `Coupon` row
before counting, which serialises redemptions of the same coupon; the unique
`(couponId, orderId)` constraint is the backstop. Lines decrement in a deterministic order
(ascending `variantId`) so two multi-item orders touching the same variants cannot deadlock.

Each decrement also writes an `InventoryTransaction` (`type: SALE`, `orderId`,
`balanceAfter`) inside the same transaction, so the ledger can never drift from the column.

**Implementation note, added during Milestone 5 because the SQL above shipped broken twice.**
TypeORM's Postgres driver special-cases the commands that report an affected count: for `UPDATE` and
`DELETE` it returns `[rows, rowCount]` rather than `rows`
(`PostgresQueryRunner.query`, the `switch (raw.command)`). So a bare `UPDATE … RETURNING "onHand"`
read back through `manager.query()` makes `rows[0]` the **rows array**, and `rows[0]?.onHand`
`undefined`. In `CheckoutService.sell` that `undefined` branch threw `OUT_OF_STOCK`, so *every*
successful decrement was reported as a sell-out and no order with a retail line could be placed; the
identical statement in `OrderStatusService.putStockBack` threw `NOT_FOUND`, so no cancellation could
restock. Both passed 458 unit tests, because the doubles returned `[{ onHand }]` — the shape a `SELECT`
returns.

The fix keeps this section's guarantee intact: wrap the write in a data-modifying CTE
(`WITH sold AS (UPDATE … RETURNING …) SELECT * FROM sold`), which makes the statement's command
`SELECT` so the driver returns rows, while it remains **one statement with the predicate still inside
the write**. `INSERT` is not special-cased, and `repository.update().affected` is safe because the
driver sets `affected` from `rowCount` before mangling `raw` — only the raw-query path carries the trap.

### 10.3 Order status state machine

`OrderStatusService` owns the legal transitions; an illegal one is a `422`, not a silent
write. Statuses are brief §33's, verbatim, and already typed in Phase 1.

```
Retail:  pending → confirmed → processing → packed → shipped → out-for-delivery → delivered
         cancelled reachable from pending | confirmed | processing | packed
         refunded reachable from delivered
         cancelled and refunded are terminal

Bulk:    quote-requested → quote-sent → quote-accepted → awaiting-payment → approved
                         → processing → shipped → delivered
```

Every transition appends an `OrderEvent` with the acting admin and an optional note, which
is exactly what `/account/orders/$id` renders as the tracking timeline — so admin action and
customer-visible tracking are the same data, not two systems that can disagree.

Stock follows status: `cancelled` before dispatch writes a `CANCELLATION` transaction
restoring `onHand`; `refunded` writes a `RETURN` only when the admin marks the goods
restockable, since returned food may not be resellable.

### 10.4 COD

`POST /checkout/orders` accepts `paymentMethod: "cod"` and rejects `"online"` with
`422 PAYMENT_METHOD_UNAVAILABLE`. A `Payment` row opens `PENDING`;
`POST /admin/orders/:id/payment/collect` moves it to `COLLECTED` on delivery. The
`onlinePaymentEnabled` setting gates the frontend option, so enabling online payment later
is a settings change plus a provider module — not a checkout rewrite.

Order placement is wrapped in Gateway's `IdempotencyInterceptor` under a
`checkout:orders` scope keyed on an `Idempotency-Key` header the frontend generates per
checkout attempt. A double-clicked Place Order replays the first response instead of
creating a second order.

---

## 11. Support queries

The contact form already posts through `contentApi.submitContactMessage` with name, email,
optional phone, topic, optional order ID and message. `POST /support/tickets` accepts that
exact shape, rate-limited and open to guests, and creates a `SupportTicket` with a
`SUP-2026-NNNNNN` number.

Unlike Phase 1 — which deliberately invented no reference, since an unlookupable number is
worse than none — the ticket number is now real: signed-in customers see their tickets at
`GET /support/tickets`. `orderNumber` is soft-linked, so admin sees the order beside the
query when the customer supplied one.

Admin works the queue at `/admin/support`: filter by status, topic and assignee; add
internal notes; transition `NEW → OPEN → WAITING → RESOLVED → CLOSED`. A `Notification` row
is queued on creation so email acknowledgement is a driver swap later.

---

## 12. Admin dashboard

Brief §29's cards come from aggregate queries, not table scans in application code: total
sales, B2C sales, B2B sales, order count, pending orders, pending RFQs, customers, B2B
customers, low stock. Charts: sales over time, B2C vs B2B, top products, top categories.

Money aggregates use `SUM()` returning numeric, converted once at the boundary. Low stock
is `available <= lowStockThreshold`. Each aggregate is an integration test against seeded
fixtures with known totals, because a dashboard that quietly reports the wrong revenue is
worse than one that fails.

---

## 13. Security

Each control below is paired with a test in the plan. "No security breach" is a
verification target, not an aspiration.

**Reviewed row by row on 2026-08-27 (Milestone 10, Task 4), against the code as built.** This
table was written before most of the service existed, and nine of its twenty-three rows were wrong.
Every correction is marked `**Corrected 2026-08-27:**` inside the cell it changes. Every row —
corrected or not — now carries the **file and line** of the test that measures it, so the next
reader can check a claim in one `sed` rather than trusting the prose; the two rows that still name
no test — `Denial of inventory (placement)` and `SQL injection` — say so, and say why. Rows are
corrected in place rather than deleted, because the wrong ones were being trusted: *a row claiming
a control that was never built is worse than an empty row.* Two earlier instances of exactly that
had already been found in this codebase — `Setting.isPublic`'s docblock referenced a `GET /settings`
that did not then exist, and `audit-log.entity.ts` named an `AuditInterceptor` that was never
written — and the `Fake "Verified Purchase"` row below turned out to be a third.

**The table below is one table.** An earlier revision had a long prose block wedged between the
`Untraceable admin action` row and the `Internal detail leakage` row, which split it into two in
every Markdown renderer and left the last five rows with no header. That block is now after the
table, rewritten, because what it said about `AuditInterceptor` had gone stale.

| Risk | Control | Test |
|---|---|---|
| **IDOR** — reading another customer's order, address, RFQ or ticket | Every query filtered by session `userId` at the repository, never by route param alone | User B receives 404 for user A's order (`orders.integration.spec.ts:877`), address (`addresses.integration.spec.ts:445`, `:622`, `:667`) and RFQ (`rfqs.integration.spec.ts:288`) — each asserting the withheld row is *indistinguishable* from one that never existed, never a 403. **Corrected 2026-08-27: strike "or ticket".** There is no customer-facing read of a support ticket to attack. `SupportTicketsController` is `@Controller('contact')` carrying one `@Public()` `POST`; every ticket *read* lives on `@Controller('admin/support/tickets')` behind `@Roles(ADMIN)`. The ticket clause named a test that cannot exist, and would have to be re-earned the day a "my enquiries" route lands |
| Price / total tampering | Server recomputes subtotal, GST, shipping, discount and total from the database; ~~client-supplied money is ignored entirely~~ **client-supplied money cannot be sent at all — see the Test column** | **Corrected 2026-08-27: not "ignored" — refused, which is stronger, and the row understated it.** `PlaceOrderDto` (`checkout/dto/place-order.dto.ts`) declares no money field of any kind — no total, no subtotal, no line prices — so with the global pipe's `forbidNonWhitelisted: true` a body carrying one is a **400 naming the offending property, and no order is written**, not a 201 at the correct price. `checkout.integration.spec.ts:1365` posts `totalPaise` and asserts exactly that, including `countOrders() === 0`. The recompute itself is `CheckoutService.place` (`checkout.service.ts:212-235`), summing GST per line rather than over the aggregate |
| Quantity / MOQ bypass | Server enforces `moq`, `moqKg` and available stock in `verdictFor`, and `CheckoutService.refuseBrokenLines` turns any refusing verdict into a 422 (`BELOW_MOQ`) or 409 (`OUT_OF_STOCK`) before an order number is allocated | Sub-MOQ rejected at `cart-read.service.spec.ts:54`, `:156` and `checkout.service.spec.ts:608`; over-stock rejected over the wire at `checkout.integration.spec.ts:1240`, which also asserts nothing at all is written |
| Coupon abuse | Usage limits counted inside the order transaction; unique `(couponId, orderId)` (`coupon-redemption.entity.ts:24`) | Concurrent redemptions of a single-use coupon yield one success — `checkout-concurrency.integration.spec.ts:799`, racing an inserted row whose `usageLimit` is 1 rather than a hoped-for seeded code |
| XSS → account takeover | Session never readable by JS (httpOnly); no token in localStorage | Cookie flags asserted on the login response — `auth.integration.spec.ts:130`, which pins `HttpOnly` on both session cookies *and* its absence on the CSRF cookie, since that one has to be readable for the double-submit to work at all. The no-localStorage half is enforced in the front-ends and was re-verified there on 2026-08-27: zero `localStorage`/`sessionStorage` occurrences in `nutwala-admin`, and the only `document.cookie` read is the `nn_csrf` value |
| CSRF | `SameSite` + double-submit token verified by `CsrfGuard` | State-changing request without the header is rejected — `CSRF_TOKEN_INVALID`, e.g. `addresses.integration.spec.ts:383`. **Corrected 2026-08-27: the flag is `sameSite: 'lax'`, not `strict`,** and deliberately (`cookie-options.ts:20-23`): a customer arriving from a search result or a WhatsApp link must still find the basket they built. `lax` still withholds the cookie from a cross-site `POST`, so the double-submit token is not carrying the whole defence alone — but this row should not be read as claiming `strict` |
| Session theft / no revocation | Server-side `Session`, refresh rotation with reuse detection, real logout | Reused refresh token revokes the family — `auth.integration.spec.ts:483` and `sessions.integration.spec.ts:192`, with `:212` covering the case where revoking the family itself fails and the refusal must still be a 401 |
| User enumeration (login) | Identical response and equalised timing for unknown email vs wrong password vs deactivated account. The unknown-email branch pays a real bcrypt cost against a dummy hash (`auth.service.ts:37`) rather than returning early | All three paths return the same body and status — `auth.integration.spec.ts:250`, `:306`. The timing half is measured, not asserted by inspection: `password.service.spec.ts:69-80` samples both durations |
| Denial of inventory (placement) | **Open, and named here because nobody chose it.** `POST /checkout/orders` is `@Public()` — guest checkout is deliberate — and carries no `@Throttle()`, so it inherits the global `{ ttl: 60s, limit: 120 }`: roughly 120 COD orders a minute from one IP, each decrementing `onHand`, writing a ledger row and creating an order somebody must cancel, with the visible effect of a shop showing SOLD OUT to real customers. CSRF costs an attacker one extra `GET`. **Corrected 2026-08-27: this is now an accepted risk, not outstanding work.** Decided by the client on 2026-08-27: document, do not mitigate. The asymmetry the row already noted has since sharpened — placement is now the *only* public write on the service without a route throttle. `POST /auth/register` has 3/hour, `POST /auth/login` 5/15min, `POST /rfqs` and `POST /rfqs/gifting` 5/hour, `POST /contact` 5/hour, review submission 5/hour; placement, the one that spends stock, has 120/minute by default. Mitigation stays a business call: a tight per-IP rule is riskier than it looks, because carrier-grade NAT is ordinary on Indian mobile networks and one egress IP legitimately carries many customers, while the alternatives — a cap on guest order value or quantity, or requiring sign-in for checkout — each cost something brief §12 asks for. Recorded in full as `docs/known-issues.md` item 3 | Nothing asserts a limit on placement, and nothing is meant to. `checkout.integration.spec.ts` places dozens of orders per run and a route throttle would have to be cleared in a `beforeEach`, so a test here would measure the clearing, not the cap |
| User enumeration (register) | **Not closed in this phase — accepted and documented.** `POST /auth/register` answers 409 `EMAIL_IN_USE` on a taken address, and leaks by timing regardless of wording: the duplicate path returns straight after the lookup while a new account pays a bcrypt cost-10 hash. Mitigated only by the strictest rate limit on the API, 3/hour per IP (`auth.controller.ts:70`) — **and see the note on `trust proxy` below the table, because that limit is per `req.ip` and does not survive an unconfigured proxy** | A taken address returns 409 — `auth.integration.spec.ts:221` — asserted as current behaviour, not as a control |
| Brute force | `@nestjs/throttler` with a shared store, 5 per 15 minutes on login (`auth.controller.ts:87`). **Per `req.ip`; see the `trust proxy` note below the table** | 6th login attempt returns 429 — `auth.integration.spec.ts:387` asserts the whole sequence `[401,401,401,401,401,429,429]`, and `:393` records that a 429 carries **no `code`**, so a client branching on `code` alone is blind to throttling and must branch on `status` |
| Enumeration via `Error.stack` (development only) | `GlobalExceptionFilter` emits `stack` **only** when `app.env === 'development'`, so production responses are byte-identical | Measured: the two login failure branches throw from different lines, so a dev response discriminates them by line number — a far stronger signal than timing. Fail-closed by construction, but **never run a staging or demo box on `NODE_ENV=development`**, or the equalisation work is undone by a stack trace. **Corrected 2026-08-27: this row and `Internal detail leakage` both named a test that did not exist.** `GlobalExceptionFilter` had no spec file at all, in 1,206 unit and 761 integration cases, and both branches were unreachable besides — every suite pins `NODE_ENV = 'test'`. Now `global-exception.filter.spec.ts` (commit `f9a2f6a`), which pins the **whole key list** with `toEqual` over `Object.keys().sort()` rather than `not.toHaveProperty('stack')`, so a second internal field added later fails it too |
| Privilege escalation | `RolesGuard` on every admin route; role never read from a client-supplied field, only from the signed token (`roles.guard.ts`) | `CUSTOMER` session receives 403 on all admin routes — verified over the wire in all 16 admin controllers' specs, *and* structurally by `admin-routes-guarded.integration.spec.ts`, which walks Nest's own `ModulesContainer` rather than a hand-maintained roster and fails if any discovered `admin/*` route resolves to anything but exactly `[UserRole.ADMIN]`. That test exists because `RolesGuard` **fails open**: no `@Roles()` means `true`, so a controller that loses the decorator is silently opened to every authenticated customer. Its non-vacuity was re-proved on 2026-08-27 by deleting the decorator from `AdminSettingsController` — two cases went red and both named that controller by class, verb and path — and restoring it |
| Mass assignment | `forbidNonWhitelisted: true` plus explicit field allowlists in services — never `save(req.body)` | Posting `role` or `isActive` to profile update is rejected — `profile.integration.spec.ts:364`, a table covering `email`, `role`, `isActive`, `passwordHash` and `id`, each asserting both the 400 *and* that the database row is byte-identical afterwards. `:394` adds the observable half of refusing `isActive`: the account can still sign in |
| Fake "Verified Purchase" | ~~Server sets it only after finding a `DELIVERED` order for that user containing that product~~ **Corrected 2026-08-27: this control was never built.** `ReviewsService.create` hardcodes `verifiedPurchase: false` (`reviews.service.ts:157`). The docblock above it promises a "real lookup against delivered orders in the checkout plan"; orders shipped in Milestone 5 and the lookup was never written. Nothing in `backend/src` derives the flag — the only `true` values in the database are fixture literals in `content.seed.ts`. So no customer can earn the badge however much they buy, and the seeded demo rows display it unearned. **This is fail-closed and not a vulnerability** — the abuse the row exists to prevent is impossible because the flag is a constant — but it is a missing feature the storefront renders, and closing it is product work, not security work | **Corrected 2026-08-27: rejected, not ignored.** `CreateReviewDto` does not declare `verifiedPurchase`, so `forbidNonWhitelisted` makes a client-supplied `verifiedPurchase: true` a 400 with the field named — `catalog.integration.spec.ts:656`, whose title says so in as many words. Nothing tests the derivation, because there is no derivation |
| Unmoderated review exposure | Public endpoints return `APPROVED` only, **and only for a published product** | A `PENDING` review is absent from the public response — `catalog.integration.spec.ts:587`, `:624`, `:728`. The published-product half was a real leak until commit `94a6ddf`: `listForProduct` and `summaryForProduct` did not filter on `products.isPublished`, so an admin withdrawing a product from sale withdrew nothing — an anonymous caller kept getting every approved review and a live rating average for a slug the catalogue answers 404 for. Now covered by three cases in `admin-reviews.integration.spec.ts` asserting the withdrawn answer *equals* the unknown-slug answer, so the fix cannot be a differently-shaped oracle |
| SQL injection | TypeORM parameterised queries; raw SQL only where a lock or an aggregate needs it, always parameterised | — (no test claimed, and the row is honest about it). Re-read on 2026-08-27: six `.query()` sites outside migrations and seeds, every one either a constant (`SELECT 1`) or `$1`-parameterised; all 35 `orderBy`/`addOrderBy` calls take literal column strings, so no user-controlled sort key reaches SQL; the only interpolations into a `where` are the module constants `KG_PRICE`/`KG_PRICE_SELECT_ALIAS` in `catalog.service.ts`, whose bind values go through `:minPrice`/`:maxPrice` |
| Untraceable admin action | `AuditLog` row per admin mutation, written by `AuditLogService.record` inside the mutation's own transaction. **Corrected 2026-08-27: not "via `AuditInterceptor`" — that class was never written, and the design deliberately went the other way.** A request-scoped interceptor cannot be atomic with the write it describes; an explicit call inside the transaction can, so a rolled-back mutation leaves no trail and a recorded trail cannot describe a mutation that did not commit. The cost of the choice is that coverage rests on each new service remembering the call, with no discovery test equivalent to `admin-routes-guarded` | A product edit writes an audit row with before/after — `admin-products.integration.spec.ts:325`, and two cases assert the converse: `:358` for a patch that changes nothing, `:314` for a write that is refused. **Coverage counted on 2026-08-27: 29 of the 30 admin mutation routes write an `audit_logs` row.** The exception is `PATCH /admin/inventory/:variantId`, whose trail is the append-only `inventory_transactions` ledger carrying `actorUserId`, `delta`, `reason` and `balanceAfter` in the same transaction — documented at `AuditAction.INVENTORY_UPDATE` and asserted in `inventory.integration.spec.ts`. Two limitations the trail does not advertise: `ip` and `userAgent` are always null (`admin-audit-logs.service.ts:40`), and stock movements are absent from `GET /admin/audit-logs` by design |
| Internal detail leakage | `GlobalExceptionFilter` strips stack and driver errors in production | Production-mode response contains no stack. **Corrected 2026-08-27: see the `Error.stack` row — this test did not exist until `global-exception.filter.spec.ts` (commit `f9a2f6a`), and the assertion is a whole-key-list comparison rather than the absence of one field** |
| PII in logs | Recursive winston redactor over a shared field-name list | Logging a payload with a password emits `[REDACTED]` — `pii-redactor.spec.ts`, which also covers the guest-token cookie names, and `global-exception.filter.spec.ts` now asserts `redact()` is actually applied to the logged body and query rather than merely existing |
| Secret leakage | `.env` gitignored (including `backend/.env`, matched by the root `.gitignore:47`), `.env.example` placeholders only, zod env schema throws at boot | Boot without `JWT_SECRET` fails fast — `env.schema.spec.ts:36`, which asserts every missing variable is named at once rather than only the first. **Strengthened 2026-08-27 (commit `2a9b843`):** the placeholder-credential assertions were gated on `NODE_ENV`, which defaults to `development`, and `load-env.ts` applies dotenv with `override: true` — so a `.env` copied from `.env.example`, whose first line is `NODE_ENV=development`, beat platform-injected variables and booted with every production assertion skipped, including the check for the publicly known placeholder JWT signing key. The checks are now unconditional (`env.schema.spec.ts:152`, `:158`, `:169`, `:175`) |
| Payload flooding | 1 MB JSON limit (`app.module.ts:54`), pagination caps, review body length caps (20–2,000 characters, plus 500 on `imageUrl`) | Oversized payload rejected — `request-pipeline.integration.spec.ts:103` asserts 413 *inside the error envelope*, which is the part that only works because `preservingStatus()` rewraps body-parser's own error. Pagination caps are `MAX_LIMIT = 60`, tested at `admin-inventory.integration.spec.ts:423` and `admin-orders.integration.spec.ts:350`. **Corrected 2026-08-27: "pagination caps" does not hold for three public reads.** `GET /catalog/products/:slug/reviews` and `.../reviews/summary` (`reviews.service.ts:87-113`) and `GET /content/posts` (`content.service.ts:49`) call `find` with no `take`, so each returns every matching row. Unbounded rather than unbounded-and-cheap: a review row can carry 2,000 characters of body, so an anonymous caller doing one cheap `GET` receives a response that grows with the review count, 120 times a minute. Left open deliberately — every fix is a decision this review is not entitled to take: the wire type is a bare array, so paginating it changes the public contract and the storefront with it, and a silent `take` hides older reviews from customers. Recorded in `docs/known-issues.md` |
| Guest order-detail leakage | Order tracking requires an authenticated owning session; `OrdersController` carries no `@Public()` at all | Anonymous fetch of a valid order number returns 401 — `orders.integration.spec.ts:900`, with `:719` asserting the list route answers 401 rather than `200 []` and that a guest cart token is not an identity |

`helmet` supplies security headers; CORS is an explicit allowlist from env, credentialed —
never `*`, which cannot be combined with cookies anyway. Swagger and its JSON are behind
`express-basic-auth`, never exposed unauthenticated (`main.ts:64-70`).

### `trust proxy` is unset, and two rows above depend on it

`ThrottlerGuard` tracks by `req.ip`. `main.ts:43-49` deliberately does **not** call
`app.set('trust proxy', …)`, and records why: with nothing in front of the service, trusting
`X-Forwarded-For` would let any client claim a fresh IP per request and skip throttling entirely,
which is the worse of the two failures. But the moment a proxy, load balancer or CDN *is* in front
and this is still unset, every request reports the proxy's address, and every per-IP limit —
login's 5/15min, registration's 3/hour, `/contact`'s and `/rfqs`'s 5/hour, and the global
120/minute — collapses into one bucket shared by all callers. That is a self-inflicted denial of
service on legitimate customers, and it silently voids the only mitigation the
**User enumeration (register)** row claims. It must be set to match whatever ends up in front of
the service, before first deployment. Nothing tests this, and nothing can until the topology exists.

### `AuditInterceptor`: recorded as of Plan 2, resolved differently

The paragraph that used to sit inside the table said `AuditInterceptor` did not exist, that
`audit_logs` held 0 rows, that `PATCH /admin/inventory/:variantId` was a live admin-only mutation
with no audit test, and that "the interceptor should land **before**" Milestone 5's and Milestone 9's
write paths.

**All of that is now stale, and the last sentence never came true.** The interceptor was never
written. Milestone 9 built `AuditLogService` instead and called it explicitly from every admin
write, inside each write's own transaction — see the `Untraceable admin action` row for why that is
better rather than merely different, and for the 29-of-30 coverage count and the two limitations it
carries. The inventory mutation's own traceability argument still stands and is now the documented
reason it is the one exception: its `inventory_transactions` row carries `actorUserId`, `delta`,
`reason` and `balanceAfter`, written in the same transaction and asserted in the integration suite.

The general lesson is worth keeping, because this section produced three instances of it: **naming
the mechanism in a spec is a claim about code, and it decays.** `AuditInterceptor` here,
`Setting.isPublic`'s reference to a then-nonexistent `GET /settings`, and the
`Fake "Verified Purchase"` row's `DELIVERED` lookup were all read as descriptions of the system by
later readers. Prefer naming the *property* in the Control column and the *file and line* in the
Test column, which is what the corrected rows above now do.

---

## 14. Testing strategy

Four layers. Business rules that involve money, stock or authorization are **test-first**
(superpowers TDD); presentational admin screens are verification-only, consistent with the
Phase 1 plan's stated philosophy.

**Unit (Jest, `*.spec.ts` beside the source)** — `money.ts`, tier resolution, cart totals,
coupon arithmetic, the order-status machine, pincode rules, `readingMinutes`, the PII
redactor. Pure functions, no database. TDD.

**Integration (Jest, testcontainers `postgres:15-alpine`, `maxWorkers: 1`)** — real HTTP
through supertest against a real database with the real migration chain applied,
TRUNCATE CASCADE between tests, `test/factories/*.factory.ts` in CUG's
`createTestX(overrides)` style. Every endpoint, every security control in §13, the
concurrency tests in §10.2, and the ledger-consistency invariant. TDD for anything
rule-bearing.

**Frontend (Vitest)** — the existing suite keeps passing with the seam pointed at a mocked
`fetch`. `routes.smoke.test.tsx` and `routes.coverage.test.tsx` are updated, not discarded.

**E2E (Playwright, `e2e/`)** — real browser, real backend, real Postgres, seeded to a known
state. The journeys the user asked for, end to end:

1. **Customer purchase** — home → shop → filter → product → pick pack size → add to cart →
   cart drawer → checkout → register/login → fill address → pincode check → COD → order
   confirmed with a real order number → `/account/orders/$id` shows the tracking timeline.
2. **Admin fulfilment** — admin login → dashboard shows the new order → `/admin/orders`
   lists it → open it → advance `confirmed → processing → packed → shipped → delivered` →
   record COD collected → customer's tracking page reflects every step.
3. **Sold-out** — admin sets a variant's stock to 1 → customer buys it → storefront shows
   **SOLD OUT** on that pack while other packs stay buyable → Add to Cart disabled →
   `/admin/inventory` shows zero available and the ledger shows the `SALE` row.
4. **Support query** — customer submits the contact form → gets a ticket number →
   `/admin/support` shows the ticket with topic and linked order → admin adds a note and
   resolves it.
5. **Authorization** — a signed-in customer navigating to `/admin` is refused, and a direct
   `/api/v1/admin/orders` call with their session returns 403.
6. **B2B** — bulk catalog → quantity crosses a tier → price recalculates → bulk cart → RFQ
   submitted with a real `RFQ-2026-NNNNNN` → visible in `/admin/rfqs` → admin adds an
   internal note and sends a quote.

---

## 15. Observability and operations

winston with the AsyncLocalStorage request context both existing services use: every line
carries `service`, `environment`, `requestId`, `correlationId`, and is PII-redacted. CUG's
"flow logging" and flow-visualiser machinery is **not** ported — it is substantial
infrastructure serving a multi-lender orchestration problem this service does not have.

`GET /health` reports process and database liveness. `docker-compose.yml` provides
`postgres:15-alpine` for development on 5432 and a separate database for tests, so the
suite never touches development data. Deployment stays the org's tarball + PM2 pattern;
`ecosystem.config.js` matches CUG's.

---

## 16. Milestones

Each ends green: migrations applied, tests passing, committed.

| # | Milestone | Delivers |
|---|---|---|
| 0 | Foundation | Workspaces, `shared/` with TDD `money.ts` and migrated constants, docker-compose Postgres, NestJS skeleton, zod env, winston, exception filter, transform interceptor, `/health`, Swagger, Jest ×3 configs, testcontainers harness |
| 1 | Schema | All 33 entities, the full migration chain, and a seeder porting `src/mocks/` verbatim: 27 products (216 variants, so 216 `Inventory` rows), 12 categories, 6 combos, 8 blog posts, 14 reviews, 3 RFQs, 6 orders, 3 addresses and 3 fixture users |
| 2 | Auth | Register, login, logout, refresh rotation, `/auth/me`, sessions, RBAC, CSRF, throttling, helmet. Frontend `AuthProvider` rewired. Every §13 auth control tested |
| 3 | Catalog read | Products, categories, combos, filters, sort, pagination, public reviews, `available`/`soldOut`. Frontend catalog + shop + product + combos rewired; SOLD OUT live |
| 4 | Cart & inventory | Server cart, guest merge, validate, `Inventory`, ledger, admin adjust. Frontend `CartProvider` sync |
| 4b | Wishlist | **Added during Plan 2.** `WishlistItem`, save/unsave, merge on sign-in, `/wishlist`. Placed here rather than later because it needs the *same* machinery as the cart — one anonymous-visitor key and one merge on sign-in — so doing it beside the cart reuses that, while deferring it means deriving it again and probably differently. Brief §8 puts a wishlist heart on the product card, and Phase 1 shipped it backed by `useState`, which forgot on every navigation |
| 5 | Checkout & orders | COD placement, race-safe decrement, idempotency, coupons, pincode rules, order creation. Frontend checkout + order success rewired |
| 6 | Account & tracking | Orders list/detail/timeline, cancel, addresses, profile — all IDOR-scoped. Frontend account area rewired |
| 7 | B2B | Business profile, pricing tiers with segment resolution, bulk catalog, bulk cart, RFQ, gifting. Frontend business area rewired |
| 8 | Content, support, settings | Blog, support tickets, `Setting`-backed configuration, notification persistence. Frontend contact + blog + settings rewired |
| 9 | Admin panel | Dashboard, products, categories, inventory, orders, customers, businesses, RFQs, pricing, coupons, reviews, blog, support, settings, audit log — 18 routes, in a **separate application and repository** (§7.1), plus the 27 `@Roles(ADMIN)` endpoints of §6.4. Distributing `@nutwala/shared` to that repo is an early task of its plan, not an afterthought |
| 10 | E2E & hardening | The six Playwright journeys, `/security-review` pass, remediation, README and runbook |

---

## 16.1 A correction to the Phase 1 seed count

The Phase 1 spec §10 states 26 seeded products. The actual figure in
`frontend/src/mocks/products.ts` is **27** — the seed array carries both `corporate-gift-box`
and `festive-gift-box` on top of the 25 the count assumed. The seeder ports what exists, not
what the earlier spec claimed, and every product yields 8 variants (4 retail packs + 4 bulk),
giving 216 `ProductVariant` and 216 `Inventory` rows.

## 17. Definition of done

1. `npm run build` passes in `shared`, `backend` and `frontend` with `strict: true`.
2. `npm run lint` and `npm run format:check` pass in every workspace.
3. Backend unit and integration suites pass; integration runs the real migration chain.
4. The frontend Vitest suite passes with `src/mocks/` deleted.
5. All six Playwright journeys pass against a real backend and database.
6. Every control in §13 has a passing test.
7. `SUM(inventory_transactions.delta) == inventory.on_hand` holds for every variant.
8. Concurrent purchase of the last unit yields exactly one order.
9. No route outside `/admin/*` is reachable by an unauthenticated request that should be
   authorized, and no `/admin/*` API route is reachable by a `CUSTOMER` session.
10. `git grep` finds no secret, no hardcoded WhatsApp number, and no certification claim
    outside a seeded `Setting`.
11. A fresh clone reaches a working store via `docker compose up`, `npm ci`,
    `npm run migration:run`, `npm run seed`, `npm run dev`.
