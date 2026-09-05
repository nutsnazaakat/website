# Milestone 11 — Code Quality, Structure, and Making the Content Dynamic

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.**

**Requested by the user 2026-08-27**, to run **after Milestone 10**. Four pieces, in this order,
because each depends on the previous one's findings.

---

## Task 1 — Code quality and file structure

**The user's ask, verbatim in effect:** no single file should be carrying 5–6k lines; things should
be split across files with proper engineering and a structure that scales.

**Measured on 2026-08-27, so this task starts from facts rather than a hunt.** Nothing is anywhere
near 5–6k lines. The largest *production* files are:

| Repo | File | Lines |
|---|---|---|
| backend | `shared/src/types/admin.ts` | 945 |
| backend | `modules/checkout/checkout.service.ts` | 890 |
| backend | `database/migrations/20260819120000-InitialSchema.ts` | 737 |
| backend | `database/seeds/catalog.seed.ts` | 723 |
| backend | `modules/catalog/admin-products.service.ts` | 547 |
| client | `features/checkout/components/CheckoutForm.tsx` | 913 |
| client | `components/ui/sidebar.tsx` | 744 (vendored shadcn — leave it) |
| admin | `routes/_console/pricing/index.tsx` | 496 |
| admin | `features/products/variant-editor.tsx` | 475 |
| admin | `features/coupons/coupon-form.tsx` | 470 |

The largest files overall are **tests**: `routes.smoke.test.tsx` at 2,895, and four backend
integration specs between 1,136 and 1,768.

- [ ] **Judge each candidate on responsibility, not line count.** A 900-line file doing one thing
      well is better than three 300-line files that must be read together. `checkout.service.ts` is
      the one to look at hardest — it owns placement, stock decrement, idempotency and the
      notification hook, which may genuinely be several responsibilities.
- [ ] **`shared/src/types/admin.ts` (945) is a barrel of wire types**, appended to by four plans. It
      is a plausible split by domain (`admin/orders.ts`, `admin/catalog.ts`, …) **but it is a
      published contract consumed by three repos** — a split changes import paths in all of them and
      requires re-vendoring. Cost it before doing it, and say why either way.
- [ ] **Do not split the vendored `components/ui/sidebar.tsx`.** It is shadcn's own file; keeping it
      diffable against upstream is worth more than its line count.
- [ ] **Do not split migrations.** `InitialSchema` is a historical record; it is long because it
      creates 33 tables, and rewriting it invalidates every applied migration checksum.
- [ ] **The large test files are worth splitting** — `routes.smoke.test.tsx` at 2,895 lines is the
      single hardest file in the project to navigate, and it is the one a future contributor will
      open most. Split by feature area, keeping every assertion.
- [ ] Run `/code-review` at high effort over each repo's diff-to-date and act on what it finds.
- [ ] **A refactor with no behaviour change must not change a single test's assertions.** If a test
      needs editing to accommodate a split, that is a signal the split changed behaviour.
- [ ] Commit per split, one file at a time, with the full suite green between each.

## Task 2 — What the storefront still hardcodes, and making it dynamic

**Measured 2026-08-27.** The client reads a **static** `src/config/settings.ts` and **nothing reads
`GET /settings`** — which plan 9.4 built specifically for this. So all fourteen fields are hardcoded
at build time today: `brandName`, `tagline`, `whatsappNumber`, `supportEmail`, `supportPhone`,
`freeShippingThreshold`, `bulkPromptThresholdGrams`, `codEnabled`, `onlinePaymentEnabled`, `gstin`,
`fssaiLicence`, `certifications`, `social`, `addressLines`.

Ten route files also carry hardcoded content arrays: `index.tsx`, `bulk.$category.tsx`,
`gifting.tsx`, `quality.tsx`, `about.tsx`, `bulk-orders.tsx`, `faq.tsx`, `business/route.tsx`,
`account/route.tsx`, and `features/catalog/components/SearchDialog.tsx`.

- [ ] **Wire `config/settings.ts` to `GET /settings`.** This is the highest-value item in the
      milestone: it is what lets the business change its own WhatsApp number, contact details and
      certifications without a deploy, and the admin screen to do it already exists.
- [ ] **A setting must not become a loading flicker.** These values render in the header and footer
      on every page. Decide how the app behaves before the first answer — a sensible build-time
      default that the fetch corrects is probably right; an empty header is not.
- [ ] **`certifications` is the one to be careful with.** Brief §26 forbids unsupported claims, so
      an *empty* list must render nothing rather than a placeholder, and the current deliberate
      emptiness must survive the change. There is already a test pinning this; keep it passing.
- [ ] **Triage the ten content arrays; do not migrate them all.** For each, ask who would change it
      and how often. FAQ questions and the quality journey are plausible editor content. Navigation
      groups and `account/route.tsx`'s sidebar are structure, not content, and moving them to the
      database buys nothing and costs a round trip. **Report the triage before implementing it.**
- [ ] Anything genuinely editor-owned needs a backend home, an admin screen, and a public read —
      **that is Task 4's scope**, not this one. Task 2 ends with the settings wiring plus a written
      triage.
- [ ] Commit — `feat(settings): the storefront reads its settings from the server`

## Task 3 — Can the admin portal actually control everything that is dynamic?

The inverse audit: for every dynamic thing, is there a screen for it?

- [ ] Enumerate every table and every settings key the storefront reads, and check each against the
      console's 22 routes. Produce a table: **thing → is it editable → where**.
- [ ] **Four known gaps already, from the backend plans** — verify and include them:
      - `PATCH /admin/businesses/:id` does not exist, so `businesses.segment` (brief §31's price
        band) and `assigned_salesperson_id` are **read-only in the console**.
      - **Nothing enumerates operator accounts**, so RFQ and ticket assignment can only offer
        "assign to me"; another operator's assignment renders with no name.
      - `PATCH /admin/shipments/:id` does not exist, so a late airway bill has nowhere to go, and
        a second dispatch cannot be recorded.
      - `catalog.seed.ts` warns that its ownership of product images and pricing tiers "expires the
        moment admin product-editing ships" — which it has. **Re-running the seeder would destroy
        hand-edited images and tiers**, and neither table has a unique key, so a real upsert is not
        expressible. This is a live footgun, not a hypothetical.
- [ ] For each gap: state whether it is worth an endpoint, and if so, whether it belongs here or in
      a later milestone. **Do not build all four by reflex** — a screen nobody asked for is cost.
- [ ] Commit — `docs(admin): what the console can and cannot change`

## Task 4 — Build the gaps worth building

Scoped by Task 3's findings, not guessed in advance. Expect this to be smaller than it looks.

- [ ] Whatever Task 3 justified: endpoint, admin screen, public read, tests at every layer.
- [ ] **The seeder footgun is the one thing here that is not optional.** Either make the seeder
      refuse to overwrite admin-edited rows, or make it explicit and loud that it is destructive.
      Silently destroying a merchandiser's work is worse than any missing screen.
- [ ] Commit per gap closed.

---

## Ordering, and why

Task 1 first because a refactor is cheapest before more code lands on top. Task 2 second because it
is the highest-value single change in the milestone and it is already unblocked. Task 3 third
because it is an audit and audits are worthless before the thing they audit has settled. Task 4 last
because its scope is Task 3's output.

**Nothing here is a new feature.** Every item is either structure, or connecting something already
built at both ends but not in the middle.

---

## Task 1 — measurement and verdicts (2026-08-27)

Measured across all three repos, excluding `node_modules`, `dist`, vendored
`components/ui/`, the initial migration, `routeTree.gen.ts`, and tests.

**Nothing is remotely near the 5–6k lines the client asked about.** Largest
production file: **945**. Largest file of any kind: a test at **2,916**. So
Task 1 is not a line-count exercise; each candidate is judged on whether one
file or one function holds more than one responsibility.

### Refactor — `CheckoutForm.tsx` (913 lines, one 777-line component)

The whole file holds **4 top-level declarations**. `CheckoutForm()` spans
lines 136–913. Inside it: ~180 lines of hooks/queries/mutations, then six
`<Section>` blocks — Contact 43, Delivery Address 96, **Business Details 321**,
Coupon 56, Shipping 28, Payment 184.

A React component has no ordering constraint between its JSX sections, so
extraction makes the structure *visible* rather than hiding it. Split into
`sections/{Contact,Address,Business,Coupon,Shipping,Payment}Section.tsx` plus
`useCheckoutForm.ts`, leaving `CheckoutForm.tsx` as a composition root.
Pass `form` down as a typed prop — **not** `FormProvider`/`useFormContext`,
which trades a compile-time error for a runtime one.

### Do NOT refactor — `checkout.service.ts` (890 lines, `place()` is 257)

`place()` is long because it is **one `dataSource.transaction`**, and almost
every step carries a comment explaining why *its position in the sequence*
matters: the basket is emptied last so a failed placement does not lose it,
the notification is queued inside the same transaction for the same reason,
the order number is allocated only after every refusal has had its chance.

The reusable parts are already extracted — `assess`, `bill`, `honouredCoupon`,
`shippingFor`, `decrementStock`, `redeem`, `sell`, `couponBasket`,
`refuseBrokenLines`, `toOrderItem` are all private methods. What is left is the
linear spine. Breaking that spine into private methods that each take `manager`
would lower the line count while making the ordering constraints — the actual
complexity — invisible across seven call sites. **Left as one readable
sequence, deliberately.**

### Do NOT refactor — the 945-line contract barrel

`admin.ts` is pure `interface`/`type` declarations: no branching, no logic,
read top-to-bottom. It also exists as **three** byte-identical copies
(backend `shared/src/`, both front-ends' `src/contract/`) reconciled by
`.source-sha` and `contract:check`, so splitting it means changing the sync
script and the sha basis in three repos to buy nothing.

### Split — the large test files

`routes.smoke.test.tsx` at **2,916** is the largest file in the project. Split
by route group. The three integration specs (orders 1,768 / checkout 1,765 /
admin-orders 1,437) are next, and splitting them also buys parallelism the
single-worker integration run currently cannot use.

### Flag, do not act — `LOVABLE REFERENCE /` is committed to `nutwala-client`

**74 files**, including a 744-line `sidebar.tsx`. `tsconfig.app.json` includes
only `src`, so none of it is compiled, linted, or shipped — it is inert. But it
is the design source of truth, it is preserved in git history either way, and
the folder name carries a trailing space. Left in place; the client decides
whether it moves to `docs/`.

## Task 2 — findings (2026-08-27)

### The endpoint exists; its contract type is the blocker

`GET /settings` is built and `@Public()` (`settings.controller.ts`), and
`publicSettings()` returns every `isPublic: true` row keyed by name. But the
contract declares:

```ts
export type PublicSettings = Record<string, unknown>;
```

That offers **no** compile-time safety, so wiring the storefront to it today
would replace 14 typed constants with 14 unchecked casts — worse than the
status quo, because a renamed key would surface at runtime instead of in `tsc`.
**Giving `PublicSettings` a real shape is therefore a prerequisite**, not a
nicety, and it must be added in backend `shared/src` and re-vendored to both
front-ends via `contract:check`.

### The mapping is 1:1, so there is no guesswork

The seeded public keys are exactly `SiteSettings`' 14 fields —
`brandName`, `tagline`, `whatsappNumber`, `supportEmail`, `supportPhone`,
`freeShippingThreshold`, `bulkPromptThresholdGrams`, `gstin`, `fssaiLicence`,
`certifications`, `social`, `addressLines`, `codEnabled`,
`onlinePaymentEnabled` — plus a 15th, `flatShippingRate`, the client has no
field for. Two further rows are `isPublic: false` and stay server-side.

### Static values become the fallback, not the source

Every page needs settings: `brandName` in each `useSeo` title,
`freeShippingThreshold` in cart maths and the progress bar. A failed
`GET /settings` must therefore not blank the storefront. The current constants
stay as the fallback and the fetched values win when present. Two consequences
worth stating plainly:

- The **empty** certification fields are load-bearing. `gstin`, `fssaiLicence`
  and `certifications` are empty precisely because brief §25/§26 forbid
  unsupported claims, and badges render only once real numbers are configured.
  The fallback must keep them empty — never seeded with placeholder numbers.
- `settings.ts`'s docblock is now **stale**: it says `Setting.isPublic` "is read
  by no route in `backend/src`, so there is no endpoint to call and building one
  is Milestone 8's work". The route now exists. Fix the comment with the wiring.

### Task 2 scope addition — the blog is the last mock-backed feature

Found during Milestone 10's documentation pass, **not** by the settings audit
above, which only looked at `config/settings.ts`. Measured across the storefront:

```
server  src/features/{account,auth,business,cart,catalog,checkout,contact,reviews,rfq,wishlist}/api
MOCKS   src/features/content/api/index.ts     <- imports `posts` from "@/mocks/posts"
```

**Ten of eleven feature APIs read the server. `content` is the one that never
switched over** (`src/features/content/api/index.ts:2`).

The backend side is finished and waiting: `content.controller.ts` serves spec
§6.1's three `/content/posts` routes, `blog_posts` was seeded with eight posts in
Milestone 3, and the controller's own docblock records that **nothing ever
consumed it**.

This is worse than the settings gap, and in a different way. Settings are
*stale* — a real value exists in the database and the storefront shows a
build-time constant instead. The blog is a **round trip that silently goes
nowhere**: the admin console's `/blog` screens create, edit and publish posts
into `blog_posts`, the writes succeed, the console shows them saved — and the
storefront renders eight hardcoded mock posts regardless. An admin can publish
an article, see it listed in the console, open the storefront, and not find it.
Nothing reports an error at any point.

Wiring it is one file (`features/content/api/index.ts`) plus the removal of
`src/mocks/posts.ts`, and it is the highest-value item in Task 2 despite
`settings` being the one originally scoped. Do it first.

**Check the mock/server shape agreement before deleting the mock.** The mock has
never been type-checked against the wire response, and `src/mocks/*` is fenced
off by an oxlint `no-restricted-imports` boundary everywhere *except* inside
`features/*/api/`, so nothing has ever forced the two shapes to match.
