# Admin Console Plan 9.6b — The Remaining Fifteen Screens

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.**

**Goal:** Finish the console. Fifteen screens, against endpoints that are all live and integration-
tested.

**Repository:** `~/Desktop/nutwala-admin`. **Not** the backend repo.

**Prerequisite:** plan 9.6a, which settled every pattern this plan copies. Read its code before
writing any — the point of 9.6a was that these fifteen do not each invent their own answer.

---

## What 9.6a settled — copy it, do not redesign it

```
src/routes/_console.tsx        the guarded layout: auth check, sidebar, sign-out
src/routes/_console/           every admin screen lives here
  index.tsx                    the dashboard
  orders/                      a directory, because the path has children
src/features/<domain>/api/     one module per domain; every screen reads through one
src/components/ui/             primitives, copied from the storefront AS NEEDED (4 so far)
src/components/page.tsx        the page frame
src/components/status-badge.tsx
```

Established conventions, all load-bearing:

- **Money on the wire is RUPEES.** The server converts from paise at the mapper boundary; the
  contract's own header says so. **Convert nothing** — calling `toRupees` divides by 100 a second
  time, and 9.6a's plan got this wrong before an agent caught it.
- **A path with children needs a directory** — `rfqs/index.tsx` + `rfqs/$id.tsx`, never
  `rfqs.tsx` beside `rfqs.$id.tsx`. Without an `<Outlet />` the child renders **blank**, no error,
  and the route still resolves.
- **`search.strict` must be set** — TanStack defaults it to `false`, so `validateSearch` can only
  add to the query string, never remove. An unknown param reaches the API and earns a 400 under
  `forbidNonWhitelisted`.
- **Filters live in the URL**, so a filtered view is shareable and the back button works.
- **A 429 carries no `code`** — detect rate limiting by `status === 429`.
- **A 403 must not sign the user out.** It means *this account cannot*, not *your session expired*.
- **Four status tones, not seventeen colours.** The question a table answers is "does this row need
  me?"
- **No new dependencies.** Charts are hand-drawn; controls are native.
- Authorisation is the server's; guards here are UX only.

## Hard rules

- **Never redeclare a contract type.** Import from `src/contract/`.
- **No `any` / `as any` / `@ts-ignore` / `eslint-disable`.**
- Do not modify `nutwala-backend` or `nutwala-client`. Read them freely.
- Commit per screen or per coherent pair.

---

## Group A — catalogue and stock (6 screens)

### Task A1: `/products`, `/products/new`, `/products/$id`
`GET/POST/PATCH/DELETE /admin/products`, publish/unpublish, and the variant routes.

- [ ] The list **includes unpublished products** — that is the point of the admin view.
- [ ] **A delete refused with `409 ENTITY_IN_USE` is the normal case**, not an error to hide: a
      product with stock ledger history cannot be deleted, and the server says which. Render the
      reason and offer unpublish, which is the non-destructive operation.
- [ ] Variants are edited on the product detail. **`lowStockThreshold` is settable only at variant
      creation** — plan 9.2 added `PATCH /admin/inventory/:variantId/threshold` for changing it
      later, which belongs on the inventory screen, not here. Do not render an input that cannot save.
- [ ] Commit — `feat(products): list, detail, and the create/edit flow`

### Task A2: `/categories`
`GET/POST/PATCH /admin/categories`. **There is no delete route and none should be added.**

- [ ] Unpublishing a category hides its tile but **not** its products — decided by the user and
      pinned by a backend test. Say so on the screen; an operator who expects a bulk withdrawal and
      gets a hidden menu entry has been misled.
- [ ] Commit — `feat(categories): list, create and edit`

### Task A3: `/inventory`
`GET /admin/inventory`, `GET /admin/inventory/:variantId/transactions`,
`PATCH /admin/inventory/:variantId` (adjust), `PATCH /admin/inventory/:variantId/threshold`.

- [ ] The operator opens this to find what needs ordering: default to the low/out filter.
- [ ] The ledger read is the audit trail for stock — **`GET /admin/audit-logs` deliberately shows
      no stock movements**. If the operator can reach both, say which answers what.
- [ ] An adjustment requires a reason. A threshold change writes **no** ledger row, because no stock
      moved; it does write an audit row.
- [ ] Commit — `feat(inventory): stock levels, adjustments and the ledger`

### Task A4: `/pricing`
`GET/POST/PATCH /admin/pricing-tiers`. Brief §31.

- [ ] Tiers are per product **and segment** (DEFAULT / RETAILER / DISTRIBUTOR / HORECA), with a
      nullable `businessId` for customer-specific pricing.
- [ ] **An overlapping tier is refused `409 PRICING_TIER_OVERLAP`.** Two rows covering one quantity
      make the resolver's answer depend on row order, and the resolved rate is snapshotted onto
      order items — a money disagreement, not a display one. Render which existing tier collided.
- [ ] Commit — `feat(pricing): tier management with overlap refusal surfaced`

---

## Group B — people, content and operations (9 screens)

### Task B1: `/customers`
`GET /admin/customers`, `/:id`. Brief §35.

- [ ] Total spend **excludes cancelled and refunded**, matching the dashboard and the customer's own
      account view. Label it so nobody reconciles two different numbers.
- [ ] Commit — `feat(customers): list and detail`

### Task B2: `/businesses`
`GET /admin/businesses`, `/:id`.

- [ ] **`PATCH /admin/businesses/:id` does not exist.** `businesses.segment` (brief §31's price
      band) and `assigned_salesperson_id` are readable and **not editable**. Say so on the screen
      rather than rendering an input that cannot save. This is a real §6.4 gap, recorded in plan 9.3.
- [ ] Commit — `feat(businesses): list and detail, with the read-only fields marked`

### Task B3: `/rfqs`, `/rfqs/$id`
`GET /admin/rfqs`, `/:rfqNumber`, `PATCH /:rfqNumber`, `POST /:rfqNumber/notes`.

- [ ] **Two kinds of notes, and they must not be confused.** `notes` is the *prospect's own*
      "additional requirements" from the public form and is shown back to them on their enquiry
      page. `internalNotes` is the sales trail and is private. Label both; never write a sales note
      into the customer-visible field.
- [ ] An illegal status transition answers **422 carrying `allowed`** — render those, do not just
      say "failed".
- [ ] Expected value and assigned salesperson are editable here (unlike on businesses).
- [ ] Commit — `feat(rfqs): the queue, the detail, and the sales trail`

### Task B4: `/coupons`
`GET/POST/PATCH/DELETE /admin/coupons`. Brief §36.

- [ ] **Addressed by `code`, and the code is immutable** — three things key on it: the order
      snapshot, the audit trail, and this URL.
- [ ] **Deleting a redeemed coupon is refused `409 ENTITY_IN_USE`** — `coupon_redemptions` is
      `ON DELETE RESTRICT` so redemption history survives. Surface the reason.
- [ ] A past expiry is **allowed** (it ends a campaign at a stated moment); a usage limit below
      current usage is refused, because it would kill the coupon silently behind a 200.
- [ ] Commit — `feat(coupons): CRUD with the refusals surfaced`

### Task B5: `/reviews`
`GET /admin/reviews`, `POST /:id/approve`, `POST /:id/reject`. Brief §27.

- [ ] Default to the `PENDING` queue — that is what this page is for.
- [ ] Approving makes it visible on the storefront; rejecting does not.
- [ ] Commit — `feat(reviews): the moderation queue`

### Task B6: `/blog`
`GET/POST/PATCH/DELETE /admin/posts`. Brief §28, §39.

- [ ] The admin list includes unpublished posts; the public one does not.
- [ ] **A published post's slug may change and the old URL 404s** — there is no redirect table.
      Warn before saving a slug change on a published post.
- [ ] Commit — `feat(blog): post management`

### Task B7: `/support`
`GET /admin/support/tickets`, `/:ticketNumber`, `PATCH`, `POST /:ticketNumber/notes`.

- [ ] Tickets arrive from the storefront contact form. Status, assignment, internal notes.
- [ ] Commit — `feat(support): the ticket queue and triage`

### Task B8: `/settings`
`GET/PUT /admin/settings`. Brief §26, §37.

- [ ] **This screen is what makes the storefront's empty contact details fillable** — WhatsApp
      number, support email, GSTIN, FSSAI, certifications are all deliberately empty because brief
      §26/§37 forbid inventing them. Say that on the screen: an empty field here means the
      storefront renders nothing, which is correct until someone types the real value.
- [ ] `business.timezone` drives every dated admin figure. Changing it changes the dashboard.
- [ ] Commit — `feat(settings): the values the storefront is waiting for`

### Task B9: audit log
`GET /admin/audit-logs`, reachable from the shell (§7.1's 18 routes do not name it a screen; put it
where it is useful).

- [ ] **Stock movements are deliberately absent** — the inventory ledger is their trail. Say so.
- [ ] Commit — `feat(audit): the admin trail`

---

## Task C: Plan 9.6b verification

- [ ] `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` — report all four
- [ ] `npm run contract:check`
- [ ] **Every one of the 18 routes mounted through the real router**, asserting content *inside*
      the route. Curl proves nothing — Vite returns 200 for any path.
- [ ] **Live run against the real backend**: sign in, and exercise at least one write on each of
      products, inventory, pricing, rfqs, coupons, reviews and settings. Report what you observed.
      `POST /auth/login` is 5/15min per IP, so sign in **once** and reuse the session.
- [ ] Append a "Plan 9.6b complete" record.
- [ ] Commit — `docs(admin): Plan 9.6b complete — verification record`
