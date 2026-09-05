# Known issues

Things that are wrong, understood only partly, and deliberately not fixed yet. Each entry says
what is known, what has been ruled out, and what it would take to close.

---

## 1. Integration-suite flake — dominant cause fixed 2026-08-27, a rare residual remains

**Status:** the connection-pool race is **fixed and measured**. A rarer, unexplained residual is
still open. A single red integration run is no longer expected, but is not yet impossible.

---

### The cause that was found and fixed

`useIntegrationApp` opens **two independent connection pools per spec file**: the test-side
`DataSource` that `cleanDatabase` truncates on, and the application's own through `TypeOrmModule`
that every request under test runs on. Nothing synchronised them, and the app's connections live
for the whole file — they are never drained between tests.

A request whose response had been sent but whose transaction had not yet committed therefore raced
the `TRUNCATE`, and **the race was resolvable in both directions**, which is what made the symptoms
look unrelated for so long:

| Direction | Symptom seen |
| --- | --- |
| App commit lands **after** the truncate | rows survive the clean — a test asserting an empty database saw `customers: 2` in a file that creates no such row |
| Contention with `TRUNCATE`'s `ACCESS EXCLUSIVE` lock | a write is lost — a session written moments earlier could not be found, and the next request answered **401** |

It was never reproducible in isolation because one file alone produces far less overlap, and the
failure rate rose with suite length because a longer run gives more in-flight work more cleaners to
collide with.

**The fix** (`3f8b0bb`): `cleanDatabase` now polls `pg_stat_activity` until no other client backend
on this database is mid-statement or mid-transaction, before truncating. `state <> 'idle'` covers
both hazards deliberately — `active` is a running statement, and `idle in transaction` is the worse
one: an open snapshot holding uncommitted rows, which reads as *not busy* to anything that checks
only for running queries. The 10s timeout throws with the offending pids and their queries rather
than truncating anyway; it has never fired.

**Measured, not asserted:**

| | Runs | Failures | Rate |
| --- | --- | --- | --- |
| Before | 4 | **5** | 1.25 / run |
| After | **11** | **1** | **0.09 / run** |
| After — most recent 8, consecutive | 8 | **0** | — |

A ~14× reduction. An earlier revision of this entry said the residual was "1 in 3 full runs"; that
was a three-run sample and too pessimistic. Eleven runs put it nearer **1 in 11**.

Neither signature symptom recurred in 1,523 tests. Per-suite times are unchanged (`orders`
18.75s → 19.58s) — a healthy run's first poll finds nothing, so the wait costs one query.

---

### A second cause found and fixed 2026-08-27 — colliding order numbers

Much of what looked like a mysterious residual was **test-factory order numbers colliding across
spec files**, and it is fixed (`1276270`).

`order.factory.ts` had `let sequence = 0` at module level. Jest hands every spec file a fresh
module registry regardless of `maxWorkers`, so all five order-creating files minted the identical
`NN-2026-900001`, `900002`, … Between tests that is invisible, because `cleanDatabase` truncates.
It stops being invisible the moment a row survives the clean: a later file's request then addresses
**another file's order**, with a different channel and status.

Two failures were diagnosed this way, and they had contradicted each other for hours:

| Test | Expected | Got | Why |
| --- | --- | --- | --- |
| refuses a B2B status on a retail order | 422 | **200** | its number resolved to a leftover *bulk* order at `quote-requested`, where `quote-sent` is legal |
| ships a B2B order, `processing → shipped` | 200 | **422** | its number resolved to a leftover *retail* order, where `processing → shipped` must go via `packed` |

Both files passed 58/58 in isolation throughout, which is what kept pointing away from the real
cause. The lesson worth keeping: **a wrong-verdict failure can be a leaked-row failure wearing a
costume.** When a state machine appears to misbehave only in a full run, check whether the
identifier under test is unique across files before suspecting the logic.

Fixed by moving the counter onto `globalThis`, which survives the registry reset — the integration
suite runs `--runInBand`, so one counter spans the whole run.

**Full suite after the fix: 566 passed, 28 suites, 0 failed.**

### What may still remain

The underlying row leak — a row surviving `cleanDatabase` — is what *exposed* the collision, and it
has not been independently disproved. It may itself have been the pool race already fixed, in which
case nothing remains. Treat the next unexplained failure as evidence and capture its body; do not
assume the suite is now perfect on two clean runs.

### The residual as originally recorded

One failure survives the fix, and it is a **different bug**:

- **Rare in isolation: 1 in 32 runs of `checkout.integration.spec.ts` alone** (~3%).
- **More frequent in the full suite: ~1 in 11 runs** — still more often than isolated, so it needs
  cross-file timing. Hunt the full suite, not the file. Note both figures are small samples; the
  honest statement is that it is rare and cross-file, not that either ratio is precise.
- **⚠️ Rate correction, 2026-08-27: the `1 in 11` figure is optimistic.** Four full runs were made
  that day, two of them red — Milestone 10's verification (run 1 red on `settings`, run 2 clean) and
  Milestone 11's (run 1 red on `checkout`'s idempotency test, run 2 clean). **2 of 4**, not 1 of 11.
  Four runs is a small sample too and the true rate is somewhere between the two figures, but the
  direction matters: this is frequent enough to redden roughly every other CI run, which is a
  different problem from a rare curiosity. A green run does not clear it — half of the day's runs
  were green *and* the defect was present in all of them. Treat `1 in 11` as a floor, not an
  estimate, and raise this item's priority accordingly.
- **It lands on a different test each time.** Two captures: `answers 400 for an Idempotency-Key
  over the cap` (status was 400, but `body.success` was `undefined`, so the body was not the JSON
  error envelope), and `guest() → GET /cart → 401` from a brand-new agent carrying no cookies.

### A third capture — 2026-08-27, Milestone 10 Task 6

The residual fired on the milestone's own verification run, which makes it three captures on three
different tests and settles that it is not tied to `checkout`:

```
test/integration/settings.integration.spec.ts
  settings > PUT /admin/settings > writes no audit row for a key whose value did not change
  Error: expected 200 "OK", got 401 "Unauthorized"
```

**763 passed, 1 failed, 39 suites.** The immediately following full re-run was clean. What the
capture adds:

- The failing request is **the second request of its own test.** `asAdmin()` creates a user, signs
  in, and `.expect(200)` on the login **passed** — so the session row was written and the cookie
  issued. The `PUT` that followed, on the same agent and carrying that cookie, could not find the
  session. That is the "a write is lost — a session written moments earlier could not be found, and
  the next request answered 401" row of the table above, in a file that has nothing to do with
  `checkout`.
- So this is the **same signature** as the `guest() → GET /cart → 401` capture, not a new one, and
  it is a *lost write* rather than a *surviving row*. That narrows the hunt to the direction the
  pool-race fix was supposed to have closed, and suggests the fix reduced its frequency without
  eliminating it: `cleanDatabase` waits for other backends to go idle, but nothing orders the
  application pool's commit against the *next* file's truncate if the connection is handed back to
  the pool between the two.
- No `code` in the body to follow — a 401 from `JwtAuthGuard` on a non-`@Public()` route is a bare
  `UnauthorizedException`, so the instrumentation added for the 400 case has nothing to print here.

**Next step unchanged, and now better aimed:** whether `app.close()` and `closeTestDataSource()`
fully drain is still unverified, and it is the remaining candidate.

**Ruled out by reading the code, not by guessing:**

- **body-parser.** There *is* a 400-on-malformed-JSON path, but `preservingStatus()` in
  `app.module.ts` wraps it in an `HttpException`, so `GlobalExceptionFilter` still emits the
  envelope.
- **Header size.** An over-cap `Idempotency-Key` is 129 characters; nothing near any limit, and an
  oversized header is a 431.
- **Throttling.** `checkout.integration.spec.ts` signs in 25 times against a 5-per-15-min cap but
  clears `ThrottlerStorage` in a `beforeEach`, and a throttle refusal is 429.
- **`JwtAuthGuard`.** It cannot produce the `GET /cart` 401: on a `@Public()` route it runs passport
  and **swallows** the failure, returning `true`. Its own docblock explains that
  `if (isPublic) return true` was rejected because it left `request.user` unset for signed-in
  customers.

**What is now instrumented.** `checkout`'s `guest()` helper uses `expectStatus`, which prints the
response body on a status mismatch. A 4xx from this service carries a `code`, and that `code` names
the rule that refused — which is what turned the original 400 from folklore into a diagnosable
event. The next capture should identify it.

**Next step:** loop the *full* suite retaining `test-results/integration.json`, not the single file.
If the capture shows a `code`, follow it. If the body is genuinely empty, the 400/401 is being
produced upstream of Nest's exception filter, and the remaining candidate is cross-file connection
lifetime — 27 files each boot an app and close it in `afterAll`, and whether `app.close()` and
`closeTestDataSource()` fully drain has not been verified.

### A fourth capture — 2026-08-27, Milestone 11 — and it is **not a 4xx**

763/764, `checkout.integration.spec.ts`, *"mounts the idempotency interceptor on the route, storing
the reply under the checkout scope"*:

```
expect(rows[0]?.response_body?.id).toBe(order.id)
Expected: "NN-2026-100018"   Received: undefined
```

**This capture is the most informative of the four, because it is not a refusal at all.** The three
preceding captures were a 400 and two 401s, which left "an auth/guard rule fired early" open as a
hypothesis. Here nothing was refused: the placement returned `201` with a real order number, and
the three assertions *before* the failing one all passed — the `idempotency_keys` row exists, with
the right `key` and the right `scope`. Only `responseBody` was still unset when the row was read
back.

So the residual is **a write not being visible to a subsequent read in the same test**, with no HTTP
layer involved. That reframes the remaining hypothesis: it is not about guards, and not about
authentication. `IdempotencyInterceptor` claims the row first and fills `responseBody` after the
handler returns, so a read that overtakes the second write sees exactly this. Combined with capture
3 landing in a file unrelated to `checkout`, the pattern across all four is one thing —
**read-your-own-write visibility across the two connection pools**, which is the same root cause
family as the dominant one already fixed above, not a new defect per endpoint.

**Not caused by the seed-guard change committed the same day.** `checkout.integration.spec.ts` does
import `users.seed.ts` (line 9), so the changed module is in its graph — but the change replaces an
inline `NODE_ENV` check with a call producing a byte-identical message, is inert when
`NODE_ENV=test`, and cannot affect whether an interceptor's second write is visible. Independent
evidence: Milestone 10 Task 6's verification run hit the same 763/764 shape **before** that change
existed. Re-running the spec alone passed 38/38.

---

## 2. Two pre-existing lint warnings

`backend/test/integration/rfq-status.integration.spec.ts:154,156` — unsafe `any` assignment and
member access. Introduced by Milestone 8 Task 3 (`af14187`). The repo's established fix for this
is to widen through an annotated `const x: unknown`, as `health.integration.spec.ts` and
`auth.integration.spec.ts` already do.

---

## 3. `POST /checkout/orders` is unthrottled — a known, ACCEPTED risk

**Status: accepted, 2026-08-27, by the client's decision. Document, do not mitigate.** This is not
outstanding work and no longer belongs to a milestone. It was assigned to Milestone 10; Milestone
10's security review put the decision to the client and the answer was to accept it and write it
down. **Do not add a throttle to placement** without a fresh decision from the client — a future
agent finding an unthrottled write and "fixing" it would be reversing a call that was deliberately
made.

### What is open

`POST /checkout/orders` is `@Public()` by design — guest checkout is a requirement, not an
oversight — and carries no `@Throttle()`, so it inherits the global `{ ttl: 60s, limit: 120 }`.
That is roughly **120 COD orders a minute from one IP**, each one decrementing `onHand`, writing an
`inventory_transactions` row, and creating an order somebody has to cancel by hand. The visible
effect is not a slow API: it is a shop showing SOLD OUT to real customers while the stock sits
reserved against orders nobody placed in good faith. CSRF costs an attacker one extra `GET`.

Placement is now the **only** public write on the service without a route throttle, and it is the
one that spends stock:

| Route | Limit |
| --- | --- |
| `POST /auth/register` | 3 / hour |
| `POST /auth/login` | 5 / 15 min |
| `POST /rfqs`, `POST /rfqs/gifting` | 5 / hour |
| `POST /contact` | 5 / hour |
| `POST /catalog/products/:slug/reviews` | 5 / hour |
| **`POST /checkout/orders`** | **120 / minute (global default)** |

### Why it is accepted rather than mitigated

**Mitigation is a business call, not an engineering one.** Every available option trades a real
customer away to stop a hypothetical attacker, and which trade is acceptable is the client's to
make:

- **A tight per-IP cap is riskier than it looks.** Carrier-grade NAT is ordinary on Indian mobile
  networks, so one egress IP legitimately carries many customers. A limit low enough to matter is
  a limit that refuses genuine orders during exactly the traffic spike the shop most wants — a
  festival push, a WhatsApp broadcast, a reel that lands. The failure is silent from the shop's
  side and looks like a broken checkout from the customer's, and a 429 carries no `code`, so a
  client branching on `code` cannot even name the reason.
- **A cap on guest order value or quantity** costs the bulk and gifting flows brief §12 asks for,
  which are the orders worth the most.
- **Requiring sign-in for checkout** removes guest checkout, which brief §12 asks for by name and
  which is the single largest conversion lever on a first-purchase storefront.

**And it is not undefended.** The global 120/minute still applies; every placement is
transactional, so a refused line writes nothing at all (`checkout.integration.spec.ts:1240`); stock
cannot be oversold under a race (`checkout-concurrency.integration.spec.ts`); and orders arrive in
`pending`, so an operator sees a flood as a flood rather than as fulfilment work already begun.

### What would close it, if the decision ever changes

Not a throttle number picked in a code review. It needs the client to choose between the three
trades above, and whichever is chosen needs a test that fails without it. Note in advance that a
per-IP rule cannot be trusted until item 5 below is settled: `ThrottlerGuard` tracks by `req.ip`,
and behind an unconfigured proxy every caller shares one bucket, which would make a tight
placement cap a site-wide outage rather than a defence.

---

## 4. Correction: integration runs do NOT share a database

Recorded 2026-08-27 because the opposite was believed for most of a night and briefed to several
agents as fact.

`jest.integration.config.ts`'s `globalSetup` calls `startTestDatabase()`, which does
`new PostgreSqlContainer('postgres:15-alpine').start()` — **a fresh container per invocation**, on a
randomly mapped port written into `process.env.DB_PORT` for the workers to inherit.

So two concurrent `npm run test:integration` runs get two independent databases and cannot corrupt
each other. The 5442 container in `docker-compose.yml` is the **development** database; the
integration suite never touches it.

What *does* conflict between concurrent agents is the working tree — two of them editing
`app.module.ts` or `entities/enums.ts` at once loses writes. Use `isolation: "worktree"` for
parallel work, not a serialised database.

---

## 5. `trust proxy` is unset, and every per-IP rate limit depends on it

**Open. Must be settled before first deployment; it cannot be settled now.**

`ThrottlerGuard` tracks callers by `req.ip`. `backend/src/main.ts:43-49` deliberately does **not**
call `app.set('trust proxy', …)`, and the comment there gives the reason: with nothing in front of
the service, trusting `X-Forwarded-For` would let any client claim a fresh IP per request and skip
throttling altogether, which is the worse of the two failures.

The other failure is what happens on the day a proxy, load balancer or CDN *is* in front and this
is still unset: **every request reports the proxy's address**, and every per-IP limit — login's
5/15min, registration's 3/hour, `/contact`'s and `/rfqs`'s 5/hour, and the global 120/minute —
collapses into a single bucket shared by all callers. That is a self-inflicted denial of service on
legitimate customers, and it silently voids the only mitigation the backend design spec §13's
**User enumeration (register)** row claims for itself.

**What it takes to close:** `app.set('trust proxy', <hops or a predicate matching the real
topology>)`, set to match whatever ends up in front of the service. Nothing tests this and nothing
can until the topology exists, so it is a deployment checklist item rather than a code defect —
which is exactly why it is written here instead of being left as a comment in `main.ts` that a
deployment would never read.

---

## 6. Three public reads are unpaginated

**Open. Found by Milestone 10's security review. Left open deliberately — the fix is a decision
this review was not entitled to take.**

Backend design spec §13's **Payload flooding** row claims "pagination caps" among its controls.
That holds for every admin list and every catalog list — `MAX_LIMIT = 60`, thirteen times over —
and does **not** hold for three `@Public()` reads, which call `find` with no `take` and so return
every matching row:

| Route | Where |
| --- | --- |
| `GET /catalog/products/:slug/reviews` | `reviews.service.ts:87-95` |
| `GET /catalog/products/:slug/reviews/summary` | `reviews.service.ts:106-113` |
| `GET /content/posts` | `content.service.ts:49` |

The reviews list is the one that matters. A review row can carry 2,000 characters of body plus an
80-character author and a 500-character `imageUrl`, so an anonymous caller doing one cheap `GET`
receives a response that grows without bound with the review count — 120 times a minute, per the
global throttle. The summary route is cheaper on the wire (it returns an aggregate) but still loads
every row to compute it. `GET /content/posts` excludes post bodies from its summaries, so its
per-row cost is small; only its row count is unbounded.

**Why it is not fixed here.** Every option is a decision about a public contract or about what
customers see:

- **Paginate properly.** The wire type is a bare `WireReview[]`, so moving to `Paginated<WireReview>`
  is a breaking change to the public API *and* to the storefront that consumes it. That is a
  coordinated change across two repositories, not a security patch.
- **Add a silent `take`.** Non-breaking, but it hides older reviews from customers with no way to
  reach them, which is a product decision about the review page. The rating average would stay
  correct — the summary aggregates separately — so the damage would be invisible in testing and
  visible only to a customer looking for their own review.

**What it takes to close:** a decision on which of those two, then the change plus a test that
fails without it. Until then the risk is bounded by the global 120/minute and by the fact that the
review count on a new storefront is small; it grows into a real amplification vector only as the
catalogue accumulates reviews, so it should be closed before the shop has been open long.

## 7. No notification has ever been delivered, and every row is marked `SENT`

`NOTIFICATION_DRIVER` has exactly one binding —
`{ provide: NOTIFICATION_DRIVER, useClass: LoggingNotificationDriver }`
(`notifications.module.ts:22`) — and that driver's `send` ends with

```ts
return Promise.resolve({ sentAt: new Date() });
```

(`logging-notification.driver.ts:33`). It logs the notification and **reports
success**, so the queue row transitions to `SENT`. Seven templates queue rows
against `EMAIL` and `WHATSAPP` channels; none of them reaches a person.

**This is deliberate, not a defect.** The driver's own docblock (line 14) says
*"no-op driver marks them SENT"*, and `notification-driver.ts:18` records that a
real provider is "a second class bound to this same token". The placeholder is
working as designed.

**What is *not* recorded anywhere is the production consequence**, which is why
this item exists: on the day this ships, a customer who places an order gets no
confirmation, and **nothing anywhere reports a problem** — not the queue, not
the logs at error level, not a metric. The failure is indistinguishable from
success at every layer. An operator would learn about it from customers.

Binding a real driver needs a provider decision and credentials, so it is not a
code fix to make now. Two things follow for whoever does:

- Do not treat a `SENT` row as evidence of delivery in any admin screen or
  report. Nothing currently does; keep it that way until a real driver lands.
- The no-op is the correct *default* — a misconfigured real driver that throws
  on every order would be worse. Failing silently is the right trade **only**
  while everyone knows, which is what this item is for.

## 8. Three-repo `origin` mismatch — closed by the monorepo merge

**Status: closed.** The storefront, console and API used to be three sibling git repositories.
`nutwala-backend`'s `origin` pointed at a local path (`/Users/kunal/Desktop/nutwala`); the other two
had no remotes. They now live in this one checkout (`apps/web`, `apps/admin`, `apps/api`) with a
fresh history. Add a real remote when you first push.

