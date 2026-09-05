# Runbook

How to operate Nuts & Nazaakat locally: bring the stack up, reseed, run each test layer, and read a
red run. Then the hazards that are known and not fixed, because a runbook is where they belong.

**Nothing has been deployed.** There is no staging, no production, no hosting account, and no CI.
This document deliberately contains no deployment instructions — see
[Before a first deployment](#before-a-first-deployment) for what would have to be decided, which is
not the same thing as instructions for doing it.

The shop is one npm-workspaces monorepo: `apps/web` (storefront), `apps/admin` (console),
`apps/api` (NestJS), `packages/shared` (wire types). Everything below runs from the **repo root**.

---

## 1. Bring the stack up from nothing

```bash
# --- once per clone ---
npm install                         # `prepare` builds packages/shared — see the README if it didn't
cp .env.example apps/api/.env
openssl rand -base64 48             # paste into apps/api/.env as JWT_SECRET

# --- the database ---
npm run db:up                       # postgres:5442 (dev), postgres-test:5443 (scratch)
docker ps                           # wait for (healthy) on nutwala-postgres
npm run migration:run               # migrations never self-apply
npm run seed                        # 8 seeders in dependency order

# --- all three servers ---
npm run dev                         # :4400 API, :5173 storefront, :5174 console
```

Check it came up:

```bash
curl -s localhost:4400/api/v1/health
open http://localhost:5173        # storefront
open http://localhost:5174        # console — sign in as admin@demo.in / Password123!
```

Both front-ends proxy `/api` to `localhost:4400`, so the browser only ever sees one origin. Sign in
through the front-ends, not against `:4400` directly — `CORS_ORIGINS` in `.env.example` lists
`http://localhost:5173` only, so a browser calling the API cross-origin from `:5174` would be
refused. The proxy is what makes that a non-issue in development.

**Seeded accounts:** `b2c@demo.in`, `b2b@demo.in`, `admin@demo.in` — all `Password123!`.

---

## 2. Reseed

```bash
npm run seed                # everything
npm run seed -- catalog     # one domain (settings users catalog coupons content orders pincodes rfqs)
```

Most seeders upsert on a natural key, so a full run is safe to repeat. Two traps around that:

### Reseed *before* an E2E run, not after

`orders.seed.ts` **deletes and re-inserts** each seeded order's items, events and payments, and
`catalog.seed.ts` resets every `inventory.onHand` to its opening figure. So tidying up *after* a run
does not help: whatever a crashed run left behind is still what the next run inherits at the moment
it crashed. Seeding first is what makes a journey's preconditions true rather than probable.

`npm run test:e2e` already does this for you in `e2e/global-setup.ts`. Set
`NUTWALA_E2E_SKIP_SEED=1` to suppress it, and understand what you are giving up.

### `npm run seed -- catalog` destroys admin-edited pricing tiers

**This is a live footgun, not a theoretical one.**

`ProductImage` and `PricingTier` have **no unique index**, so a real upsert is not expressible.
`catalog.seed.ts` therefore `DELETE`s every row for a product and re-`INSERT`s its own. Its docblock
says the seeder's ownership of those two tables *"expires the moment admin product-editing ships"* —
and for **pricing tiers** it has: `POST` and `PATCH /admin/pricing-tiers` exist and `/admin/pricing`
writes through them, so a reseed silently reverts every tier an operator has edited back to the
seed's slabs.

**Product images are the same pattern, not yet the same problem.** Nothing but the seeder writes
`product_images` — `SaveProductDto` has no image field and no admin route touches the table — so the
seeder still legitimately owns them. It becomes the identical footgun the day image editing ships,
and the fix below is the same one.

The same shape applies to stock: a reseed resets `inventory.onHand` to the opening figure but leaves
the append-only `inventory_transactions` ledger alone, breaking the
`SUM(delta) = onHand` invariant on any variant that has since moved.

**Only reseed a database the seeder still owns.** If you have been editing pricing or stock through
the console and want a clean base, take the whole database down instead:

```bash
docker compose down -v && npm run db:up && npm run migration:run && npm run seed
```

Closing this properly needs one of two decisions, per the seeder's own docblock: add natural unique
keys — `(product_id, sort_order)` and `(product_id, min_kg, segment, business_id)` — so seeding
becomes non-destructive, or make the seeder refuse to run when it finds rows it did not write.

---

## 3. Run each test layer

From the repo root. Green totals as of 2026-08-27:

| Layer | Command | Green |
| --- | --- | --- |
| Contract | `npm run test -w @nutwala/shared` | 71 in 6 files |
| API unit | `npm run test -w @nutwala/api` | 1,234 in 95 suites |
| API integration | `npm run test:integration` | 764 in 39 suites |
| End to end | `npm run test:e2e` | 6 journeys |
| Storefront | `npm test -w @nutwala/web` | 339 in 20 files |
| Console | `npm test -w @nutwala/admin` | 200 in 13 files |

Plus `npm run typecheck`, `npm run lint`, `npm run build` at the root.

**What each layer needs:**

- **Unit and contract suites** need nothing — no Docker, no database, no servers.
- **Integration** needs **Docker running**, and nothing else. It starts its own Postgres
  testcontainer per invocation on a randomly mapped port, applies the real migration chain, and
  throws it away. It never touches 5442, so it cannot corrupt your development data and
  `npm run db:up` is not a prerequisite.
- **E2E** needs the opposite: the **development** database on 5442, migrated. It reseeds itself and
  starts all three dev servers (`reuseExistingServer: true`, so it adopts any you already have up,
  and stops only what it started). One worker, no parallelism — journey 3 drives a pack's stock to a
  single unit and then buys it, which only means anything if nothing else is buying.
- **Front-end suites** need nothing. `@nutwala/admin` additionally has `npm run test:live`, which is
  **not** part of `npm test`: it drives the real API, mutates a real order, and signs in twice
  against the login throttle.

### Never run two integration suites at once

They each start their own container, so they will not corrupt each other's data — but they will
fight over CPU on a machine that has to run 39 suites serially, and the residual flake in §4 is a
timing bug. A misconfigured run (a stray `DB_PORT` in the environment, say) could also point one of
them at the development database on 5442 and truncate it. One at a time.

The thing that *does* conflict between two agents working in parallel is the **working tree** — two
of them editing `app.module.ts` at once loses writes. Use a git worktree, not a serialised database.

---

## 4. When the integration suite goes red

**Re-run it once.** `docs/known-issues.md` item 1 records a residual flake at roughly **1 in 11 full
runs**: it lands on a different test each time, it needs cross-file timing (it is far rarer in a
single file), and it has survived two fixes that each removed a real cause. A single red run is no
longer expected, but it is not yet impossible.

**Read the report, not the scrollback:**

```bash
npm run test:integration
python3 -m json.tool apps/api/test-results/integration.json | less   # or jq
```

`test:integration` writes `--json --outputFile=test-results/integration.json`. The scrollback of a
39-suite serial run is thousands of lines with expected error logs from negative-path tests mixed in,
and the JSON has the failure message and the assertion. **A filtered run overwrites the file** — so
if you follow a full red run with `npm run test:integration -- checkout`, the evidence from the full
run is gone. Copy it aside first.

If the second full run is green, log it against known-issues item 1 and move on. If it fails the same
way twice, it is not the flake — treat it as a real regression and bisect.

### Two failure signatures that are *not* the flake

- **A 429 anywhere.** That is the login throttle, §5. It is your suite's fault, not the app's.
- **A state machine returning the wrong verdict** (a 200 where you expect 422, or the reverse) that
  passes in isolation. Known-issues item 1 records this exact costume: it was colliding test order
  numbers across spec files resolving to *another file's* order. Fixed, but the lesson stands —
  check that the identifier under test is unique across files before suspecting the logic.

### And one for the dev server

`nest start --watch` can stop watching **one** source file — observed after a `git checkout` replaced
a file's inode under the compiler. Nothing errors; that file's `dist/` output is simply frozen, so a
clause silently stops applying and an endpoint returns the wrong set. It is invisible to all four
test layers, because they compile the sources themselves.

```bash
grep -c <a symbol you just added> apps/api/dist/modules/.../thing.js   # 0 means frozen
```

The fix is to **restart the backend**. Do *not* run `nest build` to "refresh" it —
`deleteOutDir: true` deletes the `dist/` the running server is serving from.

---

## 5. The login throttle, which bites test authors

Per-IP, enforced by `ThrottlerGuard`:

| Route | Limit |
| --- | --- |
| `POST /auth/login` | **5 / 15 minutes** |
| `POST /auth/register` | **3 / hour** |
| `POST /auth/refresh` | 10 / minute |
| `POST /contact` | 5 / hour |
| `POST /rfqs`, `POST /rfqs/gifting` | 5 / hour each |
| `POST /catalog/products/:slug/reviews` | 5 / hour |
| everything else, including `POST /checkout/orders` | 120 / minute (global default) |

**A suite that signs in per test rate-limits itself and then reports failures that look like
application bugs.** The 429 body carries no machine-readable `code` — `ThrottlerException` is not a
`DomainError` — so a client cannot branch on it, and a test that renders the message sees
"Too many attempts. Please wait a few minutes and try again." where it expected a validation error.

How each suite deals with it:

- **E2E** mints one `storageState` per role in `e2e/global-setup.ts` and reuses it — including
  *across* runs, which is why `.auth/` lives outside `test-results/` (Playwright empties that
  directory at the start of every run). A cold cache costs **three** logins of the five; a warm one
  costs **zero**, because `ensureSignedIn` asks `GET /auth/me` first and repairs a merely-expired
  token with `POST /auth/refresh` (10 per minute, not 5 per fifteen). **So `rm -rf e2e/.auth/` is the
  thing that makes the limit reachable** — two cold runs inside the same quarter hour will be
  refused, and the refusal looks like a broken sign-in.
- **Integration** clears `ThrottlerStorage` in a `beforeEach`, which is why
  `checkout.integration.spec.ts` can sign in 25 times.
- **`npm run test:live` in the console** does neither. It signs in twice per run against the real
  API, so restart the backend to clear the in-memory throttle between runs.

To clear the throttle by hand: **restart the backend.** Storage is in-memory, so there is nothing
else to flush and nothing survives the restart.

---

## 6. Known hazards that belong to a deployment

These are recorded in `docs/known-issues.md` and repeated here because a runbook is the only document
someone reads before touching an environment.

### `trust proxy` is deliberately unset — settle this before anything sits in front

`apps/api/src/main.ts` does **not** call `app.set('trust proxy', …)`, and the comment there gives the
reason: with nothing in front of the service, trusting `X-Forwarded-For` would let any client claim a
fresh IP per request and skip throttling altogether. That is the worse of the two failures *today*.

**The day a proxy, load balancer or CDN is in front and this is still unset, every request reports
the proxy's address** and every per-IP limit in §5 — login's 5/15min, registration's 3/hour, the
5/hour rules, and the global 120/minute — collapses into a single bucket shared by all callers. That
is a self-inflicted denial of service on real customers, and it silently voids the only mitigation
the design spec claims against user enumeration.

Nothing tests this and nothing can until the topology exists. `known-issues.md` item 5. **Put it on
the deployment checklist, not on a backlog.**

### `POST /checkout/orders` is unthrottled, and that is an accepted decision

`known-issues.md` item 3. Guest checkout is a requirement, the route is `@Public()` by design, and it
carries no `@Throttle()` — so it inherits 120/minute, which is ~120 COD orders a minute from one IP,
each one spending stock.

**The user decided on 2026-08-27 to document rather than mitigate.** Mitigation is a business call:
carrier-grade NAT is ordinary on Indian mobile networks so a tight per-IP cap refuses genuine orders
during exactly the traffic spike the shop wants; a guest value cap costs the bulk and gifting flows;
requiring sign-in removes guest checkout. **Do not add a throttle here without a fresh decision from
the user, and do not re-argue it in a code review.** Note also that a per-IP rule here cannot be
trusted at all until `trust proxy` above is settled.

### The storefront's site settings are still build-time constants

`apps/web/src/config/settings.ts` is **static**, and 45 files read it. `GET /settings` exists
and is `@Public()`; the console's `/admin/settings` screen edits those rows and saves them. **The
storefront is not wired to either.** So today:

- **WhatsApp number, support email, support phone, GSTIN, FSSAI licence, certifications, social
  links and the postal address are empty strings and empty arrays in a committed source file.**
  Editing them in the console changes nothing a customer sees.
- The certification fields are empty *deliberately* — the brief forbids unsupported claims, so the
  badges render only once real registration numbers are configured.
- `codEnabled` / `onlinePaymentEnabled` are also constants here; the server's
  `422 PAYMENT_METHOD_UNAVAILABLE` is the actual enforcement, and these two only stop the checkout
  form offering a door that was never open.

**Wiring it up is Milestone 11's Task 2.** Until then, a deployment that expects an operator to fill
in the shop's phone number from the console will ship a storefront with no phone number on it.

### The storefront's blog is still served from a mock file

`apps/web/src/features/content/api/index.ts` is the **one** feature API in the storefront that
was never switched to the real backend: it imports `src/mocks/posts.ts` and serves it through
`src/lib/mock-client.ts`, which fakes 220ms of latency. The other ten feature APIs all go through
`lib/http.ts`.

So `GET /content/posts` has no storefront consumer, and the console's `/blog` screen writes rows
nothing reads. An operator told they can publish an article cannot, today. `mock-client.ts`'s own
docblock says "Phase 2 deletes this file along with src/mocks/" — Phase 2 deleted nine tenths of it.

### Three public reads are unpaginated

`known-issues.md` item 6, found by Milestone 10's security review and left open deliberately:
`GET /catalog/products/:slug/reviews`, its `/summary`, and `GET /content/posts` return every matching
row. The reviews list is the one that grows without bound with content, and closing it is either a
breaking change to the public wire type or a silent `take` that hides customers' own reviews —
a product decision, not a security patch. Bounded for now by the global 120/minute and by a small
review count on a new shop. **Close it before the shop has been open long.**

---

## 7. Before a first deployment

Nothing is decided. This is the list of decisions, not a plan:

- **`trust proxy`**, above. This one is not optional.
- **Where the three applications are hosted, and on what origins.** The console is a separate origin
  on purpose (design spec §7.1: one origin means shared cookies, CSP and service-worker scope, so an
  XSS in the storefront runs with whatever the admin session can reach). `CORS_ORIGINS` and
  `COOKIE_DOMAIN` both follow from that choice; the front-ends' dev proxies do not exist in a build,
  so `VITE_API_URL` must be set at build time for each.
- **`VITE_ADMIN_APP_URL` in the storefront**, which is unset today. Until it is set, an admin who
  signs in on the storefront gets an explanatory message instead of a redirect to the console.
- **Secrets.** `JWT_SECRET` and `SWAGGER_PASSWORD` are placeholders in `.env.example`, and
  `DB_PASSWORD` is the throwaway that `docker-compose.yml` also holds in plain text. The backend
  refuses to boot in `NODE_ENV=production` with any of those, with `COOKIE_SECURE=false`, or with a
  `localhost` cookie domain or CORS origin — so it will tell you, loudly, at startup.
- **Whether migrations run on deploy.** `DB_MIGRATIONS_RUN` is `false` here by choice.
- **How the database is hosted and backed up.** `docker-compose.yml` is a development convenience
  and is not a deployment artifact.
- **A notification provider.** The subsystem exists and is wired: six templates are queued inside
  their caller's transaction (`order.confirmed`, `order.shipped`, `order.delivered`, `rfq.received`,
  `rfq.status-changed`, `support.received`, `stock.low`), every one persists a `notifications` row
  with an `EMAIL` or `WHATSAPP` channel, and `NOTIFICATION_DRIVER` is a swappable port. **The only
  driver bound is `LoggingNotificationDriver`, which writes a log line and reports success** — so
  every notification is marked `SENT` and **no customer has ever been told anything.** A first
  deployment has to bind a real driver, or decide out loud that it is shipping with none.
- **Online payments.** `onlinePaymentEnabled` is `false` everywhere and no gateway is integrated. COD
  is the only method that works end to end.
- **CI.** There is none. The six commands in §3 are run by hand.
