import path from 'node:path';

/**
 * Where everything is, and how to point the suite somewhere else.
 *
 * The E2E suite lives at the monorepo root because this is the checkout that owns the database,
 * the migrations and the seeds — and a journey is meaningless without a known seeded state.
 * Default locations are the workspace folders; every one is overridable by environment variable.
 */

/** The monorepo root: the directory holding `docker-compose.yml` and the workspace `package.json`. */
export const repoRoot = path.resolve(__dirname, '..', '..');

function workspaceDir(variable: string, relative: string): string {
  const override = process.env[variable];
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());
  return path.resolve(repoRoot, relative);
}

export const clientDir = workspaceDir('NUTWALA_CLIENT_DIR', 'apps/web');
export const adminDir = workspaceDir('NUTWALA_ADMIN_DIR', 'apps/admin');

function originFrom(variable: string, fallback: string): string {
  const override = process.env[variable];
  const value = override !== undefined && override.trim() !== '' ? override.trim() : fallback;
  return value.replace(/\/+$/, '');
}

/** The API's own origin. Both front-ends proxy `/api` here, so tests rarely address it directly. */
export const apiOrigin = originFrom('NUTWALA_API_URL', 'http://localhost:4400');
export const storefrontOrigin = originFrom('NUTWALA_STOREFRONT_URL', 'http://localhost:5173');
export const consoleOrigin = originFrom('NUTWALA_ADMIN_URL', 'http://localhost:5174');

/** `setGlobalPrefix('api/v1')` in `main.ts`. */
export const apiBase = `${apiOrigin}/api/v1`;

/**
 * Where the per-role `storageState` files live.
 *
 * Outside `test-results/`, because Playwright empties that directory at the start of every run and
 * these files are deliberately reused **across** runs: `POST /auth/login` is throttled at 5 per 15
 * minutes per IP, so a suite that re-mints a session on every run of every journey rate-limits
 * itself and then reports the 429 as though the application were broken.
 */
export const authDir = path.join(__dirname, '..', '.auth');
