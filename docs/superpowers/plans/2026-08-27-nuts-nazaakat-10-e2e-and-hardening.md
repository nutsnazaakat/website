# Milestone 10 — E2E, Security Review and Handover

> **For agentic workers:** superpowers:subagent-driven-development or executing-plans.
> **Ticking checkboxes is not the record of completion — commits are.**

**Goal:** Prove the three applications work together in a real browser, review what shipped for
security, and leave a README and runbook someone else can start from.

**Covers:** spec §14's six E2E journeys, §13's security table, and §15's operations notes.

---

## Facts verified against the code on 2026-08-27

1. **Playwright is not installed anywhere**, and no `e2e/` directory exists. The backend's root
   `package.json` declared an `e2e` workspace whose folder never existed; the split removed it.
   This milestone builds the harness from nothing.
2. **Three separate repositories**, side by side on `~/Desktop`:
   `nutwala-backend` (:4400, owns `docker-compose.yml`, migrations and seeds),
   `nutwala-client` (:5173), `nutwala-admin` (:5174).
3. **Integration tests already start their own Postgres testcontainer per run** on a random port.
   The `5442` container in `docker-compose.yml` is the **development** database. E2E needs a real,
   seeded, long-lived database, so it uses the dev one — and must therefore reseed rather than
   assume a state.
4. **`POST /auth/login` is throttled at 5 per 15 minutes per IP.** A suite that signs in per test
   rate-limits itself and reports failures that look like application bugs. Sign in once per role,
   reuse the session — Playwright's `storageState` is the mechanism.
5. **The orders seeder deletes and re-inserts** each order's items, events and payments, so reseed
   **before** a run, not after.
6. **Fixture accounts** are in the backend's seeder — read them there rather than guessing.

## Where the E2E suite lives, and why

**`nutwala-backend/e2e/`.** It is the only repo that owns the database, the migrations and the
seeds, and a journey is meaningless without a known seeded state. Playwright starts the two
front-ends from sibling directories, the same assumption `nutwala-client`'s `contract:sync` already
makes (`../nutwala-backend`, overridable by env var). Do the same here: default to `../nutwala-client`
and `../nutwala-admin`, overridable.

A fourth repository was considered and rejected — the user chose three, and a suite that cannot see
the seeder is a suite that cannot arrange its own preconditions.

---

## Task 1: The harness

- [ ] Playwright in `nutwala-backend`, config at `e2e/playwright.config.ts`.
- [ ] `webServer` entries starting all three: backend on :4400, client on :5173, admin on :5174.
      Reuse an already-running server rather than failing — a developer usually has one up.
- [ ] **A reseed step before the run**, not after (verified fact 5). A journey that inherits the
      previous run's mutated data is a journey that passes once.
- [ ] **`storageState` per role**, minted once (verified fact 4). Do not log in per test.
- [ ] Commit — `test(e2e): the Playwright harness, seeded and signed in once`

## Task 2: Journeys 1–3

- [ ] **1. Customer purchase** — home → shop → filter → product → pack size → add to cart → drawer
      → checkout → register/login → address → pincode → COD → **a real order number** →
      `/account/orders/$id` shows the timeline.
- [ ] **2. Admin fulfilment** — admin signs in → dashboard shows the new order → `/admin/orders`
      lists it → advance `confirmed → processing → packed → shipped → delivered` → record COD
      collected → **the customer's tracking page reflects every step**. This is the journey that
      proves the two apps share one truth; assert on the customer side, not just the admin side.
- [ ] **3. Sold-out** — admin sets a variant's stock to 1 → customer buys it → the storefront shows
      **SOLD OUT** on that pack **while other packs stay buyable** → Add to Cart disabled →
      `/admin/inventory` shows zero available **and the ledger shows the `SALE` row**.
- [ ] Commit — `test(e2e): purchase, fulfilment and sold-out`

## Task 3: Journeys 4–6

- [ ] **4. Support query** — contact form → ticket number → `/admin/support` shows it with topic
      and linked order → admin adds a note and resolves it.
- [ ] **5. Authorization** — a signed-in customer at `/admin` is refused, **and** a direct
      `/api/v1/admin/orders` call carrying their session returns **403**. Assert both: the UI
      refusal is UX, the 403 is the actual control.
- [ ] **6. B2B** — bulk catalogue → quantity crosses a tier → **the price recalculates** → bulk cart
      → RFQ submitted with a real `RFQ-2026-NNNNNN` → visible in `/admin/rfqs` → admin adds an
      internal note and sends a quote. **The internal note must not appear on the customer's own
      enquiry view** — two note fields exist and confusing them is a privacy bug.
- [ ] Commit — `test(e2e): support, authorization and B2B`

## Task 4: Security review

- [ ] Run the `/security-review` skill over the whole backend, then read spec §13's table and check
      each row against what actually shipped.
- [ ] **The unthrottled `POST /checkout/orders` stays open — the user decided on 2026-08-27 to
      document rather than mitigate it.** Do not add a throttle. Record it as a known, accepted
      risk in the README and in `docs/known-issues.md`, with the reasoning: mitigation is a business
      call, a tight per-IP rule is risky because carrier-grade NAT is ordinary on Indian mobile
      networks, and the alternatives (guest value caps, requiring sign-in) each cost something the
      brief asks for.
- [ ] Anything the review finds that is **not** a business call — a missing guard, a leaked field, an
      unescaped render — is a defect to fix here, with a test.
- [ ] Commit — `docs(security): the review, and what was accepted rather than fixed`

## Task 5: README and runbook

Three repos, and nobody but this project's authors knows how they fit.

- [ ] A README in **each** repo: what it is, what it depends on, how to run it, how to test it.
- [ ] **The backend's README carries the system view** — the three repos, the contract-vendoring
      arrangement and why (`contract:check`, `.source-sha`), the ports, and the fact that a fresh
      clone must build `shared` before anything typechecks (there is a `prepare` script, but say so).
- [ ] A runbook covering: bring the stack up from nothing, reseed, run each test layer, and what to
      do when the integration suite goes red (re-run once; the residual flake in
      `docs/known-issues.md` is ~1 in 11 full runs).
- [ ] **Do not invent deployment instructions.** Nothing has been deployed; a runbook that describes
      an imaginary production is worse than one that says "not yet deployed".
- [ ] Commit — `docs: READMEs and a runbook for the three repositories`

---

## Task 6: Milestone 10 verification

- [ ] All three repos: typecheck, lint, build, unit and integration suites — report every total.
- [ ] `npx playwright test` — all six journeys, reported individually.
- [ ] Each repo's `git status --short` empty.
- [ ] Append a "Milestone 10 complete" record: the counts, the security findings and which were
      accepted rather than fixed, and everywhere this plan was wrong.
- [ ] Commit — `docs: Milestone 10 complete — verification record`

---

# Milestone 10 complete — verification record

**Date:** 2026-08-27 · **Node** v24.11.1 · **npm** 11.6.2 · Postgres 15-alpine in Docker

Every figure below was run for this record, not carried forward.

## Counts

| Layer | Command | Result |
| --- | --- | --- |
| Contract | `npm run test -w @nutwala/shared` | **71 passed**, 6 files |
| Backend unit | `npm run test -w backend` | **1,234 passed**, 95 suites |
| Backend integration | `npm run test:integration` | **764 passed**, 39 suites, 0 failed — **on the second run**; see below |
| End to end | `npm run test:e2e` | **6 passed**, 1.5m |
| Storefront | `npm test` (client) | **339 passed**, 20 files |
| Console | `npm test` (admin) | **200 passed**, 13 files |

**2,608 tests across the three repositories** (71 + 1,234 + 764 + 339 + 200), plus the six browser journeys.

| Check | backend | client | admin |
| --- | --- | --- | --- |
| `typecheck` | exit 0 | exit 0 | exit 0 |
| `lint` | exit 0 — **2 warnings**, 0 errors | exit 0 — **91 warnings**, 0 errors | exit 0 — **1 warning**, 0 errors |
| `build` | exit 0 | exit 0 | exit 0 — 579 kB / 164 kB gzip |
| `contract:check` | n/a (owns it) | `current (backend moved, but shared/src did not)` | same |
| `git status --short` | empty | empty | empty |

`npm run typecheck:e2e` also exit 0 — the Playwright suite compiles under the same strictness.

**The lint numbers are three different baselines, not one.** The backend's 2 are known-issues item 2
(`rfq-status.integration.spec.ts:154,156`, unsafe `any`). The console's 1 is
`app/router.tsx` fast-refresh. The storefront's **91** are 77 `only-export-components` (TanStack
Router route files export both a `Route` and a component — the framework's own shape), 8
`set-state-in-effect`, 4 `incompatible-library`, 2 `purity`, and **22 of the 91 are in the tracked
`LOVABLE REFERENCE /` directory**, which is Phase-1 design reference, imported by nothing under
`src/`, and not in the build. Zero errors anywhere. This was never a "2-warning baseline" across all
three repositories; that figure is the backend's alone.

## The six journeys, individually

```
✓ 1 journey-3-sold-out.spec.ts — the last pack sells out, and only that pack            11.8s
✓ 2 journey-4-support.spec.ts — a support query becomes a ticket the desk works         7.8s
✓ 3 journey-5-authorization.spec.ts — a customer is shown the door, the server closes it 20.7s
✓ 4 journey-6-b2b.spec.ts — priced by slab, quoted by the desk, and the note the buyer
                             never sees                                                  8.2s
✓ 5 journeys-1-2 — Journey 1: a customer buys cashews and can track the order            6.4s
✓ 6 journeys-1-2 — Journey 2: the admin fulfils it and the customer sees every step      6.9s

6 passed (1.5m)
```

`global-setup` reseeded first (16 + 7 + 687 + 3 + 22 + 61 + 10 + 8 rows) and minted three
`storageState` sessions. Playwright started all three servers and stopped them; no process was left
listening on 4400, 5173 or 5174 afterwards.

## The integration suite went red once, and that is the documented flake

**Run 1: 763 passed, 1 failed, 39 suites. Run 2: 764 passed, 0 failed.** The runbook's own
instruction — re-run once, read `test-results/integration.json`, not the scrollback — was followed on
its first outing and worked.

The failure is a **third capture** of the residual in `docs/known-issues.md` item 1, now recorded
there:

```
settings.integration.spec.ts › PUT /admin/settings › writes no audit row for a key whose
value did not change    —    expected 200 "OK", got 401 "Unauthorized"
```

Its own `.expect(200)` on the login immediately before had passed, so the session was written and the
cookie issued; the very next request could not find the session. That is the *lost write* direction
of item 1's table, in a file with nothing to do with `checkout` — so the residual is confirmed not to
be checkout-specific. Frequency remains consistent with ~1 in 11 full runs (this makes 1 failure in
the last 2 runs, and 2 in the last 13 recorded).

## Security findings, and which were accepted rather than fixed

Task 4's review is recorded in `docs/known-issues.md` and in the §13 row-by-row verdict
(`6e3674c`, `ebf52ab`, `b8ad317`). Standing at the end of the milestone:

**Fixed, with tests:**

| Finding | Commit |
| --- | --- |
| Two fail-open environment gates | `2a9b843` |
| A withdrawn product still published its reviews | `94a6ddf` |
| `GlobalExceptionFilter` had no spec while §13 claimed two controls from it | `f9a2f6a` |

**Accepted rather than fixed — a decision, not a backlog:**

| Finding | Status |
| --- | --- |
| **`POST /checkout/orders` is unthrottled** (item 3) | **Accepted by the user, 2026-08-27.** Document, do not mitigate. Guest checkout is a brief requirement; carrier-grade NAT is ordinary on Indian mobile networks so a tight per-IP cap refuses genuine orders during exactly the traffic spike the shop wants; a guest value cap costs the bulk and gifting flows. **Do not add a throttle without a fresh decision.** |
| **`trust proxy` is unset** (item 5) | **Open, and unclosable now.** Correct today with nothing in front; the day a proxy appears and it is still unset, every per-IP limit collapses into one shared bucket. Nothing can test it until a topology exists, so it is a deployment-checklist item. Now in the runbook, which is the document someone reads before touching an environment. |
| **Three unpaginated public reads** (item 6) | **Open, deliberately.** `GET /catalog/products/:slug/reviews`, its `/summary`, `GET /content/posts`. Closing it is either a breaking change to a public wire type or a silent `take` that hides customers' own reviews — a product decision, not a security patch. |

**One new finding from this task, not security but the same shape** — a documented behaviour whose
premise expired: `npm run seed -- catalog` deletes and re-inserts `pricing_tiers`, and
`/admin/pricing` now writes to that table, so a reseed silently reverts an operator's slabs. The
seeder's own docblock predicted this ("expires the moment admin product-editing ships"). Now in the
runbook, with the two options its docblock names. **Not fixed here — a docs task does not add unique
indexes to two tables.**

## Everywhere this plan, or the docs, turned out to be wrong

1. **Task 6 says `npx playwright test`.** That does not work: there is no config at the repository
   root. The command is **`npm run test:e2e`**
   (`playwright test --config e2e/playwright.config.ts`).
2. **The briefing's "1,234 tests drop to 234 with `TS2307` everywhere" is false.** Measured, with
   `shared/dist` moved aside: `typecheck` fails with 170 `TS2307`, `build` fails with 141 errors,
   `lint` fails — and **`npm run test -w backend` passes 1,234 in 95 suites, unaffected**, because
   all three jest configs map `@nutwala/shared` to `../shared/src/index.ts`. The confusing signal is
   real but it is the *opposite* of the one described: the suites insist everything is fine while
   every type-checking command claims the codebase is destroyed. The README now carries the measured
   table.
3. **"There are no remotes on any of the three repos" is wrong for the backend.** It has an `origin`
   pointing at `/Users/kunal/Desktop/nutwala` — the dead monorepo, as a local path. `git push` here
   pushes into the rollback point. The client and admin genuinely have none.
4. **`shared/` is imported by 149 files under `backend/src`, not 119** (180 counting `backend/test`).
   The storefront's 44 was right; the console is 61.
5. **"Reseeding destroys admin-edited product images and pricing tiers" is half true.** Pricing tiers,
   yes. **Product images are not editable by any admin route** — `SaveProductDto` has no image field
   and nothing outside the seeder writes `product_images` — so the seeder still legitimately owns
   them. It becomes the identical footgun the day image editing ships.
6. **The backend README described the dead monorepo.** Three workspaces including a `frontend/` that
   is not in this repository, an `npm run dev` starting all three, `npm run test -w frontend`, and a
   seeder list naming six of the eight seeders (`coupons` and `rfqs` were missing). Rewritten.
7. **The storefront README was the unmodified Vite template.** Nothing about this application at all.
8. **The console README said the remaining fifteen routes were unbuilt**, "marked Soon" with no route
   files behind them. All fifteen shipped; there are 22 routes and `npm test` mounts every one.
9. **known-issues item 1 said "Full suite after the fix: 566 passed, 28 suites."** It is now 764 in
   39. The 1-in-11 rate it records still holds.
10. **`nutwala-client/src/config/settings.ts`'s docblock is stale**, as Milestone 11's Task 2 findings
    already note: it says `Setting.isPublic` "is read by no route in `backend/src`" and that building
    one is Milestone 8's work. `GET /settings` exists and is `@Public()`. Left for Milestone 11 to fix
    with the wiring.

## Left for someone else

Found while writing the docs, reported rather than fixed — this was a documentation task.

1. **The storefront's blog is still mock-backed.** `features/content/api/index.ts` is the one feature
   API of eleven never switched to the backend: it imports `src/mocks/posts.ts` and serves it through
   `src/lib/mock-client.ts`'s 220ms fake latency. So `GET /content/posts` has no consumer, and the
   console's `/blog` screen writes rows nothing renders. `mock-client.ts`'s docblock says "Phase 2
   deletes this file along with src/mocks/" — Phase 2 deleted nine tenths of it. Milestone 11
   territory; it is not in Task 2's findings, which are about `settings`.
2. **No notification has ever been delivered.** Seven templates are queued inside their caller's
   transaction and every one persists a `notifications` row with an `EMAIL` or `WHATSAPP` channel —
   but the only driver bound to `NOTIFICATION_DRIVER` is `LoggingNotificationDriver`, which writes a
   log line and **reports success**, so every row is marked `SENT`. The port is clean and swappable;
   nothing is plugged into it. In the runbook's deployment list.
3. **`CORS_ORIGINS` in `.env.example` lists only `http://localhost:5173`.** Harmless while the console
   reaches the API through its own Vite proxy, but anyone pointing a console build straight at `:4400`
   gets refused with no obvious cause. Worth a second origin in the template.
4. **`backend/jest.e2e.config.ts` and `backend/test/e2e/.gitkeep` are dead scaffolding.** The real
   E2E suite is Playwright at the repository root. `passWithNoTests: true` means
   `npm run test:e2e -w backend` prints "No tests found" and exits 0 — an empty directory reporting
   success, next to a root script with almost the same name. Delete both, or the next person runs the
   wrong one and believes it.
5. **The residual integration flake** (item 1) now has three captures and a narrowed hypothesis. The
   remaining unverified candidate is whether `app.close()` and `closeTestDataSource()` fully drain
   across the 39 files.

## Commits

| Repository | Commit |
| --- | --- |
| `nutwala-client` | `9484536` docs: a README for the storefront repository |
| `nutwala-admin` | `e2a706a` docs: bring the console README up to what shipped |
| `nutwala-backend` | `a989cf9` docs: READMEs and a runbook for the three repositories |

Milestone 10 is complete. Nothing has been deployed, and the runbook says so.
