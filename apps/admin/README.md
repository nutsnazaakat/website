# Nuts & Nazaakat — Admin Console (`apps/admin`)

Operator console: dashboard, orders, catalogue, inventory, B2B pricing, customers, RFQs, coupons,
reviews, blog, support, settings, audit log. **22 routes.** Vite + React 19 + TanStack Router.
**Dev port 5174.**

A **separate origin** on purpose (spec §7.1): two apps on one origin share cookies, CSP, and
service-worker scope.

Run from the **monorepo root**: `npm run dev` (or `npm run dev:admin`). Needs the API on `:4400`,
migrated and seeded. See the root [README](../../README.md).

Sign in: `admin@demo.in` / `Password123!`.

`VITE_API_URL` is optional and defaults to `/api/v1` (the Vite `/api` proxy). Route guards on
`role === "admin"` are UX only — `RolesGuard` on the API is the real control.

## Contract

`import … from "@/contract"` aliases `packages/shared/src`. Do not re-declare wire types. Money on
the wire is **rupees**; `lib/format.ts` is the only formatter.

## Tests

```bash
npm test -w @nutwala/admin          # 22 routes + /login, no API needed
npm run test:live -w @nutwala/admin # real API; mutates the database; reseed first
```

`test:live` signs in twice per run against a 5/15-min login throttle. Restart the API to clear it.
Reseed between runs.

## Layout

```
src/
  routes/        __root, login, _console/*
  features/      one directory per domain; API calls in features/<name>/api/
  components/    ui primitives
  lib/           http.ts, format.ts
  test/          harness, live.integration.tsx
  app/           router.tsx
```

Verification records for plans 9.6a/9.6b are in `docs/`. Settings and blog edits here do not yet
reach the storefront (Milestone 11).
