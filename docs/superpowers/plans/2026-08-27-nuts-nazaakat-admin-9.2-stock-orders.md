# Admin Console Plan 9.2 — Stock & Orders

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. **Ticking the checkboxes is not the record of completion — commits
> are.** Every prior milestone left them unticked; the git log is what told the next session what
> had been done.

**Goal:** Give the operator the stock and order surfaces: what is on hand, why it moved, which
orders exist, and the three writes that move an order forward.

**Covers:** backend design spec §6.4 rows 7 and 9–12, plus the `lowStockThreshold` gap plan 9.1
carried forward. **8 route handlers.**

---

## Facts verified against the code on 2026-08-27 — do not re-derive these

Plan 9.1 shipped with six errors because parts of it were written from memory. These were checked:

1. **Integration tests live at `backend/test/integration/*.integration.spec.ts`.** Nothing else
   runs: the unit config roots at `<rootDir>/src`, the integration config roots at
   `<rootDir>/test/integration` **and** requires the `.integration.spec.ts` suffix. A file outside
   both is invisible to every config — 9.1's guard test was nearly written that way.
2. **Orders are addressed by `orderNumber`, never a uuid.** `OrdersController` uses
   `@Get(':orderNumber')` and `@Post(':orderNumber/cancel')`. §6.4 spells these `:id`; that is the
   same spelling drift the spec already records for `PATCH /admin/inventory/:variantId`. **Use
   `:orderNumber`** and note it in the commit so §6.4 can be corrected.
3. **`OrderStatusService.transition(orderNumber, to, options)` opens its own transaction**
   (`this.dataSource.transaction(...)`). It is not given one. This matters — see Task 3.
4. **`TransitionOptions` already carries `actorUserId`, `note`, and a restock flag** for the
   `refunded` path that is deliberately never defaulted to `true`. Read its docblock before adding
   anything to it.
5. **Order status vocabularies live in `shared/src/constants/order-status.ts`** and are the single
   source of truth — the frontend re-exports them, it does not redeclare them. B2C is brief §33's
   nine; B2B is brief §33's eight. **Neither list may be extended by this plan.**
6. **`InventoryService` exposes exactly one public method, `adjust(input)`.** Reads are not there
   yet; Task 1 adds them.
7. **A route with a literal path segment must be declared above any `:param` sibling**, or the
   pattern swallows it. `OrdersController` carries this warning in two places.

## Conventions you are bound by

- **`@Roles(UserRole.ADMIN)` at class level**, carrying the **database enum**. The token carries
  `ADMIN`, an auth body carries `admin` — **`@Roles('admin')` compiles and refuses every admin.**
- **`@ApiTags('admin')`** on every admin controller.
- **`actorUserId` assigned after the DTO spread**, so no body field can override the audit "who".
- **A second controller** alongside the public one, never mixed scopes in one class.
- **`backend/test/integration/admin-routes-guarded.integration.spec.ts` must keep passing** and must
  **discover** your new routes. It compares roles metadata as raw `string[]` on purpose — **do not
  narrow it to `UserRole`**, or `@Roles('admin')` reads as `[]`, which `RolesGuard` treats as open.
- **`AuditLogService.record(manager, input)` takes the caller's open transaction.** Unlike
  `NotificationsService.queue`, a failed audit write **must fail the operation**.
- **Every admin write records an audit row in the same transaction as the change.** A write that
  changes nothing writes no row (plan 9.1's rule, including for idempotent calls).
- **Deletes are hard deletes refused with `409 ENTITY_IN_USE` when referenced** — spec §5a. Nothing
  in this plan deletes, but stay consistent if you find yourself wanting to.
- Money stays in paise (spec §8). No `any` / `as any` / `@ts-ignore` / `eslint-disable`.
- Do not weaken an existing test's assertions. Setup changes for a real new precondition are fine.
- Touch no frontend file.
- **Do not run root `npm run build`** — `nest-cli.json` sets `deleteOutDir: true` and a
  long-running `nest start --watch` holds `backend/dist`. Use `npm run typecheck -w backend`.

---

## Task 1: `GET /admin/inventory`

`AdminInventoryController` — or extend the existing `InventoryController`, which is already
`@Controller('admin/inventory')`; decide and say why.

- [ ] Spec §6.4 asks for **current / reserved / available / low / out**. Spec §12 defines low as
      `available <= threshold`, which **deliberately disagrees** with `checkLowStock`'s strict `<`
      at exactly the threshold — card versus event. Plan 9.1 asserted both ends so the discrepancy
      is on the record; keep it, and do not "fix" one to match the other.
- [ ] Computed in SQL, not by loading rows and reducing in JS. `GET /business/stats` and
      `GET /admin/dashboard` are the precedents.
- [ ] Paginated and filterable, at minimum by low/out — an operator opens this page to find what
      needs ordering, not to read 216 rows.
- [ ] §14's E2E journey 3 depends on this endpoint. It is owed, not optional.
- [ ] Integration test against seeded stock, including a variant at exactly the threshold.
- [ ] Commit — `feat(admin): GET /admin/inventory, computed in SQL`

## Task 2: `GET /admin/inventory/:variantId/transactions` and the threshold gap

- [ ] The ledger read: paginated, newest first, each row carrying delta, reason, resulting balance,
      timestamp and actor. `inventory_transactions` already holds all of it.
- [ ] **The threshold gap plan 9.1 carried forward.** §6.4 exposes no way to change
      `lowStockThreshold` on an existing variant — the adjust route takes only `delta` + `reason`,
      and `GET /admin/inventory` is a read, so today a threshold is unchangeable once a variant
      exists. Add one. `PATCH /admin/inventory/:variantId/threshold` keeps it distinct from a stock
      movement, which is the point: a threshold change writes no ledger row, because no stock moved.
      **It must still write an audit row.** State the chosen shape in the commit; §6.4 will need the
      row added.
- [ ] A threshold change that crosses the low-stock boundary is a real case — decide whether it
      queues `stock.low` and say why. `checkLowStock` is driven by a stock `delta`, and a threshold
      move has none, so this is a genuine judgment call, not a lookup.
- [ ] Commit — `feat(admin): the stock ledger read, and a way to change a threshold`

## Task 3: `POST /admin/orders/:orderNumber/status`

The route `OrderStatusService` was built for. Milestone 8 gave `RfqStatusService` the same shape and
left it routeless for exactly this milestone.

- [ ] **The transaction problem, stated plainly.** `transition` opens its own transaction, and
      `AuditLogService.record` must write inside the *same* one as the change. So the audit call
      cannot sit in the controller around `transition` — that would commit the audit row separately
      from the status change, which spec §5a rejects for exactly the reason it gives. Resolve it by
      writing the audit inside `transition`, or by giving `transition` an optional manager. **Decide,
      implement, and explain the choice in the commit message.** Do not leave the write outside.
- [ ] Illegal transitions already answer `422 ILLEGAL_STATUS_TRANSITION` carrying `allowed`. Do not
      re-implement that; assert it still holds through the new route.
- [ ] The restock flag on the `refunded` path is never defaulted to `true` — read its docblock and
      require it explicitly from the admin DTO rather than inferring it.
- [ ] A B2B order must accept only B2B statuses and a retail order only retail ones. Assert both
      refusals; the vocabularies are per-channel and both live in `shared/`.
- [ ] Commit — `feat(admin): POST /admin/orders/:orderNumber/status, audited in the same transaction`

## Task 4: `GET /admin/orders` and `GET /admin/orders/:orderNumber`

- [ ] Brief §33's list columns are normative: Order ID, Customer, B2C/B2B, Amount, Payment, Status,
      Date. Filterable by status, channel and date range; paginated.
- [ ] **Route ordering: `@Get()` for the list, `@Get(':orderNumber')` for the detail.** If you add
      any literal segment later it must be declared above the param route (verified fact 7).
- [ ] The detail returns items, totals, address, timeline and payment state — everything
      `/account/orders/:orderNumber` returns, plus the customer identity a customer's own view omits.
      Reuse the existing mapper rather than writing a second shape.
- [ ] Commit — `feat(admin): order list and detail`

## Task 5: `POST /admin/orders/:orderNumber/payment/collect`

- [ ] COD collection. Spec §10.4 covers COD; read it first.
- [ ] Idempotent: collecting twice must not double-count. Assert it, and per plan 9.1's rule the
      second call writes **no** audit row because nothing changed.
- [ ] Commit — `feat(admin): COD collection, idempotent`

## Task 6: `POST /admin/orders/:orderNumber/shipment`

- [ ] Creates a `Shipment` row — the entity exists from the initial schema; read it before designing
      the DTO.
- [ ] Decide whether creating a shipment also transitions the order to `shipped`, or whether those
      stay two deliberate acts. Either is defensible; **say which and why**. If it does transition,
      it must go through `OrderStatusService` rather than writing `status` directly, or the timeline
      and the notification hook are both bypassed.
- [ ] Commit — `feat(admin): shipment creation`

---

## Task 7: Plan 9.2 verification

- [ ] `npm run test -w @nutwala/shared` — expect 71
- [ ] `npm run test -w backend` — expect ≥ 978, report the total
- [ ] `npm run test -w frontend` — expect 266, unchanged
- [ ] `npm run test:integration` — expect ≥ 474, report the total. Reads
      `backend/test-results/integration.json` rather than scrolling. **Note a filtered run
      overwrites that file** — the full-suite report is only valid straight after a full run.
- [ ] `npm run typecheck -w backend`, `npm run lint -w backend`, `npm run format:check -w backend`
- [ ] Guard test passes **and** its discovered admin-route count grew by your new handlers
- [ ] Mutation-test, one at a time, reverting by re-editing and confirming `git diff --stat` empty
      between each — the discipline that corrupted files twice in Milestone 7 when skipped:
      1. move the audit write in Task 3 outside `transition`'s transaction → a test asserting no
         audit row survives a rolled-back transition must fail
      2. make Task 5's collection non-idempotent → the double-collect test must fail
      3. drop the per-channel status check in Task 3 → a B2B-status-on-a-retail-order test must fail
- [ ] `docs/known-issues.md` item 1 has now been seen three times, most recently as a **401** rather
      than a 400. If it appears, capture the reported response body — `expectStatus` prints it — and
      append the sighting.
- [ ] Append a "Plan 9.2 complete" record: counts, mutation results marking any that only
      integration could kill, and everywhere this plan turned out wrong or needed a judgment call.
- [ ] Commit — `docs(admin): Plan 9.2 complete — verification record`
