# Admin Console Plan 9.6a — Shell, Auth and the First Two Screens

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.**

**Goal:** Make the admin console real — an operator can sign in, be refused if they are not an
admin, and use two screens end to end against the live API. Establish every pattern the remaining
sixteen routes will copy.

**Repository:** `~/Desktop/nutwala-admin` (scaffolded, contract vendored). **Not** the backend repo.

**Why 9.6 is split:** eighteen routes against 41 admin endpoints is more than one plan's worth, and
the first two screens are where every decision gets made — the http client, auth, the layout, the
table/detail/form patterns, error and empty states. Getting those right once is worth more than
sixteen screens built three different ways. Plan 9.6b builds the rest against whatever this settles.

---

## Facts verified against the code on 2026-08-27

1. **`~/Desktop/nutwala-admin` is a bare Vite scaffold**: `App.tsx`, `main.tsx`, `assets/`,
   `src/contract/` (vendored, with `.source-sha` and `contract:check`), `src/test/setup.ts`.
   Dependencies for TanStack Router/Query, Tailwind v4, react-hook-form, zod, sonner, lucide and
   oxlint are installed. Vite is on **:5174**, proxying `/api` to the backend on **:4400**.
2. **41 admin routes are live**, across 15 controllers: `admin/audit-logs`, `businesses`,
   `categories`, `coupons`, `customers`, `dashboard`, `inventory`, `orders`, `posts`,
   `pricing-tiers`, `products`, `reviews`, `rfqs`, `settings`, `variants`.
3. **Auth is cookie-based with CSRF.** The cookie is `nn_csrf`, echoed on state-changing methods as
   `X-CSRF-Token`. `nutwala-client/src/lib/http.ts` (272 lines) implements it, including a
   401-refresh-and-retry with three deliberate exclusions (`/auth/refresh`, `/auth/login`,
   `/auth/register`) and a documented reason for each.
4. **`nutwala-client/src/components/ui/` holds 46 shadcn primitives** already styled against the
   project's design tokens.
5. **`ApiRequestError` carries `status` and an optional `code`.** A **429 carries no `code`** —
   `ThrottlerException` is not a `DomainError` — so rate limiting must be detected by
   `status === 429`. This is documented in the client's own `http.ts` and has bitten before.
6. **Authorisation is the server's.** `RolesGuard` refuses a non-admin regardless of what this app
   believes; route guards here are UX only.

## The three decisions this plan makes, and why

**1. Copy `lib/http.ts` from the client, do not rewrite it.**
It encodes security behaviour — CSRF echo, which 401s may retry, why a logout that fails to revoke
leaves a 30-day refresh cookie valid. A rewrite invites divergence in exactly the places where
divergence is a vulnerability rather than a bug. **Strip what the admin cannot use** (anything
cart-, wishlist- or storefront-specific) and note in the commit what was removed and why.

**2. Copy the shadcn primitives you actually use, not all 46.**
Copying is shadcn's own distribution model, so this is not a workaround. But copy them *as needed*:
an unused primitive is code nobody reviews carrying a dependency nobody wanted.

**3. This is an operator tool and should look like one.**
Reuse the design tokens so the two apps are recognisably one product, but do not copy the
storefront's editorial layout. An admin screen is dense, table-first, and optimised for a person
who will look at it for six hours. State what you chose in the commit.

## Hard rules

- **Authorisation is the server's.** Guard routes on `role === "admin"` for UX; never treat a
  client-side check as security.
- **No `any` / `as any` / `@ts-ignore` / `eslint-disable`.**
- **Never redeclare a contract type.** `src/contract/` is the copy; import from it. A second
  definition is how repos drift while both still compile.
- **Money on the wire is RUPEES, not paise.**
  > **Corrected 2026-08-27 during execution.** This plan originally said "paise on the wire" and it
  > is wrong. Spec §8 stores every monetary column as `bigint` paise, but the mappers call
  > `toRupees` at the boundary — `shared/src/types/admin.ts`'s own header says *"Money is rupees,
  > per spec §8: the server converts from paise"*, and the live service returns `total: 1020.85`.
  > Calling `toRupees` in this app would have divided by 100 **twice**: a 100× error on every figure
  > an operator reads, on the screen they use to decide what to refund. Caught by the 9.6a agent
  > before any code was written.
  >
  > The admin design spec's §5 line "Money stays in paise" is about **backend storage** and reads as
  > the opposite when quoted out of context, which is how this error was made. Render wire numbers
  > directly; convert nothing.
- Do not touch `nutwala-backend` or `nutwala-client`.
- Commit per task.

---

## Task 1: The HTTP client and the API seam

- [ ] Copy and trim `lib/http.ts`. Keep the CSRF handling, the envelope unwrapping, `ApiRequestError`
      with `status` **and** `code`, and the 401-refresh with its three exclusions.
- [ ] Port its tests too. A copied security-critical file with no tests is worse than a rewrite,
      because it looks trustworthy.
- [ ] `src/features/*/api/` modules, mirroring the backend's grouping. **Every screen reads through
      one**, exactly as the client does — that seam is what let the client swap mocks for the real
      API without touching a component.
- [ ] Commit — `feat(http): the API client, trimmed from the storefront's`

## Task 2: Auth, and being refused

- [ ] `POST /auth/login` → session cookie. `AuthProvider` exposing `user`, `role`, `login`, `logout`.
- [ ] **A non-admin who signs in here must be refused with an explanation, not a blank screen.**
      They may hold a perfectly valid customer session; the server will simply 403 every admin call.
      Say so.
- [ ] A route guard redirecting to `/login?redirect=…`, and a 403 handler that does not log the
      user out — a 403 means *this account cannot*, not *your session expired*.
- [ ] Tests: a b2c fixture is refused, an admin fixture reaches `/`, the redirect param survives.
- [ ] Commit — `feat(auth): sign-in, and an honest refusal for non-admins`

## Task 3: The shell

- [ ] TanStack Router file-based routing. **Use a directory when a path has children** —
      `orders/index.tsx` + `orders/$id.tsx`, never `orders.tsx` beside `orders.$id.tsx`. The
      backend repo hit that trap three times: without an `<Outlet />` the child renders **blank**,
      no error, and the route still resolves, so a test asserting "the route loaded" passes against
      an empty page.
- [ ] Sidebar navigation covering all 18 routes, with the sixteen unbuilt ones visibly disabled or
      marked — an operator clicking into a blank page learns nothing.
- [ ] A layout with the signed-in admin's identity and a sign-out.
- [ ] Commit — `feat(shell): routing, navigation and layout`

## Task 4: `/` — the dashboard

`GET /admin/dashboard` is live and computed in SQL. Brief §29's nine cards and four charts.

- [ ] Cards: Total Sales, B2C Sales, B2B Sales, Orders, Pending Orders, Pending RFQs, Customers,
      B2B Customers, Low Stock.
- [ ] Charts: sales over time, B2C vs B2B, top products, top categories.
- [ ] **The dates are in the business's timezone**, not UTC — plan 9.4 made that a setting and
      applied it server-side. Do not re-derive or re-format dates in a way that undoes it.
- [ ] Loading, error and empty states. An empty database must render zeroes, not `NaN` or a spinner
      that never resolves.
- [ ] Commit — `feat(dashboard): brief §29's cards and charts`

## Task 5: `/orders` and `/orders/$id`

The densest screen, and the one that proves the table and detail patterns.

- [ ] List: brief §33's columns — Order ID, Customer, B2C/B2B, Amount, Payment, Status, Date.
      Filter by status, channel and date range; paginate. **Filters belong in the URL**, so a link
      to a filtered view is shareable and the back button works.
- [ ] Detail: items, totals, address, timeline, payment state.
- [ ] **The three writes**: status transition, COD collection, shipment creation. An illegal
      transition answers **422 carrying `allowed`** — render that, do not just say "failed". The
      server already tells the operator exactly which statuses are legal from here.
- [ ] **A COD collection is idempotent server-side**; the UI should not pretend a second click did
      something.
- [ ] Commit — `feat(orders): the list, the detail, and the three writes`

---

## Task 6: Plan 9.6a verification

- [ ] `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` — report all four
- [ ] `npm run contract:check` — the vendored contract must be current
- [ ] **Prove the routes render.** Mount the real router and assert content **inside** each route,
      not merely that it resolved — the blank-child trap above. Curl proves nothing: Vite's dev
      server returns 200 for any path.
- [ ] Run against the **live backend** (`npm run dev -w backend` in the other repo, Docker up) and
      confirm sign-in, the dashboard and an order status change actually work. A mocked test suite
      that has never spoken to the real API is not evidence.
- [ ] Append a "Plan 9.6a complete" record: what the shell settled, and everywhere this plan was
      wrong or needed a judgment call.
- [ ] Commit — `docs(admin): Plan 9.6a complete — verification record`

---

## Known gap, for 9.6b

**`PATCH /admin/businesses/:id` does not exist in §6.4**, so `businesses.segment` — brief §31's
price band — and `businesses.assigned_salesperson_id` have **no writer at all**. The RFQ side gained
both in plan 9.3. The businesses screen can read them and not edit them; say so on the screen rather
than rendering an input that cannot save.
