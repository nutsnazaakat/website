# Nuts & Nazaakat Backend — Plan 1 of 4: Foundation, Schema, Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the npm-workspace monorepo, the `@nutwala/shared` contract package, a NestJS + Postgres service with all 33 entities and seeded data, and real cookie-based authentication — so a customer can register, sign in and sign out against a live database.

**Architecture:** npm workspaces add `shared/`, `backend/` and `e2e/` beside the existing `frontend/`, which does not move. `shared/` owns the money arithmetic, the Indian identifier regexes and the order-status machine, so the backend (class-validator) and the frontend (zod) validate against one definition and a contract break becomes a compile error. The backend is NestJS 11 modular-by-feature on TypeORM 0.3, mirroring `larkfinserv/mf-lenders-gateway`. Sessions live in httpOnly cookies backed by a revocable `Session` table.

**Tech Stack:** Node 22, TypeScript 5.7 (`strict`), NestJS 11, TypeORM 0.3.28, PostgreSQL 15, class-validator, bcrypt, `@nestjs/jwt`, winston, helmet, `@nestjs/throttler`, Jest + ts-jest, testcontainers, Swagger.

**Spec:** `docs/superpowers/specs/2026-08-19-nuts-nazaakat-backend-design.md`

---

## Plan set

The spec's 11 milestones are split across four plans. Each produces working, testable software on its own.

| Plan | Milestones | Delivers | File |
|---|---|---|---|
| **1 (this one)** | 0–2 | Monorepo, `shared/`, backend skeleton, 33 entities, seed data, working auth | `2026-08-19-nuts-nazaakat-backend.md` |
| 2 | 3–6 | Catalog reads with SOLD OUT, cart, COD checkout with race-safe stock, order tracking | `2026-08-19-nuts-nazaakat-commerce.md` |
| 3 | 7–8 | B2B pricing/RFQ, blog, support tickets, `Setting`-backed config | `2026-08-19-nuts-nazaakat-b2b-content.md` |
| 4 | 9–10 | The 18 admin routes, 6 Playwright journeys, security review | `2026-08-19-nuts-nazaakat-admin.md` |

Plans 2–4 are written after this one lands, so they can be informed by what the code actually looks like rather than guessed at three milestones ahead.

---

## Testing philosophy for this plan

Following the Phase 1 plan's precedent: not every task is TDD, and that is deliberate.

**TDD — test first, watch it fail, then implement.** Tasks 3, 4, 9, 10, 24, 25, 27, 28, 29. These are pure functions and security decisions: money and GST arithmetic, order-status transitions, the PII redactor, the response envelope, password hashing, token hashing, refresh rotation with reuse detection, and login's no-enumeration behaviour. A silent bug in any of these is either a wrong invoice or a security hole.

**Integration-tested — real Postgres in testcontainers, real HTTP through supertest.** Tasks 12, 22, 23, 31, 32. Endpoint contracts, the migration chain, the seeder, and every auth control from spec §13.

**Verification-only — it builds, it boots, it responds.** Scaffolding and wiring tasks. Asserting that `app.module.ts` imports a module catches nothing that a failing boot would not.

Every task ends in a commit.

**On the test counts in `Expected:` lines.** They are advisory. The test file given in each task is authoritative: where a count disagrees with the file, the file wins. Never add or delete a test to make a number match — a padded suite is worse than a miscounted one.

---

## A note on task granularity

Every task gives complete, runnable code except **Task 20's seeders**, which specify what to
build with precision — exact source file, exact arithmetic, exact expected row counts — but do
not transcribe the data.

That is deliberate, and it follows the Phase 1 plan's precedent for its Milestones 4–6. The
seed content is 27 product records and 12 category records that already exist verbatim in
`frontend/src/mocks/products.ts` and `mocks/categories.ts`. Copying ~400 lines of data into
this plan would create a second copy that drifts from the first the moment either changes, and
the whole point of the task is to move that data rather than restate it.

An agent executing Task 20 has three binding constraints, and any conflict between them is a
stop-and-ask:

1. The price and tier arithmetic must match `buildVariants` and `buildTiers` in the mock file
   exactly — seeded orders, combo savings and the Phase 1 screenshots all depend on it.
2. All 27 slugs must survive, because seeded orders, combos and reviews reference them.
3. The row counts in Task 20 Step 6 and Task 21 must come out exactly as stated.

Everything else in this plan is transcribed in full.

---

## File structure

What this plan creates. Each file has one responsibility.

```
nutwala/
├── package.json                          # NEW  workspace root, cross-workspace scripts
├── docker-compose.yml                    # NEW  postgres:15-alpine, dev 5432 + test 5433
├── .env.example                          # NEW  placeholders only, never real values
├── .gitignore                            # MOD  add .env, dist, coverage
│
├── shared/                               # NEW  @nutwala/shared
│   ├── package.json  tsconfig.json
│   └── src/
│       ├── index.ts                      # barrel
│       ├── money.ts                      # paise arithmetic, GST, coupon math   (TDD)
│       ├── money.test.ts
│       ├── constants/
│       │   ├── identifiers.ts            # PHONE_REGEX, PINCODE_REGEX, GSTIN_REGEX
│       │   ├── geography.ts              # INDIAN_STATES
│       │   ├── order-status.ts           # brief §33 tuples + transition maps    (TDD)
│       │   ├── order-status.test.ts
│       │   └── taxonomy.ts               # CONTACT_TOPICS, BUSINESS_TYPES, BLOG_CATEGORIES
│       └── types/
│           ├── catalog.ts  order.ts  auth.ts  api.ts
│
├── backend/                              # NEW
│   ├── package.json  tsconfig.json  nest-cli.json  .prettierrc  eslint.config.mjs
│   ├── jest.config.ts  jest.integration.config.ts  jest.e2e.config.ts
│   ├── src/
│   │   ├── main.ts                       # bootstrap; imports ./load-env.js first
│   │   ├── load-env.ts                   # dotenv override (PM2 workaround, Gateway pattern)
│   │   ├── common/money/bigint-json.ts   # BigInt.prototype.toJSON, before serialisation
│   │   ├── app.module.ts
│   │   ├── data-source.ts                # CLI-only DataSource mirror
│   │   ├── common/
│   │   │   ├── config/env.schema.ts      # fails fast at boot
│   │   │   ├── config/app.config.ts
│   │   │   ├── config/winston.config.ts
│   │   │   ├── logging/pii-redactor.ts   # (TDD)
│   │   │   ├── logging/request-context.ts
│   │   │   ├── logging/winston-logger.service.ts
│   │   │   ├── middleware/request-tracking.middleware.ts
│   │   │   ├── filters/global-exception.filter.ts
│   │   │   ├── interceptors/transform.interceptor.ts   # (TDD)
│   │   │   ├── money/paise.transformer.ts
│   │   │   ├── db/postgres-version-assertion.service.ts
│   │   │   ├── errors/domain-error.ts
│   │   │   └── auth/                     # strategy, guards, decorators
│   │   ├── database/migrations/          # date-prefixed chain
│   │   ├── database/seeds/               # flag-driven, CUG pattern
│   │   ├── entities/                     # 33 entities, grouped by domain folder
│   │   └── modules/{health,auth,users,sessions}/
│   └── test/
│       ├── integration/helpers/{test-database,test-app,db-cleaner}.ts
│       └── factories/user.factory.ts
│
└── frontend/                             # MOD  only where noted
    ├── package.json                      # MOD  depend on @nutwala/shared
    └── src/
        ├── lib/http.ts                   # NEW  fetch wrapper: envelope, CSRF, 401 refresh
        ├── features/checkout/schema.ts   # MOD  import regexes from shared
        ├── features/account/types.ts     # MOD  re-export status tuples from shared
        ├── features/auth/api/index.ts    # MOD  mocks → HTTP
        └── features/auth/AuthProvider.tsx# MOD  hydrate from GET /auth/me
```

**On the eight forwarding modules.** Steps 2–5 leave files like `features/catalog/types.ts`
containing nothing but `export type { … } from "@nutwala/shared"`. That is deliberate: it keeps
this task's diff at zero component and route edits, which is what makes it reviewable and safe.

It is a decision, not an accident, and it should be revisited rather than left to calcify.
`features/auth/types.ts` empties out naturally in Task 28, which points `AuthProvider` at
`@nutwala/shared` directly. The other six — `catalog/types.ts`, `account/types.ts`,
`content/types.ts`, `content/schema.ts`, `rfq/schema.ts`, `gifting/schema.ts` — have no such
scheduled removal. Plan 2 should decide explicitly whether its rewiring tasks collapse them by
pointing consumers at `@nutwala/shared`, or whether they stay as stable local import paths.
Either answer is defensible; drifting into one by default is not.

**Boundary rule:** an entity file declares columns and relations, nothing else. A service holds business rules. A controller maps HTTP to a service call and declares Swagger. No SQL in a controller, no HTTP types in a service.

---

# MILESTONE 0 — Foundation

Goal: `npm run dev` boots a NestJS service that connects to Postgres, answers `GET /api/v1/health`, and has a passing test suite in all three configurations.

## Task 1: Workspace root and Postgres

**Files:**
- Create: `package.json`, `docker-compose.yml`, `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Confirm the starting state**

Run: `cd /Users/kunal/Desktop/nutwala && ls && cat .gitignore`
Expected: `docs`, `frontend`, `LOVABLE REFERENCE ` present; no root `package.json`.

- [ ] **Step 2: Create the workspace root `package.json`**

```json
{
  "name": "nutwala",
  "private": true,
  "version": "0.0.0",
  "workspaces": ["shared", "backend", "frontend", "e2e"],
  "engines": { "node": ">=22" },
  "devDependencies": {
    "concurrently": "^9.1.2"
  },
  "scripts": {
    "build": "npm run build -w @nutwala/shared && npm run build -w backend && npm run build -w frontend",
    "dev": "concurrently -n shared,backend,frontend -c gray,blue,magenta --kill-others-on-fail \"npm run dev -w @nutwala/shared\" \"npm run dev -w backend\" \"npm run dev -w frontend\"",
    "dev:backend": "npm run dev -w backend",
    "dev:frontend": "npm run dev -w frontend",
    "test": "npm run test -w @nutwala/shared && npm run test -w backend && npm run test -w frontend",
    "test:integration": "npm run test:integration -w backend",
    "lint": "npm run lint -w backend && npm run lint -w frontend",
    "format:check": "npm run format:check -w backend && npm run format:check -w frontend",
    "db:up": "docker compose up -d postgres postgres-test",
    "db:down": "docker compose down",
    "migration:run": "npm run migration:run -w backend",
    "migration:revert": "npm run migration:revert -w backend",
    "seed": "npm run seed -w backend"
  }
}
```

Note `engines.node` — neither CUG nor Gateway pins a Node version in-repo, which is why their runtime had to be inferred from CI. This repo pins it.

`dev` uses `concurrently`, not `cmd-a & cmd-b`. A bare `&` backgrounds the backend with no `wait` and no shared process group: when the foreground frontend exits, the backend is orphaned still holding its port, and whether Ctrl-C reaches it depends on the watcher's own process-group behaviour. `--kill-others` makes stopping one stop all, and `-n` prefixes keep the log streams readable.

It also runs `@nutwala/shared`'s `tsc -b --watch`. Without that, editing `shared/src` during `npm run dev` would not rebuild `shared/dist`, and both consumers would keep compiling against stale `.d.ts` files until someone remembered to build by hand — a genuinely confusing failure, because the source on screen would disagree with the types in effect.

**Ordering note:** Task 1 runs before `concurrently` is installed. Write the script now; the dependency lands with the `npm install` in Task 7, the first task that needs `npm run dev`. Until then use `npm run dev:backend` and `npm run dev:frontend` in two terminals.

- [ ] **Step 3: Create `docker-compose.yml`**

Two databases on two ports. The test database is separate so `npm run test:integration` can never truncate development data.

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: nutwala-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: nutwala
      POSTGRES_USER: nutwala
      POSTGRES_PASSWORD: nutwala_dev_only
    ports:
      # Loopback-only, and 5442 rather than 5432 — see the note below this file.
      - '127.0.0.1:5442:5432'
    volumes:
      - nutwala-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U nutwala -d nutwala']
      interval: 5s
      timeout: 5s
      retries: 10

  postgres-test:
    image: postgres:15-alpine
    container_name: nutwala-postgres-test
    restart: unless-stopped
    environment:
      POSTGRES_DB: nutwala_test
      POSTGRES_USER: nutwala
      POSTGRES_PASSWORD: nutwala_dev_only
    ports:
      - '127.0.0.1:5443:5432'
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U nutwala -d nutwala_test']
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  nutwala-pgdata:
```

`postgres-test` uses `tmpfs`, so it is fast and leaves nothing behind.

**Why 5442/5443 and not 5432/5433.** This machine already runs Homebrew PostgreSQL 14 on 5432. Rather than stopping a service the user depends on, the containers take 5442 (dev) and 5443 (test), and `.env.example` sets `DB_PORT=5442` to match. Do not stop or reconfigure the Homebrew instance.

Both are bound to `127.0.0.1` rather than `0.0.0.0`. The credentials are throwaway by design, so there is no reason for either database to be reachable from the local network.

- [ ] **Step 4: Create `.env.example` with placeholders only**

Spec §3.1 departure 5: no value here may be a real credential.

```bash
NODE_ENV=development
PORT=4400

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=nutwala
# Matches docker-compose.yml. Not a secret: a local-only throwaway container whose password is
# already committed there. Any real deployment must override this.
DB_PASSWORD=nutwala_dev_only
DB_NAME=nutwala
DB_SCHEMA=public
DB_MIGRATIONS_RUN=false

# 4400, deliberately not 4000. Port 4000 is occupied on this machine by an unrelated
# long-running mockserver in another project, and a subagent killed that process to free the
# port during Task 12 — an intrusion into someone else's workload that should never have
# happened. Moving this service prevents the collision recurring.

# Auth — generate with: openssl rand -base64 48
JWT_SECRET=replace_me_min_32_chars_generate_with_openssl_rand
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false

# CORS — comma-separated, never *
CORS_ORIGINS=http://localhost:5173

# Swagger basic auth
SWAGGER_USER=docs
SWAGGER_PASSWORD=replace_me

LOG_LEVEL=debug
```

- [ ] **Step 5: Extend `.gitignore`**

```bash
cat >> .gitignore << 'EOF'

# Workspace
node_modules/
dist/
coverage/

# Secrets — never commit a working env file
.env
.env.*
!.env.example
EOF
```

- [ ] **Step 6: Verify the frontend still installs and builds under workspaces**

Run: `npm install && npm run build -w frontend`
Expected: install succeeds, hoisting `frontend/node_modules` to the root; the frontend build passes with zero TypeScript errors.

If install fails on the `e2e` workspace not existing yet, temporarily reduce `workspaces` to `["shared", "backend", "frontend"]` and restore `e2e` in Plan 4.

- [ ] **Step 7: Start the databases and confirm both accept connections**

Run: `npm run db:up && sleep 5 && docker compose ps`
Expected: both `nutwala-postgres` and `nutwala-postgres-test` report `healthy`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json docker-compose.yml .env.example .gitignore
git commit -m "build: add npm workspaces root and Postgres compose services"
```

## Task 2: Scaffold the `@nutwala/shared` package

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`

- [ ] **Step 1: Create `shared/package.json`**

```json
{
  "name": "@nutwala/shared",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist tsconfig.tsbuildinfo"
  },
  "devDependencies": {
    "typescript": "~5.7.3",
    "vitest": "^4.1.10"
  }
}
```

`commonjs` because the backend is NestJS on `module: commonjs` (CUG's setting). Vitest is the test runner here rather than Jest, because the frontend already uses it and this package is consumed by both sides.

- [ ] **Step 2: Create `shared/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```

`noUncheckedIndexedAccess` is on because this package hands out tuples and lookup maps; an unchecked `tiers[0]` is exactly the bug it catches.

- [ ] **Step 3: Create the barrel `shared/src/index.ts`**

```ts
export * from './money';
export * from './constants/identifiers';
export * from './constants/geography';
export * from './constants/order-status';
export * from './constants/taxonomy';
export * from './types/api';
export * from './types/auth';
export * from './types/catalog';
export * from './types/order';
```

- [ ] **Step 4: Create placeholder files so the barrel compiles**

Each is replaced with real content in Tasks 3–4 and 6. They exist now only so `tsc -b` succeeds.

```bash
mkdir -p shared/src/constants shared/src/types
for f in money constants/identifiers constants/geography constants/order-status constants/taxonomy \
         types/api types/auth types/catalog types/order; do
  echo "export {};" > "shared/src/$f.ts"
done
```

- [ ] **Step 5: Install and build**

Run: `npm install && npm run build -w @nutwala/shared`
Expected: `shared/dist/index.js` and `shared/dist/index.d.ts` exist.

- [ ] **Step 6: Commit**

```bash
git add shared package.json package-lock.json
git commit -m "build: scaffold @nutwala/shared workspace package"
```

## Task 3: Money arithmetic (TDD)

Spec §8. Every monetary column is `bigint` paise. This module is the only place rupees and paise convert, and the only place GST is rounded. Bugs here are silent and appear on invoices.

**Files:**
- Create: `shared/src/money.ts`
- Test: `shared/src/money.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { applyFlat, applyPercent, gstOn, sumPaise, toPaise, toRupees } from './money';

describe('toPaise', () => {
  it('converts whole rupees', () => {
    expect(toPaise(1299)).toBe(129900n);
  });

  it('converts two-decimal rupees despite binary float error', () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE-754. A naive implementation truncates to 1233.
    expect(toPaise(12.34)).toBe(1234n);
    expect(toPaise(0.07)).toBe(7n);
  });

  it('accepts zero', () => {
    expect(toPaise(0)).toBe(0n);
  });

  it('rejects sub-paise precision rather than silently rounding money', () => {
    expect(() => toPaise(12.345)).toThrow(/sub-paise/i);
  });

  it('rejects values that are not finite numbers', () => {
    expect(() => toPaise(Number.NaN)).toThrow(/finite/i);
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it('rejects negative money', () => {
    expect(() => toPaise(-1)).toThrow(/negative/i);
  });
});

describe('toRupees', () => {
  it('round-trips through toPaise', () => {
    expect(toRupees(toPaise(1299))).toBe(1299);
    expect(toRupees(toPaise(12.34))).toBe(12.34);
  });

  it('renders paise as a fractional rupee value', () => {
    expect(toRupees(7n)).toBe(0.07);
  });
});

describe('gstOn', () => {
  it('computes 5% GST on a round amount', () => {
    // ₹1000 at 5% is ₹50
    expect(gstOn(100000n, 5)).toBe(5000n);
  });

  it('rounds half up at the paise', () => {
    // 1 paise at 50% is 0.5 paise, which rounds up to 1
    expect(gstOn(1n, 50)).toBe(1n);
    // 1 paise at 49% is 0.49 paise, which rounds down to 0
    expect(gstOn(1n, 49)).toBe(0n);
  });

  it('handles a fractional rate', () => {
    // ₹100 at 2.5% is ₹2.50
    expect(gstOn(10000n, 2.5)).toBe(250n);
  });

  it('returns zero for a zero base', () => {
    expect(gstOn(0n, 5)).toBe(0n);
  });

  it('rejects a negative rate', () => {
    expect(() => gstOn(100n, -5)).toThrow(/rate/i);
  });
});

describe('per-line rounding, spec §8', () => {
  it('sums per-line GST rather than rounding the aggregate', () => {
    // Three lines of ₹33.33 at 5%. Per line: 166.65 paise -> 167 each -> 501 total.
    // Rounding the aggregate instead gives round(499.95) = 500. The invoice must equal
    // the sum of its lines, so 501 is correct.
    const lines = [3333n, 3333n, 3333n];
    const perLine = sumPaise(lines.map((base) => gstOn(base, 5)));
    expect(perLine).toBe(501n);

    const aggregate = gstOn(sumPaise(lines), 5);
    expect(aggregate).toBe(500n);
    expect(perLine).not.toBe(aggregate);
  });
});

describe('sumPaise', () => {
  it('sums an empty list to zero', () => {
    expect(sumPaise([])).toBe(0n);
  });

  it('sums a list', () => {
    expect(sumPaise([100n, 250n, 3n])).toBe(353n);
  });
});

describe('applyPercent', () => {
  it('takes a percentage of the amount', () => {
    expect(applyPercent(100000n, 10)).toBe(10000n);
  });

  it('caps the discount at maxPaise when given', () => {
    expect(applyPercent(100000n, 50, 20000n)).toBe(20000n);
  });

  it('never discounts more than the amount itself', () => {
    expect(applyPercent(5000n, 150)).toBe(5000n);
  });

  it('returns zero for a zero amount', () => {
    expect(applyPercent(0n, 25)).toBe(0n);
  });
});

describe('applyFlat', () => {
  it('returns the flat amount when it fits', () => {
    expect(applyFlat(100000n, 15000n)).toBe(15000n);
  });

  it('clamps to the amount so a total can never go negative', () => {
    expect(applyFlat(10000n, 50000n)).toBe(10000n);
  });

  it('clamps a negative flat discount to zero', () => {
    expect(applyFlat(10000n, -500n)).toBe(0n);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @nutwala/shared`
Expected: FAIL — `toPaise is not a function` (the placeholder `money.ts` exports nothing).

- [ ] **Step 3: Implement `shared/src/money.ts`**

```ts
/**
 * All money in this system is an integer count of paise held in a `bigint`.
 *
 * Rupees appear only at the API boundary, where `toRupees` converts for the frontend's
 * `price: number` contract. Nothing computes with floating-point rupees: `0.1 + 0.2`
 * problems surface as one-rupee GST discrepancies that are very hard to trace back.
 *
 * Matches the `bigint` paise convention already used by mf-lenders-gateway.
 */

/** A non-negative integer count of paise. 100 paise = ₹1. */
export type Paise = bigint;

const PAISE_PER_RUPEE = 100;
/** Rates are held as basis points internally, so 2.5% divides exactly. */
const BASIS_POINTS = 10_000n;

/**
 * Divides with half-up rounding. `bigint` division truncates toward zero, which would
 * quietly under-collect GST on every line.
 */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('divideHalfUp: denominator must be positive');
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function toBasisPoints(ratePercent: number): bigint {
  if (!Number.isFinite(ratePercent)) throw new RangeError('rate must be a finite number');
  if (ratePercent < 0) throw new RangeError('rate must not be negative');
  const scaled = Math.round(ratePercent * 100);
  if (Math.abs(ratePercent * 100 - scaled) > 1e-6) {
    throw new RangeError(`rate ${ratePercent} is finer than one basis point`);
  }
  return BigInt(scaled);
}

/**
 * Converts a rupee amount to paise.
 *
 * Throws rather than rounds when given finer precision than a paise: a price of ₹12.345
 * is a data-entry mistake, and silently storing ₹12.35 would make the stored catalogue
 * disagree with what an admin typed.
 */
export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('rupees must be a finite number');
  if (rupees < 0) throw new RangeError('rupees must not be negative');
  const scaled = Math.round(rupees * PAISE_PER_RUPEE);
  if (Math.abs(rupees * PAISE_PER_RUPEE - scaled) > 1e-6) {
    throw new RangeError(`${rupees} has sub-paise precision and cannot be stored as money`);
  }
  return BigInt(scaled);
}

/** Converts paise back to a rupee number for the API boundary. */
export function toRupees(paise: Paise): number {
  return Number(paise) / PAISE_PER_RUPEE;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<bigint>((total, value) => total + value, 0n);
}

/**
 * GST on one line, half-up to the paise.
 *
 * Spec §8: callers apply this **per line and then sum**, never to an aggregate. An invoice
 * whose tax does not equal the sum of its lines' tax cannot be reconciled.
 */
export function gstOn(basePaise: Paise, ratePercent: number): Paise {
  return divideHalfUp(basePaise * toBasisPoints(ratePercent), BASIS_POINTS);
}

/** Clamps a discount into `[0, amount]` so a total can never go negative. */
function clampDiscount(discount: bigint, amount: Paise): Paise {
  if (discount <= 0n) return 0n;
  return discount > amount ? amount : discount;
}

/** Percentage coupon, optionally capped by the coupon's `maxDiscountPaise`. */
export function applyPercent(amountPaise: Paise, percent: number, maxPaise?: Paise): Paise {
  const raw = divideHalfUp(amountPaise * toBasisPoints(percent), BASIS_POINTS);
  const capped = maxPaise !== undefined && raw > maxPaise ? maxPaise : raw;
  return clampDiscount(capped, amountPaise);
}

/** Flat-amount coupon. */
export function applyFlat(amountPaise: Paise, flatPaise: Paise): Paise {
  return clampDiscount(flatPaise, amountPaise);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @nutwala/shared`
Expected: PASS — 23 tests.

- [ ] **Step 5: Verify the build is clean under `strict`**

Run: `npm run build -w @nutwala/shared`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add shared/src/money.ts shared/src/money.test.ts
git commit -m "feat(shared): add paise money arithmetic with per-line GST rounding"
```

## Task 4: Shared constants and the order-status machine (TDD)

Spec §4.1. The Phase 1 frontend holds the canonical definitions of the Indian identifier formats and the brief §33 status vocabularies. They move here so the backend validates against the same rules.

**Files:**
- Create: `shared/src/constants/identifiers.ts`, `shared/src/constants/geography.ts`, `shared/src/constants/taxonomy.ts`, `shared/src/constants/order-status.ts`
- Test: `shared/src/constants/order-status.test.ts`
- Source to copy from: `frontend/src/features/checkout/schema.ts`, `frontend/src/features/account/types.ts`, `frontend/src/features/content/schema.ts`, `frontend/src/features/content/types.ts`, `frontend/src/features/rfq/schema.ts`

- [ ] **Step 1: Write `shared/src/constants/identifiers.ts`**

Copied verbatim from `frontend/src/features/checkout/schema.ts` lines 8–10. Do not "improve" these regexes; the frontend forms already validate against them and a change here silently changes what the site accepts.

```ts
/**
 * The three Indian identifier formats the site validates.
 *
 * Moved out of `frontend/src/features/checkout/schema.ts` so the backend's class-validator
 * DTOs and the frontend's zod schemas apply one definition. A second copy would drift the
 * moment one of them is corrected.
 */

/** 10 digits, starting 6–9, as issued for Indian mobile numbers. */
export const PHONE_REGEX = /^[6-9]\d{9}$/;

/** 6-digit Indian postal code. */
export const PINCODE_REGEX = /^\d{6}$/;

/** 15-character GSTIN: 2-digit state, 5-letter PAN prefix, 4 digits, letter, digit, Z, checksum. */
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/;
```

- [ ] **Step 2: Write `shared/src/constants/geography.ts`**

Copied verbatim from `frontend/src/features/checkout/schema.ts`.

```ts
/** Selectable states and union territories, as offered by the checkout address form. */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu & Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];
```

- [ ] **Step 3: Write `shared/src/constants/taxonomy.ts`**

`CONTACT_TOPICS` from `features/content/schema.ts`, `BLOG_CATEGORIES` from `features/content/types.ts`, and `BUSINESS_TYPES` / `PACKAGING_OPTIONS` / `ORDER_FREQUENCIES` from `features/rfq/schema.ts`, `GIFTING_OCCASIONS` from `features/gifting/schema.ts`. Every value below has been checked against those files.

```ts
/** Brief §28. The six editorial categories the blog is organised into. */
export const BLOG_CATEGORIES = [
  'Dry Fruit Guides',
  'Buying Guides',
  'Recipes',
  'Storage Tips',
  'B2B',
  'Nutrition Education',
] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

/** The reasons the contact form routes on. Kept short so the sales desk can triage. */
export const CONTACT_TOPICS = [
  'An order I have placed',
  'Shipping or delivery',
  'Returns or a damaged item',
  'Bulk and wholesale pricing',
  'Corporate gifting',
  'Something else',
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/**
 * Brief §14, verbatim from `frontend/src/features/rfq/schema.ts`.
 *
 * These are the exact strings the RFQ and business-profile selects already submit and that
 * the seeded RFQ fixtures already contain. Brief §14 words its list differently ("Retailers",
 * "Hotels / HORECA", "Food Manufacturers", "Resellers"); the frontend's wording wins, because
 * changing it would invalidate stored RFQ rows for no user-visible gain.
 */
export const BUSINESS_TYPES = [
  'Retail store',
  'Kirana / general store',
  'Sweet shop',
  'Bakery',
  'Café',
  'Restaurant or hotel',
  'Cloud kitchen',
  'Caterer',
  'Corporate gifting',
  'Distributor',
  'Health food brand',
  'Other',
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Brief §17 packaging preference, verbatim from `features/rfq/schema.ts`. */
export const PACKAGING_OPTIONS = [
  'Bulk sacks (25 kg)',
  'Vacuum packs (5 kg)',
  'Retail-ready pouches',
  'Custom / own branding',
  'No preference',
] as const;

export type PackagingOption = (typeof PACKAGING_OPTIONS)[number];

/** Brief §17 expected frequency, verbatim from `features/rfq/schema.ts`. */
export const ORDER_FREQUENCIES = [
  'One-time',
  'Weekly',
  'Fortnightly',
  'Monthly',
  'Quarterly',
] as const;

export type OrderFrequency = (typeof ORDER_FREQUENCIES)[number];

/** Brief §24 gifting occasions, verbatim from `features/gifting/schema.ts`. */
export const GIFTING_OCCASIONS = [
  'Diwali',
  'New Year',
  'Employee onboarding',
  'Client appreciation',
  'Wedding',
  'Conference or event',
  'Other',
] as const;

export type GiftingOccasion = (typeof GIFTING_OCCASIONS)[number];

/** Support ticket lifecycle. Spec §11. */
export const SUPPORT_TICKET_STATUSES = ['new', 'open', 'waiting', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/** Brief §34. RFQ pipeline as the sales desk works it. */
export const RFQ_STATUSES = [
  'new',
  'contacted',
  'quote-sent',
  'negotiation',
  'approved',
  'rejected',
  'converted',
] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
```

Note: `RFQ_STATUSES` is brief §34's full seven-state pipeline. The Phase 1 frontend types only four (`new | quoted | accepted | closed`) because Phase 1 had no sales desk. Plan 3 widens the frontend type to this tuple; a mapping is not needed because the frontend only ever displays the value.

- [ ] **Step 4: Write the failing tests for the status machine**

```ts
import { describe, expect, it } from 'vitest';
import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  canTransition,
  isTerminalStatus,
  nextStatuses,
} from './order-status';

describe('status vocabularies match brief §33 verbatim', () => {
  it('lists the nine retail statuses in order', () => {
    expect(B2C_ORDER_STATUSES).toEqual([
      'pending',
      'confirmed',
      'processing',
      'packed',
      'shipped',
      'out-for-delivery',
      'delivered',
      'cancelled',
      'refunded',
    ]);
  });

  it('lists the eight bulk statuses in order', () => {
    expect(B2B_ORDER_STATUSES).toEqual([
      'quote-requested',
      'quote-sent',
      'quote-accepted',
      'awaiting-payment',
      'approved',
      'processing',
      'shipped',
      'delivered',
    ]);
  });
});

describe('canTransition — retail', () => {
  it('allows each forward step of the happy path', () => {
    expect(canTransition('retail', 'pending', 'confirmed')).toBe(true);
    expect(canTransition('retail', 'confirmed', 'processing')).toBe(true);
    expect(canTransition('retail', 'processing', 'packed')).toBe(true);
    expect(canTransition('retail', 'packed', 'shipped')).toBe(true);
    expect(canTransition('retail', 'shipped', 'out-for-delivery')).toBe(true);
    expect(canTransition('retail', 'out-for-delivery', 'delivered')).toBe(true);
  });

  it('refuses to move backwards', () => {
    expect(canTransition('retail', 'delivered', 'pending')).toBe(false);
    expect(canTransition('retail', 'shipped', 'packed')).toBe(false);
  });

  it('refuses to skip a step', () => {
    expect(canTransition('retail', 'pending', 'shipped')).toBe(false);
    expect(canTransition('retail', 'confirmed', 'delivered')).toBe(false);
  });

  it('allows cancellation up to and including packed, but not after dispatch', () => {
    expect(canTransition('retail', 'pending', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'confirmed', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'processing', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'packed', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'shipped', 'cancelled')).toBe(false);
    expect(canTransition('retail', 'delivered', 'cancelled')).toBe(false);
  });

  it('allows a refund only from delivered', () => {
    expect(canTransition('retail', 'delivered', 'refunded')).toBe(true);
    expect(canTransition('retail', 'shipped', 'refunded')).toBe(false);
  });

  it('treats cancelled and refunded as terminal', () => {
    expect(nextStatuses('retail', 'cancelled')).toEqual([]);
    expect(nextStatuses('retail', 'refunded')).toEqual([]);
    expect(isTerminalStatus('retail', 'cancelled')).toBe(true);
    expect(isTerminalStatus('retail', 'refunded')).toBe(true);
    expect(isTerminalStatus('retail', 'delivered')).toBe(false);
  });

  it('rejects a status that is not in the retail vocabulary', () => {
    expect(canTransition('retail', 'pending', 'quote-sent')).toBe(false);
  });

  it('refuses a no-op transition, so a duplicate admin click is not recorded twice', () => {
    expect(canTransition('retail', 'confirmed', 'confirmed')).toBe(false);
  });
});

describe('canTransition — bulk', () => {
  it('walks the quote-first pipeline', () => {
    expect(canTransition('bulk', 'quote-requested', 'quote-sent')).toBe(true);
    expect(canTransition('bulk', 'quote-sent', 'quote-accepted')).toBe(true);
    expect(canTransition('bulk', 'quote-accepted', 'awaiting-payment')).toBe(true);
    expect(canTransition('bulk', 'awaiting-payment', 'approved')).toBe(true);
    expect(canTransition('bulk', 'approved', 'processing')).toBe(true);
    expect(canTransition('bulk', 'processing', 'shipped')).toBe(true);
    expect(canTransition('bulk', 'shipped', 'delivered')).toBe(true);
  });

  it('does not accept retail-only statuses', () => {
    expect(canTransition('bulk', 'processing', 'packed')).toBe(false);
    expect(canTransition('bulk', 'delivered', 'refunded')).toBe(false);
  });

  it('ends at delivered', () => {
    expect(isTerminalStatus('bulk', 'delivered')).toBe(true);
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npm run test -w @nutwala/shared`
Expected: FAIL — `canTransition is not a function`.

- [ ] **Step 6: Implement `shared/src/constants/order-status.ts`**

```ts
/**
 * Order status vocabularies and the legal transitions between them.
 *
 * The two tuples are verbatim from client brief §33 — do not invent, rename or reorder
 * entries. They were previously in `frontend/src/features/account/types.ts`, which carries
 * a warning that an earlier revision guessed at them and got them wrong.
 *
 * The transition maps are new in Phase 2. Phase 1 had no admin, so nothing could move an
 * order; now that admin can, an illegal move must be a rejected request rather than a
 * write that leaves the timeline nonsensical.
 */

export const B2C_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'packed',
  'shipped',
  'out-for-delivery',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export const B2B_ORDER_STATUSES = [
  'quote-requested',
  'quote-sent',
  'quote-accepted',
  'awaiting-payment',
  'approved',
  'processing',
  'shipped',
  'delivered',
] as const;

export type B2cOrderStatus = (typeof B2C_ORDER_STATUSES)[number];
export type B2bOrderStatus = (typeof B2B_ORDER_STATUSES)[number];
export type OrderStatus = B2cOrderStatus | B2bOrderStatus;

export type OrderChannel = 'retail' | 'bulk';

/**
 * Retail transitions. `cancelled` is reachable until the parcel is dispatched — after that
 * the goods are with a courier and the correct action is a return, not a cancellation.
 * `refunded` follows only `delivered`, so a refund always has a delivery behind it.
 */
const RETAIL_TRANSITIONS: Readonly<Record<B2cOrderStatus, readonly B2cOrderStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out-for-delivery'],
  'out-for-delivery': ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

/** Bulk transitions. A B2B order is quoted and approved before it is worked. */
const BULK_TRANSITIONS: Readonly<Record<B2bOrderStatus, readonly B2bOrderStatus[]>> = {
  'quote-requested': ['quote-sent'],
  'quote-sent': ['quote-accepted'],
  'quote-accepted': ['awaiting-payment'],
  'awaiting-payment': ['approved'],
  approved: ['processing'],
  processing: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
};

/** The statuses reachable in one step, or `[]` for a terminal or unknown status. */
export function nextStatuses(channel: OrderChannel, from: OrderStatus): readonly OrderStatus[] {
  if (channel === 'retail') {
    return RETAIL_TRANSITIONS[from as B2cOrderStatus] ?? [];
  }
  return BULK_TRANSITIONS[from as B2bOrderStatus] ?? [];
}

/**
 * Whether `from -> to` is legal for this channel.
 *
 * A no-op (`from === to`) is false: admin clicking the same status twice must not append a
 * second identical timeline event, which would read to the customer as the step happening
 * twice.
 */
export function canTransition(channel: OrderChannel, from: OrderStatus, to: OrderStatus): boolean {
  return nextStatuses(channel, from).includes(to);
}

/** A status with nowhere left to go. */
export function isTerminalStatus(channel: OrderChannel, status: OrderStatus): boolean {
  return nextStatuses(channel, status).length === 0;
}
```

- [ ] **Step 7: Run to verify the tests pass**

Run: `npm run test -w @nutwala/shared`
Expected: PASS — 36 tests (23 money, 13 order-status).

- [ ] **Step 8: Commit**

```bash
git add shared/src/constants
git commit -m "feat(shared): add identifier regexes, taxonomies and order-status machine"
```

## Task 5: Shared API contract types

Spec §4.1. These are the response shapes the backend must produce and the frontend already consumes. Putting them here means a backend response the frontend cannot read is a **compile error**, not something E2E discovers later.

**Files:**
- Create: `shared/src/types/api.ts`, `shared/src/types/auth.ts`, `shared/src/types/catalog.ts`, `shared/src/types/order.ts`

**A note on `stock`.** Phase 1's `Variant` carries `stock: number`, but a grep of `frontend/src/` shows only three consumers: the type declaration itself, the `inStockOnly` filter in `features/catalog/api/index.ts` (which moves server-side), and fixtures in `cart-math.test.ts`. **No component renders a sold-out state** — Phase 1 declared the field and never used it. So replacing `stock` with `available` + `soldOut` is safe, and building the SOLD OUT UI is new work in Plan 2, not a modification of existing UI.

- [ ] **Step 1: Write `shared/src/types/api.ts`**

```ts
/**
 * The transport envelope. Spec §3.1 departure 2: CUG returns `{ success, data }` from most
 * controllers but bare DTOs from auth, and Gateway returns raw payloads. This service emits
 * one shape from a global interceptor, so a client never has to guess.
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

/** Emitted by `GlobalExceptionFilter`. `stack` appears outside production only. */
export interface ApiError {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string;
  /** Stable machine-readable code, e.g. `OUT_OF_STOCK`. Absent for unclassified errors. */
  code?: string;
  errorId: string;
  requestId: string;
  /**
   * Machine-readable context, when there is any.
   *
   * `Record<string, unknown>` rather than `Record<string, string[]>`, because two different
   * shapes legitimately flow through here and the narrower type was a lie the filter had to
   * cast past:
   *
   * - **Validation failures** — field path to messages, e.g.
   *   `{ "shipping.pincode": ["Enter a valid 6-digit pincode"] }`, nested paths dotted.
   * - **Domain errors** — whatever the code needs, e.g. `OUT_OF_STOCK` carrying
   *   `{ available: 3, requested: 10 }` so the UI can say how many are left.
   *
   * Branch on `code` to know which you hold.
   */
  details?: Record<string, unknown>;
  stack?: string;
}

/**
 * An explicit opt-in for a handler that wants to set `message` on the envelope.
 *
 * The interceptor must not infer this from shape. `'data' in value` plus a string `message` looks
 * like a safe heuristic and is not: `SupportTicket` has a `message` column, so a genuine DTO
 * would be silently unwrapped, and a passed-through upstream `{ success, data }` payload would
 * trip the double-wrap guard and be emitted unenveloped. `__envelope` is a key no domain object
 * will ever carry.
 */
export interface Enveloped<T> {
  readonly __envelope: true;
  data: T;
  message?: string;
}

export function withMessage<T>(data: T, message: string): Enveloped<T> {
  return { __envelope: true, data, message };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}
```

- [ ] **Step 2: Write `shared/src/types/auth.ts`**

Carried from `frontend/src/features/auth/types.ts`, minus `DemoAccount` — Phase 1 advertised fixture logins on the sign-in screen because auth was a mock. Real auth must not advertise credentials, so that type and the UI reading it are deleted in Task 28.

```ts
/**
 * Brief §46 — one account serves both retail and bulk. There is no separate B2B login: the
 * same session gains bulk access by carrying `role: "b2b"`.
 *
 * The wire values stay `b2c` / `b2b` / `admin` to match what the Phase 1 frontend already
 * types and stores. The database enum is `CUSTOMER` / `BUSINESS` / `ADMIN` (spec §5.1); the
 * backend maps between them in one place, `UserMapper` (Task 31).
 */
export type Role = 'b2c' | 'b2b' | 'admin';

/** Only populated on a business account. `/business/profile` owns the fuller record. */
export interface CompanyProfile {
  companyName: string;
  contactPerson: string;
  businessType: string;
  gstin?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  company?: CompanyProfile;
  createdAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  /** The "I'm buying for a business" checkbox. True creates the account as `b2b`. */
  isBusiness: boolean;
  company?: CompanyProfile;
}
```

- [ ] **Step 3: Write `shared/src/types/catalog.ts`**

Carried from `frontend/src/features/catalog/types.ts` with the stock change described above.

```ts
export type Channel = 'retail' | 'bulk';
export type Badge = 'BESTSELLER' | 'NEW' | 'PREMIUM';

export interface Variant {
  sku: string;
  size: string;
  /** Canonical unit for per-100g and per-kg comparison (brief §47). */
  grams: number;
  channel: Channel;
  price: number;
  mrp: number;
  moq: number;
  /**
   * `onHand - reserved`, per spec §10.1. Replaces Phase 1's `stock`, which was declared but
   * never read by any component.
   */
  available: number;
  /** `available === 0`. Derived server-side so every client agrees on the rule. */
  soldOut: boolean;
}

export interface BulkTier {
  minKg: number;
  maxKg: number | null;
  /** Null means the tier requires a quote and routes to the RFQ flow. */
  pricePerKg: number | null;
}

export interface Seo {
  title: string;
  description: string;
  ogImage: string;
}

export interface Product {
  slug: string;
  name: string;
  category: string;
  subtitle: string;
  description: string;
  badge?: Badge;
  rating: number;
  reviewCount: number;
  images: string[];
  origin: string;
  grade: string;
  processing: string;
  shelfLife: string;
  storage: string;
  ingredients: string;
  hsn: string;
  gstRate: number;
  variants: Variant[];
  bulkTiers: BulkTier[];
  moqKg: number;
  quoteOnly?: boolean;
  /** True only when every active variant is sold out. Spec §10.1. */
  soldOut: boolean;
  seo: Seo;
}

export interface Category {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
}

export interface ComboComponent {
  slug: string;
  name: string;
  size: string;
  grams: number;
  price: number;
  mrp: number;
}

export interface Combo {
  slug: string;
  name: string;
  subtitle: string;
  blurb: string;
  occasion: string;
  image: string;
  price: number;
  partsMrp: number;
  partsPrice: number;
  savings: number;
  savingsPercent: number;
  totalGrams: number;
  components: ComboComponent[];
}

export type ProductSort =
  | 'featured'
  | 'best-selling'
  | 'price-asc'
  | 'price-desc'
  | 'newest'
  | 'rating';

export interface ProductFilters {
  category?: string;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  origin?: string;
  grade?: string;
  bestsellerOnly?: boolean;
  inStockOnly?: boolean;
  sort?: ProductSort;
}
```

- [ ] **Step 4: Write `shared/src/types/order.ts`**

Carried from `frontend/src/features/account/types.ts` and `features/checkout/schema.ts`. The status types are imported from the constants module rather than redeclared.

```ts
import type { OrderChannel, OrderStatus } from '../constants/order-status';

export interface Address {
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

/** An entry in the account address book. */
export interface SavedAddress extends Address {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface OrderEvent {
  status: OrderStatus;
  at: string;
  note?: string;
}

export interface OrderLine {
  slug?: string;
  name: string;
  /** Pack size for a retail line, "25 kg" for a bulk one. */
  detail: string;
  qty: number;
  /** Null when the line was fulfilled against a negotiated quote. */
  total: number | null;
}

export type PaymentMethod = 'cod' | 'online';
export type PaymentStatus = 'pending' | 'collected' | 'failed' | 'refunded';

export interface AccountOrder {
  /** `NN-{year}-{6 digits}`. */
  id: string;
  email: string;
  channel: OrderChannel;
  status: OrderStatus;
  placedAt: string;
  estimatedDelivery: string;
  /** Oldest first. The last entry always matches `status`. */
  timeline: OrderEvent[];
  items: OrderLine[];
  subtotal: number;
  discount: number;
  gst: number;
  shipping: number;
  total: number;
  address: Address;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  couponCode?: string;
  companyName?: string;
  gstin?: string;
  poNumber?: string;
}

export interface OrderFilters {
  channel?: OrderChannel;
}
```

Two additions to Phase 1's `AccountOrder`: `discount` (Phase 1 had no coupons wired) and `paymentMethod` / `paymentStatus` (Phase 1 had no payment concept). `email` is retained, but the backend derives it from the session rather than trusting a field, per spec §13.

- [ ] **Step 5: Build and verify `strict` passes**

Run: `npm run build -w @nutwala/shared && npm run test -w @nutwala/shared`
Expected: build clean, 36 tests pass.

- [ ] **Step 6: Commit**

```bash
git add shared/src/types
git commit -m "feat(shared): add API contract types for auth, catalog and orders"
```

## Task 6: Point the frontend at `@nutwala/shared`

Removes the duplicated constants so there is one definition. No component changes and no behaviour change — this task must leave the existing test suite green.

**Files:**
- Modify: `frontend/package.json`, `frontend/tsconfig.app.json`
- Modify: `frontend/src/features/checkout/schema.ts`, `frontend/src/features/account/types.ts`, `frontend/src/features/rfq/schema.ts`, `frontend/src/features/gifting/schema.ts`, `frontend/src/features/content/types.ts`, `frontend/src/features/content/schema.ts`, `frontend/src/features/catalog/types.ts`
- Modify: `frontend/src/features/cart/cart-math.test.ts`, `frontend/src/mocks/products.ts`

- [ ] **Step 1: Add the dependency**

```bash
npm pkg set dependencies.@nutwala/shared="*" -w frontend
npm install
```

Run: `ls -l frontend/node_modules/@nutwala/shared || ls -l node_modules/@nutwala/shared`
Expected: a symlink into `../../shared`.

- [ ] **Step 2: Re-export the shared constants from their current homes**

Keep the existing module paths exporting the same names, so no importing file changes. This is the smallest possible edit and keeps the diff reviewable.

In `frontend/src/features/checkout/schema.ts`, replace the three regex declarations and the `INDIAN_STATES` array with re-exports, leaving every zod schema in the file untouched:

```ts
import { z } from "zod";
import { GSTIN_REGEX, INDIAN_STATES, PHONE_REGEX, PINCODE_REGEX } from "@nutwala/shared";

/**
 * The identifier formats and the state list now live in `@nutwala/shared` so the backend's
 * class-validator DTOs apply exactly these rules. Re-exported here because the RFQ, gifting
 * and business-profile schemas already import them from this module.
 */
export { GSTIN_REGEX, INDIAN_STATES, PHONE_REGEX, PINCODE_REGEX };
```

Everything below that in the file — `addressSchema`, `b2cCheckoutSchema`, `b2bCheckoutSchema`, the inferred types — stays exactly as it is.

- [ ] **Step 3: Re-export the status tuples**

In `frontend/src/features/account/types.ts`, delete the two `as const` arrays and the three status type aliases, replacing them with:

```ts
import type { Address } from "@/features/checkout/schema";

/**
 * Brief §33's status vocabularies now live in `@nutwala/shared` so the backend's transition
 * machine and this file cannot disagree. The warning that used to sit here still applies:
 * these values are verbatim from the brief, and an earlier revision got them wrong by
 * guessing.
 */
export {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
} from "@nutwala/shared";
export type {
  B2bOrderStatus,
  B2cOrderStatus,
  OrderChannel,
  OrderEvent,
  OrderLine,
  OrderStatus,
} from "@nutwala/shared";
```

Then delete the local `OrderEvent`, `OrderLine`, `OrderChannel` interfaces and re-export `AccountOrder`, `OrderFilters` and `SavedAddress` from shared as well:

```ts
export type { AccountOrder, OrderFilters, SavedAddress } from "@nutwala/shared";
```

The file's remaining job is only to keep `@/features/account/types` working as an import path.

- [ ] **Step 3b: Re-export the auth types, aliasing `AuthUser` back to `User`**

`shared/src/types/auth.ts` names the type `AuthUser`; the frontend calls it `User` and three
files import that name (`features/auth/api/index.ts`, `test/routes.smoke.test.tsx`,
`test/routes.coverage.test.tsx`). Alias rather than rename, so no call site changes:

```ts
/**
 * The auth domain types now live in `@nutwala/shared`. `AuthUser` is re-exported as `User`
 * because that is the name this codebase already uses; renaming three files' imports to gain
 * nothing would be churn.
 *
 * `DemoAccount` is deliberately gone. Phase 1 advertised fixture logins on the sign-in screen
 * because auth was a mock — a real sign-in screen must not publish credentials. Task 28
 * removes the UI that rendered them.
 */
export type {
  AuthUser as User,
  CompanyProfile,
  Credentials,
  RegisterInput,
  Role,
} from "@nutwala/shared";
```

Delete the local `User`, `Role`, `CompanyProfile`, `Credentials`, `RegisterInput` and
`DemoAccount` declarations from `frontend/src/features/auth/types.ts`.

- [ ] **Step 4: Re-export the taxonomies**

`frontend/src/features/content/types.ts` — replace the local `BLOG_CATEGORIES` array with a
re-export, keeping `BlogPost`, `ContactMessageDraft` and `ContactMessage` as they are.

**Careful:** `export type { BlogCategory } from "@nutwala/shared";` alone will **not** compile
here. A re-export-from statement forwards a name without binding it in the local scope, and
`BlogPost.category: BlogCategory` needs it bound. Import first, then re-export:

```ts
import type { BlogCategory } from "@nutwala/shared";

export { BLOG_CATEGORIES } from "@nutwala/shared";
export type { BlogCategory };
```

The same applies to any other file where a re-exported type is also *referenced* in the same
module. Where a file only forwards names it never uses itself — `catalog/types.ts`, for example
— the plain `export type { ... } from` form is correct.

`frontend/src/features/content/schema.ts` — replace the local `CONTACT_TOPICS` array with `export { CONTACT_TOPICS } from "@nutwala/shared";`, keeping `contactSchema`.

`frontend/src/features/rfq/schema.ts` — replace `BUSINESS_TYPES`, `PACKAGING_OPTIONS` and `ORDER_FREQUENCIES` with re-exports from `@nutwala/shared`, keeping every zod schema.

`frontend/src/features/gifting/schema.ts` — replace `GIFTING_OCCASIONS` with a re-export, keeping `giftingSchema`.

- [ ] **Step 5: Adopt the shared catalog types**

`frontend/src/features/catalog/types.ts` becomes a re-export, because every one of its types now lives in shared:

```ts
/**
 * The catalogue domain types live in `@nutwala/shared` so the backend compiles against the
 * same shapes it must serve. This module remains as the import path components already use.
 */
export type {
  Badge,
  BulkTier,
  Category,
  Channel,
  Combo,
  ComboComponent,
  Product,
  ProductFilters,
  ProductSort,
  Seo,
  Variant,
} from "@nutwala/shared";
```

- [ ] **Step 6: Fix every place that constructs a `Variant` or an `AccountOrder`**

Adopting the shared types changes two shapes, so three files need updating. Miss any one and
`npm run typecheck -w frontend` fails.

**6a. `Variant` no longer has `stock`; it has `available` and `soldOut`.**

In `frontend/src/mocks/products.ts`, change `buildVariants` so each returned retail and bulk variant replaces `stock: 120` with:

```ts
      available: 120,
      soldOut: false,
```

In `frontend/src/features/cart/cart-math.test.ts` lines 25–26, replace `stock: 10` with `available: 10, soldOut: false` in both fixtures.

In `frontend/src/features/catalog/api/index.ts` line 14, change the filter to read the new field:

```ts
  if (f.inStockOnly) out = out.filter((p) => p.variants.some((v) => v.available > 0));
```

**6b. `AccountOrder` gained three required fields** — `discount`, `paymentMethod` and
`paymentStatus`. Phase 1 had neither coupons nor a payment concept, so nothing currently
supplies them, and two files construct `AccountOrder` values.

In `frontend/src/mocks/orders.ts`, extend the `money()` helper (around line 46) so the discount
is derived in one place rather than repeated per order:

```ts
/** Flat 5% GST, matching every product in the seed catalogue, and the ₹79 flat shipping. */
function money(items: OrderLine[], shipping: number) {
  const subtotal = items.reduce((sum, i) => sum + (i.total ?? 0), 0);
  const gst = Math.round(subtotal * 0.05);
  // No coupon applies to any seeded order, so the discount is zero everywhere. It is returned
  // rather than omitted because `AccountOrder.discount` is required.
  const discount = 0;
  return { subtotal, discount, gst, shipping, total: subtotal - discount + gst + shipping };
}
```

Then add `paymentMethod: "cod"` to each of the six seeded orders — COD is the only method the
store offers — plus the matching `paymentStatus`. The mapping follows the order state, which is
the same rule Task 20's seeder applies to these same six records:

| Order status | `paymentStatus` |
|---|---|
| `delivered` | `"collected"` |
| `refunded` | `"refunded"` |
| `cancelled` | `"pending"` — never collected |
| anything still in flight | `"pending"` |

In `frontend/src/features/account/api/index.ts`, `fromReceipt` builds an `AccountOrder` from a
checkout receipt. Add the same three fields to its return value:

```ts
    subtotal,
    discount: 0,
    gst,
    shipping,
    total: record.amount,
    address: record.address,
    paymentMethod: "cod",
    // Just placed, so nothing has been collected yet.
    paymentStatus: "pending",
```

`fromReceipt` derives `shipping` as the residue of `record.amount - subtotal - gst`. With
`discount` always zero that arithmetic is unchanged, so leave it alone.

**6c. `Product` gained a required `soldOut: boolean`.** The frontend's `Product` has no such
field and `mocks/products.ts` builds product literals without it. Derive it from the variants
rather than hardcoding `false`, so the mock tells the truth if a variant's stock is ever edited
to zero during development:

```ts
export const products: Product[] = seeds.map((s) => {
  const variants = buildVariants(s.slug, s.kg);
  return {
    slug: s.slug,
    // … every existing field unchanged …
    variants,
    // Product-level sold-out means every variant is out, per spec §10.1. Derived so it cannot
    // disagree with the variants beside it.
    soldOut: variants.every((v) => v.available === 0),
    bulkTiers: buildTiers(s.kg),
```

Note this requires converting the existing `seeds.map((s) => ({ … }))` arrow-with-implicit-return
into a block body so `variants` can be bound once and used twice.

**6d. `OrderFilters` no longer has `email` — and that is deliberate.**

`frontend/src/features/account/api/index.ts:90` currently declares
`listOrders: ({ email, channel }: OrderFilters = {})` and filters `o.email === email`. Shared's
`OrderFilters` has only `channel`, so re-exporting it breaks this line.

**Do not add `email` back to the shared type.** `GET /account/orders` derives the owner from the
session; a request type that lets a client name an arbitrary email is precisely the IDOR vector
spec §13 forbids. The shared type being unable to express "someone else's orders" is a security
property worth keeping.

Instead, give the mock its own local widening, documented as temporary:

```ts
/**
 * The mock needs to scope seeded orders to an account, which the real endpoint does from the
 * session instead — `OrderFilters` deliberately cannot carry an email, because a client able
 * to filter by arbitrary address is the IDOR hole spec §13 rules out. Plan 2 replaces this
 * function with `GET /account/orders` and this local type disappears with it.
 */
type MockOrderFilters = OrderFilters & { email?: string };
```

and change the signature to `listOrders: ({ email, channel }: MockOrderFilters = {})`. The body
is unchanged.

**6e. `AccountOrder.couponCode`** is a fourth new field but it is optional, so existing order
fixtures stay valid with no edit. Nothing to do.

- [ ] **Step 7: Allow the frontend to resolve the workspace package**

`frontend/tsconfig.app.json` already resolves `@/*`. Confirm it does not set `"types"` in a way that excludes node_modules resolution, and that `moduleResolution` is `bundler` or `node16`+. If the build cannot find `@nutwala/shared`, add to `compilerOptions`:

```json
    "paths": {
      "@/*": ["./src/*"],
      "@nutwala/shared": ["../shared/src/index.ts"]
    }
```

Prefer the built `dist` resolution; use the source path only if Vite fails to resolve the package.

- [ ] **Step 8: Confirm live edits to `shared/` reach the frontend**

This is the first task where anything consumes `@nutwala/shared`, so it is the first task where a
stale `shared/dist` can mislead. Verify the loop actually closes:

1. Start `npm run dev`. Confirm `concurrently` shows three prefixed streams — `shared`, `backend`
   (which will fail until Task 7, that is expected) and `frontend`.
2. With the frontend running, add a throwaway export to `shared/src/constants/identifiers.ts`,
   e.g. `export const PROBE = 1;`.
3. Confirm the `shared` stream rebuilds and that importing `PROBE` in a frontend file
   typechecks without a manual build.
4. Remove the probe and confirm `git status` is clean.

If step 3 fails, the frontend is resolving a stale `dist`. Fix it by adding to
`frontend/tsconfig.app.json`:

```json
    "references": [{ "path": "../shared" }]
```

Do not work around it by telling the developer to run the build by hand.

- [ ] **Step 9: Verify nothing regressed**

Run: `npm run build -w @nutwala/shared && npm run typecheck -w frontend && npm run test -w frontend && npm run lint -w frontend`
Expected: all pass. The frontend suite is the Phase 1 suite — it must stay green, because this task is a refactor with no intended behaviour change.

If `routes.smoke.test.tsx` or `routes.coverage.test.tsx` fail, the cause is a renamed export, not a real regression. Fix the export, do not weaken the test.

- [ ] **Step 10: Commit**

```bash
git add frontend shared package-lock.json
git commit -m "refactor(frontend): source domain constants and types from @nutwala/shared"
```

## Task 7: Scaffold the NestJS backend

Mirrors `mf-lenders-gateway`'s layout and `cug`'s `strict: true` and tooling.

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/tsconfig.build.json`, `backend/nest-cli.json`, `backend/.prettierrc`, `backend/eslint.config.mjs`, `backend/src/load-env.ts`, `backend/src/common/money/bigint-json.ts`

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "backend",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\" \"test/**/*.ts\"",
    "typecheck": "tsc --noEmit",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:integration": "jest --config jest.integration.config.ts --runInBand",
    "test:e2e": "jest --config jest.e2e.config.ts --runInBand",
    "typeorm": "typeorm-ts-node-commonjs -d src/data-source.ts",
    "migration:run": "npm run typeorm -- migration:run",
    "migration:revert": "npm run typeorm -- migration:revert",
    "migration:show": "npm run typeorm -- migration:show",
    "migration:generate": "typeorm-ts-node-commonjs -d src/data-source.ts migration:generate",
    "migration:create": "typeorm-ts-node-commonjs migration:create",
    "seed": "ts-node -r tsconfig-paths/register src/database/seeds/seed.ts"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/config": "^4.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/jwt": "^11.0.0",
    "@nestjs/passport": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/swagger": "^11.0.0",
    "@nestjs/throttler": "^6.4.0",
    "@nestjs/typeorm": "^11.0.0",
    "@nutwala/shared": "*",
    "bcrypt": "^6.0.0",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.1",
    "cookie-parser": "^1.4.7",
    "dotenv": "^16.4.7",
    "express-basic-auth": "^1.2.1",
    "helmet": "^8.0.0",
    "passport": "^0.7.0",
    "passport-jwt": "^4.0.1",
    "pg": "^8.13.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "typeorm": "0.3.31",
    "winston": "^3.17.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@testcontainers/postgresql": "^12.1.0",
    "@types/bcrypt": "^5.0.2",
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.7",
    "@types/passport-jwt": "^4.0.1",
    "@types/supertest": "^6.0.2",
    "eslint": "^9.18.0",
    "eslint-config-prettier": "^10.0.1",
    "jest": "^29.7.0",
    "prettier": "^3.4.2",
    "supertest": "^7.0.0",
    "testcontainers": "^12.1.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "~5.7.3",
    "typescript-eslint": "^8.21.0"
  }
}
```

- [ ] **Step 2: Create `backend/tsconfig.json`**

CUG's settings: `commonjs`, decorators on, `@/*` alias, `strict: true`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "baseUrl": "./src",
    "paths": { "@/*": ["*"] },
    "declaration": false,
    "sourceMap": true,
    "incremental": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

`strictPropertyInitialization` is off because TypeORM entity columns and class-validator DTO fields are plain fields with no initialiser, and `!` on every one of them is mechanical boilerplate. Everything else in `strict` stays on.

**This is a divergence from cug, not a mirror of it** — worth stating plainly, because the plan previously claimed otherwise. cug leaves the flag on (inherited from `strict`) and writes `!` on every `@Column` field instead. We take the global carve-out because ~33 entities plus DTOs are coming; the cost, which is real, is that the check weakens for every hand-written class and not just entities. TypeScript options are program-wide, so the only alternative was cug's per-field `!` — there is no per-directory override short of project references, which would be a larger and less welcome divergence.

Note the driver is *fields*, not constructor injection: `constructor(private readonly x: Foo) {}` — Nest's idiomatic style — is treated as initialised either way.

**There is deliberately no `rootDir` here.** This config is what `tsc --noEmit` and eslint read, and its `include` covers `test/**/*`, which sits above `./src`. TypeScript rejects an included file above its `rootDir` with TS6059 *even when not emitting*, so setting it here breaks `npm run typecheck`. `rootDir` belongs in `tsconfig.build.json`, which excludes `test` and is the only config that emits.

- [ ] **Step 3: Create `backend/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "incremental": false
  },
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts"]
}
```

`rootDir` is set here rather than in the base config so `dist` stays flat — `dist/main.js`, not `dist/src/main.js` — while leaving `tsc --noEmit` free to typecheck `test/` as well.

**`incremental: false` must stay false.** `nest-cli.json` sets `deleteOutDir`, which wipes `dist`
before every build. An incremental build then reads `tsconfig.build.tsbuildinfo`, concludes
everything is already up to date, and emits **nothing** — leaving an empty `dist` and exiting 0.
Verified: with `incremental` inherited as true, the first build emitted 13 files and every
subsequent build emitted zero, silently. A deploy would have shipped an artifact containing no
code. Confirm repeatability by running `npm run build -w backend` three times and checking
`find backend/dist -name '*.js' | wc -l` is non-zero and identical each time.

- [ ] **Step 4: Create `backend/nest-cli.json`**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "tsConfigPath": "tsconfig.build.json"
  }
}
```

- [ ] **Step 5: Create `backend/.prettierrc`**

Matching both existing repos exactly.

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true
}
```

- [ ] **Step 6: Create `backend/eslint.config.mjs`**

Flat config, because eslint 9 no longer reads `.eslintrc.json` — CUG's legacy `.eslintrc.json` is likely being ignored in that repo for exactly this reason.

```js
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      /**
       * Money columns must go through `PaiseColumn`, never a bare `@Column({ type: 'bigint' })`.
       * Without the transformer, `pg` hands the column back as a *string* and totals silently
       * concatenate — a wrong-invoice bug no type error catches, so it earns a syntactic guard.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='Column'] Property[key.name='type'][value.value='bigint']",
          message:
            "Use @PaiseColumn() from common/money/paise.transformer instead of a bare @Column({ type: 'bigint' }).",
        },
      ],
    },
  },
  // The helper itself is where the canonical `type: 'bigint'` legitimately lives.
  {
    files: ['src/common/money/paise.transformer.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
```

`no-explicit-any` is `error` here, unlike both existing repos where it is `off`. New code has no legacy to grandfather, and `any` in a service that handles money or authorization is how type safety silently stops helping.

Be honest about its limit, though: the rule flags only the literal `any` spelling and says nothing about `as unknown as X`, which discards structural checking just as completely while being harder to grep for and harder to review. House convention, recorded in the config's own comment: where a runtime shape check already exists, write a named type predicate and let the compiler narrow, rather than asserting past it with a double cast.

Add `@eslint/js` to devDependencies: `npm pkg set devDependencies.@eslint/js="^9.18.0" -w backend`

- [ ] **Step 7: Create `backend/src/load-env.ts`**

Gateway's pattern, including the reason it must be a side-effect module imported first.

```ts
/**
 * Side-effect-only module. It MUST be the first import in `main.ts`.
 *
 * Two reasons, both learned in mf-lenders-gateway:
 *
 * 1. Static imports hoist above inline statements, so calling `dotenv.config()` in the body
 *    of `main.ts` would run *after* every imported module had already read `process.env`.
 * 2. `override: true` is required because PM2 caches a process's first environment and
 *    re-injects it on `pm2 restart`, so without it an edited `.env` has no effect.
 *
 * There is deliberately **no `.env.test` file**, and one must not be added. `dotenv.config`
 * against a missing path is a silent no-op, which is exactly what the tests want: unit tests set
 * what they need directly in `test/setup.ts`, and the integration tests get their `DB_HOST` and
 * `DB_PORT` from testcontainers at runtime. A real `.env.test` combined with `override: true`
 * would clobber those dynamically-assigned ports and break every integration test.
 */
import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config({
  path: path.resolve(process.cwd(), process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
  override: true,
});
```

- [ ] **Step 8: Create `backend/src/common/money/bigint-json.ts`**

```ts
/**
 * Nest's response serialiser throws `TypeError: Do not know how to serialize a BigInt` the
 * first time a `bigint` reaches `JSON.stringify`. Money columns are `bigint` paise, so this
 * must be installed before anything serialises a response.
 *
 * Emitting a string rather than a number is deliberate: a paise value large enough to lose
 * precision as an IEEE-754 double must not silently round. API responses convert money to
 * rupee numbers via `toRupees` anyway; this polyfill is the safety net for anything that
 * slips through, and a string is visible in a test where a rounded number would not be.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

export {};
```

**Two version choices that deviate from the reference repos, both for security.**

`typeorm` is `0.3.31`, not Gateway's `0.3.28`. Two advisories affect `<=0.3.30`: a SQL injection
in `UpdateQueryBuilder`/`SoftDeleteQueryBuilder` `orderBy` (MySQL/MariaDB only, so it does not
reach this Postgres service) and a `migration:generate` template-literal injection (a dev-time
tool). Neither is critical here, but 0.3.31 is a patch inside 0.3.x and a fixed CVE outweighs
matching Gateway's pin exactly.

`testcontainers` and `@testcontainers/postgresql` are `^12`, not `^10`. The v10 line pulls
`dockerode` -> `undici <=6.27.0`, which carries a **high**-severity set including HTTP
request/response smuggling and CRLF injection. It is a devDependency, so nothing vulnerable
ships — but the bump is free right now because no code uses testcontainers until Task 13, and
taking it later would mean migrating working test infrastructure. `npm audit` reports zero
vulnerabilities after both changes; verify that in Step 9.

- [ ] **Step 9: Install and verify the toolchain runs**

Run: `npm install && npm run lint -w backend && npm audit --audit-level=high --prefix backend`
Expected: install succeeds; **lint passes cleanly with exit 0**; audit reports zero
vulnerabilities.

The lint script is `eslint .` rather than explicit globs, because a glob for `test/**/*.ts` exits
2 until Task 13 creates that directory — and a lint script that cannot pass is one nobody runs.
`eslint .` needs two things from the Step 6 flat config to work: type-aware rules scoped to
`files: ['**/*.ts']`, so eslint does not try to type-check its own ESM config file, and
`projectService.allowDefaultProject: ['*.config.ts']`, so root-level tooling configs still lint
— they sit outside tsconfig's `include` and cannot be added to it, because `rootDir` is `./src`
and tsc rejects an included file above its rootDir.

- [ ] **Step 10: Commit**

```bash
git add backend package.json package-lock.json
git commit -m "build: scaffold NestJS backend workspace matching cug/gateway conventions"
```

## Task 8: Environment schema and typed config

Spec §3.1 departure 5. Both existing repos read env with inline defaults and IIFE throws; this uses one parse-and-narrow at boot so a misconfigured service fails immediately with every problem listed, rather than at the first request that touches a missing value.

**Files:**
- Create: `backend/src/common/config/env.schema.ts`, `backend/src/common/config/app.config.ts`
- Test: `backend/src/common/config/env.schema.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { loadEnv } from './env.schema';

const valid = {
  NODE_ENV: 'development',
  DB_HOST: 'localhost',
  DB_USER: 'nutwala',
  DB_PASSWORD: 'nutwala_dev_only',
  DB_NAME: 'nutwala',
  JWT_SECRET: 'a'.repeat(48),
  CORS_ORIGINS: 'http://localhost:5173',
  SWAGGER_USER: 'docs',
  SWAGGER_PASSWORD: 'docs',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4400);
    expect(env.DB_PORT).toBe(5432);
    expect(env.DB_SCHEMA).toBe('public');
    expect(env.DB_MIGRATIONS_RUN).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric strings', () => {
    const env = loadEnv({ ...valid, PORT: '4100', DB_PORT: '5433' });
    expect(env.PORT).toBe(4100);
    expect(env.DB_PORT).toBe(5433);
  });

  it('splits CORS origins into a list', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('reports every problem at once rather than the first', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow(/DB_HOST/);
    try {
      loadEnv({ NODE_ENV: 'development' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/DB_HOST/);
      expect(message).toMatch(/JWT_SECRET/);
      expect(message).toMatch(/SWAGGER_PASSWORD/);
    }
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'too-short' })).toThrow(/32 characters/);
  });

  it('refuses the .env.example placeholder secret in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'replace_me_min_32_chars_generate_with_openssl_rand',
      }),
    ).toThrow(/placeholder/i);
  });

  it('requires secure cookies in production', () => {
    expect(() =>
      loadEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('rejects a wildcard CORS origin, which cannot carry credentials anyway', () => {
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: '*' })).toThrow(/wildcard/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w backend -- env.schema`
Expected: FAIL — cannot find module `./env.schema`.

- [ ] **Step 3: Implement `backend/src/common/config/env.schema.ts`**

```ts
import { z } from 'zod';

/**
 * One parse-and-narrow of `process.env` at boot.
 *
 * CUG and Gateway read configuration with inline `config.get('X', 'default')` calls and a
 * few IIFE throws for must-have secrets. That works, but a typo in a rarely-read variable
 * only surfaces on the request that needs it. Parsing everything once means a misconfigured
 * service refuses to start and prints every problem together.
 */

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4400),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_SCHEMA: z.string().min(1).default('public'),
  /**
   * Off by default, matching Gateway: an unreviewed migration must never auto-apply when a
   * process restarts.
   */
  DB_MIGRATIONS_RUN: booleanish.default('false'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().min(2).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().min(1).default('localhost'),
  COOKIE_SECURE: booleanish.default('false'),

  CORS_ORIGINS: z
    .string()
    .min(1)
    .refine((value) => !value.split(',').some((origin) => origin.trim() === '*'), {
      message: 'CORS_ORIGINS must not contain a wildcard: credentialed requests require an explicit allowlist',
    })
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  SWAGGER_USER: z.string().min(1),
  SWAGGER_PASSWORD: z.string().min(1),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

const PLACEHOLDER_MARKER = 'replace_me';

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // Production-only assertions. These are not schema rules because the same schema has to
  // accept a relaxed development environment.
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.includes(PLACEHOLDER_MARKER)) {
      throw new Error('JWT_SECRET is still the .env.example placeholder; generate one with `openssl rand -base64 48`');
    }
    if (env.SWAGGER_PASSWORD.includes(PLACEHOLDER_MARKER)) {
      throw new Error('SWAGGER_PASSWORD is still the .env.example placeholder');
    }
    if (!env.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production: the session cookie carries the access token');
    }
  }

  return env;
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm run test -w backend -- env.schema`
Expected: PASS — 8 tests.

Then confirm the whole workspace is healthy, not just the new test:

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run build -w backend`
Expected: all three exit 0.

- [ ] **Step 5: Implement `backend/src/common/config/app.config.ts`**

```ts
import { registerAs } from '@nestjs/config';
import { loadEnv, type Env } from './env.schema';

/**
 * Typed configuration, grouped the way CUG groups its `AppConfig`. Read it with
 * `configService.get<AppConfiguration>('app')` and destructure — never reach for
 * `process.env` outside this module.
 */
export interface AppConfiguration {
  env: Env['NODE_ENV'];
  port: number;
  isProduction: boolean;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    schema: string;
    migrationsRun: boolean;
  };
  auth: {
    jwtSecret: string;
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
    cookieDomain: string;
    cookieSecure: boolean;
  };
  cors: { origins: string[] };
  swagger: { user: string; password: string };
  logging: { level: Env['LOG_LEVEL'] };
}

export const APP_CONFIG_KEY = 'app';

export const appConfig = registerAs(APP_CONFIG_KEY, (): AppConfiguration => {
  const env = loadEnv();

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    isProduction: env.NODE_ENV === 'production',
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      schema: env.DB_SCHEMA,
      migrationsRun: env.DB_MIGRATIONS_RUN,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      cookieDomain: env.COOKIE_DOMAIN,
      cookieSecure: env.COOKIE_SECURE,
    },
    cors: { origins: env.CORS_ORIGINS },
    swagger: { user: env.SWAGGER_USER, password: env.SWAGGER_PASSWORD },
    logging: { level: env.LOG_LEVEL },
  };
});
```

- [ ] **Step 6: Create a working `backend/.env` from the example**

```bash
cp .env.example backend/.env
```

Then edit `backend/.env`: set `JWT_SECRET` to the output of `openssl rand -base64 48`, `DB_PASSWORD=nutwala_dev_only`, and `SWAGGER_PASSWORD` to anything local. Confirm it is ignored:

Run: `git check-ignore -v backend/.env`
Expected: a line showing `.gitignore` matched `.env`. If it prints nothing, **stop** — the file would be committed.

- [ ] **Step 7: Commit**

```bash
git add backend/src/common/config
git commit -m "feat(backend): add fail-fast environment schema and typed app config"
```

## Task 9: PII redaction and structured logging (TDD)

Spec §13, "PII in logs". Both existing repos redact recursively against a shared field-name list; this reproduces that with a distinction they do not make — credentials are removed entirely, contact details are masked so logs stay useful for support.

**Files:**
- Create: `backend/src/common/logging/pii-redactor.ts`, `backend/src/common/logging/request-context.ts`, `backend/src/common/config/winston.config.ts`, `backend/src/common/logging/winston-logger.service.ts`, `backend/src/common/logging/logging.module.ts`, `backend/src/common/middleware/request-tracking.middleware.ts`
- Test: `backend/src/common/logging/pii-redactor.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { redact } from './pii-redactor';

describe('redact — credentials', () => {
  it('removes a password', () => {
    expect(redact({ email: 'a@b.test', password: 'hunter2' })).toMatchObject({
      password: '[REDACTED]',
    });
  });

  it('matches field names case-insensitively and as substrings', () => {
    const result = redact({
      Password: 'x',
      passwordHash: 'x',
      refresh_token: 'x',
      accessToken: 'x',
      Authorization: 'Bearer x',
      Cookie: 'nn_access_token=x',
      csrfToken: 'x',
      apiKey: 'x',
      clientSecret: 'x',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('redacts nested objects', () => {
    expect(redact({ body: { user: { password: 'x' } } })).toEqual({
      body: { user: { password: '[REDACTED]' } },
    });
  });

  it('redacts inside arrays', () => {
    expect(redact({ users: [{ password: 'x' }, { password: 'y' }] })).toEqual({
      users: [{ password: '[REDACTED]' }, { password: '[REDACTED]' }],
    });
  });

  it('catches separator-broken key names, notably the X-API-Key header', () => {
    // A plain substring match on the raw key misses `x-api-key`, because the hyphens break
    // `apikey` apart. That is the most common API-key header name there is, so any handler
    // logging `req.headers` would have written a caller's key out in plaintext.
    const result = redact({
      'X-API-Key': 'sk_live_abc',
      'x-api-key': 'sk_live_abc',
      api_key: 'sk_live_abc',
      'api.key': 'sk_live_abc',
      bearerToken: 'x',
      privateKey: 'x',
      cvv: '123',
      aadhaarNumber: 'x',
      panNumber: 'x',
      creditCardNumber: 'x',
      accountNumber: 'x',
      pwd: 'x',
    }) as Record<string, unknown>;

    for (const [key, value] of Object.entries(result)) {
      expect(value).toBe('[REDACTED]');
      expect(key).toBeTruthy();
    }
  });

  it('does not redact innocent fields that merely contain a credential substring', () => {
    // The guard that matters most. Substring matching is easy to widen carelessly: `auth` would
    // swallow `author`, `pin` would swallow `shipping`, `pan` would swallow `company`. A future
    // addition that breaks this should fail loudly rather than quietly gutting order and review
    // logs. `sessionId` stays visible too — it identifies a session but cannot authenticate one,
    // and it is what makes a request traceable across log lines.
    expect(
      redact({
        author: 'Asha Rao',
        shipping: 79,
        company: 'Sharma Sweets',
        orderNumber: 'NN-2026-000123',
        trackingNumber: 'TRK-99',
        ticketNumber: 'SUP-2026-000001',
        rfqNumber: 'RFQ-2026-000001',
        sessionId: 'b2c-session-uuid',
      }),
    ).toEqual({
      author: 'Asha Rao',
      shipping: 79,
      company: 'Sharma Sweets',
      orderNumber: 'NN-2026-000123',
      trackingNumber: 'TRK-99',
      ticketNumber: 'SUP-2026-000001',
      rfqNumber: 'RFQ-2026-000001',
      sessionId: 'b2c-session-uuid',
    });
  });
});

describe('redact — contact details are masked, not removed', () => {
  it('masks an email but keeps the domain, so support can still triage', () => {
    expect(redact({ email: 'kunal@example.com' })).toEqual({ email: 'k***@example.com' });
  });

  it('masks a phone number to its last four digits', () => {
    expect(redact({ phone: '9876543210' })).toEqual({ phone: '******3210' });
    expect(redact({ mobile: '9876543210' })).toEqual({ mobile: '******3210' });
  });

  it('masks a GSTIN to its trailing characters', () => {
    expect(redact({ gstin: '27AAPFU0939F1ZV' })).toEqual({ gstin: '***********F1ZV' });
  });

  it('leaves a malformed email masked rather than echoing it', () => {
    expect(redact({ email: 'not-an-email' })).toEqual({ email: '[REDACTED]' });
  });
});

describe('redact — structural safety', () => {
  it('leaves non-sensitive values untouched', () => {
    expect(redact({ orderNumber: 'NN-2026-000123', qty: 3, ok: true })).toEqual({
      orderNumber: 'NN-2026-000123',
      qty: 3,
      ok: true,
    });
  });

  it('replaces a circular reference instead of overflowing the stack', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('preserves Date, Error and primitive inputs', () => {
    const when = new Date('2026-08-19T00:00:00.000Z');
    expect(redact({ when })).toEqual({ when: when.toISOString() });
    expect(redact('plain string')).toBe('plain string');
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('truncates a very long string so one log line cannot flood the transport', () => {
    const result = redact({ body: 'x'.repeat(5000) }) as { body: string };
    expect(result.body.length).toBeLessThan(2100);
    expect(result.body).toMatch(/truncated/);
  });

  it('does not mutate its input', () => {
    const input = { password: 'hunter2' };
    redact(input);
    expect(input.password).toBe('hunter2');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w backend -- pii-redactor`
Expected: FAIL — cannot find module `./pii-redactor`.

- [ ] **Step 3: Implement `backend/src/common/logging/pii-redactor.ts`**

```ts
/**
 * Recursive log scrubber, modelled on the `sanitize()` in both cug and mf-lenders-gateway.
 *
 * The one thing it does differently: credentials are removed, but contact details are
 * *masked*. A support engineer reading logs needs to tell one customer's request from
 * another's; `[REDACTED]` everywhere makes an incident unreadable, while a full email
 * address in a log aggregator is a data-protection problem. Masking keeps both properties.
 */

/**
 * Matched against the *normalised* key — lowercased with non-alphanumerics stripped. Anything
 * matching is removed outright.
 *
 * Entries must be long enough not to collide with innocent field names, because the match is a
 * substring. `auth` would redact `author` (a real Review and BlogPost column), `pin` would
 * redact `shipping`, and `pan` would redact `company` — hence `pannumber`. Do not shorten these.
 */
const CREDENTIAL_KEY_PARTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'bearer',
  'authorization',
  'cookie',
  'csrf',
  'apikey',
  'jwt',
  'otp',
  'hash',
  'signature',
  'privatekey',
  'cvv',
  'aadhaar',
  'pannumber',
  'creditcard',
  'cardnumber',
  'accountnumber',
] as const;

/** Exact-matched (lowercased) keys whose values are masked rather than removed. */
const MASKED_KEYS = new Set(['email', 'phone', 'mobile', 'gstin', 'pincode']);

const REDACTED = '[REDACTED]';
const MAX_STRING_LENGTH = 2000;

/**
 * Aggregate budget across the whole walk. `MAX_STRING_LENGTH` alone caps a single leaf, not the
 * payload — an object of 500 fields at 2000 chars each still serialises to about a megabyte, and
 * a bulk RFQ body or a long support note can reach that from one request. The per-leaf cap and
 * this one are two different controls and both are needed.
 */
const MAX_TOTAL_LENGTH = 32_768;

/**
 * Value-level scrubbing, applied ONLY to error messages and stacks.
 *
 * Each pattern matches a shape that is almost never anything but a credential. They are
 * deliberately narrow and deliberately not applied to arbitrary strings: a false positive here
 * would silently mangle a product description or a customer's support message, and destroying
 * debuggability to chase a hypothetical is a bad trade.
 */
const VALUE_PATTERNS: readonly [RegExp, string][] = [
  // postgres://user:password@host — the DSN form pg errors quote verbatim.
  [/\/\/[^\s:/@]+:[^\s@]+@/g, '//[REDACTED]@'],
  [/\bBearer\s+[\w\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\bsk_(live|test)_[A-Za-z0-9]+/g, 'sk_$1_[REDACTED]'],
  // A JWT's three base64url segments.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
];

function scrubValues(text: string): string {
  return VALUE_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function isCredentialKey(key: string): boolean {
  // Separators are stripped before matching. A plain substring check on the raw key misses
  // `x-api-key` entirely — the hyphens break `apikey` apart — which silently leaked the most
  // common API-key header name in existence. Normalising collapses `X-API-Key`, `api_key` and
  // `api.key` onto one token.
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CREDENTIAL_KEY_PARTS.some((part) => normalised.includes(part));
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  // A value that is not shaped like an email may be anything; do not echo it.
  if (at < 1 || at === value.length - 1) return REDACTED;
  return `${value[0] ?? ''}***${value.slice(at)}`;
}

function maskTail(value: string, visible: number): string {
  if (value.length <= visible) return REDACTED;
  return `${'*'.repeat(value.length - visible)}${value.slice(-visible)}`;
}

function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  switch (key.toLowerCase()) {
    case 'email':
      return maskEmail(value);
    case 'phone':
    case 'mobile':
      return maskTail(value, 4);
    case 'gstin':
      return maskTail(value, 4);
    case 'pincode':
      return maskTail(value, 2);
    default:
      return value;
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}… [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    // Both message and stack go through value-level scrubbing as well as truncation. Key-name
    // matching structurally cannot help here: a driver error carries its secret inside the
    // text, not behind a recognisable field name. `pg` and TypeORM quote the connection string
    // or the failing query on failure, and `GlobalExceptionFilter` logs the raw exception on
    // every 5xx — so without this, one database outage writes the database password to the log
    // store in full.
    return {
      name: value.name,
      message: truncate(scrubValues(value.message)),
      stack: value.stack === undefined ? undefined : truncate(scrubValues(value.stack)),
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => walk(item, seen));

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialKey(key)) {
        output[key] = REDACTED;
      } else if (MASKED_KEYS.has(key.toLowerCase())) {
        output[key] = maskValue(key, child);
      } else {
        output[key] = walk(child, seen);
      }
    }
    return output;
  }

  return REDACTED;
}

/** Returns a scrubbed deep copy. Never mutates its input. */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet<object>());
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm run test -w backend -- pii-redactor`
Expected: PASS — 13 tests.

- [ ] **Step 5: Implement the request context**

```ts
// backend/src/common/logging/request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request values that every log line should carry without being threaded through every
 * function signature. Same approach as both existing services.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  method?: string;
  url?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches the authenticated user to the active context once a guard has resolved it, so
 * logs after that point are attributable.
 */
export function setContextUserId(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
```

- [ ] **Step 6: Implement the winston config and logger service**

```ts
// backend/src/common/config/winston.config.ts
import { createLogger, format, transports, type Logger } from 'winston';

/**
 * CloudWatch-friendly JSON on stdout, matching Gateway. File transports are development-only
 * because in production the platform captures stdout.
 */
export function createWinstonLogger(level: string, isProduction: boolean): Logger {
  const logger = createLogger({
    // Production never emits `debug`, so a stray debug log cannot leak volume or detail.
    level: isProduction && level === 'debug' ? 'info' : level,
    format: format.combine(
      format.uncolorize(),
      format.timestamp(),
      format.errors({ stack: true }),
      format.json(),
    ),
    transports: [new transports.Console()],
  });

  if (!isProduction) {
    logger.add(new transports.File({ filename: 'logs/app.log', maxsize: 5_242_880, maxFiles: 3 }));
    logger.add(
      new transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 5_242_880,
        maxFiles: 3,
      }),
    );
  }

  return logger;
}
```

```ts
// backend/src/common/logging/winston-logger.service.ts
import { Inject, Injectable, Scope, type LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import { createWinstonLogger } from '../config/winston.config';
import type { AppConfiguration } from '../config/app.config';
import { getRequestContext } from './request-context';
import { redact } from './pii-redactor';

/** Built once per process; the request-scoped detail comes from AsyncLocalStorage instead. */
let singleton: Logger | undefined;

@Injectable({ scope: Scope.TRANSIENT })
export class WinstonLoggerService implements LoggerService {
  private context = 'Application';

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    if (!singleton) {
      const app = this.config.getOrThrow<AppConfiguration>('app');
      singleton = createWinstonLogger(app.logging.level, app.isProduction);
    }
  }

  setContext(context: string): this {
    this.context = context;
    return this;
  }

  log(message: string, meta?: unknown): void {
    singleton?.info(message, this.envelope(meta));
  }

  error(message: string, meta?: unknown): void {
    singleton?.error(message, this.envelope(meta));
  }

  warn(message: string, meta?: unknown): void {
    singleton?.warn(message, this.envelope(meta));
  }

  debug(message: string, meta?: unknown): void {
    singleton?.debug(message, this.envelope(meta));
  }

  verbose(message: string, meta?: unknown): void {
    singleton?.verbose(message, this.envelope(meta));
  }

  /**
   * Every line carries the request identifiers and is scrubbed. `redact` runs on the way out
   * so a caller cannot forget to apply it.
   */
  private envelope(meta?: unknown): Record<string, unknown> {
    const request = getRequestContext();
    return {
      service: 'nutwala-backend',
      context: this.context,
      requestId: request?.requestId,
      correlationId: request?.correlationId,
      userId: request?.userId,
      method: request?.method,
      url: request?.url,
      ...(meta === undefined ? {} : { meta: redact(meta) }),
    };
  }
}
```

```ts
// backend/src/common/logging/logging.module.ts
import { Global, Module } from '@nestjs/common';
import { WinstonLoggerService } from './winston-logger.service';

@Global()
@Module({ providers: [WinstonLoggerService], exports: [WinstonLoggerService] })
export class LoggingModule {}
```

- [ ] **Step 7: Implement the request-tracking middleware**

```ts
// backend/src/common/middleware/request-tracking.middleware.ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../logging/request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class RequestTrackingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();

    // A caller-supplied correlation id is echoed so a trace can span services, but the
    // request id is always generated here: a client must not be able to choose it.
    const supplied = req.header(CORRELATION_ID_HEADER);
    const correlationId =
      typeof supplied === 'string' && /^[\w-]{1,64}$/.test(supplied) ? supplied : requestId;

    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext(
      { requestId, correlationId, method: req.method, url: req.originalUrl },
      () => next(),
    );
  }
}
```

- [ ] **Step 8: Run the full backend unit suite**

Run: `npm run test -w backend`
Expected: PASS — env schema (8) and redactor (13) tests.

- [ ] **Step 9: Commit**

```bash
git add backend/src/common/logging backend/src/common/config/winston.config.ts backend/src/common/middleware
git commit -m "feat(backend): add PII-redacting winston logging with request context"
```

## Task 10: Error and response envelopes (TDD)

Spec §3.1 departures 1 and 2. One success shape from an interceptor, one error shape from a filter.

**Files:**
- Create: `backend/src/common/errors/domain-error.ts`, `backend/src/common/interceptors/transform.interceptor.ts`, `backend/src/common/filters/global-exception.filter.ts`
- Test: `backend/src/common/interceptors/transform.interceptor.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { TransformInterceptor } from './transform.interceptor';

function contextFor(statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('TransformInterceptor', () => {
  it('wraps a plain object', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning({ id: 'p1' })),
    );
    expect(result).toEqual({ success: true, data: { id: 'p1' } });
  });

  it('wraps an array without flattening it', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning([1, 2])),
    );
    expect(result).toEqual({ success: true, data: [1, 2] });
  });

  it('represents an empty handler response as null data, never a missing key', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(204), handlerReturning(undefined)),
    );
    expect(result).toEqual({ success: true, data: null });
  });

  it('lifts a { data, message } handler response into the envelope', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(
        contextFor(201),
        handlerReturning({ data: { id: 'o1' }, message: 'Order placed' }),
      ),
    );
    expect(result).toEqual({ success: true, data: { id: 'o1' }, message: 'Order placed' });
  });

  it('does not double-wrap an already-enveloped response', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(
        contextFor(),
        handlerReturning({ success: true, data: { id: 'p1' } }),
      ),
    );
    expect(result).toEqual({ success: true, data: { id: 'p1' } });
  });

  it('treats a falsy scalar as data rather than as absence', async () => {
    await expect(
      firstValueFrom(new TransformInterceptor().intercept(contextFor(), handlerReturning(0))),
    ).resolves.toEqual({ success: true, data: 0 });
    await expect(
      firstValueFrom(new TransformInterceptor().intercept(contextFor(), handlerReturning(false))),
    ).resolves.toEqual({ success: true, data: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w backend -- transform.interceptor`
Expected: FAIL — cannot find module `./transform.interceptor`.

- [ ] **Step 3: Implement `backend/src/common/errors/domain-error.ts`**

```ts
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A business-rule rejection carrying a stable machine-readable `code`.
 *
 * The code is what a client switches on — `OUT_OF_STOCK` needs different UI from
 * `COUPON_EXPIRED` — and it must not change when the human-readable message is reworded.
 */
export class DomainError extends HttpException {
  constructor(
    // Narrowed to the registry, not `string`. While it accepted any string, two throw sites
    // invented bare literals — 'VALIDATION_FAILED' in the filter and 'WEAK_PASSWORD' in
    // registration — exactly the drift the ErrorCodes comment warns against, and undetectable.
    // Now it fails typecheck. `ErrorCode` must therefore be declared above this class.
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details }, status);
  }
}

/** The codes this service emits. Add here rather than inventing a string at a throw site. */
export const ErrorCodes = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_IN_USE: 'EMAIL_IN_USE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  BELOW_MOQ: 'BELOW_MOQ',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_LIMIT_REACHED: 'COUPON_LIMIT_REACHED',
  PAYMENT_METHOD_UNAVAILABLE: 'PAYMENT_METHOD_UNAVAILABLE',
  PINCODE_NOT_SERVICEABLE: 'PINCODE_NOT_SERVICEABLE',
  ILLEGAL_STATUS_TRANSITION: 'ILLEGAL_STATUS_TRANSITION',
  CART_EMPTY: 'CART_EMPTY',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
```

- [ ] **Step 4: Implement `backend/src/common/interceptors/transform.interceptor.ts`**

```ts
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { ApiSuccess } from '@nutwala/shared';

interface HandlerEnvelope {
  data: unknown;
  message?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Applies the one success envelope, globally.
 *
 * Spec §3.1 departure 2: cug wraps in `{ success, data }` from 65 controllers but returns
 * bare DTOs from auth, and gateway returns raw payloads. Doing it in an interceptor means a
 * controller cannot forget, and there is exactly one shape on the wire.
 *
 * A handler may return `{ data, message }` when it wants to set a message; anything else is
 * taken as the payload.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiSuccess<unknown>> {
    return next.handle().pipe(
      map((value: unknown): ApiSuccess<unknown> => {
        // Already enveloped — a controller that built its own response, or a nested call.
        if (isPlainObject(value) && value.success === true && 'data' in value) {
          return value as unknown as ApiSuccess<unknown>;
        }

        if (isPlainObject(value) && 'data' in value && typeof value.message === 'string') {
          const envelope = value as unknown as HandlerEnvelope;
          return { success: true, data: envelope.data ?? null, message: envelope.message };
        }

        // `undefined` means the handler returned nothing; `null`, `0` and `false` are data.
        return { success: true, data: value === undefined ? null : value };
      }),
    );
  }
}
```

- [ ] **Step 5: Run to verify the tests pass**

Run: `npm run test -w backend -- transform.interceptor`
Expected: PASS — 6 tests.

- [ ] **Step 6: Implement `backend/src/common/filters/global-exception.filter.ts`**

CUG's `GlobalExceptionFilter` shape, which is the richer of the two repos'.

```ts
import {
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ApiError } from '@nutwala/shared';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/app.config';
import { getRequestContext } from '../logging/request-context';
import { WinstonLoggerService } from '../logging/winston-logger.service';
import { redact } from '../logging/pii-redactor';

interface NestValidationBody {
  message?: string | string[];
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Widened to `number` deliberately. `exception.getStatus()` returns a plain `number`, and
 * comparing that against an `HttpStatus` member trips `no-unsafe-enum-comparison` — which is on
 * here via `recommendedTypeChecked`. Naming the boundary once keeps the intent readable without
 * scattering casts or a bare `500` through the filter.
 */
const SERVER_ERROR_THRESHOLD: number = HttpStatus.INTERNAL_SERVER_ERROR;

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: WinstonLoggerService,
    private readonly config: ConfigService,
  ) {
    this.logger.setContext('GlobalExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const app = this.config.getOrThrow<AppConfiguration>('app');
    const requestContext = getRequestContext();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const { message, code, details } = this.describe(exception, status, app.isProduction);
    const errorId = `err_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

    const body: ApiError = {
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
      method: request.method,
      message,
      ...(code ? { code } : {}),
      errorId,
      requestId: requestContext?.requestId ?? 'unknown',
      ...(details ? { details } : {}),
      // Stack never crosses the wire in production. Spec §13, "internal detail leakage".
      ...(app.isProduction || !(exception instanceof Error) ? {} : { stack: exception.stack }),
    };

    const logMeta = {
      errorId,
      statusCode: status,
      path: request.originalUrl,
      method: request.method,
      body: redact(request.body),
      query: redact(request.query),
    };

    // 5xx is our fault and gets a stack; 4xx is the caller's and would be log spam at error.
    if (status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(message, { ...logMeta, error: exception });
    } else {
      this.logger.warn(message, logMeta);
    }

    response.status(status).json(body);
  }

  private describe(
    exception: unknown,
    status: number,
    isProduction: boolean,
  ): { message: string; code?: string; details?: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'string') return { message: payload };

      const shaped = payload as NestValidationBody;

      // ValidationPipe emits `message: string[]`, one entry per failed constraint.
      if (Array.isArray(shaped.message)) {
        return {
          message: 'Validation failed',
          code: 'VALIDATION_FAILED',
          details: { _errors: shaped.message },
        };
      }

      return {
        message: shaped.message ?? exception.message,
        ...(shaped.code ? { code: shaped.code } : {}),
        ...(shaped.details ? { details: shaped.details as Record<string, string[]> } : {}),
      };
    }

    // An unclassified throw. In production the caller learns nothing beyond the error id:
    // a driver message can name a column, a constraint, or a query.
    if (isProduction) return { message: 'Internal server error' };
    return { message: exception instanceof Error ? exception.message : String(exception) };
  }
}
```

- [ ] **Step 7: Verify the unit suite and typecheck**

Run: `npm run test -w backend && npm run typecheck -w backend`
Expected: 27 tests pass; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/common/errors backend/src/common/interceptors backend/src/common/filters
git commit -m "feat(backend): add uniform success envelope and rich error filter"
```

## Task 11: TypeORM wiring, the paise transformer, and health

**Files:**
- Create: `backend/src/common/money/paise.transformer.ts`, `backend/src/common/db/postgres-version-assertion.service.ts`, `backend/src/database/typeorm.options.ts`, `backend/src/data-source.ts`, `backend/src/modules/health/health.controller.ts`, `backend/src/modules/health/health.module.ts`

- [ ] **Step 1: Implement the paise transformer**

```ts
// backend/src/common/money/paise.transformer.ts
import { Column, type ColumnOptions, type ValueTransformer } from 'typeorm';

/**
 * Maps a Postgres `bigint` to a JavaScript `bigint`.
 *
 * The `pg` driver returns `bigint` columns as strings, because a 64-bit integer does not fit a
 * JavaScript number. Without this transformer every money field would arrive as a string and
 * arithmetic would silently concatenate: `'100' + '50'` is `'10050'`, not `150`.
 *
 * `satisfies` rather than a `: ValueTransformer` annotation. TypeORM declares `to`/`from` as
 * `(value: any) => any` using method shorthand, which TypeScript compares bivariantly — so
 * annotating with the interface widens the exported type and `paiseTransformer.to(123)` or
 * `.to('abc')` would typecheck at every call site. `satisfies` still validates structural
 * conformance while keeping the narrow signatures for callers, which is the whole point.
 */
export const paiseTransformer = {
  to: (value?: bigint | null): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value?: string | null): bigint | null | undefined =>
    value === null || value === undefined ? value : BigInt(value),
} satisfies ValueTransformer;

/**
 * Everything a money column needs, minus the two things it must not be allowed to change.
 *
 * `Omit`ting `type` and `transformer` makes overriding them a compile error. A spread-an-object
 * helper cannot do that: `@Column({ ...paiseColumn, type: 'integer' })` typechecks happily and
 * silently drops the invariant, which for a money column means the driver hands back a string
 * and totals start concatenating.
 */
export type PaiseColumnOptions = Omit<ColumnOptions, 'type' | 'transformer'>;

/**
 * Declares a money column. Use this for every monetary field — never a bare
 * `@Column({ type: 'bigint' })`, which `eslint.config.mjs` rejects via `no-restricted-syntax`
 * for exactly that reason.
 *
 *   @PaiseColumn() pricePaise: bigint;
 *   @PaiseColumn({ nullable: true }) pricePerKgPaise: bigint | null;
 *   @PaiseColumn({ default: 0 }) discountPaise: bigint;
 */
export function PaiseColumn(options: PaiseColumnOptions = {}): PropertyDecorator {
  // `type` and `transformer` come last so they win at runtime even if a caller defeats the
  // compile-time guard with an `as` cast.
  return Column({ ...options, type: 'bigint', transformer: paiseTransformer });
}
```

- [ ] **Step 2: Implement the Postgres version assertion**

Gateway asserts this at boot. Worth keeping: the migration chain and the aggregates use features that behave differently on older majors.

```ts
// backend/src/common/db/postgres-version-assertion.service.ts
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WinstonLoggerService } from '../logging/winston-logger.service';

const MINIMUM_MAJOR = 15;

@Injectable()
export class PostgresVersionAssertionService implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext('PostgresVersionAssertion');
  }

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.dataSource.query<{ server_version_num: string }[]>(
      'SHOW server_version_num',
    );
    const versionNum = Number(rows[0]?.server_version_num ?? 0);
    const major = Math.floor(versionNum / 10_000);

    if (major < MINIMUM_MAJOR) {
      throw new Error(
        `PostgreSQL ${MINIMUM_MAJOR} or newer is required; connected server reports major ${major}`,
      );
    }
    this.logger.log('Database version verified', { major });
  }
}
```

- [ ] **Step 3: Implement shared TypeORM options**

One definition consumed by both the runtime module and the CLI DataSource, so the two cannot drift — Gateway's `data-source.ts` carries a comment warning that its two copies must be hand-synced, which this avoids.

```ts
// backend/src/database/typeorm.options.ts
import type { DataSourceOptions } from 'typeorm';
import type { AppConfiguration } from '../common/config/app.config';

export function buildTypeOrmOptions(app: AppConfiguration): DataSourceOptions {
  return {
    type: 'postgres',
    host: app.database.host,
    port: app.database.port,
    username: app.database.username,
    password: app.database.password,
    database: app.database.database,
    schema: app.database.schema,
    // Entities and migrations are globbed from dist at runtime and from src under ts-node.
    entities: [`${__dirname}/../entities/**/*.entity.{ts,js}`],
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
    // Never true. The migration chain is the only way the schema changes.
    synchronize: false,
    migrationsRun: app.database.migrationsRun,
    // Postgres refuses `ALTER TYPE ... ADD VALUE` inside a transaction that later uses the
    // new value (55P04), so each migration gets its own transaction. Same as both repos.
    migrationsTransactionMode: 'each',
    logging: app.isProduction ? ['error', 'warn'] : ['error', 'warn', 'schema'],
  };
}
```

- [ ] **Step 4: Implement the CLI DataSource**

```ts
// backend/src/data-source.ts
import './load-env';
import { DataSource } from 'typeorm';
import { loadEnv } from './common/config/env.schema';
import { buildTypeOrmOptions } from './database/typeorm.options';

/**
 * Used only by the TypeORM CLI (`npm run migration:run`). It builds its options from the same
 * `buildTypeOrmOptions` the application uses, so there is no second copy to keep in sync.
 *
 * This is the second place `loadEnv()` is called — the first being `appConfig`'s factory. That
 * is harmless rather than an oversight: `registerAs` factories run once at `ConfigModule`
 * bootstrap and are cached by `ConfigService`, and this file only ever executes in a separate
 * CLI process that shares no state with the running app. There is no window in which the two
 * parses could observe a different `process.env` and disagree.
 */
const env = loadEnv();

export default new DataSource(
  buildTypeOrmOptions({
    env: env.NODE_ENV,
    port: env.PORT,
    isProduction: env.NODE_ENV === 'production',
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      schema: env.DB_SCHEMA,
      migrationsRun: false,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      cookieDomain: env.COOKIE_DOMAIN,
      cookieSecure: env.COOKIE_SECURE,
    },
    cors: { origins: env.CORS_ORIGINS },
    swagger: { user: env.SWAGGER_USER, password: env.SWAGGER_PASSWORD },
    logging: { level: env.LOG_LEVEL },
  }),
);
```

- [ ] **Step 5: Implement the health module**

```ts
// backend/src/modules/health/health.controller.ts
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../../common/auth/decorators/public.decorator';

interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: 'up' | 'down';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Process and database liveness' })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      // Reported as degraded rather than thrown: a monitor needs the body, not a 500.
    }

    // 503 when the database is unreachable, so an orchestrator actually pulls the instance out of
    // rotation. A status-code-blind 200 with `degraded` in the body is the most common way a health
    // check ends up decorative — Docker, k8s and most load balancers key their default probe off
    // the code alone. `passthrough` keeps the body flowing through the success envelope.
    if (database === 'down') response.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      database,
    };
  }
}
```

```ts
// backend/src/modules/health/health.module.ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

- [ ] **Step 6: Create the `@Public()` decorator the controller uses**

```ts
// backend/src/common/auth/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route as reachable without a session. `JwtAuthGuard` (Task 30) is registered
 * globally, so authentication is the default and every exception is explicit and greppable.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w backend`
Expected: clean. `entities/` is empty so far, which the glob tolerates.

- [ ] **Step 8: Commit**

```bash
git add backend/src/common/money backend/src/common/db backend/src/common/auth backend/src/database backend/src/data-source.ts backend/src/modules/health
git commit -m "feat(backend): wire TypeORM, paise transformer and health endpoint"
```

## Task 12: Bootstrap and the application module

**Files:**
- Create: `backend/src/app.module.ts`, `backend/src/main.ts`

- [ ] **Step 1: Implement `backend/src/app.module.ts`**

```ts
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { appConfig, type AppConfiguration } from './common/config/app.config';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { RequestTrackingMiddleware } from './common/middleware/request-tracking.middleware';
import { PostgresVersionAssertionService } from './common/db/postgres-version-assertion.service';
import { buildTypeOrmOptions } from './database/typeorm.options';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      // `load-env.ts` has already applied dotenv with override, so ConfigModule must not
      // re-read a file and undo it.
      ignoreEnvFile: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildTypeOrmOptions(config.getOrThrow<AppConfiguration>('app')),
    }),
    // Baseline limit for every route. Auth routes tighten this with @Throttle in Task 32.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    LoggingModule,
    HealthModule,
  ],
  providers: [
    PostgresVersionAssertionService,
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestTrackingMiddleware).forRoutes('*');
  }
}
```

**One thing to fix while wiring, deferred here from Task 9's review.**

`WinstonLoggerService` holds its winston instance in a module-level `let singleton`, guarded by
`if (!singleton)`. That guard never re-fires within a process, so a second
`Test.createTestingModule()` silently inherits the first context's logger — which will bite the
integration tests in Task 13, where more than one module gets built per run, and would present
as a baffling test-isolation bug rather than an obvious one.

Provide the winston `Logger` through a DI token with `useFactory` in `LoggingModule`, and have
the transient `WinstonLoggerService` inject it. That keeps the per-injection `context` label the
transient scope exists for, while putting instance lifetime under Nest's control instead of a
hidden module global. Remove the `let singleton` and its guard.

- [ ] **Step 2: Implement `backend/src/main.ts`**

```ts
// Must be first: dotenv override has to run before any module reads process.env.
import './load-env';
// Must precede any response serialisation, because money columns are bigint.
import './common/money/bigint-json';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import basicAuth from 'express-basic-auth';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfiguration } from './common/config/app.config';
import { WinstonLoggerService } from './common/logging/winston-logger.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const appConfiguration = config.getOrThrow<AppConfiguration>('app');

  // Transient-scoped, so resolve rather than get — same as cug.
  const logger = await app.resolve(WinstonLoggerService);
  app.useLogger(logger.setContext('Bootstrap'));

  app.setGlobalPrefix('api/v1');

  app.use(helmet());
  app.use(cookieParser());
  // 1 MB cap so an oversized payload is rejected before it reaches a handler. Spec §13.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.enableCors({
    origin: appConfiguration.cors.origins,
    // Required for the session cookies to be sent at all.
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // `whitelist` strips unknown properties and `forbidNonWhitelisted` rejects them
      // outright — together they are the mass-assignment defence from spec §13.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      /**
       * Without this factory, Nest collapses every validation failure into one flat
       * `message: string[]`, so `ApiError.details` — documented as "keyed by field path" —
       * would only ever carry a single `_errors` bucket. That is the shape every client
       * integration gets written against, and changing it later is a breaking change, so it
       * has to be right the first time.
       *
       * Flattens class-validator's per-property `ValidationError[]` (including nested
       * children, via dotted paths) into `field -> messages`.
       */
      exceptionFactory: (errors) => {
        const details: Record<string, string[]> = {};

        const collect = (list: ValidationError[], prefix = ''): void => {
          for (const error of list) {
            const path = prefix ? `${prefix}.${error.property}` : error.property;
            const messages = Object.values(error.constraints ?? {});
            if (messages.length > 0) details[path] = messages;
            if (error.children && error.children.length > 0) collect(error.children, path);
          }
        };

        collect(errors);
        return new DomainError('VALIDATION_FAILED', 'Validation failed', HttpStatus.BAD_REQUEST, details);
      },
    }),
  );

  // Docs behind basic auth, as cug does. Never exposed unauthenticated.
  app.use(
    ['/api-docs', '/api-docs-json'],
    basicAuth({
      challenge: true,
      users: { [appConfiguration.swagger.user]: appConfiguration.swagger.password },
    }),
  );

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nuts & Nazaakat API')
      .setDescription('Storefront, account and admin API')
      .setVersion('1.0')
      .addCookieAuth('nn_access_token')
      .build(),
  );
  SwaggerModule.setup('api-docs', app, document, { jsonDocumentUrl: 'api-docs-json' });

  app.enableShutdownHooks();

  await app.listen(appConfiguration.port);
  logger.log('Backend started', {
    port: appConfiguration.port,
    env: appConfiguration.env,
    prefix: 'api/v1',
  });
}

void bootstrap();
```

- [ ] **Step 3: Confirm `cookie-parser` and `basicAuth` default imports resolve**

These are CommonJS packages. With `esModuleInterop: true` the default import works. If TypeScript complains, use `import * as cookieParser from 'cookie-parser'` — do not add `allowSyntheticDefaultImports` globally.

- [ ] **Step 4: Boot it**

Run: `npm run db:up && npm run dev -w backend`
Expected: log lines showing `Database version verified` then `Backend started` on port 4400. TypeORM finds no entities and no migrations, which is correct at this point.

- [ ] **Step 5: Verify the health endpoint and the envelope**

Run: `curl -s http://localhost:4400/api/v1/health | python3 -m json.tool`
Expected:

```json
{
    "success": true,
    "data": {
        "status": "ok",
        "uptimeSeconds": 3,
        "database": "up"
    }
}
```

Run: `curl -s -i http://localhost:4400/api/v1/health | grep -i "x-request-id"`
Expected: a `X-Request-Id` header with a UUID.

- [ ] **Step 6: Verify the error envelope and that Swagger is protected**

Run: `curl -s http://localhost:4400/api/v1/nope | python3 -m json.tool`
Expected: `success: false`, `statusCode: 404`, and populated `errorId`, `requestId`, `path`, `method`, `timestamp`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4400/api-docs`
Expected: `401`.

Then stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add backend/src/app.module.ts backend/src/main.ts
git commit -m "feat(backend): bootstrap app with helmet, CORS, validation, Swagger and throttling"
```

## Task 13: Test harness — three Jest configs and a real Postgres

CUG's testcontainers approach, with spec §3.1 departure 4: the real migration chain runs, not `synchronize`.

**Files:**
- Create: `backend/jest.integration.config.ts`, `backend/jest.e2e.config.ts`, `backend/test/integration/setup.ts`
- **Already created in Task 8:** `backend/jest.config.ts` and `backend/test/setup.ts` — the unit runner has to exist before Task 8's first `.spec.ts`, so those two moved forward. Do not recreate them., `backend/test/integration/helpers/test-database.ts`, `backend/test/integration/helpers/db-cleaner.ts`, `backend/test/integration/helpers/test-app.ts`, `backend/test/integration/helpers/index.ts`
- Test: `backend/test/integration/health.integration.spec.ts`

- [ ] **Step 1: Create `backend/jest.config.ts`**

```ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/test/integration/', '/test/e2e/'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@nutwala/shared$': '<rootDir>/../shared/src/index.ts',
  },
  clearMocks: true,
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.entity.ts', '!src/main.ts'],
};

export default config;
```

Mapping `@nutwala/shared` to the workspace source means a change there is picked up without a rebuild between runs.

- [ ] **Step 2: Create `backend/test/setup.ts`**

```ts
// Deterministic dates and money formatting across machines and CI.
process.env.TZ = 'UTC';

// Unit tests must never reach a database or a real secret.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-thirty-two-chars-long';
```

- [ ] **Step 3: Create `backend/jest.integration.config.ts`**

```ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.integration\\.spec\\.ts$',
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@nutwala/shared$': '<rootDir>/../shared/src/index.ts',
  },
  // One container, shared serially. Parallel workers would each start Postgres and the
  // TRUNCATE cleaner would race between them.
  maxWorkers: 1,
  testTimeout: 120_000,
};

export default config;
```

- [ ] **Step 4: Create `backend/test/integration/setup.ts`**

```ts
process.env.TZ = 'UTC';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-secret-at-least-thirty-two-chars';
process.env.SWAGGER_USER = 'docs';
process.env.SWAGGER_PASSWORD = 'docs';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'error';
```

- [ ] **Step 5: Create `backend/test/integration/helpers/test-database.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import type { AppConfiguration } from '../../../src/common/config/app.config';

let container: StartedPostgreSqlContainer | undefined;
let dataSource: DataSource | undefined;

/**
 * Starts one Postgres container for the whole integration run and applies the real migration
 * chain to it.
 *
 * Spec §3.1 departure 4: cug's equivalent helper uses `synchronize: true` with a note that
 * its migration set has ordering issues. Running migrations here means the chain is exercised
 * on every integration run, so an ordering problem is a failing test rather than a surprise
 * at deploy time.
 */
export async function startTestDatabase(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  container = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('nutwala_test')
    .withUsername('nutwala')
    .withPassword('nutwala_test_only')
    .start();

  // The application reads its database settings from env, so point them at the container.
  process.env.DB_HOST = container.getHost();
  process.env.DB_PORT = String(container.getMappedPort(5432));
  process.env.DB_USER = container.getUsername();
  process.env.DB_PASSWORD = container.getPassword();
  process.env.DB_NAME = container.getDatabase();
  process.env.DB_SCHEMA = 'public';

  const options = buildTypeOrmOptions({
    isProduction: false,
    database: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      schema: 'public',
      migrationsRun: false,
    },
  } as AppConfiguration);

  dataSource = new DataSource(options);
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });

  return dataSource;
}

export function getTestDataSource(): DataSource {
  if (!dataSource?.isInitialized) {
    throw new Error('startTestDatabase() must be awaited before getTestDataSource()');
  }
  return dataSource;
}

export async function stopTestDatabase(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = undefined;
  await container?.stop();
  container = undefined;
}
```

- [ ] **Step 6: Create `backend/test/integration/helpers/db-cleaner.ts`**

```ts
import type { DataSource } from 'typeorm';

/**
 * Empties every table between tests, CUG's approach. `TRUNCATE ... CASCADE` in one statement
 * is far faster than per-table deletes and sidesteps foreign-key ordering entirely.
 *
 * `migrations` is excluded — truncating it would make TypeORM re-run the whole chain.
 */
export async function cleanDatabase(dataSource: DataSource): Promise<void> {
  const tables = dataSource.entityMetadatas
    .map((metadata) => `"${metadata.schema ?? 'public'}"."${metadata.tableName}"`)
    .filter((table) => !table.includes('migrations'));

  if (tables.length === 0) return;

  await dataSource.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 7: Create `backend/test/integration/helpers/test-app.ts`**

```ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../../src/app.module';

/**
 * Boots the real application module against the test container, with the same global pipes
 * and middleware `main.ts` installs. Anything configured only in `main.ts` would otherwise
 * be untested — which is how a missing `ValidationPipe` reaches production.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.init();
  return app;
}
```

```ts
// backend/test/integration/helpers/index.ts
export * from './db-cleaner';
export * from './test-app';
export * from './test-database';
```

- [ ] **Step 8: Write the first integration test**

```ts
// backend/test/integration/health.integration.spec.ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, startTestDatabase, stopTestDatabase } from './helpers';

describe('GET /api/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await startTestDatabase();
    app = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await stopTestDatabase();
  });

  it('reports ok with the database up, inside the success envelope', async () => {
    const response = await request(integration.app).get('/api/v1/health').expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        status: 'ok',
        uptimeSeconds: expect.any(Number),
        database: 'up',
      },
    });
  });

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(integration.app).get('/api/v1/nope').expect(404);

    expect(response.body).toMatchObject({
      success: false,
      statusCode: 404,
      path: '/api/v1/nope',
      method: 'GET',
    });
    expect(response.body.errorId).toMatch(/^err_/);
    expect(response.body.requestId).toBeDefined();
  });
});
```

- [ ] **Step 8b: Create `backend/test/e2e/.gitkeep`**

`passWithNoTests` covers "the directory exists but holds no tests" — it does **not** cover a
missing directory. Jest validates `roots` before it looks for tests, so without a placeholder
`npm run test:e2e -w backend` fails with `roots[0] not found` rather than exiting 0. An empty
`.gitkeep` keeps the directory in git until Plan 4 fills it.

- [ ] **Step 9: Create `backend/jest.e2e.config.ts`**

Present now so the configuration set is complete; Plan 4 fills `test/e2e/`.

```ts
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@nutwala/shared$': '<rootDir>/../shared/src/index.ts',
  },
  maxWorkers: 1,
  testTimeout: 180_000,
  passWithNoTests: true,
  // NOTE for Plan 4, when the first e2e spec lands: this config has no globalSetup /
  // globalTeardown. The integration config gained them because Jest resets the module registry
  // per spec FILE, so a per-file container memo never hits and every spec would start its own
  // Postgres and replay the whole migration chain. e2e will need the same wiring the moment it
  // has more than one spec file — copy integration's, do not reinvent a per-file beforeAll.
};

export default config;
```

- [ ] **Step 10: Run both suites**

Run: `npm run test -w backend`
Expected: PASS — 27 unit tests.

Run: `npm run test:integration -w backend`
Expected: Docker pulls `postgres:15-alpine` on the first run, then PASS — 2 tests. The migration chain is empty at this point, which `runMigrations` handles.

If the container fails to start, confirm Docker is running (`docker info`). Testcontainers needs a reachable Docker socket.

- [ ] **Step 11: Commit**

```bash
git add backend/jest.config.ts backend/jest.integration.config.ts backend/jest.e2e.config.ts backend/test
git commit -m "test(backend): add unit, integration and e2e Jest configs with testcontainers Postgres"
```

**Milestone 0 is complete.** The service boots, connects to Postgres, answers a health check inside the success envelope, and has three working test configurations.

---

# MILESTONE 1 — Schema and seed data

Goal: the full migration chain applies to an empty database, and the seeder loads everything `src/mocks/` currently holds, so the API has real data to serve in Plan 2.

## Task 14: Entity conventions and shared enums

**Files:**
- Create: `backend/src/entities/base.entity.ts`, `backend/src/entities/enums.ts`

- [ ] **Step 1: Create the base entity**

```ts
// backend/src/entities/base.entity.ts
import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * UUID primary keys throughout.
 *
 * Sequential integer ids leak volume (an order id of 42 tells a competitor how many orders
 * exist) and make an IDOR probe trivial to enumerate. Access is scoped by session anyway
 * (spec §13), but there is no reason to hand out a guessable key as well.
 *
 * Customer-facing references — `NN-2026-000123`, `RFQ-2026-000123` — are separate human
 * columns, not the primary key.
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 2: Create the enums**

Postgres native enums, so the database rejects a bad value rather than trusting the application. Wire values differ from database values for `UserRole` only, as spec §5.1 and `shared/types/auth.ts` describe.

```ts
// backend/src/entities/enums.ts

/** Spec §3.2 — brief §45's `AdminUsers` collapses into this column. */
export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  BUSINESS = 'BUSINESS',
  ADMIN = 'ADMIN',
}

export enum VariantChannel {
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

/** Brief §32. The reasons stock moves. */
export enum InventoryTransactionType {
  RECEIPT = 'RECEIPT',
  SALE = 'SALE',
  ADJUSTMENT = 'ADJUSTMENT',
  RETURN = 'RETURN',
  CANCELLATION = 'CANCELLATION',
}

/** Brief §31. Which buyer group a pricing tier applies to. */
export enum CustomerSegment {
  DEFAULT = 'DEFAULT',
  RETAILER = 'RETAILER',
  DISTRIBUTOR = 'DISTRIBUTOR',
  HORECA = 'HORECA',
}

export enum OrderChannelEnum {
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

export enum PaymentMethodEnum {
  COD = 'COD',
  /** Present so enabling online payment later is a settings change, not a migration. */
  ONLINE = 'ONLINE',
}

export enum PaymentStatusEnum {
  PENDING = 'PENDING',
  COLLECTED = 'COLLECTED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum CouponType {
  PERCENT = 'PERCENT',
  FLAT = 'FLAT',
}

export enum CouponScope {
  ALL = 'ALL',
  CATEGORY = 'CATEGORY',
}

export enum CouponChannel {
  ALL = 'ALL',
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

export enum ReviewStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum RfqKind {
  BULK = 'BULK',
  GIFTING = 'GIFTING',
}

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
}

export enum NotificationStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum ShipmentStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  RETURNED = 'RETURNED',
}
```

Order status, RFQ status and support-ticket status are **not** enums here. They come from `@nutwala/shared` tuples that the frontend also uses, and are stored as `varchar` with a check constraint added in the migration. Duplicating brief §33's nine values into a Postgres enum would mean changing them in two places, and `ALTER TYPE ... ADD VALUE` is the awkward migration Gateway's `migrationsTransactionMode: 'each'` comment exists to work around.

- [ ] **Step 3: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: clean.

```bash
git add backend/src/entities
git commit -m "feat(backend): add entity base class and domain enums"
```

## Task 15: Identity entities

Spec §5.1.

**Files:**
- Create: `backend/src/entities/identity/user.entity.ts`, `session.entity.ts`, `business.entity.ts`, `address.entity.ts`

- [ ] **Step 1: Create `user.entity.ts`**

```ts
import { Column, Entity, Index, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { UserRole } from '../enums';
import type { Address } from './address.entity';
import type { Business } from './business.entity';
import type { Session } from './session.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * Stored lowercased by the service, with a unique index. Postgres `citext` would also work
   * but requires an extension; normalising on write keeps the schema portable and makes the
   * stored value predictable.
   */
  @Index('uq_users_email', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 15 })
  phone: string;

  /** bcrypt hash, cost 10 — matching cug. Never selected by default. */
  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @OneToOne('Business', 'user')
  business: Business | null;

  @OneToMany('Address', 'user')
  addresses: Address[];

  @OneToMany('Session', 'user')
  sessions: Session[];
}
```

`select: false` on `passwordHash` means an accidental `find()` that gets returned to a controller cannot leak the hash. Code that needs it asks for it explicitly with `addSelect`.

- [ ] **Step 2: Create `session.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from './user.entity';

/**
 * A server-side session, so logout genuinely invalidates and an admin can force-logout.
 * Spec §9 / §3.1 departure 1 — this table is what a stateless JWT cannot give us.
 */
@Entity('sessions')
export class Session extends BaseEntity {
  @Index('idx_sessions_user')
  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  /**
   * SHA-256 of the refresh token, never the token. A database disclosure must not hand over
   * usable credentials. Unique so a reuse check is a single indexed lookup.
   */
  @Index('uq_sessions_refresh_token_hash', { unique: true })
  @Column({ type: 'char', length: 64 })
  refreshTokenHash: string;

  /**
   * Sessions form a family through rotation. Reuse of a revoked token revokes the whole
   * family, which is why every rotated session keeps the id it descended from.
   */
  @Index('idx_sessions_family')
  @Column({ type: 'uuid' })
  familyId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  revokedReason: string | null;
}
```

- [ ] **Step 3: Create `address.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from './user.entity';

/**
 * The account address book. Orders never reference this table — they store an
 * `addressSnapshot` jsonb instead (spec §5.3), so deleting an address cannot rewrite where a
 * past order was delivered. Soft-deleted so a restore is possible.
 */
@Entity('addresses')
export class Address extends BaseEntity {
  @Index('idx_addresses_user')
  @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 40 })
  label: string;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Column({ type: 'varchar', length: 15 })
  phone: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  line1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  line2: string | null;

  @Column({ type: 'varchar', length: 80 })
  city: string;

  @Column({ type: 'varchar', length: 80 })
  state: string;

  @Column({ type: 'char', length: 6 })
  pincode: string;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
```

- [ ] **Step 4: Create `business.entity.ts`**

```ts
import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from './user.entity';

/** Brief §19. One-to-one with a `BUSINESS` user — brief §46 forbids a separate B2B account. */
@Entity('businesses')
export class Business extends BaseEntity {
  @OneToOne(() => User, (user) => user.business, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id', unique: true })
  userId: string;

  @Column({ type: 'varchar', length: 160 })
  companyName: string;

  @Column({ type: 'varchar', length: 120 })
  contactPerson: string;

  @Column({ type: 'varchar', length: 15 })
  mobile: string;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60 })
  businessType: string;

  @Column({ type: 'uuid', nullable: true, name: 'billing_address_id' })
  billingAddressId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'shipping_address_id' })
  shippingAddressId: string | null;

  /** Brief §34/§35. An admin user, not a separate staff table. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_salesperson_id' })
  assignedSalesperson: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_salesperson_id' })
  assignedSalespersonId: string | null;
}
```

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: clean.

```bash
git add backend/src/entities/identity
git commit -m "feat(backend): add User, Session, Address and Business entities"
```

## Task 16: Catalog and stock entities

Spec §5.2. Note that `Inventory` is a separate table from `ProductVariant`, so stock writes do not contend with catalog reads.

**Files:**
- Create: `backend/src/entities/catalog/category.entity.ts`, `product.entity.ts`, `product-image.entity.ts`, `product-variant.entity.ts`, `inventory.entity.ts`, `inventory-transaction.entity.ts`, `pricing-tier.entity.ts`

- [ ] **Step 1: Create `category.entity.ts`**

```ts
import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import type { Product } from './product.entity';

@Entity('categories')
export class Category extends BaseEntity {
  @Index('uq_categories_slug', { unique: true })
  @Column({ type: 'varchar', length: 80 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500 })
  image: string;

  @Column({ type: 'varchar', length: 300 })
  blurb: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  /** Brief §39. Held as jsonb because the three fields always travel together. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };

  @OneToMany('Product', 'category')
  products: Product[];
}
```

- [ ] **Step 2: Create `product.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Category } from './category.entity';
import type { PricingTier } from './pricing-tier.entity';
import type { ProductImage } from './product-image.entity';
import type { ProductVariant } from './product-variant.entity';

@Entity('products')
export class Product extends BaseEntity {
  @Index('uq_products_slug', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  slug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Index('idx_products_category')
  @ManyToOne(() => Category, (category) => category.products, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ type: 'uuid', name: 'category_id' })
  categoryId: string;

  @Column({ type: 'varchar', length: 300 })
  subtitle: string;

  @Column({ type: 'text' })
  description: string;

  /** `BESTSELLER` | `NEW` | `PREMIUM`, or null. Varchar because the frontend owns the union. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  badge: string | null;

  // Brief §30 product detail fields.
  @Column({ type: 'varchar', length: 120 })
  origin: string;

  @Column({ type: 'varchar', length: 80 })
  grade: string;

  @Column({ type: 'varchar', length: 200 })
  processing: string;

  @Column({ type: 'varchar', length: 120 })
  shelfLife: string;

  @Column({ type: 'varchar', length: 300 })
  storage: string;

  @Column({ type: 'varchar', length: 300 })
  ingredients: string;

  @Column({ type: 'varchar', length: 12 })
  hsn: string;

  /** Whole or fractional percent, e.g. 5 or 12.5. Not money, so `numeric` is right here. */
  @Column({ type: 'numeric', precision: 5, scale: 2 })
  gstRate: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  moqKg: string;

  @Column({ type: 'boolean', default: false })
  quoteOnly: boolean;

  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /**
   * Denormalised review aggregates, recomputed when a review is approved or rejected.
   * The frontend's `Product` type carries `rating` and `reviewCount`, and computing them
   * with a correlated subquery on every product-list request would not scale.
   */
  @Column({ type: 'numeric', precision: 3, scale: 2, default: 0 })
  ratingAvg: string;

  @Column({ type: 'int', default: 0 })
  reviewCount: number;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };

  @OneToMany('ProductVariant', 'product')
  variants: ProductVariant[];

  @OneToMany('ProductImage', 'product')
  images: ProductImage[];

  @OneToMany('PricingTier', 'product')
  pricingTiers: PricingTier[];
}
```

`gstRate`, `moqKg` and `ratingAvg` are `numeric` and therefore arrive as strings from `pg`. That is deliberate — they are not money, so they do not use the paise transformer, and a string forces the caller to convert explicitly rather than accidentally doing float arithmetic.

- [ ] **Step 3: Create `product-image.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from './product.entity';

@Entity('product_images')
export class ProductImage extends BaseEntity {
  @Index('idx_product_images_product')
  @ManyToOne(() => Product, (product) => product.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  /** A URL. Brief §1 forbids generated images, so these are placeholders or remote assets. */
  @Column({ type: 'varchar', length: 500 })
  url: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  alt: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;
}
```

- [ ] **Step 4: Create `product-variant.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { VariantChannel } from '../enums';
import type { Inventory } from './inventory.entity';
import { Product } from './product.entity';

/** Brief §11. Eight sizes from 100g to 50kg, each with its own SKU, price and stock. */
@Entity('product_variants')
export class ProductVariant extends BaseEntity {
  @Index('idx_product_variants_product')
  @ManyToOne(() => Product, (product) => product.variants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  @Index('uq_product_variants_sku', { unique: true })
  @Column({ type: 'varchar', length: 60 })
  sku: string;

  @Column({ type: 'varchar', length: 20 })
  size: string;

  /** Canonical unit for per-100g and per-kg comparison. Brief §47. */
  @Column({ type: 'int' })
  grams: number;

  @Column({ type: 'enum', enum: VariantChannel })
  channel: VariantChannel;

  @PaiseColumn()
  pricePaise: bigint;

  @PaiseColumn()
  mrpPaise: bigint;

  @Column({ type: 'int', default: 1 })
  moq: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToOne('Inventory', 'variant')
  inventory: Inventory | null;
}
```

- [ ] **Step 5: Create `inventory.entity.ts`**

```ts
import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ProductVariant } from './product-variant.entity';

/**
 * Stock, one row per variant. Brief §32.
 *
 * A separate table from `ProductVariant` for two reasons: a stock write during checkout must
 * not lock a row that catalogue reads and admin product edits also touch, and the ledger in
 * `InventoryTransaction` needs a single clear owner.
 *
 * `available` is `onHand - reserved`, computed rather than stored — a third column would be a
 * third thing that can disagree with the other two.
 */
@Entity('inventory')
export class Inventory {
  @PrimaryColumn({ type: 'uuid', name: 'variant_id' })
  variantId: string;

  @OneToOne(() => ProductVariant, (variant) => variant.inventory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant;

  /** Physical stock. Never negative — enforced by a check constraint in the migration. */
  @Column({ type: 'int', default: 0 })
  onHand: number;

  /**
   * Held for in-flight operations. Adding to cart reserves nothing (spec §10.1), so this is
   * zero in normal operation; it exists so a future hold mechanism does not need a migration.
   */
  @Column({ type: 'int', default: 0 })
  reserved: number;

  @Column({ type: 'int', default: 10 })
  lowStockThreshold: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 6: Create `inventory-transaction.entity.ts`**

```ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { InventoryTransactionType } from '../enums';
import { ProductVariant } from './product-variant.entity';
import { User } from '../identity/user.entity';

/**
 * Append-only stock ledger. Brief §32 wants stock added, sold and adjusted with a reason, a
 * date and the admin responsible.
 *
 * No `updatedAt`, and nothing ever updates or deletes a row: an audit trail that can be
 * edited is not an audit trail. A correction is a new compensating row.
 *
 * The invariant `SUM(delta) = inventory.on_hand` per variant is asserted by an integration
 * test in Task 21, which is what stops the denormalised column drifting from the ledger.
 */
@Entity('inventory_transactions')
export class InventoryTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_inventory_transactions_variant')
  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant;

  @Column({ type: 'uuid', name: 'variant_id' })
  variantId: string;

  /** Signed. Negative for a sale, positive for a receipt, either for an adjustment. */
  @Column({ type: 'int' })
  delta: number;

  @Column({ type: 'enum', enum: InventoryTransactionType })
  type: InventoryTransactionType;

  @Column({ type: 'varchar', length: 200 })
  reason: string;

  /** Set for SALE, CANCELLATION and RETURN. Null for a manual receipt or adjustment. */
  @Index('idx_inventory_transactions_order')
  @Column({ type: 'uuid', nullable: true, name: 'order_id' })
  orderId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'actor_user_id' })
  actorUserId: string | null;

  /** `onHand` after this row was applied, so the ledger reads without recomputing a sum. */
  @Column({ type: 'int' })
  balanceAfter: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 7: Create `pricing-tier.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { CustomerSegment } from '../enums';
import { Business } from '../identity/business.entity';
import { Product } from './product.entity';

/**
 * Brief §16 and §31. Quantity-slab pricing per product, optionally narrowed to a segment or
 * to one business.
 *
 * Resolution order, implemented in Plan 3: a tier for this exact `businessId` wins, then one
 * for the buyer's segment, then `DEFAULT`. That ordering is why all three live in one table
 * rather than three.
 */
@Entity('pricing_tiers')
export class PricingTier extends BaseEntity {
  @Index('idx_pricing_tiers_product')
  @ManyToOne(() => Product, (product) => product.pricingTiers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  @Column({ type: 'numeric', precision: 8, scale: 2 })
  minKg: string;

  /** Null is the open-ended top slab, e.g. "50kg+". */
  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  maxKg: string | null;

  /** Null means this slab requires a quote and routes to the RFQ flow. Brief §47. */
  @PaiseColumn({ nullable: true })
  pricePerKgPaise: bigint | null;

  @Column({ type: 'enum', enum: CustomerSegment, default: CustomerSegment.DEFAULT })
  segment: CustomerSegment;

  /** Brief §31 customer-specific pricing. */
  @ManyToOne(() => Business, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Business | null;

  @Column({ type: 'uuid', nullable: true, name: 'business_id' })
  businessId: string | null;
}
```

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: clean.

```bash
git add backend/src/entities/catalog
git commit -m "feat(backend): add catalog, variant, inventory and pricing-tier entities"
```

## Task 17: Commerce entities

Spec §5.3. The critical design point is that `Order` and `OrderItem` **snapshot** their data.

**Files:**
- Create in `backend/src/entities/commerce/`: `cart.entity.ts`, `cart-item.entity.ts`, `coupon.entity.ts`, `coupon-redemption.entity.ts`, `order.entity.ts`, `order-item.entity.ts`, `order-event.entity.ts`, `payment.entity.ts`, `shipment.entity.ts`, `serviceable-pincode.entity.ts`

- [ ] **Step 1: Create `cart.entity.ts` and `cart-item.entity.ts`**

```ts
// cart.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from '../identity/user.entity';
import type { CartItem } from './cart-item.entity';

/**
 * Persisted for signed-in users only. Guests keep their cart in localStorage and merge it on
 * login (spec §7). Server persistence exists so brief §38's abandoned-cart notification has
 * something to read, and so a cart survives a device change.
 */
@Entity('carts')
export class Cart extends BaseEntity {
  @Index('uq_carts_user', { unique: true })
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @OneToMany('CartItem', 'cart', { cascade: true })
  items: CartItem[];
}
```

```ts
// cart-item.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { OrderChannelEnum } from '../enums';
import { Product } from '../catalog/product.entity';
import { ProductVariant } from '../catalog/product-variant.entity';
import { Cart } from './cart.entity';

/**
 * Mirrors the frontend's `CartLine`.
 *
 * Deliberately has no price column. A cart is a list of intentions; the price is resolved
 * live on every read, so a catalogue price change is reflected immediately rather than a
 * stale figure being carried to checkout. Spec §13 forbids trusting a client-supplied price
 * for the same reason.
 */
@Entity('cart_items')
export class CartItem extends BaseEntity {
  @Index('idx_cart_items_cart')
  @ManyToOne(() => Cart, (cart) => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: Cart;

  @Column({ type: 'uuid', name: 'cart_id' })
  cartId: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  /** Set on a retail line. Null on a bulk line, which is priced per kg from a tier. */
  @ManyToOne(() => ProductVariant, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant | null;

  @Column({ type: 'uuid', nullable: true, name: 'variant_id' })
  variantId: string | null;

  @Column({ type: 'enum', enum: OrderChannelEnum })
  mode: OrderChannelEnum;

  /** Bulk lines carry a kilogram quantity instead of a variant. */
  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  kg: string | null;

  @Column({ type: 'int', default: 1 })
  qty: number;
}
```

- [ ] **Step 2: Create `coupon.entity.ts` and `coupon-redemption.entity.ts`**

```ts
// coupon.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { CouponChannel, CouponScope, CouponType } from '../enums';
import { Category } from '../catalog/category.entity';

/** Brief §36. */
@Entity('coupons')
export class Coupon extends BaseEntity {
  /** Stored uppercase so lookup is exact and `save10` matches `SAVE10`. */
  @Index('uq_coupons_code', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'enum', enum: CouponType })
  type: CouponType;

  /** Percent for PERCENT (e.g. 10), paise for FLAT. Interpreted by `type`. */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  value: string;

  @PaiseColumn({ nullable: true })
  minOrderValuePaise: bigint | null;

  /** Caps a percentage discount. Brief §36. */
  @PaiseColumn({ nullable: true })
  maxDiscountPaise: bigint | null;

  @Column({ type: 'enum', enum: CouponScope, default: CouponScope.ALL })
  appliesTo: CouponScope;

  @ManyToOne(() => Category, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ type: 'uuid', nullable: true, name: 'category_id' })
  categoryId: string | null;

  @Column({ type: 'enum', enum: CouponChannel, default: CouponChannel.ALL })
  channel: CouponChannel;

  @Column({ type: 'boolean', default: false })
  firstOrderOnly: boolean;

  @Column({ type: 'int', nullable: true })
  usageLimit: number | null;

  @Column({ type: 'int', nullable: true })
  usageLimitPerUser: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
```

```ts
// coupon-redemption.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Coupon } from './coupon.entity';
import { User } from '../identity/user.entity';

/**
 * One row per successful redemption.
 *
 * `Unique(couponId, orderId)` is the backstop against a retried checkout double-counting a
 * use. Per-user limits are counted inside the order transaction after taking
 * `SELECT ... FOR UPDATE` on the coupon row (spec §10.2), because counting then inserting is
 * otherwise a read-then-write race two concurrent checkouts can both win.
 */
@Entity('coupon_redemptions')
@Unique('uq_coupon_redemptions_coupon_order', ['couponId', 'orderId'])
export class CouponRedemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_coupon_redemptions_coupon')
  @ManyToOne(() => Coupon, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'coupon_id' })
  coupon: Coupon;

  @Column({ type: 'uuid', name: 'coupon_id' })
  couponId: string;

  @Index('idx_coupon_redemptions_user')
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @PaiseColumn()
  discountPaise: bigint;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 3: Create `order.entity.ts`**

```ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../enums';
import { Business } from '../identity/business.entity';
import { User } from '../identity/user.entity';
import type { OrderEvent } from './order-event.entity';
import type { OrderItem } from './order-item.entity';

/** A snapshot of a delivery address as it was at checkout. */
export interface AddressSnapshot {
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

@Entity('orders')
export class Order extends BaseEntity {
  /** `NN-{year}-{6 digits}`, the reference a customer quotes to support. */
  @Index('uq_orders_order_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  orderNumber: string;

  @Index('idx_orders_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @ManyToOne(() => Business, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'business_id' })
  business: Business | null;

  @Column({ type: 'uuid', nullable: true, name: 'business_id' })
  businessId: string | null;

  @Column({ type: 'enum', enum: OrderChannelEnum })
  channel: OrderChannelEnum;

  /**
   * One of the tuples in `@nutwala/shared`. Varchar with a check constraint rather than a
   * Postgres enum, so brief §33's vocabulary has exactly one definition — see Task 14.
   */
  @Index('idx_orders_status')
  @Column({ type: 'varchar', length: 24 })
  status: string;

  @Column({ type: 'enum', enum: PaymentMethodEnum })
  paymentMethod: PaymentMethodEnum;

  @Column({ type: 'enum', enum: PaymentStatusEnum, default: PaymentStatusEnum.PENDING })
  paymentStatus: PaymentStatusEnum;

  @PaiseColumn()
  subtotalPaise: bigint;

  @PaiseColumn({ default: 0 })
  discountPaise: bigint;

  @PaiseColumn()
  gstPaise: bigint;

  @PaiseColumn({ default: 0 })
  shippingPaise: bigint;

  @PaiseColumn()
  totalPaise: bigint;

  @Column({ type: 'varchar', length: 40, nullable: true })
  couponCode: string | null;

  /**
   * The address as it was at checkout, not a foreign key.
   *
   * Spec §5.3: a customer editing or deleting an address must not change where a past order
   * says it was delivered. This is the same reason `OrderItem` snapshots its price.
   */
  @Column({ type: 'jsonb' })
  addressSnapshot: AddressSnapshot;

  @Column({ type: 'jsonb', nullable: true })
  billingSnapshot: AddressSnapshot | null;

  // Brief §20 B2B checkout fields.
  @Column({ type: 'varchar', length: 160, nullable: true })
  companyName: string | null;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  poNumber: string | null;

  @Column({ type: 'text', nullable: true })
  specialInstructions: string | null;

  @Index('idx_orders_placed_at')
  @Column({ type: 'timestamptz' })
  placedAt: Date;

  @Column({ type: 'timestamptz' })
  estimatedDelivery: Date;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  cancelReason: string | null;

  @OneToMany('OrderItem', 'order', { cascade: ['insert'] })
  items: OrderItem[];

  @OneToMany('OrderEvent', 'order', { cascade: ['insert'] })
  events: OrderEvent[];
}
```

- [ ] **Step 4: Create `order-item.entity.ts` and `order-event.entity.ts`**

```ts
// order-item.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Product } from '../catalog/product.entity';
import { ProductVariant } from '../catalog/product-variant.entity';
import { Order } from './order.entity';

/**
 * A purchased line, fully snapshotted.
 *
 * `productId` and `variantId` are nullable and `SET NULL` on delete, while `productSlug`,
 * `name` and `unitPricePaise` are copies. So a product deleted or repriced in admin leaves
 * this row — and the invoice it prints — completely unchanged.
 */
@Entity('order_items')
export class OrderItem extends BaseEntity {
  @Index('idx_order_items_order')
  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'uuid', nullable: true, name: 'product_id' })
  productId: string | null;

  @ManyToOne(() => ProductVariant, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant | null;

  @Column({ type: 'uuid', nullable: true, name: 'variant_id' })
  variantId: string | null;

  @Column({ type: 'varchar', length: 120 })
  productSlug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** Pack size for a retail line, "25 kg" for a bulk one. Matches the frontend's `detail`. */
  @Column({ type: 'varchar', length: 40 })
  detail: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  size: string | null;

  @Column({ type: 'int', nullable: true })
  grams: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  kg: string | null;

  @Column({ type: 'int' })
  qty: number;

  @PaiseColumn()
  unitPricePaise: bigint;

  /** Null when the line was fulfilled against a negotiated quote. */
  @PaiseColumn({ nullable: true })
  lineTotalPaise: bigint | null;

  @Column({ type: 'numeric', precision: 5, scale: 2 })
  gstRate: string;

  @PaiseColumn({ default: 0 })
  gstAmountPaise: bigint;
}
```

```ts
// order-event.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Order } from './order.entity';
import { User } from '../identity/user.entity';

/**
 * The order tracking timeline. Append-only.
 *
 * The customer's tracking page and the admin status history read the same rows, so admin
 * action and what the customer sees cannot disagree — spec §10.3.
 */
@Entity('order_events')
export class OrderEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_order_events_order')
  @ManyToOne(() => Order, (order) => order.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'varchar', length: 24 })
  status: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note: string | null;

  /** Null for a system-generated event such as the initial `pending`. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'actor_user_id' })
  actorUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 5: Create `payment.entity.ts`, `shipment.entity.ts` and `serviceable-pincode.entity.ts`**

```ts
// payment.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { PaymentMethodEnum, PaymentStatusEnum } from '../enums';
import { Order } from './order.entity';

/** COD opens PENDING and moves to COLLECTED when admin records collection. Spec §10.4. */
@Entity('payments')
export class Payment extends BaseEntity {
  @Index('idx_payments_order')
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'enum', enum: PaymentMethodEnum })
  method: PaymentMethodEnum;

  @Column({ type: 'enum', enum: PaymentStatusEnum, default: PaymentStatusEnum.PENDING })
  status: PaymentStatusEnum;

  @PaiseColumn()
  amountPaise: bigint;

  @Column({ type: 'timestamptz', nullable: true })
  collectedAt: Date | null;

  /** A gateway reference once online payment is enabled; a receipt number for COD. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  reference: string | null;
}
```

```ts
// shipment.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { ShipmentStatus } from '../enums';
import { Order } from './order.entity';

@Entity('shipments')
export class Shipment extends BaseEntity {
  @Index('idx_shipments_order')
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  courier: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  trackingNumber: string | null;

  @Column({ type: 'enum', enum: ShipmentStatus, default: ShipmentStatus.PENDING })
  status: ShipmentStatus;

  @Column({ type: 'timestamptz', nullable: true })
  shippedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
```

```ts
// serviceable-pincode.entity.ts
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';

/**
 * Admin-editable delivery rules, keyed by pincode prefix.
 *
 * Phase 1 answered the pincode checker with `/^[2-8]\d{6}$/` and a digit-sum ETA. That was
 * honest as a mock but is not a delivery policy. Longest-prefix match wins, so a single '1'
 * row can cover a whole region and a specific '110001' row can override it.
 */
@Entity('serviceable_pincodes')
export class ServiceablePincode {
  /** 1 to 6 digits. A 6-digit row is an exact pincode. */
  @PrimaryColumn({ type: 'varchar', length: 6, name: 'pincode_prefix' })
  pincodePrefix: string;

  @Column({ type: 'boolean', default: true })
  isServiceable: boolean;

  /** Working days from dispatch. */
  @Column({ type: 'int', default: 4 })
  etaDays: number;

  @PaiseColumn({ default: 0 })
  shippingPaise: bigint;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w backend`
Expected: clean.

```bash
git add backend/src/entities/commerce
git commit -m "feat(backend): add cart, coupon, order, payment and shipping entities"
```

## Task 18: B2B, content and operations entities

Spec §5.4.

**Files:**
- Create in `backend/src/entities/b2b/`: `rfq.entity.ts`, `rfq-item.entity.ts`, `rfq-note.entity.ts`, `rfq-gifting-detail.entity.ts`
- Create in `backend/src/entities/content/`: `review.entity.ts`, `blog-post.entity.ts`
- Create in `backend/src/entities/ops/`: `support-ticket.entity.ts`, `support-ticket-note.entity.ts`, `notification.entity.ts`, `setting.entity.ts`, `audit-log.entity.ts`, `idempotency-key.entity.ts`

- [ ] **Step 1: Create the RFQ entities**

```ts
// rfq.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { RfqKind } from '../enums';
import { User } from '../identity/user.entity';
import type { RfqGiftingDetail } from './rfq-gifting-detail.entity';
import type { RfqItem } from './rfq-item.entity';
import type { RfqNote } from './rfq-note.entity';

/**
 * Brief §17 and §34. Created publicly — a prospect need not have an account, which is why
 * `userId` is nullable and the contact fields are stored on the RFQ rather than read from a
 * user record.
 */
@Entity('rfqs')
export class Rfq extends BaseEntity {
  @Index('uq_rfqs_rfq_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  rfqNumber: string;

  @Index('idx_rfqs_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'enum', enum: RfqKind, default: RfqKind.BULK })
  kind: RfqKind;

  @Column({ type: 'varchar', length: 160 })
  businessName: string;

  @Column({ type: 'varchar', length: 120 })
  contactPerson: string;

  @Column({ type: 'varchar', length: 15 })
  mobile: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60 })
  businessType: string;

  @Column({ type: 'char', length: 6 })
  pincode: string;

  @Column({ type: 'varchar', length: 60 })
  packaging: string;

  @Column({ type: 'varchar', length: 40 })
  frequency: string;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** One of `RFQ_STATUSES` from `@nutwala/shared`. Brief §34's seven-state pipeline. */
  @Index('idx_rfqs_status')
  @Column({ type: 'varchar', length: 20, default: 'new' })
  status: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_salesperson_id' })
  assignedSalesperson: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_salesperson_id' })
  assignedSalespersonId: string | null;

  /** Brief §34's "expected value", set by the sales desk. */
  @PaiseColumn({ nullable: true })
  expectedValuePaise: bigint | null;

  @OneToMany('RfqItem', 'rfq', { cascade: ['insert'] })
  items: RfqItem[];

  @OneToMany('RfqNote', 'rfq')
  notesList: RfqNote[];

  @OneToOne('RfqGiftingDetail', 'rfq', { cascade: ['insert'] })
  gifting: RfqGiftingDetail | null;
}
```

```ts
// rfq-item.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from '../catalog/product.entity';
import { Rfq } from './rfq.entity';

@Entity('rfq_items')
export class RfqItem extends BaseEntity {
  @Index('idx_rfq_items_rfq')
  @ManyToOne(() => Rfq, (rfq) => rfq.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'uuid', nullable: true, name: 'product_id' })
  productId: string | null;

  /** Kept alongside the id so an unpublished product still shows on a historic RFQ. */
  @Column({ type: 'varchar', length: 120 })
  productSlug: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  kg: string;
}
```

```ts
// rfq-note.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../identity/user.entity';
import { Rfq } from './rfq.entity';

/**
 * Brief §34 internal notes.
 *
 * Never exposed on a customer-facing endpoint. `GET /rfqs/:rfqNumber` must not select this
 * relation — a sales note about a prospect's negotiating position is not for the prospect.
 */
@Entity('rfq_notes')
export class RfqNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_rfq_notes_rfq')
  @ManyToOne(() => Rfq, (rfq) => rfq.notesList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_user_id' })
  authorUser: User;

  @Column({ type: 'uuid', name: 'author_user_id' })
  authorUserId: string;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

```ts
// rfq-gifting-detail.entity.ts
import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Rfq } from './rfq.entity';

/**
 * Brief §24. Spec §3.2 maps brief §45's `GiftOrders` here, because the Phase 1 frontend
 * already models a gifting enquiry as `Rfq.kind = "gifting"` and both should land in one
 * numbered sales queue rather than two with separate statuses.
 */
@Entity('rfq_gifting_details')
export class RfqGiftingDetail {
  @PrimaryColumn({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @OneToOne(() => Rfq, (rfq) => rfq.gifting, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'varchar', length: 60 })
  occasion: string;

  @Column({ type: 'varchar', length: 120 })
  giftBoxSlug: string;

  @Column({ type: 'int' })
  boxes: number;

  @PaiseColumn()
  budgetPerBoxPaise: bigint;

  @Column({ type: 'boolean', default: false })
  brandingRequired: boolean;

  /** A calendar date, not an instant — `date` avoids a timezone shifting it by a day. */
  @Column({ type: 'date' })
  deliveryDate: string;

  @Column({ type: 'text', default: '' })
  message: string;
}
```

- [ ] **Step 2: Create the content entities**

```ts
// review.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { ReviewStatus } from '../enums';
import { Product } from '../catalog/product.entity';
import { User } from '../identity/user.entity';

/** Brief §27. Held behind admin moderation; public endpoints return APPROVED only. */
@Entity('reviews')
export class Review extends BaseEntity {
  @Index('idx_reviews_product')
  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'varchar', length: 120 })
  author: string;

  /** Whole stars 1–5, enforced by a check constraint in the migration. */
  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  /**
   * Set by the server only, after finding a DELIVERED order for this user containing this
   * product. Spec §13 — a client-supplied value here would make the badge meaningless.
   */
  @Column({ type: 'boolean', default: false })
  verifiedPurchase: boolean;

  @Index('idx_reviews_status')
  @Column({ type: 'enum', enum: ReviewStatus, default: ReviewStatus.PENDING })
  status: ReviewStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'moderated_by_user_id' })
  moderatedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'moderated_by_user_id' })
  moderatedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  moderatedAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  rejectionReason: string | null;
}
```

```ts
// blog-post.entity.ts
import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../base.entity';

/** Brief §28. `readingMinutes` stays derived from the body, never stored. */
@Entity('blog_posts')
export class BlogPost extends BaseEntity {
  @Index('uq_blog_posts_slug', { unique: true })
  @Column({ type: 'varchar', length: 160 })
  slug: string;

  @Column({ type: 'varchar', length: 250 })
  title: string;

  /** One of `BLOG_CATEGORIES` from `@nutwala/shared`. */
  @Index('idx_blog_posts_category')
  @Column({ type: 'varchar', length: 40 })
  category: string;

  @Column({ type: 'varchar', length: 400 })
  excerpt: string;

  @Column({ type: 'varchar', length: 500 })
  image: string;

  @Column({ type: 'varchar', length: 120 })
  author: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  @Index('idx_blog_posts_published_at')
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };
}
```

- [ ] **Step 3: Create the operations entities**

```ts
// support-ticket.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from '../identity/user.entity';
import type { SupportTicketNote } from './support-ticket-note.entity';

/**
 * The user's "help support queries". Fed by the existing contact form, which already submits
 * name, email, optional phone, topic, optional order id and message.
 *
 * `orderNumber` is a soft link, not a foreign key: a customer may type an order number that
 * does not exist or belongs to someone else, and the ticket must still be created so support
 * can answer. Admin resolves it to an order for display.
 */
@Entity('support_tickets')
export class SupportTicket extends BaseEntity {
  @Index('uq_support_tickets_ticket_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  ticketNumber: string;

  @Index('idx_support_tickets_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  phone: string | null;

  /** One of `CONTACT_TOPICS` from `@nutwala/shared`. */
  @Column({ type: 'varchar', length: 60 })
  topic: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  orderNumber: string | null;

  @Column({ type: 'text' })
  message: string;

  /** One of `SUPPORT_TICKET_STATUSES` from `@nutwala/shared`. */
  @Index('idx_support_tickets_status')
  @Column({ type: 'varchar', length: 20, default: 'new' })
  status: string;

  @Column({ type: 'int', default: 2 })
  priority: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_to_user_id' })
  assignedToUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_to_user_id' })
  assignedToUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @OneToMany('SupportTicketNote', 'ticket')
  notes: SupportTicketNote[];
}
```

```ts
// support-ticket-note.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../identity/user.entity';
import { SupportTicket } from './support-ticket.entity';

@Entity('support_ticket_notes')
export class SupportTicketNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_support_ticket_notes_ticket')
  @ManyToOne(() => SupportTicket, (ticket) => ticket.notes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket;

  @Column({ type: 'uuid', name: 'ticket_id' })
  ticketId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_user_id' })
  authorUser: User;

  @Column({ type: 'uuid', name: 'author_user_id' })
  authorUserId: string;

  @Column({ type: 'text' })
  body: string;

  /** True is staff-only. A customer-visible reply is false. */
  @Column({ type: 'boolean', default: true })
  isInternal: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

```ts
// notification.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { NotificationChannel, NotificationStatus } from '../enums';
import { User } from '../identity/user.entity';

/**
 * Brief §38 asks the architecture to *support* notifications, not to deliver them yet.
 *
 * Rows are persisted and a logging no-op driver marks them SENT. Adding a real provider is a
 * driver swap: nothing else reads this table's shape.
 */
@Entity('notifications')
export class Notification extends BaseEntity {
  @Index('idx_notifications_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  /** e.g. `order.confirmed`, `rfq.received`, `stock.low`. Brief §38's list. */
  @Column({ type: 'varchar', length: 60 })
  template: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Index('idx_notifications_status')
  @Column({ type: 'enum', enum: NotificationStatus, default: NotificationStatus.QUEUED })
  status: NotificationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error: string | null;
}
```

```ts
// setting.entity.ts
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../identity/user.entity';

/**
 * Backs `frontend/src/config/settings.ts`. Brief §26 and §37 require the WhatsApp number,
 * contact details and certification text to be admin-editable and never hardcoded.
 *
 * A key/value table rather than a one-row table with 13 columns, so adding a setting in a
 * later phase is an insert rather than a migration.
 */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  /** False keeps a setting out of the public `GET /settings` response. */
  @Column({ type: 'boolean', default: true })
  isPublic: boolean;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by_user_id' })
  updatedByUserId: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
```

```ts
// audit-log.entity.ts
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../identity/user.entity';

/** Spec §13. One row per admin mutation, written by `AuditInterceptor` in Plan 4. */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_audit_logs_actor')
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User;

  @Column({ type: 'uuid', name: 'actor_user_id' })
  actorUserId: string;

  /** e.g. `product.update`, `order.status.change`, `inventory.adjust`. */
  @Column({ type: 'varchar', length: 60 })
  action: string;

  @Index('idx_audit_logs_entity')
  @Column({ type: 'varchar', length: 40 })
  entity: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

```ts
// idempotency-key.entity.ts
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Gateway's idempotency pattern. Spec §10.4 applies it to order placement, so a
 * double-clicked Place Order replays the first response instead of creating a second order
 * and decrementing stock twice.
 *
 * `requestHash` is compared on replay: the same key with a *different* body is a client bug
 * and must be rejected, not silently answered with the first response.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  key: string;

  /** Namespaces the key, e.g. `checkout:orders`, so two features cannot collide. */
  @Column({ type: 'varchar', length: 60 })
  scope: string;

  @Column({ type: 'char', length: 64 })
  requestHash: string;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  @Index('idx_idempotency_keys_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
```

- [ ] **Step 4: Verify all 33 entities are present**

Run: `find backend/src/entities -name '*.entity.ts' | wc -l`
Expected: `33`.

Run: `npm run typecheck -w backend`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/entities
git commit -m "feat(backend): add RFQ, review, blog, support, notification, setting and audit entities"
```

## Task 19: The initial migration

**Files:**
- Create: `backend/src/database/migrations/20260819120000-InitialSchema.ts`

- [ ] **Step 1: Generate the migration from the entities**

Run: `npm run db:up && npm run migration:generate -w backend -- src/database/migrations/InitialSchema`
Expected: a file `src/database/migrations/<timestamp>-InitialSchema.ts` containing `CREATE TABLE` for 33 tables plus the enum types.

**Review the generated output before trusting it.** Two things to check specifically, both consequences of decisions made deliberately in the entities:

- It must **not** contain a plain unique index on `users.email`. The entity has no `@Index` there on purpose; Step 2 adds a `LOWER(email)` functional index instead. If one appears, delete it from the generated file.
- It will contain the composite `Order` indexes and the absence of `idx_coupon_redemptions_coupon`. Both are intentional.

Rename it to the date-prefixed convention both repos' newer migrations use:

```bash
cd backend/src/database/migrations && for f in *-InitialSchema.ts; do mv "$f" 20260819120000-InitialSchema.ts; done
```

Then edit the class name inside to `InitialSchema20260819120000` and confirm it still exports a class implementing `MigrationInterface`.

- [ ] **Step 2: Add the check constraints TypeORM cannot infer**

Append these to the end of the generated `up()`, and their drops to the start of `down()`. They are the database-level guarantees behind spec §10 and §5.4 — an application bug must not be able to write a nonsensical row.

```ts
    // Stock can never go negative. This is the backstop behind the conditional UPDATE in
    // the checkout transaction (spec §10.2): if that guard were ever removed or bypassed,
    // the database still refuses.
    await queryRunner.query(`
      ALTER TABLE "inventory"
        ADD CONSTRAINT "ck_inventory_non_negative"
        CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "onHand" >= "reserved")
    `);

    // Brief §33's retail and bulk vocabularies, as one constraint. The canonical definition
    // is the tuple in @nutwala/shared; this mirrors it so a bad write fails at the database.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD CONSTRAINT "ck_orders_status"
        CHECK ("status" IN (
          'pending','confirmed','processing','packed','shipped','out-for-delivery',
          'delivered','cancelled','refunded',
          'quote-requested','quote-sent','quote-accepted','awaiting-payment','approved'
        ))
    `);

    await queryRunner.query(`
      ALTER TABLE "order_events"
        ADD CONSTRAINT "ck_order_events_status"
        CHECK ("status" IN (
          'pending','confirmed','processing','packed','shipped','out-for-delivery',
          'delivered','cancelled','refunded',
          'quote-requested','quote-sent','quote-accepted','awaiting-payment','approved'
        ))
    `);

    await queryRunner.query(`
      ALTER TABLE "reviews"
        ADD CONSTRAINT "ck_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5)
    `);

    await queryRunner.query(`
      ALTER TABLE "rfqs"
        ADD CONSTRAINT "ck_rfqs_status"
        CHECK ("status" IN ('new','contacted','quote-sent','negotiation','approved','rejected','converted'))
    `);

    await queryRunner.query(`
      ALTER TABLE "support_tickets"
        ADD CONSTRAINT "ck_support_tickets_status"
        CHECK ("status" IN ('new','open','waiting','resolved','closed'))
    `);

    // Exactly one of the coupon's two value columns is populated, matching its type. They were
    // split out of a single polymorphic `numeric` column that held either a percentage or a paise
    // amount — which meant the paise case bypassed the money convention entirely.
    await queryRunner.query(`
      ALTER TABLE "coupons"
        ADD CONSTRAINT "ck_coupons_value_exclusive"
        CHECK (
          ("type" = 'PERCENT' AND "percentValue" IS NOT NULL AND "flatValuePaise" IS NULL)
          OR
          ("type" = 'FLAT' AND "flatValuePaise" IS NOT NULL AND "percentValue" IS NULL)
        )
    `);

    // A tier is either open-ended or ordered. maxKg < minKg is a data-entry error that would
    // make the slab unreachable and silently fall through to the wrong price.
    await queryRunner.query(`
      ALTER TABLE "pricing_tiers"
        ADD CONSTRAINT "ck_pricing_tiers_range"
        CHECK ("maxKg" IS NULL OR "maxKg" >= "minKg")
    `);

    // Money is never negative anywhere.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD CONSTRAINT "ck_orders_money_non_negative"
        CHECK ("subtotalPaise" >= 0 AND "discountPaise" >= 0 AND "gstPaise" >= 0
               AND "shippingPaise" >= 0 AND "totalPaise" >= 0)
    `);

    // A partial unique index, so one user can have many addresses but only one default.
    // A plain unique index on (user_id, isDefault) would wrongly forbid two non-defaults.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_addresses_one_default_per_user"
        ON "addresses" ("user_id")
        WHERE "isDefault" = true AND "deletedAt" IS NULL
    `);

    // Email uniqueness must be case-insensitive: Kunal@x.test and kunal@x.test are one account.
    // The service lowercases on write; this stops anything that forgets.
    //
    // This index is the ONLY thing enforcing email uniqueness. The entity deliberately carries no
    // `@Index` decorator, because a plain unique index on the column would permanently disagree
    // with this functional one and every `migration:generate` would propose re-adding it. Until
    // this migration runs there is a real (currently dormant, since nothing writes users yet)
    // window in which two accounts could share an address — so this must not be dropped or
    // deferred, and `migration:generate` output must be checked for a spurious plain
    // `uq_users_email` addition, which is to be discarded.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_users_email" ON "users" (LOWER("email"))
    `);
```

- [ ] **Step 3: Apply the migration to the dev database**

Run: `npm run migration:run -w backend`
Expected: log lines showing each query, ending with the migration recorded in `migrations`.

- [ ] **Step 4: Verify the schema landed**

Run: `docker exec -i nutwala-postgres psql -U nutwala -d nutwala -c "\dt"`
Expected: 33 tables plus `migrations`.

Run: `docker exec -i nutwala-postgres psql -U nutwala -d nutwala -c "SELECT conname FROM pg_constraint WHERE contype='c' ORDER BY conname"`
Expected: the eight `ck_` constraints above.

- [ ] **Step 5: Verify the migration reverses cleanly**

A migration that cannot be reverted is not finished.

Run: `npm run migration:revert -w backend && docker exec -i nutwala-postgres psql -U nutwala -d nutwala -c "\dt"`
Expected: no application tables remain.

Run: `npm run migration:run -w backend`
Expected: applies again cleanly.

- [ ] **Step 6: Confirm the integration harness runs the chain**

Run: `npm run test:integration -w backend`
Expected: PASS — the same 2 health tests, now against a container with 33 migrated tables. This proves spec §3.1 departure 4 is working.

## Three permanent consequences of this migration — read before running `migration:generate` again

These were all observed for real after the first migration landed. None is a defect; all three will
mislead someone who trusts generated output.

**1. Every future `migration:generate` will propose DROPPING all nine check constraints and
`uq_addresses_one_default_per_user`.** None of the eleven hand-written objects exist in TypeORM's
entity metadata, so its schema differ sees them as drift. **Those proposals must be discarded, never
applied.** `uq_users_email` is the one exception — TypeORM's schema loader ignores expression
indexes entirely, so it proposes neither adding nor dropping it.

**2. Three phantom `seo` lines will appear in every generated diff:**

```
ALTER TABLE "categories" ALTER COLUMN "seo" SET DEFAULT '{}'::jsonb
ALTER TABLE "products"   ALTER COLUMN "seo" SET DEFAULT '{}'::jsonb
ALTER TABLE "blog_posts" ALTER COLUMN "seo" SET DEFAULT '{}'::jsonb
```

The database default already *is* `'{}'::jsonb` — confirmed via `information_schema.columns`. This is
TypeORM normalising the two sides of a function-valued default differently, not real drift. Discard
these too. Left unfixed deliberately: changing the three entities to appease the differ would be
churn on a false positive, and now that the migration exists an entity change costs a second
migration.

**3. The date-prefix naming convention has a sharp edge.** TypeORM derives a migration's ordering
timestamp from the **last 13 characters of the class name**. `InitialSchema20260819120000` yields
`260819120000`, which is what lands in the `migrations` table. That sorts correctly against other
date-prefixed names — but a migration left with TypeORM's own generated name
(`…1787136759847`) would sort **after** every date-prefixed one regardless of real chronology.

**So the rename in Step 1 is mandatory, not cosmetic.** Every migration in this repo must be
renamed to the `YYYYMMDDHHMMSS-Name` form and its class renamed to match. Mixing the two styles is
an ordering bug that will not surface until migrations run out of order on a fresh database.

- [ ] **Step 7: Commit**

```bash
git add backend/src/database/migrations
git commit -m "feat(backend): add initial schema migration with database-level invariants"
```

## Task 20: Seed the database from the existing mocks

Spec §16 milestone 1. Everything `frontend/src/mocks/` holds moves into Postgres: 27 products, 216 variants and inventory rows, 12 categories, 8 blog posts, 14 reviews, 3 RFQs, 6 orders, 3 addresses, 3 users.

**Files:**
- Create: `backend/src/database/seeds/seed.ts`, `seed-context.ts`, `settings.seed.ts`, `catalog.seed.ts`, `users.seed.ts`, `content.seed.ts`, `orders.seed.ts`, `pincodes.seed.ts`

- [ ] **Step 1: Create the seed runner**

Flag-driven, following CUG's `seed.ts` pattern so a single domain can be reseeded without wiping everything.

```ts
// backend/src/database/seeds/seed.ts
import '../../load-env';
import '../../common/money/bigint-json';
import dataSource from '../../data-source';
import { seedSettings } from './settings.seed';
import { seedUsers } from './users.seed';
import { seedCatalog } from './catalog.seed';
import { seedContent } from './content.seed';
import { seedOrders } from './orders.seed';
import { seedPincodes } from './pincodes.seed';

/**
 * Usage:
 *   npm run seed            — everything, in dependency order
 *   npm run seed -- catalog — one domain only
 *
 * Every seeder is idempotent: it upserts on the natural key (slug, email, code), so running
 * it twice does not duplicate rows. That matters because this is also how a developer
 * refreshes their database after pulling new seed data.
 */
const SEEDERS = {
  settings: seedSettings,
  users: seedUsers,
  catalog: seedCatalog,
  content: seedContent,
  orders: seedOrders,
  pincodes: seedPincodes,
} as const;

type SeederName = keyof typeof SEEDERS;

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const names = (requested.length > 0 ? requested : Object.keys(SEEDERS)) as SeederName[];

  for (const name of names) {
    const seeder = SEEDERS[name];
    if (!seeder) throw new Error(`Unknown seeder "${name}". Known: ${Object.keys(SEEDERS).join(', ')}`);
  }

  await dataSource.initialize();
  try {
    for (const name of names) {
      process.stdout.write(`Seeding ${name}… `);
      const count = await SEEDERS[name](dataSource);
      process.stdout.write(`${count} rows\n`);
    }
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Create the catalog seeder**

The mock data is generated by functions in `frontend/src/mocks/products.ts` (`buildVariants`, `buildTiers`) from a compact seed array. Port those functions rather than the 27 expanded products: the derivation is the source of truth, and hand-copying 216 variants would be both huge and immediately stale.

```ts
// backend/src/database/seeds/catalog.seed.ts
import type { DataSource } from 'typeorm';
import { toPaise } from '@nutwala/shared';
import { Category } from '../../entities/catalog/category.entity';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductImage } from '../../entities/catalog/product-image.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { CustomerSegment, VariantChannel } from '../../entities/enums';

/**
 * Ported from `frontend/src/mocks/products.ts`. Keep the arithmetic identical — the seeded
 * prices are what the Phase 1 screenshots, the seeded orders and the combo savings figures
 * all assume, so changing the formula would silently invalidate all three.
 */
const RETAIL_PACKS = [
  { size: '100g', grams: 100, frac: 0.13 },
  { size: '250g', grams: 250, frac: 0.3 },
  { size: '500g', grams: 500, frac: 0.55 },
  { size: '1kg', grams: 1000, frac: 1 },
] as const;

const BULK_PACKS = [
  { size: '5kg', grams: 5000 },
  { size: '10kg', grams: 10000 },
  { size: '25kg', grams: 25000 },
  { size: '50kg', grams: 50000 },
] as const;

const DISCOUNT = 0.14;

const slugToSku = (slug: string): string =>
  slug
    .split('-')
    .map((word) => word.slice(0, 3).toUpperCase())
    .join('');

interface VariantSeed {
  sku: string;
  size: string;
  grams: number;
  channel: VariantChannel;
  pricePaise: bigint;
  mrpPaise: bigint;
  moq: number;
}

function buildVariants(slug: string, kgPrice: number): VariantSeed[] {
  const retail = RETAIL_PACKS.map(({ size, grams, frac }) => {
    const price = Math.round((kgPrice * frac) / 10) * 10 - 1;
    const mrp = Math.round(price / (1 - DISCOUNT) / 10) * 10 - 1;
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: VariantChannel.RETAIL,
      pricePaise: toPaise(price),
      mrpPaise: toPaise(mrp),
      moq: 1,
    };
  });

  const bulk = BULK_PACKS.map(({ size, grams }) => {
    const kg = grams / 1000;
    const rate = Math.round(kgPrice * (kg >= 50 ? 0.82 : kg >= 25 ? 0.85 : kg >= 10 ? 0.9 : 0.95));
    return {
      sku: `${slugToSku(slug)}-${size.toUpperCase()}`,
      size,
      grams,
      channel: VariantChannel.BULK,
      pricePaise: toPaise(rate * kg),
      mrpPaise: toPaise(kgPrice * kg),
      moq: 1,
    };
  });

  return [...retail, ...bulk];
}

/** Brief §16's five slabs. Ported from `buildTiers` in the same mock file. */
function buildTiers(kgPrice: number): { minKg: number; maxKg: number | null; rate: number | null }[] {
  return [
    { minKg: 1, maxKg: 4, rate: kgPrice },
    { minKg: 5, maxKg: 9, rate: Math.round(kgPrice * 0.95) },
    { minKg: 10, maxKg: 24, rate: Math.round(kgPrice * 0.9) },
    { minKg: 25, maxKg: 49, rate: Math.round(kgPrice * 0.85) },
    { minKg: 50, maxKg: null, rate: Math.round(kgPrice * 0.82) },
  ];
}

export async function seedCatalog(dataSource: DataSource): Promise<number> {
  // 1. Read `frontend/src/mocks/categories.ts` and insert all 12 categories, upserting on
  //    slug. Set isPublished true and sortOrder by array position.
  // 2. Read the `seeds: Seed[]` array in `frontend/src/mocks/products.ts` — all 27 entries —
  //    and for each: upsert the Product on slug, insert 3 ProductImage rows from `images`,
  //    insert 8 ProductVariant rows from buildVariants(slug, kg), insert one Inventory row
  //    per variant with onHand 120 and lowStockThreshold 10, and insert 5 PricingTier rows
  //    from buildTiers(kg) with segment DEFAULT.
  // 2b. For each Inventory row, also insert one InventoryTransaction:
  //    { type: RECEIPT, delta: 120, reason: 'Opening stock (seed)', balanceAfter: 120 }.
  //    Without it the ledger starts 120 short of `onHand`, and every consistency check would
  //    have to know that magic opening figure. With it, SUM(delta) = onHand exactly from the
  //    first row onwards.
  // 3. For a product with `quoteOnly: true`, set the top tier's pricePerKgPaise to null so
  //    it routes to RFQ, matching how the frontend's `isQuoteRequired` behaves.
  //
  // Implement with a single transaction and `dataSource.manager.upsert(...)` on the natural
  // keys, so a re-run replaces rather than duplicates.
  throw new Error('implement per the steps above');
}
```

**This is the one task in this plan where the code is described rather than transcribed**, and deliberately: the seed content is 27 product records and 12 category records that already exist verbatim in `frontend/src/mocks/products.ts` and `categories.ts`. Copying ~400 lines of data into this plan would create a second copy that drifts from the first. The executing engineer reads those two files and ports them.

The three binding constraints, and any conflict between them is a stop-and-ask:

1. The arithmetic above must match `buildVariants` and `buildTiers` in the mock file exactly.
2. Every one of the 27 slugs must survive, because seeded orders, combos and reviews reference them by slug.
3. `find`-level verification in Step 6 must show 27 products, 216 variants and 216 inventory rows.

- [ ] **Step 3: Create the users seeder**

```ts
// backend/src/database/seeds/users.seed.ts
import * as bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { UserRole } from '../../entities/enums';

/**
 * The three fixture accounts from `frontend/src/mocks/users.ts`, now with real password
 * hashes so they can actually sign in.
 *
 * The password is deliberately a single obvious development value, and `seedUsers` refuses to
 * run when NODE_ENV is production — seeding a known credential into a live database is
 * exactly the kind of accident this guard exists to prevent.
 */
const DEV_PASSWORD = 'Password123!';

export async function seedUsers(dataSource: DataSource): Promise<number> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed fixture accounts with a known password in production');
  }

  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const users = integration.dataSource.getRepository(User);

  const fixtures = [
    { name: 'Retail Customer', email: 'b2c@demo.in', phone: '9876543210', role: UserRole.CUSTOMER },
    { name: 'Bulk Buyer', email: 'b2b@demo.in', phone: '9876543211', role: UserRole.BUSINESS },
    { name: 'Store Admin', email: 'admin@demo.in', phone: '9876543212', role: UserRole.ADMIN },
  ];

  for (const fixture of fixtures) {
    const existing = await users.findOne({ where: { email: fixture.email } });
    if (existing) {
      await users.update(existing.id, { ...fixture, passwordHash });
    } else {
      await users.save(users.create({ ...fixture, passwordHash, isActive: true }));
    }
  }

  // Then: create a Business row for b2b@demo.in using the company details in
  // `frontend/src/mocks/users.ts`, and insert the 3 addresses from
  // `frontend/src/mocks/addresses.ts` against the accounts they are keyed by email under.
  // Exactly one address per user carries isDefault true — the partial unique index added in
  // Task 19 will reject a second.

  return fixtures.length;
}
```

- [ ] **Step 4: Create the settings seeder**

```ts
// backend/src/database/seeds/settings.seed.ts
import type { DataSource } from 'typeorm';
import { Setting } from '../../entities/ops/setting.entity';

/**
 * Seeds exactly the keys `frontend/src/config/settings.ts` declares, plus the two payment
 * flags.
 *
 * Certification fields seed **empty**. Brief §25 and §26 forbid claims that have not been
 * configured, and a placeholder FSSAI number would be precisely the unsupported claim the
 * brief rules out. `certifications` renders nothing until an admin fills it in.
 */
const SETTINGS: { key: string; value: unknown; isPublic: boolean }[] = [
  { key: 'brandName', value: 'Nuts & Nazaakat', isPublic: true },
  { key: 'tagline', value: 'Small packs for home. Bulk supply for business.', isPublic: true },
  { key: 'whatsappNumber', value: '', isPublic: true },
  { key: 'supportEmail', value: '', isPublic: true },
  { key: 'supportPhone', value: '', isPublic: true },
  { key: 'freeShippingThreshold', value: 999, isPublic: true },
  { key: 'bulkPromptThresholdGrams', value: 5000, isPublic: true },
  { key: 'gstin', value: '', isPublic: true },
  { key: 'fssaiLicence', value: '', isPublic: true },
  { key: 'certifications', value: [], isPublic: true },
  { key: 'social', value: [], isPublic: true },
  { key: 'addressLines', value: [], isPublic: true },
  // Spec §10.4 — COD only until online payment is deliberately switched on.
  { key: 'codEnabled', value: true, isPublic: true },
  { key: 'onlinePaymentEnabled', value: false, isPublic: true },
  { key: 'flatShippingRate', value: 79, isPublic: true },
];

export async function seedSettings(dataSource: DataSource): Promise<number> {
  const repository = integration.dataSource.getRepository(Setting);
  for (const setting of SETTINGS) {
    await repository.upsert({ ...setting }, ['key']);
  }
  return SETTINGS.length;
}
```

- [ ] **Step 5: Create the content, orders and pincode seeders**

`content.seed.ts` — port all 8 posts from `frontend/src/mocks/posts.ts` (upsert on slug, `isPublished: true`, `publishedAt` from the mock's `publishedAt`) and all 14 reviews from `mocks/reviews.ts`, resolving `productSlug` to a `productId`. Preserve each review's `status` exactly.

**Correction to an earlier version of this step.** It claimed the mock "deliberately includes non-approved rows so the moderation queue has something in it." That is false — verified: **all 14 mock reviews are `approved`**, and the mock's own header comment says so outright ("Every row here is `approved` — the moderation queue starts empty"). The single `"pending"` string in that file sits inside that comment, describing what a visitor submission becomes.

So the moderation queue **seeds empty**, which is correct behaviour rather than a gap. **Plan 4's admin review-moderation screen must create its own `PENDING`/`REJECTED` fixtures**; it will not find any.

After seeding reviews, recompute `Product.ratingAvg` and `Product.reviewCount` from the `APPROVED` rows only, so the denormalised aggregates agree with the ledger of reviews from the start.

`orders.seed.ts` — port all 6 orders from `frontend/src/mocks/orders.ts`. For each: resolve the owning user by the mock's `email`, write `addressSnapshot` from the mock's `address`, insert one `OrderItem` per item with `unitPricePaise` derived as `total / qty`, insert one `OrderEvent` per `timeline` entry preserving `at` as `createdAt`, and insert one `Payment` row. Set `paymentMethod: COD` and `paymentStatus: COLLECTED` for a `delivered` order, `PENDING` otherwise.

These seeded orders must **not** decrement inventory. They are historical fixtures, and the
Task 21 invariant requires `SUM(delta) = onHand` — so writing `SALE` rows here would also
demand matching `onHand` reductions, turning the seed into a stock simulation. Seed the orders
with no `InventoryTransaction` rows, leaving every variant at the opening figure the catalog
seeder gave it: **120 for a retail variant, 40 for a bulk one**, exactly as the mock has them.

Every product/variant/HSN lookup in this seeder goes through `requireValue`, like every other
seeder's. The three item-level columns are nullable in the schema so a snapshot survives its
product being deleted (`ON DELETE SET NULL`) — but at *seed* time they must all resolve, and a
mistyped `variantSize` writing an order line that points at nothing is the exact silent
corruption `requireValue` exists to stop. Same for `businessId` on a bulk order: retail has no
company, bulk always does.

**RFQs are deliberately not seeded, and this is a real conflict for Plan 3 to resolve.**

An earlier version of this task's prose mentioned "3 RFQs", but there is no `rfqs.seed.ts` in its file list and no expected count in Step 6 — and seeding them would violate a live check constraint. The mock's RFQ rows use `status` values `new`, `quoted` and `accepted`, while `RFQ_STATUSES` in `@nutwala/shared` — which `ck_rfqs_status` mirrors — is `new`, `contacted`, `quote-sent`, `negotiation`, `approved`, `rejected`, `converted`. So `quoted` and `accepted` would be rejected by Postgres.

This is the divergence first noted when the shared constants were written: `frontend/src/features/rfq/types.ts` types four states while the brief's sales pipeline has seven. It is now a hard conflict rather than cosmetic, because a check constraint enforces the seven.

**Plan 3 must decide explicitly:** migrate the frontend's `RfqStatus` and its mock rows onto the seven-state vocabulary, or add an explicit two-way mapping at the API boundary. Do **not** resolve it by widening the check constraint — the seven states are the client brief's own pipeline.

#### Carried forward from the Task 20/21 quality review

Four findings were deliberately deferred rather than fixed. Each is recorded with the trigger
that should force the decision, so none of them is rediscovered the hard way.

1. **`ProductImage` and `PricingTier` are replaced wholesale on every catalog reseed.**
   `catalog.seed.ts` deletes and reinserts both per product. Harmless today because nothing else
   writes them — but the moment **admin product-editing ships**, `npm run seed -- catalog`
   silently destroys hand-edited images and tiers, exactly as it would destroy real stock
   movements. Unlike the ledger there is no fallback: neither entity has *any* unique index, so a
   real upsert is not expressible. That task must either add natural keys —
   `(product_id, sort_order)` and `(product_id, min_kg, segment, business_id)` — or make the
   seeder refuse to run when it finds rows it did not write. A caveat now sits in the code beside
   the delete.

2. **Six hand-written check constraints have no test anywhere.**
   `ck_orders_money_non_negative`, `ck_pricing_tiers_range`, `ck_coupons_value_exclusive`,
   `ck_order_events_status`, `ck_rfqs_status`, `ck_support_tickets_status` appear only in the
   migration. Task 21's scope was spec §17 items 7 and 11, so this is a gap rather than a defect —
   but a future migration refactor could drop one with nothing to catch it. Cover them **when
   RFQs or coupons get feature work**, since that is when someone is already in those tables.

3. **`Product.publishedAt` stays null while `isPublished` is true — this is an acceptance
   criterion of the catalogue read-API task, not a bug to fix here.** Verified inert today:
   nothing outside `entities/`, `migrations/` and `seeds/` references the column. The catalogue
   listing query **must filter on `isPublished`**, never on `publishedAt IS NOT NULL`, or all 27
   seeded products vanish from the shop. Whoever writes that query owns this line.

4. **The catalog seeder issues ~270 statements for 27 products, and re-runs in a `beforeEach`.**
   The upsert already returns the row id, so the `findOne` that immediately follows it (here and
   in `orders.seed.ts`) is one avoidable round trip per product/order. Measured: 402 statements
   for a from-empty run, ~2,700 per integration suite. Fine at ~9s. Fix it when **a fourth
   integration spec reuses this `beforeEach`**, or when the catalogue grows materially past 27
   products.

`pincodes.seed.ts` — seed one row per leading digit 1–8 with `isServiceable: true`, `etaDays: 4`, `shippingPaise: toPaise(79)`, plus a `0` and `9` row with `isServiceable: false`. This reproduces Phase 1's `/^[2-8]\d{5}$/` behaviour closely enough that the existing pincode-checker UI keeps working, while being admin-editable as spec §5.3 requires.

- [ ] **Step 6: Run the seeder and verify the counts**

Run: `npm run seed -w backend`
Expected: a line per seeder with a row count, no errors.

```bash
docker exec -i nutwala-postgres psql -U nutwala -d nutwala -c "
SELECT 'categories' t, count(*) FROM categories
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'variants', count(*) FROM product_variants
UNION ALL SELECT 'inventory', count(*) FROM inventory
UNION ALL SELECT 'inventory_transactions', count(*) FROM inventory_transactions
UNION ALL SELECT 'pricing_tiers', count(*) FROM pricing_tiers
UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'addresses', count(*) FROM addresses
UNION ALL SELECT 'blog_posts', count(*) FROM blog_posts
UNION ALL SELECT 'reviews', count(*) FROM reviews
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'settings', count(*) FROM settings
ORDER BY t"
```

Expected: `categories 12`, `products 27`, `variants 216`, `inventory 216`, `inventory_transactions 216`, `pricing_tiers 135`, `users 3`, `addresses 3`, `blog_posts 8`, `reviews 14`, `orders 6`, `settings 15`.

- [ ] **Step 7: Verify the seeder is idempotent**

Run: `npm run seed -w backend` a second time, then re-run the count query.
Expected: identical counts. A second run that doubles a count means an `upsert` is missing its conflict target.

- [ ] **Step 8: Commit**

```bash
git add backend/src/database/seeds
git commit -m "feat(backend): seed catalog, users, content, orders and settings from mocks"
```

## Task 21: Assert the data invariants (integration)

Spec §17 items 7 and 11. These tests are what stop the denormalised columns drifting from the rows they summarise.

**Files:**
- Create: `backend/test/integration/schema-invariants.integration.spec.ts`

- [ ] **Step 1: Write the tests**

```ts
import { DataSource } from 'typeorm';
import { cleanDatabase, closeTestDataSource, connectTestDataSource } from './helpers';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';

describe('schema invariants', () => {
  let dataSource: DataSource;

  // The container itself is started once in `globalSetup`, not here. `connectTestDataSource`
  // only opens a connection to it — a spec that starts its own container is the bug the harness
  // was restructured to remove, which is why `startTestDatabase` is not exported to specs.
  beforeAll(async () => {
    dataSource = await connectTestDataSource();
  }, 120_000);

  afterAll(async () => {
    // Closes this spec's connection. The container is torn down by `globalTeardown`.
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await cleanDatabase(dataSource);
    await seedSettings(dataSource);
    await seedUsers(dataSource);
    await seedCatalog(dataSource);
  });

  it('seeds the expected catalog volume', async () => {
    const [{ count: products }] = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM products',
    );
    const [{ count: variants }] = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM product_variants',
    );
    const [{ count: inventory }] = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM inventory',
    );

    expect(Number(products)).toBe(27);
    expect(Number(variants)).toBe(216);
    // Every variant must have exactly one inventory row, or a stock read returns undefined
    // and the sold-out rule silently stops applying to that pack.
    expect(Number(inventory)).toBe(216);
  });

  it('gives every variant an inventory row', async () => {
    const orphans = await dataSource.query<{ id: string }[]>(`
      SELECT v.id FROM product_variants v
      LEFT JOIN inventory i ON i.variant_id = v.id
      WHERE i.variant_id IS NULL
    `);
    expect(orphans).toEqual([]);
  });

  it('keeps the inventory ledger consistent with on-hand stock', async () => {
    // Spec §17 item 7. `onHand` is denormalised and the ledger is append-only, so this is the
    // assertion that they can never silently disagree.
    //
    // It is an exact equality because the seeder writes an opening RECEIPT row for the
    // starting 120 (Task 20 step 2b). Seeding stock without a ledger entry would force this
    // test — and every later one — to know that magic number.
    const drift = await dataSource.query<{ variant_id: string; on_hand: number; ledger: number }[]>(`
      SELECT i.variant_id,
             i."onHand" AS on_hand,
             COALESCE(SUM(t.delta), 0)::int AS ledger
        FROM inventory i
        LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
       GROUP BY i.variant_id, i."onHand"
      HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
    `);
    expect(drift).toEqual([]);
  });

  it('records an opening ledger row for every variant', async () => {
    const [{ count }] = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::int AS count FROM inventory_transactions WHERE type = 'RECEIPT'`,
    );
    expect(Number(count)).toBe(216);
  });

  it('refuses to drive stock negative', async () => {
    const [variant] = await dataSource.query<{ variant_id: string }[]>(
      'SELECT variant_id FROM inventory LIMIT 1',
    );
    await expect(
      dataSource.query('UPDATE inventory SET "onHand" = -1 WHERE variant_id = $1', [
        variant?.variant_id,
      ]),
    ).rejects.toThrow(/ck_inventory_non_negative/);
  });

  it('refuses an out-of-range review rating', async () => {
    const [product] = await dataSource.query<{ id: string }[]>('SELECT id FROM products LIMIT 1');
    await expect(
      dataSource.query(
        `INSERT INTO reviews (product_id, author, rating, body, status)
         VALUES ($1, 'Tester', 6, 'too many stars', 'PENDING')`,
        [product?.id],
      ),
    ).rejects.toThrow(/ck_reviews_rating/);
  });

  it('refuses an unknown order status', async () => {
    await expect(
      dataSource.query(`
        INSERT INTO orders ("orderNumber", channel, status, "paymentMethod",
                            "subtotalPaise", "gstPaise", "totalPaise",
                            "addressSnapshot", "placedAt", "estimatedDelivery")
        VALUES ('NN-2026-999999', 'RETAIL', 'teleported', 'COD', 0, 0, 0,
                '{}'::jsonb, now(), now())
      `),
    ).rejects.toThrow(/ck_orders_status/);
  });

  it('treats email uniqueness case-insensitively', async () => {
    await expect(
      dataSource.query(`
        INSERT INTO users (name, email, phone, "passwordHash", role)
        VALUES ('Duplicate', 'B2C@DEMO.IN', '9999999999', 'x', 'CUSTOMER')
      `),
    ).rejects.toThrow(/uq_users_email/);
  });

  it('allows only one default address per user', async () => {
    const [address] = await dataSource.query<{ user_id: string }[]>(
      'SELECT user_id FROM addresses WHERE "isDefault" = true LIMIT 1',
    );
    await expect(
      dataSource.query(
        `INSERT INTO addresses (user_id, label, "fullName", phone, email, line1, city, state,
                                pincode, "isDefault")
         VALUES ($1, 'Second', 'Someone', '9876543210', 'a@b.test', 'Line', 'City', 'Delhi',
                 '110001', true)`,
        [address?.user_id],
      ),
    ).rejects.toThrow(/uq_addresses_one_default_per_user/);
  });

  it('seeds no certification claim, per brief §25 and §26', async () => {
    const rows = await dataSource.query<{ key: string; value: unknown }[]>(
      `SELECT key, value FROM settings WHERE key IN ('certifications', 'fssaiLicence', 'gstin')`,
    );
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey.certifications).toEqual([]);
    expect(byKey.fssaiLicence).toBe('');
    expect(byKey.gstin).toBe('');
  });
});
```

- [ ] **Step 2: Run the integration suite**

Run: `npm run test:integration -w backend`
Expected: PASS. This is the **third** integration spec file, so it is also the real test of the
shared-container work: watch the output and confirm `[integration] postgres container …` appears
**once**, not three times, and that the migration chain runs once.

Counts are advisory as always — the other two specs have grown since this was written. Report what
you observe rather than matching a number.

If the ledger test fails, the seeder is writing `InventoryTransaction` rows it should not; re-read Task 20 Step 5. Opening stock is per channel — 120 retail, 40 bulk — so do not assert a single figure.

- [ ] **Step 3: Commit**

```bash
git add backend/test/integration/schema-invariants.integration.spec.ts
git commit -m "test(backend): assert schema invariants and seed volumes against real Postgres"
```

## Four seed-data facts a later task will trip over

Observed during the real seeding run, not predicted.

1. **`Product.publishedAt` is null while `isPublished` is true.** The mock carries no product publication date, and inventing one would be fabrication. Any query filtering `publishedAt IS NOT NULL` therefore returns **no products**. Filter on `isPublished`, or backfill deliberately.

2. **Images are stored as `/assets/cat-almonds.jpg`-style paths.** The mock's category images are Vite `import`s resolving to content-hashed bundle URLs, which cannot live in a database row. The stored paths name the real files in `frontend/src/assets/`, so **Plan 3 needs a public-path wiring step** to serve them. The remote `placehold.co` URL is stored verbatim.

3. **The top bulk pricing slab is `null` — quote-required — on every product.** An earlier version of this task's `buildTiers` computed a `0.82` rate for the 50kg+ slab; the mock has `null` throughout, and the mock wins: `isQuoteRequired` returns true precisely when the resolved slab is null, so publishing a rate would silently change Phase 1's bulk-calculator behaviour on every product.

4. **Re-seeding a database that has seen real stock movement breaks the ledger invariant.** `onHand` resets to the opening figure while the append-only ledger keeps its `SALE` rows, so `SUM(delta) == onHand` no longer holds — and deleting the seed's ledger rows would not fix it. The seeder is a fresh-setup tool, not a reset button.

   This bites on a *changed opening figure* too, and did: splitting `OPENING_STOCK` into 120 retail / 40 bulk reset `onHand` on the 108 bulk variants while their `+120` opening ledger rows stayed — because the opening row is keyed on `(variantId, reason)` and skipped when present, by design. 108 mismatches, fixed by a clean `DROP SCHEMA public CASCADE` + migrate + seed. **Change an opening figure and you must reset the schema, not reseed over it.**

5. **`DB_PORT=… npm run seed` does not do what it looks like.** `load-env.ts` applies dotenv with `override: true` (PM2 re-injects a cached environment on restart, so an edited `.env` would otherwise have no effect), which means `.env` beats anything exported in the shell. Pointing a seed or migration at a scratch database needs `NODE_ENV=test` as well — dotenv then targets the deliberately absent `.env.test`, no-ops, and the shell's values survive. This is the same mechanism the integration harness relies on for its testcontainers port.

**Milestone 1 is complete.** 33 tables, a reversible migration chain with database-level invariants, and the full mock dataset in Postgres.

---

# MILESTONE 2 — Authentication

Goal: a customer registers, signs in, is remembered across a refresh, and signs out — with the session in an httpOnly cookie backed by a revocable `Session` row. Every control in spec §13's auth rows has a passing test.

Read spec §9 before starting this milestone. The design decisions here are the ones that are expensive to change later.

### Asserting on a `DomainError` — read this before writing any test in this milestone

**`expect(...).toThrow(/SOME_ERROR_CODE/)` can never pass.** This was written into three of
Task 23's tests and six of Task 25's before anyone ran them, and it is the kind of mistake that
produces a *green* security suite verifying nothing, so it is worth stating once, here.

`DomainError extends HttpException`, and its constructor calls `super({ code, message, details })`.
`HttpException.initMessage()` copies only `response.message` — the human wording — into
`Error.message`. `code` stays a separate own property. Jest's `toThrow(regex)` tests
`thrown.message` and nothing else. So a regex for `CSRF_TOKEN_INVALID` is matched against
*"Your request could not be verified. Please refresh the page and try again."* and fails. Worse,
the reverse also holds: a regex that happens to match the human wording would keep passing after
the code changed, and break on a harmless rewording — which `DomainError`'s own doc comment
explicitly reserves the right to do.

Assert on `code`. Verified against the real class — all four forms below were run, typechecked
and linted before being written down:

| Form | Jest | `tsc` | `eslint` |
| --- | --- | --- | --- |
| `toThrow(/CODE/)` | **fails** | ✓ | ✓ |
| `await expect(p).rejects.toMatchObject({ code: ErrorCodes.X })` | ✓ | ✓ | ✓ |
| `toThrow(expect.objectContaining({ code }))` | ✓ | ✓ | **fails** — `objectContaining` returns `any`, and `toThrow` declares a real parameter type, so `no-unsafe-argument` rejects the call |
| catch-and-read via a `rejectionFrom` helper | ✓ | ✓ | ✓ |

So: **async** rejections use `.rejects.toMatchObject({ code: ErrorCodes.X })`. **Synchronous**
throws — guards, mainly — use the `rejectionFrom` helper given in Task 25 Step 2, which reads
`.code` off the caught error and throws its own error if the call was *allowed*. Do not replace it
with a bare `try/catch`: that form passes silently when a guard wrongly lets a request through,
which is the single failure a CSRF suite exists to catch.

Note the boundary precisely: this is **not** "never use `expect.objectContaining`". It is fine in
`toHaveBeenCalledWith`, which is typed `...params: any[]` — `any` flowing into `any` is not a
violation — and the plan uses it there deliberately. Only `toThrow` trips the rule, because it
declares a real parameter type for `any` to be assigned into.

Task 27's integration tests are unaffected — they read `response.body.code` off the HTTP
envelope, which is where `GlobalExceptionFilter` puts it.

### Carried forward from the Task 22/23 security review

The review measured against real Postgres rather than reading. Its critical finding — a
read-then-write race in `rotate` that let 19 of 20 concurrent presentations of one token both
succeed — plus the failed-revoke path, the un-instantiable `SessionsModule`, the vacuous `revoke`
test and the 4x-wide timing bound are all being fixed directly. What follows is what was
deliberately **not** fixed, each against the task that should own it.

1. ~~**`validateStrength` has no maximum length, so bcrypt's 72-byte truncation is user-visible.**~~
   **FIXED** in `afc4fa7`. A 72-byte maximum now rejects input bcrypt would silently truncate, and
   a test pins the truncation itself so the guard cannot outlive the behaviour it guards against.
   Login is deliberately untouched — it never calls `validateStrength`, since strength rules at
   sign-in would tell an attacker which candidates are worth trying — so existing accounts with
   longer passwords keep working against the same truncated prefix they were hashed from.

2. **`isActive` returns a 500 on a malformed session id.** `isActive('not-a-uuid')` throws
   `QueryFailedError: invalid input syntax for type uuid`. Not attacker-reachable today — the id
   comes from a signed JWT — but `JwtAuthGuard` calls it on **every authenticated request**, so a
   validly-signed token carrying a stale or malformed `sessionId` yields a 500 and an error-level
   log instead of a clean 401. Owner: whoever next touches `SessionsService`; a `isUUID` check or
   catching the driver error and returning `false` both work.

3. **A deactivated user can keep refreshing.** Verified: set `users.isActive = false`, and `rotate`
   still succeeds. Distinct from the login gap already recorded below — `rotate` never consults the
   user row at all. Owner: the admin deactivation flow, which must call `revokeAllForUser`.

4. **`Session` is returned whole and carries `refreshTokenHash`.** It serialises into
   `JSON.stringify(session)`. `User.passwordHash` uses `select: false`; `Session.refreshTokenHash`
   has no equivalent and no `@Exclude()`. Not exploitable — SHA-256 has no preimage and nothing
   serialises it today — but `issue`/`rotate` return the entity and there is no DTO boundary yet.
   Owner: **Task 26**, which is the first code to put a session anywhere near a response.

5. **Stale sessions are never reaped.** An expired-but-unrevoked row stays `revokedAt = NULL`
   forever. `isActive` handles it correctly via the expiry check, so this is growth rather than a
   hole — but with a 15-minute access TTL and a 30-day refresh TTL, one active session accrues on
   the order of 2,880 rows a month. Owner: a scheduled cleanup, out of scope for this plan; record
   it rather than let it be discovered by a slow query.

6. **`revoke(sessionId, reason: string)` takes free text against a `varchar(40)` column.** The four
   call-site literals are all short, so nothing fails today, but a longer reason would fail at the
   driver rather than at the type. A union of the four known reasons would make the column width
   unreachable.

7. **Comments that were not true.** `session.entity.ts` claimed "every rotated session keeps the id
   it descended from" — it keeps the `familyId`; the descendant gets a fresh `id`. And
   `token.service.ts` describes `tokenSettingsFactory` as "used by `AuthModule`", which does not
   exist yet and has zero consumers. Verified true and left alone: the bcrypt cost claim, and that a
   bad TTL really does throw at runtime.

8. **Redactor blind spots beyond the cookie names.** Keys `rt`, `sid`, `session` and `credential`
   pass a raw token through, as does a token inside a URL string or an `Error.message` — no value
   pattern matches an opaque 43-char base64url blob. Separately, TypeORM's own logger prints
   `-- PARAMETERS: [...]` to stdout, bypassing the redactor entirely; it was observed emitting a
   `refreshTokenHash`. That is the stored digest rather than a usable credential, and it predates
   this milestone, but it means **the redactor is not a backstop for anything TypeORM logs.**

**Verification datum worth keeping:** the reviewer ran TypeORM's schema differ against a live
migrated database. Every proposal it emitted fell into the false-positive classes already documented
above — the nine check-constraint drops, the three phantom `seo` defaults, and
`DROP INDEX uq_addresses_one_default_per_user`. `uq_users_email` was **not** proposed, confirming
that expression indexes are invisible to the differ exactly as recorded. The `Session` entity and
its table agree on all 11 columns, all three indexes and the FK's `ON DELETE CASCADE`.

### How to inject the logger — `WINSTON_LOGGER` is not injectable

Anything needing to log takes **`WinstonLoggerService`**, never the `WINSTON_LOGGER` symbol.
`LoggingModule` provides the token but its `exports` lists only the service, so injecting the symbol
from another module fails at boot:

```
Nest can't resolve dependencies of the WantsRawLogger (?) … Symbol(WINSTON_LOGGER) at index [0]
```

I gave a task the wrong instruction here and it probed the failure rather than working around it.
Injecting the service is also the better choice on its merits: it wraps the same winston instance
*and* adds the request envelope and `redact()`, so a logger obtained this way cannot casually write
a credential into the logs. Reach for the raw token only inside a test asserting against winston
itself — `app.get(WINSTON_LOGGER)` works there, because `app.get` is not gated by module exports.

### The cookies are domain-cookies, and host-only would be tighter

Found during Task 27 and **not yet fixed** — recorded here with the reasoning because the fix is
small, the argument is not, and it should be made deliberately rather than in passing.

`CookieService` always sets an explicit `Domain`, because `COOKIE_DOMAIN` is
`z.string().min(1).default('localhost')` — there is no way to express "no domain". A cookie with a
`Domain` attribute is a *domain-cookie*: the browser sends it to that host **and every subdomain**.
Omitting the attribute yields a *host-only* cookie, sent to exactly the host that set it, which is
strictly tighter.

Today that is harmless: `localhost` in development, and production has a boot assertion refusing to
start while `COOKIE_DOMAIN` is still the default. The exposure appears the first time the real domain
has a subdomain nobody is guarding — a status page, a marketing microsite, a CMS, anything on a
shared parent — because the refresh token, the longest-lived credential this service issues, is then
sent to it on every request.

The fix is to let `COOKIE_DOMAIN` be empty and omit `domain` when it is, defaulting to host-only and
keeping the explicit value for a genuine cross-subdomain deployment. Two things to get right:

- The production assertion currently rejects the *default* value. It would need to reject the default
  while accepting a deliberate empty string, or the tighter option becomes the one that refuses to
  boot.
- It would also retire the `COOKIE_DOMAIN = '127.0.0.1'` line in `test/integration/setup.ts`.
  Host-only cookies always match the host that set them, so `agent()`'s jar would work with no
  alignment needed — the workaround exists purely because an explicit domain has to be made to agree
  with whatever host supertest dialled.

Deliberately deferred rather than folded in: this changes cookie scoping while Task 28 is verifying
cookie behaviour in a real browser, and changing the thing under observation mid-verification is how
a confusing report gets produced. Task 26's implementer already lost an assertion to exactly that —
`app.module.ts` gained the throttler message between its read of the file and its test run.

### Two auth gaps that are deliberately not fixed in Milestone 2

Both were found by tracing the login path by hand after Task 24, and both are recorded against
the task that should own them, because fixing either one *here* would make things worse.

1. **A deactivated user keeps every session they already had**, for up to the 30-day refresh
   lifetime. `login` refuses new sign-ins, but nothing calls `SessionsService.revokeAllForUser`,
   whose own comment names deactivation as its reason for existing. **Do not fix this inside
   `login`:** adding a write to the inactive branch would put a database UPDATE on exactly one of
   the three failure paths and hand back the timing signal Task 24 exists to remove. It belongs to
   the **admin user-deactivation flow**, which must call `revokeAllForUser` at the moment it flips
   `isActive`.

2. **Register is an account-existence oracle.** See spec §9 and the §13 table, both amended. It is
   an accepted, documented gap in this phase, not an oversight, and email-verified signup is what
   closes it. The 3/hour limit is doing the real work in the meantime, so **Task 26 must not
   relax it**.

## Task 22: Password and token services (TDD)

**Files:**
- Create: `backend/src/modules/auth/password.service.ts`, `backend/src/modules/auth/token.service.ts`
- Test: `backend/src/modules/auth/password.service.spec.ts`, `backend/src/modules/auth/token.service.spec.ts`

- [ ] **Step 1: Write the failing password tests**

```ts
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a bcrypt hash at cost 10, matching cug', async () => {
    const hash = await service.hash('Password123!');
    // $2b$ is the bcrypt identifier; 10 is the cost.
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
  });

  it('does not store the password in the hash', async () => {
    const hash = await service.hash('Password123!');
    expect(hash).not.toContain('Password123!');
  });

  it('produces a different hash each time, because the salt is random', async () => {
    const [first, second] = await Promise.all([
      service.hash('Password123!'),
      service.hash('Password123!'),
    ]);
    expect(first).not.toBe(second);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('Password123!');
    await expect(service.compare('Password123!', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('Password123!');
    await expect(service.compare('wrong', hash)).resolves.toBe(false);
  });

  it('burns comparable time when there is no user, so login cannot be timed', async () => {
    // Spec §13, "user enumeration": returning early for an unknown email makes that path
    // measurably faster and turns login into an account-existence oracle.
    await expect(service.compareAgainstDummy('anything')).resolves.toBe(false);

    const start = process.hrtime.bigint();
    await service.compareAgainstDummy('anything');
    const dummyNs = Number(process.hrtime.bigint() - start);

    const hash = await service.hash('Password123!');
    const realStart = process.hrtime.bigint();
    await service.compare('wrong', hash);
    const realNs = Number(process.hrtime.bigint() - realStart);

    // Same order of magnitude. An exact match is not achievable, but a 10x gap would be.
    expect(dummyNs).toBeGreaterThan(realNs / 5);
  });

  it('rejects a password shorter than eight characters', async () => {
    expect(service.validateStrength('short')).toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('rejects one of the most common passwords even when long enough', async () => {
    expect(service.validateStrength('password')).toEqual(expect.objectContaining({ ok: false }));
    expect(service.validateStrength('12345678')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('accepts a reasonable password', () => {
    expect(service.validateStrength('Kaju1kgPlease')).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `npm run test -w backend -- password.service`
Expected: FAIL — cannot find module.

```ts
// backend/src/modules/auth/password.service.ts
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';

/** Cost 10, matching cug's `bcrypt.hash(password, 10)`. */
const BCRYPT_COST = 10;
const MIN_LENGTH = 8;

/**
 * A short denylist of the passwords that actually appear in credential-stuffing lists. Not a
 * substitute for rate limiting (spec §9), but it stops the handful of values that would make
 * an account trivially guessable.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'iloveyou',
  'admin123',
  'welcome1',
  'letmein1',
  'abc12345',
  'nutwala123',
]);

export type StrengthResult = { ok: true } | { ok: false; reason: string };

@Injectable()
export class PasswordService {
  /**
   * A real bcrypt hash of a random value nobody holds. Comparing against it costs the same
   * as comparing against a genuine hash, which is how the unknown-email login path is made
   * to take the same time as the wrong-password path.
   */
  private readonly dummyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_COST);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Always false. Called when the email is unknown, purely to equalise timing. */
  async compareAgainstDummy(plain: string): Promise<false> {
    await bcrypt.compare(plain, this.dummyHash);
    return false;
  }

  validateStrength(plain: string): StrengthResult {
    if (plain.length < MIN_LENGTH) {
      return { ok: false, reason: `Use at least ${MIN_LENGTH} characters.` };
    }
    if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
      return { ok: false, reason: 'That password is too common. Choose something less guessable.' };
    }
    return { ok: true };
  }
}
```

Run: `npm run test -w backend -- password.service`
Expected: PASS — 9 tests.

**Two things the given code needs that are not obvious:**

- `token.service.ts` needs `import type { StringValue } from 'ms'` and a cast at the `expiresIn`
  call site, as shown. Without it `tsc` fails with `TS2769: No overload matches this call`.
- In `password.service.spec.ts`, the two `validateStrength` tests must **not** be `async`. As
  written with `async () => {}` and no `await` inside, `@typescript-eslint/require-await` — an
  error in this repo with no spec-file override — rejects them.

- [ ] **Step 3: Write the failing token tests**

```ts
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

function build(): TokenService {
  const jwt = new JwtService({ secret: 'a'.repeat(48) });
  return new TokenService(jwt, { accessTokenTtl: '15m', refreshTokenTtlDays: 30 });
}

describe('TokenService', () => {
  it('signs an access token carrying subject, role and session', () => {
    const service = build();
    const token = service.signAccessToken({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
    const decoded = service.verifyAccessToken(token);
    expect(decoded).toMatchObject({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
  });

  it('rejects a tampered access token', () => {
    const service = build();
    const token = service.signAccessToken({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
    const tampered = `${token.slice(0, -2)}xy`;
    expect(() => service.verifyAccessToken(tampered)).toThrow();
  });

  it('generates a refresh token with at least 256 bits of entropy', () => {
    const service = build();
    const token = service.generateRefreshToken();
    // 32 random bytes base64url-encoded is 43 characters.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never generates the same refresh token twice', () => {
    const service = build();
    const tokens = new Set(Array.from({ length: 500 }, () => service.generateRefreshToken()));
    expect(tokens.size).toBe(500);
  });

  it('hashes a refresh token to a stable 64-character hex digest', () => {
    const service = build();
    const first = service.hashRefreshToken('some-token');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hashRefreshToken('some-token')).toBe(first);
    expect(service.hashRefreshToken('other-token')).not.toBe(first);
  });

  it('computes a refresh expiry from the configured day count', () => {
    const service = build();
    const now = new Date('2026-08-19T00:00:00.000Z');
    expect(service.refreshExpiryFrom(now).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement**

```ts
// backend/src/modules/auth/token.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
// `@types/jsonwebtoken` types `expiresIn` as `ms`'s template-literal `StringValue`, not `string`,
// so a plain `string` TTL does not satisfy the call site. One narrow type-only cast below is the
// least-bad fix — widening `TokenSettings.accessTokenTtl` to `StringValue` would push the
// constraint out into the config layer, and `jsonwebtoken` validates the format at runtime anyway.
import type { StringValue } from 'ms';
import type { AppConfiguration } from '../../common/config/app.config';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  sessionId: string;
}

/** Injected directly in unit tests so the service does not need a Nest container. */
export interface TokenSettings {
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
}

export const TOKEN_SETTINGS = 'TOKEN_SETTINGS';

const REFRESH_TOKEN_BYTES = 32;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(TOKEN_SETTINGS) private readonly settings: TokenSettings,
  ) {}

  /**
   * Short-lived, 15 minutes by default. Short enough that a revoked session stops working
   * quickly without a database read on every request, which is the trade spec §9 makes.
   */
  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign(claims, {
      expiresIn: this.settings.accessTokenTtl as StringValue,
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.jwt.verify<AccessTokenClaims>(token);
  }

  /**
   * An opaque random token, not a JWT.
   *
   * A refresh token needs no claims — it is looked up in `sessions` — and making it opaque
   * means it carries no information at all if it leaks, and cannot be accepted on signature
   * alone by a service that forgets to check revocation.
   */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  /** Only the digest is stored, so a database disclosure yields no usable credential. */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshExpiryFrom(now: Date = new Date()): Date {
    return new Date(now.getTime() + this.settings.refreshTokenTtlDays * MS_PER_DAY);
  }
}

/** Factory used by `AuthModule` to supply `TOKEN_SETTINGS` from configuration. */
export function tokenSettingsFactory(config: ConfigService): TokenSettings {
  const app = config.getOrThrow<AppConfiguration>('app');
  return {
    accessTokenTtl: app.auth.accessTokenTtl,
    refreshTokenTtlDays: app.auth.refreshTokenTtlDays,
  };
}
```

Run: `npm run test -w backend -- token.service`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/auth
git commit -m "feat(auth): add password hashing with timing equalisation and token service"
```

## Task 23: Sessions with rotation and reuse detection (TDD)

Spec §9. This is the mechanism that makes logout real and a stolen refresh token detectable.

**Files:**
- Create: `backend/src/modules/sessions/sessions.service.ts`, `backend/src/modules/sessions/sessions.module.ts`
- Test: `backend/src/modules/sessions/sessions.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

These use an in-memory fake repository, because the logic under test is the rotation state machine, not SQL. The database behaviour is covered by Task 27's integration tests.

```ts
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';
import { ErrorCodes } from '../../common/errors/domain-error';
import { Session } from '../../entities/identity/session.entity';
import { TokenService } from '../auth/token.service';
import { SessionsService } from './sessions.service';

/** Minimal in-memory stand-in for the three repository methods the service uses. */
function fakeRepository(): Repository<Session> & { rows: Session[] } {
  const rows: Session[] = [];
  return {
    rows,
    create: (input: Partial<Session>) => ({ ...input }) as Session,
    save: async (entity: Session) => {
      const existing = rows.findIndex((row) => row.id === entity.id);
      if (existing >= 0) {
        rows[existing] = { ...rows[existing], ...entity } as Session;
        return rows[existing]!;
      }
      const created = { ...entity, id: entity.id ?? randomUUID() } as Session;
      rows.push(created);
      return created;
    },
    findOne: async ({ where }: { where: { refreshTokenHash?: string; id?: string } }) =>
      rows.find(
        (row) =>
          (where.refreshTokenHash !== undefined && row.refreshTokenHash === where.refreshTokenHash) ||
          (where.id !== undefined && row.id === where.id),
      ) ?? null,
    update: async (criteria: Partial<Session>, patch: Partial<Session>) => {
      for (const row of rows) {
        if (criteria.familyId !== undefined && row.familyId !== criteria.familyId) continue;
        if (criteria.userId !== undefined && row.userId !== criteria.userId) continue;
        if (row.revokedAt) continue;
        Object.assign(row, patch);
      }
      return { affected: rows.length } as never;
    },
  } as unknown as Repository<Session> & { rows: Session[] };
}

function build() {
  const repository = fakeRepository();
  const tokens = new TokenService(new JwtService({ secret: 'a'.repeat(48) }), {
    accessTokenTtl: '15m',
    refreshTokenTtlDays: 30,
  });
  return { repository, service: new SessionsService(repository, tokens), tokens };
}

const meta = { userAgent: 'jest', ip: '127.0.0.1' };

describe('SessionsService.issue', () => {
  it('creates a session and returns a refresh token that is not what was stored', async () => {
    const { service, repository, tokens } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);

    expect(repository.rows).toHaveLength(1);
    expect(session.refreshTokenHash).toBe(tokens.hashRefreshToken(refreshToken));
    // The raw token must never be persisted.
    expect(repository.rows[0]?.refreshTokenHash).not.toBe(refreshToken);
  });

  it('starts a new family per login, so two devices are independent', async () => {
    const { service } = build();
    const first = await service.issue('user-1', meta);
    const second = await service.issue('user-1', meta);
    expect(first.session.familyId).not.toBe(second.session.familyId);
  });
});

describe('SessionsService.rotate', () => {
  it('issues a new token and revokes the presented one', async () => {
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);

    const rotated = await service.rotate(refreshToken, meta);

    expect(rotated.refreshToken).not.toBe(refreshToken);
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(repository.rows[0]?.revokedReason).toBe('rotated');
    expect(repository.rows[1]?.revokedAt).toBeNull();
  });

  it('keeps the rotated session in the same family', async () => {
    const { service } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);
    const rotated = await service.rotate(refreshToken, meta);
    expect(rotated.session.familyId).toBe(session.familyId);
  });

  it('revokes the whole family when a already-used token is presented again', async () => {
    // This is the stolen-refresh-token signature: the legitimate client rotated, and now
    // something else is presenting the old token. Neither party can be trusted, so the
    // family dies and both must sign in again.
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    await service.rotate(refreshToken, meta);

    await expect(service.rotate(refreshToken, meta)).rejects.toMatchObject({
      code: ErrorCodes.REFRESH_TOKEN_REUSED,
    });
    expect(repository.rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(repository.rows.some((row) => row.revokedReason === 'reuse-detected')).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const { service } = build();
    await expect(service.rotate('never-issued', meta)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_EXPIRED,
    });
  });

  it('rejects an expired token without rotating it', async () => {
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    repository.rows[0]!.expiresAt = new Date(Date.now() - 1000);

    await expect(service.rotate(refreshToken, meta)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_EXPIRED,
    });
    expect(repository.rows).toHaveLength(1);
  });
});

describe('SessionsService.revoke', () => {
  it('revokes a single session on logout', async () => {
    const { service, repository } = build();
    const { session } = await service.issue('user-1', meta);
    await service.revoke(session.id, 'logout');
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(repository.rows[0]?.revokedReason).toBe('logout');
  });

  it('revokes every session for a user, for admin force-logout', async () => {
    const { service, repository } = build();
    await service.issue('user-1', meta);
    await service.issue('user-1', meta);
    await service.revokeAllForUser('user-1', 'admin-forced');
    expect(repository.rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe('SessionsService.isActive', () => {
  it('is false once revoked, which is what makes logout real', async () => {
    const { service, repository } = build();
    const { session } = await service.issue('user-1', meta);
    await expect(service.isActive(session.id)).resolves.toBe(true);
    await service.revoke(session.id, 'logout');
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    await expect(service.isActive(session.id)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```ts
// backend/src/modules/sessions/sessions.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Session } from '../../entities/identity/session.entity';
import { TokenService } from '../auth/token.service';

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Starts a new session family. Called on every login, never reused — issuing a fresh
   * session per login is what prevents session fixation (spec §9).
   */
  async issue(userId: string, meta: SessionMeta): Promise<IssuedSession> {
    const refreshToken = this.tokens.generateRefreshToken();
    const session = await this.sessions.save(
      this.sessions.create({
        userId,
        familyId: randomUUID(),
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt: this.tokens.refreshExpiryFrom(),
        revokedAt: null,
        revokedReason: null,
      }),
    );
    return { session, refreshToken };
  }

  /**
   * Exchanges a refresh token for a new one, revoking the old.
   *
   * Presenting a token that has already been rotated means two parties hold it: the
   * legitimate client and whoever copied it. There is no way to tell which is which, so the
   * entire family is revoked and both must sign in again. Silently issuing a new token here
   * would let a thief keep a session alive indefinitely.
   */
  async rotate(presentedToken: string, meta: SessionMeta): Promise<IssuedSession> {
    const hash = this.tokens.hashRefreshToken(presentedToken);
    const existing = await this.sessions.findOne({ where: { refreshTokenHash: hash } });

    if (!existing) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (existing.revokedAt) {
      await this.sessions.update(
        { familyId: existing.familyId, revokedAt: IsNull() },
        { revokedAt: new Date(), revokedReason: 'reuse-detected' },
      );
      throw new DomainError(
        ErrorCodes.REFRESH_TOKEN_REUSED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    existing.revokedAt = new Date();
    existing.revokedReason = 'rotated';
    await this.sessions.save(existing);

    const refreshToken = this.tokens.generateRefreshToken();
    const session = await this.sessions.save(
      this.sessions.create({
        userId: existing.userId,
        familyId: existing.familyId,
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        userAgent: meta.userAgent ?? existing.userAgent,
        ip: meta.ip ?? existing.ip,
        expiresAt: this.tokens.refreshExpiryFrom(),
        revokedAt: null,
        revokedReason: null,
      }),
    );

    return { session, refreshToken };
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.sessions.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Admin force-logout, and the correct response to a deactivated account. */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /**
   * Checked by `JwtAuthGuard` on every authenticated request. This one indexed lookup is what
   * a stateless JWT cannot offer: without it, logout could not take effect until the access
   * token expired.
   */
  async isActive(sessionId: string): Promise<boolean> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) return false;
    if (session.revokedAt) return false;
    return session.expiresAt.getTime() > Date.now();
  }
}
```

```ts
// backend/src/modules/sessions/sessions.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '../../entities/identity/session.entity';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TypeOrmModule.forFeature([Session])],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
```

Run: `npm run test -w backend -- sessions.service`
Expected: PASS — 10 tests.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/sessions
git commit -m "feat(auth): add revocable sessions with refresh rotation and reuse detection"
```

## Task 24: Users and the auth service (TDD)

Spec §9 and §13. The no-enumeration behaviour is the part that must be tested, because it is invisible when it works and a real information leak when it does not.

**Files:**
- Create: `backend/src/modules/users/users.service.ts`, `backend/src/modules/users/users.module.ts`, `backend/src/modules/users/user.mapper.ts`, `backend/src/modules/auth/auth.service.ts`
- Test: `backend/src/modules/users/user.mapper.spec.ts`, `backend/src/modules/auth/auth.service.spec.ts`

- [ ] **Step 1: Write the failing mapper tests**

The mapper is the single place the database enum and the wire role translate, per `shared/types/auth.ts`.

```ts
import { User } from '../../entities/identity/user.entity';
import { UserRole } from '../../entities/enums';
import { toAuthUser, toUserRole } from './user.mapper';

function userFixture(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    name: 'Retail Customer',
    email: 'b2c@demo.in',
    phone: '9876543210',
    passwordHash: '$2b$10$hash',
    role: UserRole.CUSTOMER,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    business: null,
    addresses: [],
    sessions: [],
    ...overrides,
  } as User;
}

describe('toAuthUser', () => {
  it('maps CUSTOMER to the wire role b2c', () => {
    expect(toAuthUser(userFixture()).role).toBe('b2c');
  });

  it('maps BUSINESS to b2b and ADMIN to admin', () => {
    expect(toAuthUser(userFixture({ role: UserRole.BUSINESS })).role).toBe('b2b');
    expect(toAuthUser(userFixture({ role: UserRole.ADMIN })).role).toBe('admin');
  });

  it('never includes the password hash', () => {
    const result = toAuthUser(userFixture()) as Record<string, unknown>;
    expect(result.passwordHash).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('$2b$');
  });

  it('serialises createdAt as an ISO string, matching the frontend type', () => {
    expect(toAuthUser(userFixture()).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('includes company details only for a business account', () => {
    expect(toAuthUser(userFixture()).company).toBeUndefined();

    const withBusiness = userFixture({
      role: UserRole.BUSINESS,
      business: {
        companyName: 'Sharma Sweets',
        contactPerson: 'R Sharma',
        businessType: 'Sweet shop',
        gstin: '27AAPFU0939F1ZV',
      } as never,
    });
    expect(toAuthUser(withBusiness).company).toEqual({
      companyName: 'Sharma Sweets',
      contactPerson: 'R Sharma',
      businessType: 'Sweet shop',
      gstin: '27AAPFU0939F1ZV',
    });
  });
});

describe('toUserRole', () => {
  it('maps the wire role back to the database enum', () => {
    expect(toUserRole('b2c')).toBe(UserRole.CUSTOMER);
    expect(toUserRole('b2b')).toBe(UserRole.BUSINESS);
    expect(toUserRole('admin')).toBe(UserRole.ADMIN);
  });
});
```

- [ ] **Step 2: Implement the mapper**

```ts
// backend/src/modules/users/user.mapper.ts
import type { AuthUser, Role } from '@nutwala/shared';
import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';

/**
 * The only place the database enum and the wire role translate.
 *
 * The database uses `CUSTOMER`/`BUSINESS`/`ADMIN` because those read correctly in SQL and in
 * an admin screen. The wire keeps `b2c`/`b2b`/`admin` because the Phase 1 frontend already
 * types and persists those values. One mapper is cheaper than changing either side.
 */
const TO_WIRE: Record<UserRole, Role> = {
  [UserRole.CUSTOMER]: 'b2c',
  [UserRole.BUSINESS]: 'b2b',
  [UserRole.ADMIN]: 'admin',
};

const TO_ENUM: Record<Role, UserRole> = {
  b2c: UserRole.CUSTOMER,
  b2b: UserRole.BUSINESS,
  admin: UserRole.ADMIN,
};

export function toUserRole(role: Role): UserRole {
  return TO_ENUM[role];
}

/**
 * Builds the response body. Constructed field by field rather than by spreading and deleting,
 * so a column added to `User` later cannot leak into an API response by default.
 */
export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: TO_WIRE[user.role],
    createdAt: user.createdAt.toISOString(),
    ...(user.business
      ? {
          company: {
            companyName: user.business.companyName,
            contactPerson: user.business.contactPerson,
            businessType: user.business.businessType,
            ...(user.business.gstin ? { gstin: user.business.gstin } : {}),
          },
        }
      : {}),
  };
}
```

Run: `npm run test -w backend -- user.mapper`
Expected: PASS — 6 tests.

- [ ] **Step 3: Implement `UsersService`**

```ts
// backend/src/modules/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../entities/enums';
import { User } from '../../entities/identity/user.entity';

export interface CreateUserInput {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  /** Emails are stored and compared lowercased; the migration also indexes `LOWER(email)`. */
  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({
      where: { email: UsersService.normaliseEmail(email) },
      relations: { business: true },
    });
  }

  /**
   * Includes `passwordHash`, which the entity marks `select: false`. Only the login path
   * calls this, so a hash cannot reach a response by accident.
   */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = :email', { email: UsersService.normaliseEmail(email) })
      .getOne();
  }

  findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id }, relations: { business: true } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.users.save(
      this.users.create({
        ...input,
        email: UsersService.normaliseEmail(input.email),
        isActive: true,
      }),
    );
  }

  async markLoggedIn(id: string): Promise<void> {
    await this.users.update({ id }, { lastLoginAt: new Date() });
  }

  /** Brief §46 — an existing retail customer turns on bulk buying rather than re-registering. */
  async promoteToBusiness(id: string): Promise<void> {
    await this.users.update({ id, role: UserRole.CUSTOMER }, { role: UserRole.BUSINESS });
  }
}
```

```ts
// backend/src/modules/users/users.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/identity/user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 4: Write the failing auth-service tests**

```ts
import { HttpStatus } from '@nestjs/common';
import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

const meta = { userAgent: 'jest', ip: '127.0.0.1' };

function build(existing: User | null) {
  const passwords = new PasswordService();
  const users = {
    findByEmail: jest.fn().mockResolvedValue(existing),
    findByEmailWithPassword: jest.fn().mockResolvedValue(existing),
    findById: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'new-user',
      createdAt: new Date(),
      business: null,
      ...input,
    })),
    markLoggedIn: jest.fn().mockResolvedValue(undefined),
    promoteToBusiness: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    issue: jest.fn().mockResolvedValue({
      session: { id: 's1', familyId: 'f1' },
      refreshToken: 'refresh-token',
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = { signAccessToken: jest.fn().mockReturnValue('access-token') };
  const businesses = { createFor: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    users as never,
    passwords,
    sessions as never,
    tokens as never,
    businesses as never,
  );

  return { service, users, sessions, tokens, passwords, businesses };
}

async function customerFixture(password: string): Promise<User> {
  const hash = await new PasswordService().hash(password);
  return {
    id: 'u1',
    name: 'Retail Customer',
    email: 'b2c@demo.in',
    phone: '9876543210',
    passwordHash: hash,
    role: UserRole.CUSTOMER,
    isActive: true,
    createdAt: new Date(),
    business: null,
  } as User;
}

describe('AuthService.login', () => {
  it('returns the user, an access token and a refresh token on success', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);

    const result = await service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta);

    expect(result.user).toMatchObject({ id: 'u1', role: 'b2c' });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('records the login timestamp', async () => {
    const user = await customerFixture('Password123!');
    const { service, users } = build(user);
    await service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta);
    expect(users.markLoggedIn).toHaveBeenCalledWith('u1');
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    // Spec §13. Differing messages here turn login into an account-existence oracle, which
    // is exactly what the Phase 1 mock did with "No account found with that email address."
    const user = await customerFixture('Password123!');
    const known = build(user);
    const unknown = build(null);

    const wrongPassword = await known.service
      .login({ email: 'b2c@demo.in', password: 'nope' }, meta)
      .catch((error: Error & { getStatus?: () => number }) => error);
    const unknownEmail = await unknown.service
      .login({ email: 'nobody@demo.in', password: 'nope' }, meta)
      .catch((error: Error & { getStatus?: () => number }) => error);

    expect((wrongPassword as Error).message).toBe('Invalid email or password.');
    expect((unknownEmail as Error).message).toBe('Invalid email or password.');
    expect((wrongPassword as { getStatus: () => number }).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((unknownEmail as { getStatus: () => number }).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('still runs a bcrypt comparison when the email is unknown', async () => {
    const { service, passwords } = build(null);
    const spy = jest.spyOn(passwords, 'compareAgainstDummy');
    await service.login({ email: 'nobody@demo.in', password: 'nope' }, meta).catch(() => undefined);
    expect(spy).toHaveBeenCalledWith('nope');
  });

  it('issues no session when the password is wrong', async () => {
    const user = await customerFixture('Password123!');
    const { service, sessions } = build(user);
    await service.login({ email: 'b2c@demo.in', password: 'nope' }, meta).catch(() => undefined);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('refuses a deactivated account with the same generic message', async () => {
    const user = await customerFixture('Password123!');
    user.isActive = false;
    const { service, sessions } = build(user);
    await expect(
      service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta),
    ).rejects.toThrow('Invalid email or password.');
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('matches the email case-insensitively', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);
    await expect(
      service.login({ email: '  B2C@DEMO.IN  ', password: 'Password123!' }, meta),
    ).resolves.toMatchObject({ accessToken: 'access-token' });
  });
});

describe('AuthService.register', () => {
  const input = {
    name: 'New Customer',
    email: 'New@Demo.in',
    phone: '9876543210',
    password: 'Kaju1kgPlease',
    isBusiness: false,
  };

  it('creates a CUSTOMER and signs them in', async () => {
    const { service, users } = build(null);
    const result = await service.register(input, meta);

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@demo.in', role: UserRole.CUSTOMER }),
    );
    expect(result.accessToken).toBe('access-token');
  });

  it('stores a hash, never the password', async () => {
    const { service, users } = build(null);
    await service.register(input, meta);
    const created = users.create.mock.calls[0]?.[0] as { passwordHash: string };
    expect(created.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(created).not.toHaveProperty('password');
  });

  it('creates a BUSINESS account and its company record when isBusiness is set', async () => {
    const { service, users, businesses } = build(null);
    await service.register(
      {
        ...input,
        isBusiness: true,
        company: {
          companyName: 'Sharma Sweets',
          contactPerson: 'R Sharma',
          businessType: 'Sweet shop',
        },
      },
      meta,
    );
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: UserRole.BUSINESS }),
    );
    expect(businesses.createFor).toHaveBeenCalled();
  });

  it('rejects a duplicate email', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);
    await expect(service.register({ ...input, email: 'b2c@demo.in' }, meta)).rejects.toThrow(
      /already/i,
    );
  });

  it('rejects a weak password before touching the database', async () => {
    const { service, users } = build(null);
    await expect(service.register({ ...input, password: 'password' }, meta)).rejects.toThrow(
      /too common/i,
    );
    expect(users.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('revokes the session so the refresh token is dead immediately', async () => {
    const { service, sessions } = build(null);
    await service.logout('s1');
    expect(sessions.revoke).toHaveBeenCalledWith('s1', 'logout');
  });
});
```

- [ ] **Step 5: Implement `AuthService`**

```ts
// backend/src/modules/auth/auth.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser, Credentials, RegisterInput } from '@nutwala/shared';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import { BusinessesService } from '../business/businesses.service';
import { SessionsService, type SessionMeta } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import { toAuthUser } from '../users/user.mapper';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/** One message for every failed sign-in. See the tests and spec §13. */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly businesses: BusinessesService,
  ) {}

  async login(credentials: Credentials, meta: SessionMeta): Promise<AuthResult> {
    const user = await this.users.findByEmailWithPassword(credentials.email);

    // The unknown-email branch still performs a bcrypt comparison. Returning early here is
    // what makes an enumeration attack possible: the fast path is measurably faster.
    if (!user) {
      await this.passwords.compareAgainstDummy(credentials.password);
      throw this.loginFailure();
    }

    const matches = await this.passwords.compare(credentials.password, user.passwordHash);

    // A deactivated account gives the same message. Saying "this account is suspended"
    // confirms the address is registered.
    if (!matches || !user.isActive) throw this.loginFailure();

    await this.users.markLoggedIn(user.id);
    return this.issue(user.id, user.role, meta);
  }

  async register(input: RegisterInput, meta: SessionMeta): Promise<AuthResult> {
    const strength = this.passwords.validateStrength(input.password);
    if (!strength.ok) {
      throw new DomainError(
        ErrorCodes.WEAK_PASSWORD,
        strength.reason,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      throw new DomainError(
        ErrorCodes.EMAIL_IN_USE,
        'An account with this email address already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const role = input.isBusiness ? UserRole.BUSINESS : UserRole.CUSTOMER;
    const created = await this.users.create({
      name: input.name.trim(),
      email: input.email,
      phone: input.phone,
      passwordHash: await this.passwords.hash(input.password),
      role,
    });

    if (input.isBusiness && input.company) {
      await this.businesses.createFor(created.id, input.company);
    }

    return this.issue(created.id, role, meta);
  }

  /** Revoking the row is what makes logout real — spec §9. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return toAuthUser(user);
  }

  /** Brief §46. */
  async upgradeToBusiness(userId: string): Promise<AuthUser> {
    await this.users.promoteToBusiness(userId);
    return this.me(userId);
  }

  private async issue(userId: string, role: UserRole, meta: SessionMeta): Promise<AuthResult> {
    const { session, refreshToken } = await this.sessions.issue(userId, meta);
    const user = await this.users.findById(userId);
    if (!user) throw new Error(`User ${userId} vanished between creation and session issue`);

    return {
      user: toAuthUser(user),
      accessToken: this.tokens.signAccessToken({ sub: userId, role, sessionId: session.id }),
      refreshToken,
    };
  }

  private loginFailure(): DomainError {
    return new DomainError(
      ErrorCodes.INVALID_CREDENTIALS,
      GENERIC_LOGIN_FAILURE,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
```

- [ ] **Step 6: Create the minimal `BusinessesService` this depends on**

Plan 3 builds the full business module; this is the one method auth needs.

```ts
// backend/src/modules/business/businesses.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { CompanyProfile } from '@nutwala/shared';
import { Repository } from 'typeorm';
import { Business } from '../../entities/identity/business.entity';

@Injectable()
export class BusinessesService {
  constructor(@InjectRepository(Business) private readonly businesses: Repository<Business>) {}

  /** Called during registration when the "buying for a business" box is ticked. */
  async createFor(userId: string, company: CompanyProfile): Promise<Business> {
    return this.businesses.save(
      this.businesses.create({
        userId,
        companyName: company.companyName,
        contactPerson: company.contactPerson,
        businessType: company.businessType,
        gstin: company.gstin ?? null,
        // Registration collects only the essentials; `/business/profile` captures the rest.
        mobile: '',
      }),
    );
  }
}
```

```ts
// backend/src/modules/business/businesses.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../../entities/identity/business.entity';
import { BusinessesService } from './businesses.service';

@Module({
  imports: [TypeOrmModule.forFeature([Business])],
  providers: [BusinessesService],
  exports: [BusinessesService],
})
export class BusinessesModule {}
```

Note: `mobile` is `''` here because registration does not ask for it, and the column is
non-null. Plan 3's `PUT /business/me` requires a real value before an RFQ or bulk order can be
placed. If that ordering feels wrong when you get there, make the column nullable in a Plan 3
migration rather than inventing a placeholder number.

- [ ] **Step 7: Run the tests**

Run: `npm run test -w backend -- auth.service`
Expected: PASS — 13 tests.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/users backend/src/modules/auth backend/src/modules/business
git commit -m "feat(auth): add register and login with no-enumeration failure handling"
```

## Task 25: Cookies, CSRF and the auth guards

Spec §9. The transport half of the departure from CUG's bearer-token pattern.

**Files:**
- Create: `backend/src/modules/auth/cookie.service.ts`, `backend/src/common/auth/jwt.strategy.ts`, `backend/src/common/auth/jwt-auth.guard.ts`, `backend/src/common/auth/csrf.guard.ts`, `backend/src/common/auth/roles.guard.ts`, `backend/src/common/auth/decorators/roles.decorator.ts`, `backend/src/common/auth/decorators/current-user.decorator.ts`, `backend/src/common/auth/decorators/skip-csrf.decorator.ts`
- Note: `backend/src/common/auth/decorators/public.decorator.ts` already exists from Milestone 0 (`health.controller.ts` uses it). Do not recreate it.
- Test: `backend/src/common/auth/csrf.guard.spec.ts`

- [ ] **Step 1: Implement the cookie service**

```ts
// backend/src/modules/auth/cookie.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import type { AppConfiguration } from '../../common/config/app.config';

export const ACCESS_COOKIE = 'nn_access_token';
export const REFRESH_COOKIE = 'nn_refresh_token';
export const CSRF_COOKIE = 'nn_csrf';

const REFRESH_PATH = '/api/v1/auth';
const MS_PER_DAY = 86_400_000;
/** Slightly longer than the 15-minute token, so the cookie never outlives its own contents. */
const ACCESS_COOKIE_MAX_AGE_MS = 20 * 60 * 1000;

@Injectable()
export class CookieService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Writes the session cookies.
   *
   * The access and refresh cookies are `httpOnly`, so no JavaScript — including injected
   * script — can read them. That is the whole point of spec §3.1 departure 1.
   *
   * The CSRF cookie is deliberately readable, because the frontend has to echo it back in a
   * header. It is not a credential: it proves only that the request came from a page that
   * could read the cookie, which a cross-site attacker cannot do.
   */
  issue(response: Response, tokens: { accessToken: string; refreshToken: string }): string {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');

    response.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.base(),
      maxAge: ACCESS_COOKIE_MAX_AGE_MS,
    });

    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.base(),
      // Scoped to the auth routes, so the long-lived token is not attached to every request
      // and cannot leak through an unrelated endpoint.
      path: REFRESH_PATH,
      // Strict rather than Lax: nothing should ever send this cross-site, not even a
      // top-level navigation.
      sameSite: 'strict',
      maxAge: auth.refreshTokenTtlDays * MS_PER_DAY,
    });

    const csrfToken = randomBytes(32).toString('base64url');
    response.cookie(CSRF_COOKIE, csrfToken, {
      ...this.base(),
      httpOnly: false,
      maxAge: auth.refreshTokenTtlDays * MS_PER_DAY,
    });

    return csrfToken;
  }

  clear(response: Response): void {
    const base = this.base();
    response.clearCookie(ACCESS_COOKIE, base);
    response.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
    response.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
  }

  private base(): CookieOptions {
    const { auth } = this.config.getOrThrow<AppConfiguration>('app');
    return {
      httpOnly: true,
      // Forced true in production by the env schema (Task 8).
      secure: auth.cookieSecure,
      sameSite: 'lax',
      domain: auth.cookieDomain,
      path: '/',
    };
  }
}
```

- [ ] **Step 2: Create the `@SkipCsrf()` decorator**

`login`, `register` and `refresh` cannot carry a CSRF token — the client has none yet, because
the cookie is issued *by* those endpoints. They need an exemption, and it is built here rather
than bolted on in Task 26 for one reason: an exemption from a security control is exactly the
thing that must arrive together with the tests proving it applies only where intended.

```ts
// backend/src/common/auth/decorators/skip-csrf.decorator.ts
import { SetMetadata } from '@nestjs/common';

/**
 * Exempts a handler from `CsrfGuard`.
 *
 * Only for the three endpoints that issue the CSRF cookie rather than consume it. Every other
 * state-changing route must carry a token; if you find yourself reaching for this decorator
 * elsewhere, the route is wrong, not the guard.
 */
export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = (): MethodDecorator => SetMetadata(SKIP_CSRF_KEY, true);
```

- [ ] **Step 3: Write the failing CSRF guard tests**

```ts
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';
import { DomainError, ErrorCodes } from '../errors/domain-error';
import { SKIP_CSRF_KEY } from './decorators/skip-csrf.decorator';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

/**
 * Reads the `code` off a synchronous `DomainError`, and fails loudly if the call was *allowed*.
 *
 * `expect(fn).toThrow(/CSRF/i)` cannot work here — see "Asserting on a DomainError" above. The
 * two shorter alternatives are both unusable: `toThrow(expect.objectContaining({ code }))` does
 * pass Jest and `tsc`, but `objectContaining` returns `any`, so `npm run lint` rejects it under
 * `no-unsafe-argument`; and a bare `try { ... } catch { expect(...) }` silently passes when the
 * guard wrongly *allows* the request, which is the one failure this suite exists to catch.
 */
function rejectionFrom(call: () => unknown): DomainError {
  try {
    call();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Expected the guard to reject the request, but it allowed it');
}

/** Stand-ins for the decorated handler and its controller, so the metadata targets are checkable. */
const HANDLER = function checkout(): void {};
class CheckoutController {}

function contextFor(method: string, cookie?: string, header?: string): ExecutionContext {
  return {
    // Both are required: the guard passes them to `getAllAndOverride` as the metadata targets.
    // Omitting them fails every state-changing test with `context.getHandler is not a function`.
    getHandler: () => HANDLER,
    getClass: () => CheckoutController,
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        cookies: cookie === undefined ? {} : { [CSRF_COOKIE]: cookie },
        header: (name: string) =>
          name.toLowerCase() === 'x-csrf-token' ? header : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

interface Harness {
  guard: CsrfGuard;
  /** The `Reflector` call the guard makes, so a test can assert *what* it looked up. */
  getAllAndOverride: jest.Mock<boolean | undefined, [string, unknown[]]>;
}

/**
 * The guard reads `@SkipCsrf()` metadata through a `Reflector`, so every construction needs one.
 * `undefined` is what Nest yields for a handler with no such decorator, which is the default case
 * for every route.
 *
 * The stub is deliberately *key-aware* rather than returning `true` for anything asked of it. A
 * blanket `mockReturnValue` would keep both exemption tests green even if the guard read the wrong
 * metadata key — `IS_PUBLIC_KEY`, say — which would mean every `@Public()` route silently lost its
 * CSRF check too. An earlier version of this plan had the blanket form, and it took a mutation to
 * find: the tests passed against a guard reading the wrong key.
 */
function guardWith(skipCsrf: boolean): Harness {
  const getAllAndOverride = jest.fn((key: string, _targets: unknown[]): boolean | undefined =>
    skipCsrf && key === SKIP_CSRF_KEY ? true : undefined,
  );
  const reflector = { getAllAndOverride };
  return { guard: new CsrfGuard(reflector as unknown as Reflector), getAllAndOverride };
}

describe('CsrfGuard', () => {
  const { guard } = guardWith(false);

  it.each(['GET', 'HEAD', 'OPTIONS'])('allows the safe method %s without a token', (method) => {
    expect(guard.canActivate(contextFor(method))).toBe(true);
  });

  it('allows a state-changing request when the cookie and header match', () => {
    expect(guard.canActivate(contextFor('POST', 'abc123', 'abc123'))).toBe(true);
  });

  it('rejects a state-changing request with no header', () => {
    expect(rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc123'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
  });

  it('rejects a state-changing request with no cookie', () => {
    expect(
      rejectionFrom(() => guard.canActivate(contextFor('POST', undefined, 'abc123'))).code,
    ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
  });

  it('rejects a mismatched token', () => {
    expect(
      rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc123', 'def456'))).code,
    ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
  });

  it('rejects tokens of differing length without throwing from timingSafeEqual', () => {
    expect(rejectionFrom(() => guard.canActivate(contextFor('POST', 'abc', 'abcdef'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
  });

  it('exempts a handler carrying @SkipCsrf() — login has no token to send yet', () => {
    const { guard: exempt, getAllAndOverride } = guardWith(true);
    expect(exempt.canActivate(contextFor('POST'))).toBe(true);
    // Assert *which* key was read, not just the outcome.
    expect(getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [HANDLER, CheckoutController]);
  });

  it('does not let the exemption leak to a handler without the decorator', () => {
    // The same guard instance serves every route. If this ever returns true, one `@SkipCsrf()`
    // on login would have silently disabled CSRF for the whole application.
    expect(rejectionFrom(() => guardWith(false).guard.canActivate(contextFor('POST'))).code).toBe(
      ErrorCodes.CSRF_TOKEN_INVALID,
    );
  });

  it('guards PATCH, PUT and DELETE as well as POST', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(
        rejectionFrom(() => guard.canActivate(contextFor(method, 'abc123', 'wrong1'))).code,
      ).toBe(ErrorCodes.CSRF_TOKEN_INVALID);
    }
  });
});
```

- [ ] **Step 4: Implement the CSRF guard**

```ts
// backend/src/common/auth/csrf.guard.ts
import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { DomainError, ErrorCodes } from '../errors/domain-error';
import { SKIP_CSRF_KEY } from './decorators/skip-csrf.decorator';
import { CSRF_COOKIE } from '../../modules/auth/cookie.service';

export const CSRF_HEADER = 'x-csrf-token';

/** Methods that do not change state need no token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check.
 *
 * `SameSite` already blocks the common cross-site POST, but it is a browser policy and not
 * every client honours it identically. This adds a second, independent condition: the caller
 * must be able to *read* the CSRF cookie, which a cross-origin page cannot do.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    // Mirrors how `JwtAuthGuard` honours `@Public()`. Handler first, then class, so a
    // method-level decorator wins over its controller.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const cookie = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
    const header = request.header(CSRF_HEADER);

    if (!cookie || !header) throw this.reject();

    const cookieBuffer = Buffer.from(cookie);
    const headerBuffer = Buffer.from(header);
    // `timingSafeEqual` throws on differing lengths, so compare those first.
    if (cookieBuffer.length !== headerBuffer.length) throw this.reject();
    if (!timingSafeEqual(cookieBuffer, headerBuffer)) throw this.reject();

    return true;
  }

  private reject(): DomainError {
    return new DomainError(
      ErrorCodes.CSRF_TOKEN_INVALID,
      'Your request could not be verified. Please refresh the page and try again.',
      HttpStatus.FORBIDDEN,
    );
  }
}
```

Run: `npm run test -w backend -- csrf.guard`
Expected: PASS — 11 tests.

- [ ] **Step 5: Implement the JWT strategy**

```ts
// backend/src/common/auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AppConfiguration } from '../config/app.config';
import { setContextUserId } from '../logging/request-context';
import { SessionsService } from '../../modules/sessions/sessions.service';
import { ACCESS_COOKIE } from '../../modules/auth/cookie.service';
import type { AccessTokenClaims } from '../../modules/auth/token.service';

export interface AuthenticatedUser {
  id: string;
  role: string;
  sessionId: string;
}

/** Reads the access token from the httpOnly cookie, not an Authorization header. */
function fromCookie(request: Request): string | null {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.[ACCESS_COOKIE] ?? null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly sessions: SessionsService,
  ) {
    const app = config.getOrThrow<AppConfiguration>('app');
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([fromCookie]),
      secretOrKey: app.auth.jwtSecret,
      ignoreExpiration: false,
    });
  }

  /**
   * A valid signature is not enough. The session must still be active, which is what makes
   * logout and admin force-logout take effect rather than waiting out the token's 15 minutes.
   */
  async validate(claims: AccessTokenClaims): Promise<AuthenticatedUser> {
    if (!claims.sessionId) throw new UnauthorizedException();

    const active = await this.sessions.isActive(claims.sessionId);
    if (!active) throw new UnauthorizedException();

    setContextUserId(claims.sub);
    return { id: claims.sub, role: claims.role, sessionId: claims.sessionId };
  }
}
```

- [ ] **Step 6: Implement the guards and decorators**

```ts
// backend/src/common/auth/jwt-auth.guard.ts
import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Registered globally, so **authentication is the default** and every unauthenticated route
 * carries an explicit `@Public()`. The inverse — opting routes in — is how an endpoint ends up
 * unprotected because someone forgot a decorator.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

```ts
// backend/src/common/auth/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../../entities/enums';

export const ROLES_KEY = 'roles';

/** Any one of the listed roles is sufficient. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
```

```ts
// backend/src/common/auth/roles.guard.ts
import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '../../entities/enums';
import { ROLES_KEY } from './decorators/roles.decorator';
import type { AuthenticatedUser } from './jwt.strategy';

const USER_ROLES: readonly string[] = Object.values(UserRole);

/** Narrows a token's `role` claim, which is a plain `string`, to the enum the guard compares. */
function isUserRole(role: string): role is UserRole {
  return USER_ROLES.includes(role);
}

/**
 * Registered globally alongside `JwtAuthGuard`. A route with no `@Roles()` is open to any
 * authenticated user; `@Roles(UserRole.ADMIN)` restricts it.
 *
 * Spec §13: this is the *only* thing that enforces admin access. The frontend's `/admin` route
 * guard is user experience — it stops a customer seeing a broken screen, and stops nothing else.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const role = request.user?.role;

    // The role comes from the signed token, never from a header or body field.
    //
    // Membership is tested against the enum's real values rather than by casting `role` to
    // `UserRole`. The cast would compile whatever the token actually carries, and there are two
    // role vocabularies in this codebase — the token carries the database enum (`ADMIN`), the
    // response body carries the wire role (`admin`, via `toAuthUser`). If anyone ever signs the
    // wire role instead, a cast would leave every admin route returning a silent, identical 403
    // with nothing to point at. This way the anomaly is distinguishable in the logs while the
    // client still gets the same generic refusal.
    if (role === undefined || !isUserRole(role)) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }
    if (!required.includes(role)) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }
    return true;
  }
}
```

```ts
// backend/src/common/auth/decorators/current-user.decorator.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../jwt.strategy';

/**
 * Injects the authenticated user resolved from the token.
 *
 * Every scoped query reads its owner from here and never from a route parameter or body
 * field — that is the IDOR defence in spec §13, applied at the point of use.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) throw new Error('CurrentUser used on a route without JwtAuthGuard');
    return request.user;
  },
);
```

- [ ] **Step 7: Run the unit suite and typecheck**

Run: `npm run test -w backend && npm run typecheck -w backend`
Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/common/auth backend/src/modules/auth/cookie.service.ts
git commit -m "feat(auth): add httpOnly cookie session, CSRF guard, JWT strategy and RBAC"
```

## Task 26: The auth controller

**Files:**
- Create: `backend/src/modules/auth/dto/login.dto.ts`, `register.dto.ts`, `backend/src/modules/auth/auth.controller.ts`, `backend/src/modules/auth/auth.module.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Create the DTOs**

class-validator, matching both existing repos, applying the regexes from `@nutwala/shared`.

```ts
// backend/src/modules/auth/dto/login.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'b2c@demo.in' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email: string;

  /**
   * Only a length bound here. Strength rules belong to registration; applying them at login
   * would tell an attacker which candidate passwords are even worth trying.
   */
  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;
}
```

```ts
// backend/src/modules/auth/dto/register.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GSTIN_REGEX, PHONE_REGEX } from '@nutwala/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class CompanyProfileDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  companyName: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  contactPerson: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  businessType: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'Enter a valid 15-character GSTIN' })
  gstin?: string;
}

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @MinLength(2, { message: 'Enter your full name' })
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email: string;

  /** Exactly the rule the checkout form applies, from `@nutwala/shared`. */
  @ApiProperty({ example: '9876543210' })
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone: string;

  @ApiProperty()
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters' })
  @MaxLength(200)
  password: string;

  @ApiProperty({ description: 'Brief §46 — one account, promoted to bulk buying' })
  @IsBoolean()
  isBusiness: boolean;

  @ApiPropertyOptional({ type: CompanyProfileDto })
  @ValidateIf((dto: RegisterDto) => dto.isBusiness)
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyProfileDto)
  company?: CompanyProfileDto;
}
```

**Note there is no `role` field.** A client that could send its own role could make itself an admin. Role is derived from `isBusiness` and nothing else; `forbidNonWhitelisted` rejects the property outright if anyone tries.

- [ ] **Step 2: Create the controller**

```ts
// backend/src/modules/auth/auth.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { withMessage, type AuthUser, type Enveloped } from '@nutwala/shared';
import type { Request, Response } from 'express';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { SessionsService } from '../sessions/sessions.service';
import { AuthService } from './auth.service';
import { CookieService, REFRESH_COOKIE } from './cookie.service';
import { TokenService } from './token.service';
import { toUserRole } from '../users/user.mapper';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** What the client gets back. The tokens themselves are in httpOnly cookies, never here. */
interface AuthResponse {
  user: AuthUser;
  /** Echoed in `X-CSRF-Token` on state-changing requests. Not a credential — see CsrfGuard. */
  csrfToken: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  // 3 registrations per hour per IP. Spec §9.
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @SkipCsrf()
  @Post('register')
  @ApiOperation({ summary: 'Create an account and start a session' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.register(dto, this.meta(request));
    const csrfToken = this.cookies.issue(response, result);
    return { user: result.user, csrfToken };
  }

  @Public()
  // 5 attempts per 15 minutes. Throttled per IP by @nestjs/throttler's default tracker.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @SkipCsrf()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const result = await this.auth.login(dto, this.meta(request));
    const csrfToken = this.cookies.issue(response, result);
    return { user: result.user, csrfToken };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @SkipCsrf()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const presented = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Rotation revokes the presented token and detects reuse — see SessionsService.
    const rotated = await this.sessions.rotate(presented, this.meta(request));

    // Resolved once. The role is read from the database rather than carried over from the old
    // token, so an admin promoting or demoting a user takes effect on the next refresh rather
    // than waiting for them to sign out.
    const user = await this.auth.me(rotated.session.userId);

    const csrfToken = this.cookies.issue(response, {
      accessToken: this.tokens.signAccessToken({
        sub: rotated.session.userId,
        role: toUserRole(user.role),
        sessionId: rotated.session.id,
      }),
      refreshToken: rotated.refreshToken,
    });

    return { user, csrfToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the session and clear cookies' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Enveloped<null>> {
    await this.auth.logout(user.sessionId);
    this.cookies.clear(response);
    // Nominal opt-in — see `Enveloped` in @nutwala/shared. A bare `{ data, message }` object
    // would NOT be lifted.
    return withMessage(null, 'Signed out.');
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthUser> {
    return this.auth.me(user.id);
  }

  @Post('upgrade-to-business')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Brief §46 — enable bulk buying on an existing account' })
  upgradeToBusiness(@CurrentUser() user: AuthenticatedUser): Promise<AuthUser> {
    return this.auth.upgradeToBusiness(user.id);
  }

  private meta(request: Request): { userAgent: string | null; ip: string | null } {
    return { userAgent: request.header('user-agent') ?? null, ip: request.ip ?? null };
  }
}
```

- [ ] **Step 3: Create `AuthModule`**

```ts
// backend/src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from '../../common/auth/jwt.strategy';
import { BusinessesModule } from '../business/businesses.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CookieService } from './cookie.service';
import { PasswordService } from './password.service';

/**
 * `TokenService`, `TOKEN_SETTINGS` and `JwtModule` are **not** declared here. They live in
 * `SessionsModule`, which exports `TokenService`, and importing that module is what brings it into
 * scope.
 *
 * This is deliberate and was a bug in an earlier version of this task, which declared its own
 * `TokenService` and `TOKEN_SETTINGS` *and* imported `SessionsModule`. Nest would have built two
 * independent `TokenService` instances with two separate settings objects — one signing access
 * tokens for the login path, one hashing refresh tokens and computing refresh expiry for the
 * session path. Identical today, because both factories read the same `ConfigService`; silently
 * divergent the moment either is configured from anything else, and a refresh TTL that disagrees
 * with the one the session rows were written against is not a failure that announces itself.
 *
 * `JwtStrategy` needs only `ConfigService` and `SessionsService`, so it is satisfied by the same
 * import. `PassportModule` stays — it is what registers the strategy machinery.
 */
@Module({
  imports: [PassportModule, UsersModule, SessionsModule, BusinessesModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, CookieService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 4: Register the global guards in `app.module.ts`**

Add these imports and providers. Order matters: `JwtAuthGuard` must run before `RolesGuard`, because the latter reads the user the former resolves.

```ts
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { CsrfGuard } from './common/auth/csrf.guard';
import { AuthModule } from './modules/auth/auth.module';
```

In `imports`, add `AuthModule`. In `providers`, replace the single throttler entry with:

```ts
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
```

Global guards run in registration order, which is why this order and not another. `RolesGuard`
reads `request.user`, so it must follow `JwtAuthGuard` that puts it there. `ThrottlerGuard` is first
so a flood is refused before anything expensive happens, and `CsrfGuard` precedes `JwtAuthGuard` so
a forged request is rejected without spending the session lookup — the visible consequence is that
an unauthenticated state-changing request with no CSRF token answers 403 rather than 401, which is
the cheaper rejection and leaks less.

**A constraint this creates, which bites Plan 3 rather than this milestone — decide it there, do not
discover it.** `CookieService.issue()` is called only by login, register and refresh, so the
`nn_csrf` cookie exists **only for clients that have authenticated**. Once `CsrfGuard` is global,
every state-changing request from an anonymous visitor is refused. Nothing breaks now, because the
only public POSTs are the three that carry `@SkipCsrf()`. But Plan 3's public contact form, RFQ
submission and newsletter signup are all anonymous POSTs, and all three would 403.

The wrong fix is to add them to the `@SkipCsrf()` list. That list is a security exemption, it would
grow endpoint by endpoint, and it is wrong on the merits for any form that a *signed-in* user can
also submit — an RFQ tied to an account is exactly the authenticated state CSRF exists to protect,
and one endpoint serves both callers.

The right fix is to issue `nn_csrf` to anonymous clients too, which is how double-submit is normally
bootstrapped: set it on any request that arrives without one. It keeps the guard uniform, needs no
exemption, and every client then holds a token whether or not it has signed in.

- [ ] **Step 5: Exempt the auth entry points from CSRF**

`login`, `register` and `refresh` cannot carry a CSRF token, because the client has none yet — the cookie is issued *by* those endpoints.

`@SkipCsrf()` and the `Reflector` wiring in `CsrfGuard` were both built in **Task 25**, along with the two tests that matter: that a decorated handler is exempt, and that the exemption does not leak to an undecorated one. Nothing about the guard needs changing here.

So this step is only the application: put `@SkipCsrf()` on the `register`, `login` and `refresh` handlers, and on no others. Import it from `../../common/auth/decorators/skip-csrf.decorator`.

Every other state-changing route in the application must keep the guard. If a route seems to need this decorator, the route is issuing credentials it should not be, or is not really state-changing — fix the route, not the exemption list.

- [ ] **Step 6: Boot and exercise the flow by hand**

Run: `npm run dev -w backend`, then in another shell:

```bash
# Register a new account and keep the cookie jar
curl -s -c /tmp/nn.jar -X POST http://localhost:4400/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Buyer","email":"test@demo.in","phone":"9876543210","password":"Kaju1kgPlease","isBusiness":false}' \
  | python3 -m json.tool
```

Expected: `success: true`, `data.user.role` is `b2c`, and `data.csrfToken` is present. Confirm the cookies:

```bash
grep -E 'nn_access_token|nn_refresh_token|nn_csrf' /tmp/nn.jar
```

Expected: three cookies, with `nn_access_token` and `nn_refresh_token` flagged `HttpOnly` (the jar shows `#HttpOnly_` prefixes) and `nn_csrf` not.

```bash
# The session is readable
curl -s -b /tmp/nn.jar http://localhost:4400/api/v1/auth/me | python3 -m json.tool

# Login with the wrong password returns the generic message
curl -s -X POST http://localhost:4400/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@demo.in","password":"wrong"}' | python3 -m json.tool

# An unknown email returns exactly the same message and status
curl -s -X POST http://localhost:4400/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@demo.in","password":"wrong"}' | python3 -m json.tool
```

Expected: both return 401 with `"message": "Invalid email or password."` and
`"code": "INVALID_CREDENTIALS"`. If the two differ in any way, spec §13's enumeration control
is broken — stop and fix it.

```bash
# Logout without the CSRF header is refused
curl -s -b /tmp/nn.jar -X POST http://localhost:4400/api/v1/auth/logout | python3 -m json.tool
```

Expected: 403, `code: CSRF_TOKEN_INVALID`.

```bash
# With the header it succeeds, and the session is then dead
CSRF=$(grep nn_csrf /tmp/nn.jar | awk '{print $7}')
curl -s -b /tmp/nn.jar -X POST http://localhost:4400/api/v1/auth/logout \
  -H "X-CSRF-Token: $CSRF" | python3 -m json.tool
curl -s -b /tmp/nn.jar http://localhost:4400/api/v1/auth/me -o /dev/null -w '%{http_code}\n'
```

Expected: logout returns `success: true`; the follow-up `me` returns `401`. That 401 is the
proof that logout is real rather than cosmetic.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/auth backend/src/common/auth backend/src/app.module.ts
git commit -m "feat(auth): add auth endpoints with cookie sessions, CSRF and rate limits"
```

## Task 27: Auth integration tests

Spec §13. Every auth row of the risk table gets a test here, against a real database.

**Files:**
- Create: `backend/test/factories/user.factory.ts`, `backend/test/integration/auth.integration.spec.ts`

**Read `backend/test/integration/helpers/` before writing a line of this.** An earlier version of
this task hand-rolled the container lifecycle and called `startTestDatabase` — which the harness
deliberately does not export to specs, because the container is started once in `globalSetup` and a
spec that starts its own replays the entire migration chain. Use `useIntegrationApp()`, and cross
the untyped supertest boundary through `expectSuccess<T>` / `expectError` rather than reaching into
`response.body`, which raises `no-unsafe-member-access` on every assertion.

`agent(app)` — a cookie-persisting client — already exists in `helpers/http.ts` for the flows that
span more than one request. `request()` starts fresh each call, which cannot express "log in, then
call a protected route", "log out, then prove the next request is refused", or "rotate, then prove
the old cookie is dead". Note it is `supertest.agent`, not a method on `request()`'s return value.

- [ ] **Step 1: Create the user factory**

CUG's `createTestX(overrides)` convention.

```ts
// backend/test/factories/user.factory.ts
import * as bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';
import { UserRole } from '../../src/entities/enums';
import { User } from '../../src/entities/identity/user.entity';

export const TEST_PASSWORD = 'Kaju1kgPlease';

export async function createTestUser(
  dataSource: DataSource,
  overrides: Partial<User> = {},
): Promise<User> {
  const repository = integration.dataSource.getRepository(User);
  const suffix = Math.random().toString(36).slice(2, 8);

  return repository.save(
    repository.create({
      name: 'Test Customer',
      email: `test-${suffix}@demo.in`,
      phone: '9876543210',
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      role: UserRole.CUSTOMER,
      isActive: true,
      ...overrides,
    }),
  );
}
```

- [ ] **Step 2: Write the integration tests**

```ts
import { UserRole } from '../../src/entities/enums';
import { Session } from '../../src/entities/identity/session.entity';
import type { Response } from 'supertest';
import {
  agent,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
  type ErrorBody,
} from './helpers';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';

const BASE = '/api/v1/auth';

/**
 * The user shape the API returns. Declared here rather than imported from `@nutwala/shared`'s
 * `AuthUser` on purpose: the point of these tests is to catch the response drifting away from the
 * contract, and asserting against the very type the code is built from could not do that.
 * `passwordHash` is optional so a test can assert it is absent.
 */
interface AuthUserBody {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'b2c' | 'b2b' | 'admin';
  company?: { companyName: string; contactPerson: string; businessType: string; gstin?: string };
  createdAt: string;
  passwordHash?: never;
}

/** Pulls a named cookie's value out of a `set-cookie` header array. */
function cookieValue(headers: string[] | undefined, name: string): string | undefined {
  const entry = headers?.find((header) => header.startsWith(`${name}=`));
  return entry?.split(';')[0]?.split('=')[1];
}

function cookieAttributes(headers: string[] | undefined, name: string): string {
  return headers?.find((header) => header.startsWith(`${name}=`)) ?? '';
}

describe('auth', () => {
  // One call handles the whole lifecycle: connect the test DataSource, boot the app with a
  // generous timeout, `cleanDatabase` after every test, then close both. Do NOT hand-roll
  // `beforeAll`/`afterAll` here, and do not reach for `startTestDatabase` — it is deliberately
  // not exported to specs, because the container is started once in `globalSetup` and a spec that
  // starts its own is the exact bug this harness was restructured to remove.
  const integration = useIntegrationApp();

  describe('POST /register', () => {
    it('creates a b2c account and sets three cookies', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'New Customer',
          email: 'New@Demo.in',
          phone: '9876543210',
          password: TEST_PASSWORD,
          isBusiness: false,
        })
        .expect(201);

      // `expectSuccess<T>` is the single place the untyped supertest boundary is crossed. Reaching
      // into `response.body` directly raises `no-unsafe-member-access` on every assertion.
      const data = expectSuccess<{ user: AuthUserBody; csrfToken: string }>(response);
      expect(data.user).toMatchObject({ email: 'new@demo.in', role: 'b2c' });
      expect(data.csrfToken).toEqual(expect.any(String));

      const cookies = response.headers['set-cookie'] as string[] | undefined;
      expect(cookieValue(cookies, 'nn_access_token')).toBeDefined();
      expect(cookieValue(cookies, 'nn_refresh_token')).toBeDefined();
      expect(cookieValue(cookies, 'nn_csrf')).toBeDefined();
    });

    it('flags the session cookies httpOnly and the csrf cookie readable', () => {
      // Spec §13, "XSS to account takeover". If nn_access_token is ever readable by script, one
      // injection anywhere on the site becomes a full account compromise.
      return request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'Cookie Check',
          email: 'cookies@demo.in',
          phone: '9876543210',
          password: TEST_PASSWORD,
          isBusiness: false,
        })
        .expect(201)
        .then((response) => {
          const cookies = response.headers['set-cookie'] as string[] | undefined;
          expect(cookieAttributes(cookies, 'nn_access_token')).toMatch(/HttpOnly/i);
          expect(cookieAttributes(cookies, 'nn_refresh_token')).toMatch(/HttpOnly/i);
          expect(cookieAttributes(cookies, 'nn_refresh_token')).toMatch(/SameSite=Strict/i);
          expect(cookieAttributes(cookies, 'nn_csrf')).not.toMatch(/HttpOnly/i);
        });
    });

    it('never returns the password hash', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'No Hash',
          email: 'nohash@demo.in',
          phone: '9876543210',
          password: TEST_PASSWORD,
          isBusiness: false,
        })
        .expect(201);

      expect(JSON.stringify(response.body)).not.toContain('$2b$');
      expect(expectSuccess<{ user: AuthUserBody }>(response).user.passwordHash).toBeUndefined();
    });

    it('creates a b2b account with its business record', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'Bulk Buyer',
          email: 'bulk@demo.in',
          phone: '9876543211',
          password: TEST_PASSWORD,
          isBusiness: true,
          company: {
            companyName: 'Sharma Sweets',
            contactPerson: 'R Sharma',
            businessType: 'Sweet shop',
          },
        })
        .expect(201);

      const business = expectSuccess<{ user: AuthUserBody }>(response).user;
      expect(business.role).toBe('b2b');
      expect(business.company).toMatchObject({ companyName: 'Sharma Sweets' });
    });

    it('rejects a role sent by the client, so an account cannot self-promote', async () => {
      // Spec §13, "privilege escalation" and "mass assignment". forbidNonWhitelisted makes
      // this a 400 rather than a silently ignored field.
      await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'Sneaky',
          email: 'sneaky@demo.in',
          phone: '9876543210',
          password: TEST_PASSWORD,
          isBusiness: false,
          role: 'admin',
        })
        .expect(400);
    });

    it('rejects a malformed phone number using the shared regex', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'Bad Phone',
          email: 'badphone@demo.in',
          phone: '1234567890',
          password: TEST_PASSWORD,
          isBusiness: false,
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/10-digit Indian mobile/);
    });

    it('rejects a duplicate email regardless of case', async () => {
      await createTestUser(dataSource, { email: 'taken@demo.in' });
      await request(integration.app)
        .post(`${BASE}/register`)
        .send({
          name: 'Duplicate',
          email: 'TAKEN@DEMO.IN',
          phone: '9876543210',
          password: TEST_PASSWORD,
          isBusiness: false,
        })
        .expect(409);
    });
  });

  describe('POST /login', () => {
    it('signs in with correct credentials', async () => {
      const user = await createTestUser(dataSource);
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);

      expect(expectSuccess<{ user: AuthUserBody }>(response).user.id).toBe(user.id);
    });

    it('returns an identical body for all three login failure paths', async () => {
      // Spec §13, and the definition-of-done item this suite exists for. All three must be
      // indistinguishable: unknown email, wrong password, and a live account with the right
      // password but `isActive: false`. The deactivated path is the one most likely to drift,
      // because it is the only one where the account exists and the password is correct.
      const active = await createTestUser(integration.dataSource);
      const inactive = await createTestUser(integration.dataSource, {
        email: 'deactivated@demo.in',
        isActive: false,
      });

      const attempt = (email: string, password: string): Promise<Response> =>
        request(integration.app).post(`${BASE}/login`).send({ email, password }).expect(401);

      const [wrongPassword, unknownEmail, deactivated] = await Promise.all([
        attempt(active.email, 'definitely-wrong'),
        attempt('nobody@demo.in', 'definitely-wrong'),
        attempt(inactive.email, TEST_PASSWORD),
      ]);

      /**
       * Compare the *whole* envelope rather than three named fields.
       *
       * Picking fields is what lets a leak through: an earlier version asserted `message`, `code`
       * and `statusCode`, so anything the filter added later — a `details` object, a differing
       * `path` — would have discriminated the paths while this test stayed green. Only the three
       * per-request values are stripped, and each is asserted present so removing one cannot
       * silently widen what is ignored.
       */
      const comparable = (response: Response): Omit<ErrorBody, 'timestamp' | 'errorId' | 'requestId'> => {
        const body = expectError(response);
        expect(body.timestamp).toEqual(expect.any(String));
        expect(body.errorId).toEqual(expect.any(String));
        expect(body.requestId).toEqual(expect.any(String));
        const { timestamp: _t, errorId: _e, requestId: _r, ...rest } = body;
        return rest;
      };

      expect(comparable(wrongPassword).message).toBe('Invalid email or password.');
      expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));
      expect(comparable(deactivated)).toEqual(comparable(wrongPassword));
    });

    it('refuses a deactivated account with the same message', async () => {
      const user = await createTestUser(dataSource, { isActive: false });
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(401);
      expect(expectError(response).message).toBe('Invalid email or password.');
    });

    it('issues a fresh session per login, preventing fixation', async () => {
      const user = await createTestUser(dataSource);
      const credentials = { email: user.email, password: TEST_PASSWORD };

      await request(integration.app).post(`${BASE}/login`).send(credentials).expect(200);
      await request(integration.app).post(`${BASE}/login`).send(credentials).expect(200);

      const sessions = await integration.dataSource.getRepository(Session).find({ where: { userId: user.id } });
      expect(sessions).toHaveLength(2);
      expect(new Set(sessions.map((session) => session.familyId)).size).toBe(2);
    });

    it('stores only a hash of the refresh token', async () => {
      const user = await createTestUser(dataSource);
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);

      const refreshToken = cookieValue(response.headers['set-cookie'] as string[], 'nn_refresh_token');
      const [session] = await integration.dataSource.getRepository(Session).find({ where: { userId: user.id } });

      expect(refreshToken).toBeDefined();
      expect(session?.refreshTokenHash).not.toBe(refreshToken);
      expect(session?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rate-limits repeated failures', async () => {
      const user = await createTestUser(dataSource);
      const attempt = () =>
        request(integration.app)
          .post(`${BASE}/login`)
          .send({ email: user.email, password: 'wrong' });

      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        statuses.push((await attempt()).status);
      }
      // Five attempts allowed per the @Throttle on the route, then 429.
      expect(statuses).toContain(429);
    });
  });

  describe('GET /me', () => {
    it('returns the signed-in user', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      await client.post(`${BASE}/login`).send({ email: user.email, password: TEST_PASSWORD });

      const response = await client.get(`${BASE}/me`).expect(200);
      expect(expectSuccess<AuthUserBody>(response).id).toBe(user.id);
    });

    it('refuses an anonymous request', async () => {
      await request(integration.app).get(`${BASE}/me`).expect(401);
    });

    it('refuses a forged access token', async () => {
      await request(integration.app)
        .get(`${BASE}/me`)
        .set('Cookie', 'nn_access_token=not.a.real.jwt')
        .expect(401);
    });

    it('ignores an Authorization header, since the token comes from the cookie', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      const login = await client
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD });
      const token = cookieValue(login.headers['set-cookie'] as string[], 'nn_access_token');

      await request(integration.app)
        .get(`${BASE}/me`)
        .set('Authorization', `Bearer ${token ?? ''}`)
        .expect(401);
    });
  });

  describe('POST /refresh', () => {
    it('rotates the refresh token', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      const login = await client
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD });
      const original = cookieValue(login.headers['set-cookie'] as string[], 'nn_refresh_token');

      const refreshed = await client.post(`${BASE}/refresh`).expect(200);
      const rotated = cookieValue(refreshed.headers['set-cookie'] as string[], 'nn_refresh_token');

      expect(rotated).toBeDefined();
      expect(rotated).not.toBe(original);
    });

    it('revokes the whole family when a rotated token is presented again', async () => {
      // Spec §13, "session theft". This is the stolen-token signature.
      const user = await createTestUser(dataSource);
      const login = await request(integration.app)
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD });
      const original = cookieValue(login.headers['set-cookie'] as string[], 'nn_refresh_token');

      await request(integration.app)
        .post(`${BASE}/refresh`)
        .set('Cookie', `nn_refresh_token=${original ?? ''}`)
        .expect(200);

      const replayed = await request(integration.app)
        .post(`${BASE}/refresh`)
        .set('Cookie', `nn_refresh_token=${original ?? ''}`)
        .expect(401);

      expect(expectError(replayed).code).toBe('REFRESH_TOKEN_REUSED');

      const sessions = await integration.dataSource.getRepository(Session).find({ where: { userId: user.id } });
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });

    it('refuses a request with no refresh cookie', async () => {
      await request(integration.app).post(`${BASE}/refresh`).expect(401);
    });
  });

  describe('POST /logout', () => {
    it('requires the CSRF header', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      await client.post(`${BASE}/login`).send({ email: user.email, password: TEST_PASSWORD });

      const response = await client.post(`${BASE}/logout`).expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('revokes the session, so the access token stops working immediately', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      const login = await client
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD });
      const { csrfToken: csrf } = expectSuccess<{ csrfToken: string }>(login);

      await client.post(`${BASE}/logout`).set('X-CSRF-Token', csrf).expect(200);

      // Spec §9: this is what a stateless JWT cannot do. The token is still within its 15
      // minutes and cryptographically valid, but the session behind it is gone.
      await client.get(`${BASE}/me`).expect(401);
    });
  });

  describe('authorization', () => {
    it('lets an authenticated customer read their own session', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource);
      await client.post(`${BASE}/login`).send({ email: user.email, password: TEST_PASSWORD });
      await client.get(`${BASE}/me`).expect(200);
    });

    it('promotes a customer to a business account per brief §46', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(dataSource, { role: UserRole.CUSTOMER });
      const login = await client
        .post(`${BASE}/login`)
        .send({ email: user.email, password: TEST_PASSWORD });

      const response = await client
        .post(`${BASE}/upgrade-to-business`)
        .set('X-CSRF-Token', expectSuccess<{ csrfToken: string }>(login).csrfToken)
        .expect(200);

      expect(expectSuccess<AuthUserBody>(response).role).toBe('b2b');
    });
  });
});
```

- [ ] **Step 3: Run the integration suite**

Run: `npm run test:integration -w backend`
Expected: PASS — health (2), schema invariants (9), auth (24).

If the rate-limit test is flaky because throttler state carries between tests, give the
throttler an explicit per-test storage reset in `createTestApp`, or move that single test to
its own describe block with a distinct email. Do not delete the test.

- [ ] **Step 4: Commit**

```bash
git add backend/test
git commit -F - <<'MSG'
test(auth): cover cookies, enumeration, rotation, CSRF and revocation
MSG
```

## Task 28: Point the frontend at the real API

**Files:**
- Create: `frontend/src/lib/http.ts`, `frontend/.env.development`
- Modify: `frontend/src/features/auth/api/index.ts`, `frontend/src/features/auth/AuthProvider.tsx`, `frontend/src/features/auth/storage.ts`, `frontend/src/features/auth/types.ts`, `frontend/src/features/auth/guards.ts`, `frontend/src/routes/account/profile.tsx`, `frontend/vite.config.ts`
- Test: `frontend/src/test/routes.coverage.test.tsx`, `frontend/src/test/routes.smoke.test.tsx` — both import the storage module's old names and must be updated with it

`import.meta.env.VITE_API_URL` typechecks without a new declaration file: `frontend/tsconfig.app.json` already sets `"types": ["vite/client"]`. Nothing in the frontend references `import.meta.env` yet, so this is the first use — if the frontend's type-aware lint rules object to the `any` that Vite's index signature yields, annotate the constant rather than widening a rule.

- [ ] **Step 1: Create the HTTP client**

```ts
// frontend/src/lib/http.ts
import type { ApiError, ApiSuccess } from "@nutwala/shared";

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api/v1";
const CSRF_COOKIE = "nn_csrf";
const CSRF_HEADER = "X-CSRF-Token";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** A failed request, carrying the backend's stable `code` so callers can branch on it. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function readCsrfCookie(): string | undefined {
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${CSRF_COOKIE}=`))
    ?.split("=")[1];
}

/**
 * Serialises concurrent refreshes **within this tab**.
 *
 * Without it, three requests failing with 401 at once would each POST /auth/refresh. The first
 * rotates the token and the other two present the now-revoked one — which the backend correctly
 * reads as token reuse and answers by killing the whole session family. So the frontend must
 * refresh once and have the others wait.
 *
 * **This is not sufficient, and the gap is not theoretical.** `refreshInFlight` is a module-level
 * variable, so it is per JavaScript context — per tab. Two tabs open on the site, both idle past
 * the access cookie's twenty minutes, both waking to a 401, will each fire their own refresh.
 * Exactly one wins; the loser's family revoke then kills the winner's brand-new session too, by
 * design, because from the server's side two parties presented one token and neither can be
 * trusted. Net effect: **the user is signed out of both tabs for doing nothing wrong.** Two tabs
 * open is ordinary behaviour, so this will be reported as "it randomly logs me out".
 *
 * Task 29 must verify it, and it is a **frontend** fix, not a server one:
 *
 * - **Preferred: elect one refresher across tabs.** `navigator.locks.request('nn-auth-refresh', …)`
 *   around `refreshSession` serialises every tab in the origin, and the losers re-read the fresh
 *   cookie the winner just set. Keeps reuse detection strict, which matters — the whole point of
 *   the session table is that a replayed token is caught.
 * - **Fallback where the Web Locks API is unavailable:** a `BroadcastChannel` announcement, or the
 *   existing in-flight promise plus a short randomised delay so tabs rarely collide. Weaker, but it
 *   degrades to "occasionally signed out" rather than "insecure".
 * - **Do NOT ask for a server-side grace window** that accepts the immediately-preceding token as a
 *   convenience. It is the obvious suggestion and it reopens exactly the hole that took a measured
 *   19-in-20 failure to find: inside the grace period a stolen token is indistinguishable from a
 *   racing tab. If a grace window is ever wanted it needs its own design and its own tests, not a
 *   patch bolted onto the reuse check.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Two common failures carry **no** `code`. Branch on `status` for both.
 *
 * `code` is a `DomainError` property, so only errors this service raises deliberately have one.
 * Both measured against the running service:
 *
 * - **429** — `ThrottlerException` is a plain `HttpException`, so a rate-limited request has a
 *   `message` and a `statusCode` and nothing to switch on. This is the failure a real user is most
 *   likely to hit by accident.
 * - **401 while anonymous** — `GET /auth/me` with no cookies returns `{"message":"Unauthorized"}`
 *   from passport's bare `UnauthorizedException`. Only `/auth/refresh` answers with a real code
 *   (`SESSION_EXPIRED`), because that path throws a `DomainError`.
 *
 * The second is the more dangerous assumption, because "not signed in" is the single most common
 * response the API gives an anonymous visitor, and code written to recognise it by `code` would
 * fail silently on the happy path rather than loudly. Recognise it by `status === 401`.
 */

/**
 * The three paths where a 401 must NOT trigger a refresh-and-retry.
 *
 * `/auth/refresh` would recurse. On `/auth/login` and `/auth/register` a 401 means the credentials
 * were wrong, and refreshing would be answering the wrong question.
 *
 * Deliberately an exact-match set rather than the `path.startsWith("/auth/")` an earlier version
 * used, because that prefix was far too broad and broke the one guarantee the whole server-side
 * session table exists to provide. `POST /auth/logout` needs a valid access token to identify the
 * session it is revoking; after the access cookie's 20 minutes it answers 401. Under the prefix
 * test no refresh was attempted, so logout failed — the UI cleared its local snapshot and looked
 * signed out while **the session row was never revoked and the 30-day refresh cookie stayed
 * valid**. A logout that does not revoke is precisely the failure this design was chosen to avoid.
 *
 * `GET /auth/me` was broken the same way: a returning visitor with an expired access cookie and 29
 * days of refresh validity left would 401, hydrate as `null`, and be shown a signed-out site.
 */
const NEVER_REFRESH = new Set(["/auth/refresh", "/auth/login", "/auth/register"]);

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Internal: prevents a refresh loop when the retried request also 401s. */
  retry?: boolean;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  if (!SAFE_METHODS.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    // Required, or the browser sends no cookies and every request is anonymous.
    credentials: "include",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 401 && !options.retry && !NEVER_REFRESH.has(path)) {
    const refreshed = await refreshSession();
    if (refreshed) return apiRequest<T>(path, { ...options, retry: true });
  }

  // 204 and an empty body are valid successes with nothing to parse.
  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = payload as ApiError | null;
    throw new ApiRequestError(
      response.status,
      error?.message ?? "Something went wrong. Please try again.",
      error?.code,
      error?.details,
    );
  }

  return (payload as ApiSuccess<T>).data;
}

export const http = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { ...(signal ? { signal } : {}) }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: "DELETE" }),
};
```

- [ ] **Step 2: Proxy the API in dev so cookies are same-origin**

Add to `frontend/vite.config.ts` inside the config object:

```ts
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4400",
        changeOrigin: false,
      },
    },
  },
```

`changeOrigin: false` keeps the Host header, so `Domain=localhost` cookies are accepted. With
the proxy in place the frontend and API share an origin in development, which means
`SameSite` behaves as it will in production and there is no CORS preflight to debug.

- [ ] **Step 3: Rewrite the auth API module**

```ts
// frontend/src/features/auth/api/index.ts
import type { AuthUser, Credentials, RegisterInput } from "@nutwala/shared";
import { ApiRequestError, http } from "@/lib/http";

/** A rejected sign-in or a duplicate registration, with copy fit to show the customer. */
export class AuthError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface AuthResponse {
  user: AuthUser;
  csrfToken: string;
}

function toAuthError(error: unknown): never {
  if (error instanceof ApiRequestError) throw new AuthError(error.message, error.code);
  throw error;
}

export const authApi = {
  login: async (credentials: Credentials): Promise<AuthUser> => {
    try {
      const { user } = await http.post<AuthResponse>("/auth/login", credentials);
      return user;
    } catch (error) {
      return toAuthError(error);
    }
  },

  register: async (input: RegisterInput): Promise<AuthUser> => {
    try {
      const { user } = await http.post<AuthResponse>("/auth/register", input);
      return user;
    } catch (error) {
      return toAuthError(error);
    }
  },

  logout: async (): Promise<void> => {
    await http.post<null>("/auth/logout");
  },

  /**
   * Hydrates the session on load. Returns null rather than throwing on 401, because "not
   * signed in" is an ordinary state on every public page, not an error.
   */
  me: async (): Promise<AuthUser | null> => {
    try {
      return await http.get<AuthUser>("/auth/me");
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return null;
      throw error;
    }
  },

  upgradeToBusiness: async (): Promise<AuthUser> => {
    try {
      return await http.post<AuthUser>("/auth/upgrade-to-business");
    } catch (error) {
      return toAuthError(error);
    }
  },
};
```

`demoAccounts` is **deleted**. Phase 1 advertised fixture logins on the sign-in screen because
auth was a mock; a real sign-in screen must not publish credentials. Remove the type from
`features/auth/types.ts` and the block that renders it from `routes/login.tsx`.

- [ ] **Step 4: Rewrite `AuthProvider`**

```tsx
// frontend/src/features/auth/AuthProvider.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthUser, Credentials, RegisterInput, Role } from "@nutwala/shared";
import { authApi } from "./api";
import { clearSnapshot, readSnapshot, writeSnapshot } from "./storage";

interface AuthCtx {
  user: AuthUser | null;
  role: Role | null;
  isAuthenticated: boolean;
  /**
   * True until `GET /auth/me` has answered.
   *
   * For **components**, not for route guards — a `beforeLoad` guard runs before the component tree
   * exists and cannot read this context at all, which is the whole reason `guards.ts` reads the
   * localStorage snapshot instead. An earlier version of this comment claimed a guard could wait on
   * it, which is not true of any guard in this app.
   *
   * What it is genuinely for: a component that renders auth state must not flash the signed-out
   * version while `me()` is still in flight. The snapshot makes first paint right in the common
   * case, but a visitor holding valid cookies whose localStorage was cleared has no snapshot, and
   * without this the header would show "Sign in" and then flip to their name.
   */
  isLoading: boolean;
  login: (credentials: Credentials) => Promise<AuthUser>;
  register: (input: RegisterInput) => Promise<AuthUser>;
  logout: () => Promise<void>;
  upgradeToBusiness: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  /**
   * Seeded from the localStorage snapshot so the first paint and the route guards in
   * `beforeLoad` agree, then corrected by the server.
   *
   * The snapshot is **display state, not a credential**. The real session is an httpOnly
   * cookie that JavaScript cannot read. Tampering with the snapshot changes what the UI
   * optimistically renders and nothing else: every API call is authorised server-side.
   */
  const [user, setUser] = useState<AuthUser | null>(() => readSnapshot());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void authApi
      .me()
      .then((serverUser) => {
        if (cancelled) return;
        setUser(serverUser);
        if (serverUser) writeSnapshot(serverUser);
        else clearSnapshot();
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: AuthUser) => {
    writeSnapshot(next);
    setUser(next);
    return next;
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      role: user?.role ?? null,
      isAuthenticated: user !== null,
      isLoading,
      login: async (credentials) => persist(await authApi.login(credentials)),
      register: async (input) => persist(await authApi.register(input)),
      logout: async () => {
        /**
         * Clear locally even if the request fails, because the user asked to sign out and a UI
         * that refuses is worse than one that is optimistic.
         *
         * But be honest about what a failure leaves behind: the server-side session row is still
         * live and the refresh cookie is valid for **30 days**, so this is a local sign-out only.
         * An earlier version of this comment reasoned that "the access cookie expires within 15
         * minutes regardless" — which is true and irrelevant, since the refresh cookie is what
         * keeps the session alive. That was the same false comfort that hid the refresh-retry bug
         * on this endpoint. The retry is what makes the call actually succeed; this branch is the
         * genuine-network-failure case, and it does not revoke anything.
         */
        try {
          await authApi.logout();
        } finally {
          clearSnapshot();
          setUser(null);
        }
      },
      upgradeToBusiness: async () => {
        persist(await authApi.upgradeToBusiness());
      },
    }),
    [user, isLoading, persist],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used inside AuthProvider");
  return c;
}
```

- [ ] **Step 5: Rename the storage module's exports to say what they now are**

`features/auth/storage.ts` keeps the same localStorage key so an existing session snapshot
still reads, but the functions become `readSnapshot` / `writeSnapshot` / `clearSnapshot` and
the file's doc comment states plainly that this is a display cache and never a credential.
Update `features/auth/guards.ts` and the two test files that import the old names.

- [ ] **Step 6: Handle `updateProfile`**

`AuthProvider` previously exposed `updateProfile`, used by `/account/profile`. There is no
profile endpoint until Plan 2 Milestone 6. Remove it from the context and have
`routes/account/profile.tsx` show its form as read-only with a short note, rather than keeping
a method that writes only to localStorage and silently loses the change.

- [ ] **Step 7: Verify the flow in the browser**

Run: `npm run db:up`, `npm run seed -w backend`, `npm run dev -w backend`, and `npm run dev -w frontend`.

Then, at `http://localhost:5173`:
1. Register a new account → you land signed in, and the header shows the account menu.
2. Reload the page → still signed in. This is `GET /auth/me` hydrating from the cookie; before this task it was localStorage.
3. In devtools, run `document.cookie` → `nn_csrf` appears, `nn_access_token` and `nn_refresh_token` do **not**. That absence is spec §3.1 departure 1 working.
4. Sign out → the header returns to its anonymous state, and a reload keeps it that way.
5. Sign in as `admin@demo.in` with `Password123!` → succeeds with `role: admin`.
6. Sign in with a wrong password → the form shows "Invalid email or password."

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/http.ts frontend/src/features/auth frontend/vite.config.ts
git commit -m "feat(frontend): replace mock auth with cookie-backed API session"
```

## Task 29: Milestone 2 verification

**Files:**
- Create: `README.md`
- The three frontend test files this task used to modify are already done — see the note below.

**`frontend/.env.development` cannot be committed**, and this is not a gitignore bug to work around.
Root `.gitignore` matches `.env.*`, so Step 7's `git add` would silently skip it, and forcing it past
the rule with `-f` would commit a working environment file — the exact problem this repo's ignore
rules exist to prevent. It is safe to leave uncommitted: `http.ts` defaults `VITE_API_URL` to the
same `/api/v1` the file sets, so a fresh clone behaves identically without it. **The README must say
the file is optional in dev and why**, or the next developer will assume the setup is broken.

- [x] **Steps 1 and 2 are already done, differently and better — do not redo them**

This task originally called for a global `vi.stubGlobal("fetch", …)` in `frontend/src/test/setup.ts`,
defaulting every mounted route to "not signed in", plus per-test overrides.

**Task 28 built something better and it is already committed.** `frontend/src/test/auth-api.stub.ts`
exports `installAuthStub(options)`, which each route test file installs explicitly and which returns
its own teardown. It models the real auth surface rather than a blanket 401: an optional pre-existing
session, a set of known accounts, correct wrong-password behaviour, and — the part a global stub
would have missed — it **sets or clears the `nn_csrf` cookie to match**, because a browser holding a
session holds all three cookies together. Since `http.ts` now skips the refresh attempt when that
cookie is absent, a stub that ignored it would put the client in a state no browser is ever in.

`setup.ts` therefore stays as it is — one line importing the jest-dom matchers.

**Do not add a global `fetch` stub.** It would shadow the explicit one, apply to files that never
asked for it, and make a test that forgot to install a stub pass anyway — for the wrong reason. If a
future route test needs auth, it should call `installAuthStub`, and the failure when it forgets
should be loud.

Both route test files already use it, and `frontend` is at **140 passing tests** across 6 files.

- [ ] **Step 3: Run every suite**

```bash
npm run build -w @nutwala/shared
npm run test -w @nutwala/shared
npm run typecheck -w backend && npm run lint -w backend && npm run test -w backend
npm run test:integration -w backend
npm run typecheck -w frontend && npm run lint -w frontend && npm run test -w frontend
npm run build
```

Expected: all pass. If the frontend suite fails on a missing export, fix the export rather
than the assertion.

- [ ] **Step 4: Write the README**

Cover: prerequisites (Node 22, Docker), the port-5432 conflict with the user's existing
Homebrew Postgres 14 and how to resolve it, **the requirement to run
`npm run build -w @nutwala/shared` once before the first `npm run dev`** (the frontend and
backend resolve the package through `dist/`, which does not exist on a fresh clone, so the first
`npm run dev` would otherwise race shared's first watch-build), `npm install`, `cp .env.example backend/.env` plus
generating `JWT_SECRET` with `openssl rand -base64 48`, `npm run db:up`,
`npm run migration:run`, `npm run seed`, `npm run dev`, the three seeded logins and their
shared development password, how to run each test suite, and the note that `backend/.env` is
gitignored and must never be committed.

- [ ] **Step 5: Verify a clean clone works**

In a scratch directory, clone the repo, then follow the README exactly. This is definition-of-done item 11, and it is the step that catches a missing migration, an unseeded setting, or an undocumented environment variable.

Expected: a running store at `http://localhost:5173` where you can sign in as `b2c@demo.in`.

- [ ] **Step 6: Confirm no secret is committed**

```bash
git grep -nE '(BEGIN [A-Z ]*PRIVATE KEY|sk_live|AKIA[0-9A-Z]{16})' -- . && echo "SECRET FOUND" || echo "clean"
git ls-files | grep -E '(^|/)\.env$' && echo "ENV COMMITTED" || echo "clean"
```

Expected: `clean` from both. This is the check that keeps the CUG/Gateway `.env` problem out of this repo.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/test README.md
git commit -F - <<'MSG'
test(frontend): stub the API in route tests and document local setup

MSG
```

Use the heredoc form, not `-m`. A commit message written with `-m "..."` and a backtick in
it has already had words silently executed and deleted by zsh in this repo.

---

## Definition of done for Plan 1

1. `npm run build` passes across `shared`, `backend` and `frontend` under `strict: true`.
2. `npm run lint` and `npm run format:check` pass in `backend` and `frontend`.
3. `npm run test -w @nutwala/shared` passes — **55** tests covering money, GST rounding and the order-status machine. (An earlier version of this list said 36; the suite grew as the constants did.)
4. `npm run test -w backend` passes — unit tests for env, redaction, envelope, password, token, sessions, mapper, auth and CSRF.
5. `npm run test:integration -w backend` passes against testcontainers Postgres with the **real migration chain** applied — health, schema invariants and auth.
6. `npm run test -w frontend` passes — the Phase 1 suite, updated for HTTP auth, with no assertion weakened.
7. ~~The migration chain applies to an empty database and reverts cleanly.~~ **VERIFIED** — full
   round trip against a throwaway Postgres 15: apply (2 migrations, 34 tables), revert both, then
   re-apply, ending on 34 tables, 9 check constraints and 18 enum types. After the revert only
   TypeORM's own `migrations` table remained and **zero enum types leaked**, which is the part a
   hand-written `down()` most often misses — a dropped table leaves its `CREATE TYPE` behind, and
   the next `migration:run` then fails on "type already exists" rather than on anything informative.

   Method worth reusing: `NODE_ENV=test DB_PORT=… DB_PASSWORD=… npm run migration:run`. Without
   `NODE_ENV=test` the exported variables are ignored, because `load-env.ts` applies dotenv with
   `override: true` and `.env` wins — so the command silently targets the dev database instead.
8. The seeder is idempotent and loads 27 products, 216 variants, 216 inventory rows, 216 opening ledger rows, 12 categories, 8 posts, 14 reviews, 6 orders, 3 users, 3 addresses and 15 settings.
9. `SUM(inventory_transactions.delta)` agrees with `inventory.on_hand` for every variant.
10. Register, sign in, reload, and sign out all work in the browser against Postgres.
11. `document.cookie` in the browser shows `nn_csrf` and **neither** `nn_access_token` nor `nn_refresh_token`.
12. Login returns a byte-identical `message`, `code` and `statusCode` for **all three** failure paths — unknown email, wrong password, and a deactivated account — and the unknown-email path still performs a real bcrypt comparison so it does not answer measurably faster. Assert the whole `getResponse()` object, not just the message: `GlobalExceptionFilter` reads that, and a difference in `details` would leak just as well as a difference in wording.
13. Logout makes a still-unexpired access token stop working, proven by a test.
14. Presenting a rotated refresh token revokes the whole session family, **and N simultaneous presentations of one token yield exactly one success** — the property a read-then-write `rotate` failed 19 times in 20. This one must be proven against real Postgres: the unit suite's in-memory repository fake serialises concurrent calls, so a green concurrency test there certifies nothing.
15. **Two browser tabs refreshing at once do not sign the user out.** A direct consequence of item 14 done correctly: the loser's family revoke kills the winner's new session, and the frontend's in-flight promise is per-tab, so nothing currently prevents it. Open two tabs, let both pass the access cookie's twenty minutes, act in both, and confirm the session survives. If it does not, fix it in the client — see the note on `refreshInFlight` in Task 28. Do **not** relax the reuse check.
16. `POST` without `X-CSRF-Token` is refused with `CSRF_TOKEN_INVALID`.
17. A registration carrying `role: "admin"` is rejected with 400.
18. No `.env` is tracked by git and no secret matches the scan in Task 29 Step 6.
19. A fresh clone reaches a working, signed-in store by following the README alone.
20. A password longer than 72 bytes is rejected rather than silently truncated by bcrypt.

## What Plan 1 deliberately leaves undone

These are Plan 2's opening tasks, listed so their absence is not mistaken for an oversight:

- Every seam module except `features/auth/api/` still reads from `src/mocks/`. The mocks folder is **not** deleted yet.
- `SOLD OUT` does not render anywhere. `Variant.available` exists and is seeded, but no component reads it — Phase 1 never had a sold-out state to modify.
- Cart, checkout, orders, addresses and profile are unchanged and still use localStorage or sessionStorage.
- `config/settings.ts` still holds hardcoded defaults; the seeded `Setting` rows are not served yet.
- `/admin/*` does not exist. `RolesGuard` is wired and tested, but no admin route uses it yet.
- Reviews, RFQs, blog and support have entities and seed data but no endpoints.
