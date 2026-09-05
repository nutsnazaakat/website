# Nuts & Nazaakat

Dry-fruits and gifting shop: retail (B2C) and bulk (B2B). One checkout — storefront, operator
console, NestJS API, Postgres, and the shared wire contract.

```
apps/web          Customer storefront          http://localhost:5173
apps/admin        Operator console             http://localhost:5174
apps/api          NestJS API                   http://localhost:4400
packages/shared   @nutwala/shared (wire types)
e2e/              Playwright journeys
docs/             Runbook, known issues, specs
```

Both front-ends proxy `/api` to `:4400` in development, so the browser sees one origin and `SameSite`
cookies behave as they will in production.

## Setup

**Prerequisites:** Node 22+, npm 10+, Docker with Compose v2.

```bash
npm install                          # also builds packages/shared via `prepare`
cp .env.example apps/api/.env        # skip if apps/api/.env already exists
# paste a fresh JWT_SECRET into apps/api/.env if you generated one:
#   openssl rand -base64 48

npm run db:up                        # postgres :5442, postgres-test :5443
npm run migration:run
npm run seed
npm run dev                          # api + storefront + admin
```

| Check | URL |
| --- | --- |
| API health | http://localhost:4400/api/v1/health |
| Swagger | http://localhost:4400/api-docs (`docs` / `replace_me`) |
| Storefront | http://localhost:5173 |
| Console | http://localhost:5174 |

**Seeded accounts** (password `Password123!` for all; `seedUsers` refuses `NODE_ENV=production`):

| Email | Role |
| --- | --- |
| `b2c@demo.in` | Retail customer |
| `b2b@demo.in` | Business customer |
| `admin@demo.in` | Operator |

`apps/api/.env` is gitignored. Add new variables to `.env.example` as well.

## Ports

| Port | What |
| --- | --- |
| **4400** | API (`/api/v1`, Swagger at `/api-docs`) |
| **5173** | Storefront |
| **5174** | Admin console |
| **5442** | Development Postgres (`docker-compose.yml`) |
| **5443** | Scratch Postgres on tmpfs — nothing automated uses it |

Integration tests start their **own** Postgres testcontainer. They do not use 5442. E2E uses the
seeded database on 5442.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | Shared watch + API + storefront + admin |
| `npm run dev:api` / `dev:web` / `dev:admin` | One process |
| `npm run db:up` / `db:down` | Start / stop Postgres. `down` keeps the volume |
| `npm run migration:run` | Apply migrations (`DB_MIGRATIONS_RUN=false` on purpose) |
| `npm run seed` | Reseed. `npm run seed -- catalog` for one domain |
| `npm test` | Shared + API unit + storefront + admin (no Docker) |
| `npm run test:integration` | API + real Postgres testcontainer |
| `npm run test:e2e` | Playwright across all three apps |
| `npm run typecheck` / `lint` / `build` | All workspaces |

⚠️ **`npm run seed -- catalog` wipes admin-edited pricing tiers** and resets stock. See
[docs/runbook.md](docs/runbook.md).

## The API contract

`packages/shared` is the only definition of money (paise), GST, status machines, and request /
response types. The API consumes the compiled package (`dist/`). The two front-ends import the
**TypeScript source** through a Vite/tsconfig alias `@/contract` → `packages/shared/src`.

Do not re-declare those types in either app. Do not point Vite at `packages/shared/dist` — a linked
CommonJS build rendered blank pages in dev last time this was a monorepo.

Change types in `packages/shared/src`. The API picks them up after `npm run build -w @nutwala/shared`
(or the `shared` watcher started by `npm run dev`). Front-ends see source immediately.

## Apps

- **[apps/web](apps/web)** — catalogue, cart, COD checkout, account, wishlist, B2B bulk / RFQ.
- **[apps/admin](apps/admin)** — 22 operator routes. Separate origin on purpose (spec §7.1).
- **[apps/api](apps/api)** — NestJS, TypeORM, cookie sessions + CSRF.

Further reading: [docs/runbook.md](docs/runbook.md), [docs/known-issues.md](docs/known-issues.md).
