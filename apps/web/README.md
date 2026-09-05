# Nuts & Nazaakat — Storefront (`apps/web`)

Customer shop: catalogue, cart, COD checkout, account, wishlist, blog, contact, and B2B bulk / RFQ.
Vite + React 19 + TanStack Router. **Dev port 5173.**

Run it from the **monorepo root**: `npm run dev` (or `npm run dev:web` for this app alone). The API
on `:4400` must be migrated and seeded. See the root [README](../../README.md).

Sign in: `b2c@demo.in` or `b2b@demo.in`, password `Password123!`.

`vite.config.ts` proxies `/api` to `http://localhost:4400` with `changeOrigin: false` so session
cookies (`Domain=localhost`) work.

Optional env (defaults are enough locally): `VITE_API_URL` (`/api/v1`), `VITE_ADMIN_APP_URL` (unset
in development — this app must not grow an `/admin` route; `src/test/no-admin-routes.test.ts`
enforces that).

## Contract

`import … from "@/contract"` is a Vite/tsconfig alias to `packages/shared/src`. Do not re-declare
wire types here. Do not point Vite at `packages/shared/dist` (linked CommonJS blank-page bug).

## Tests

```bash
npm test -w @nutwala/web     # component and route tests, no API needed
npm run typecheck -w @nutwala/web
npm run lint -w @nutwala/web
```

## Layout

```
src/
  routes/        TanStack Router, file-based, code-split
  features/      one directory per domain; API calls in features/<name>/api/
  components/    ui/, layout/, common/
  config/        settings.ts — still a static file (Milestone 11)
  lib/           http.ts (fetch + CSRF), format.ts (wire money is rupees)
  test/          stubs and structural suites
```

`.oxlintrc.json` forbids importing `src/mocks/*` except from `features/*/api/`, `src/mocks`, and
`src/test`.
