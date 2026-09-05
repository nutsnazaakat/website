# Nuts & Nazaakat — API (`apps/api`)

NestJS 11 + TypeORM + Postgres. Cookie sessions (`nn_access_token`, `nn_refresh_token`, `nn_csrf`),
prefix `/api/v1`, Swagger at `/api-docs`. **Port 4400.**

Run from the **monorepo root** — that checkout owns Docker, migrations, seeds, and the Playwright
suite:

```bash
npm run db:up
npm run migration:run
npm run seed
npm run dev:api
```

`.env` lives in **this directory** (`apps/api/.env`). Copy from the repo-root `.env.example`. See
the root [README](../../README.md) and [docs/runbook.md](../../docs/runbook.md).

`@nutwala/shared` is the compiled workspace package (`packages/shared/dist`). Jest maps it to
source so unit tests do not need a rebuild.

```bash
npm test -w @nutwala/api              # unit, no database
npm run test:integration -w @nutwala/api   # real Postgres testcontainer
```
