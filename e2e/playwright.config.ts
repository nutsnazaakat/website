import { defineConfig } from '@playwright/test';
import {
  adminDir,
  apiOrigin,
  clientDir,
  consoleOrigin,
  repoRoot,
  storefrontOrigin,
} from './support/env';

/**
 * The E2E harness for the three Nuts & Nazaakat applications.
 *
 * It lives at the monorepo root because that is the checkout that owns the database, the
 * migration chain and the seeds, and a journey against an unknown state is a journey that proves
 * nothing. The two front-ends are started from `apps/web` and `apps/admin`.
 *
 * **One worker, no parallelism.** The three journeys share one development database and one seeded
 * catalogue: journey 3 drives a pack's stock to a single unit and then buys it, which is only a
 * meaningful assertion if nothing else is buying at the same time.
 *
 * Both front-ends proxy `/api` to the backend in development, so every browser in this suite talks
 * to a single origin and `SameSite` behaves as it will in production. That is why the tests
 * navigate to `:5173` and `:5174` and almost never to `:4400`.
 */
export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',

  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,

  timeout: 180_000,
  expect: { timeout: 20_000 },

  globalSetup: require.resolve('./global-setup'),

  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],

  use: {
    // 1440×900: the storefront's header nav and the shop's filter sidebar are `md:`-and-up, and
    // the console is built for a laptop. A mobile viewport would be testing the drawer variants of
    // every one of these screens, which is a different suite.
    viewport: { width: 1440, height: 900 },
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },

  /**
   * `reuseExistingServer` everywhere: a developer usually has some of this stack up already, and
   * failing because port 5173 is taken by the thing the suite wanted there is not useful. What
   * Playwright starts, Playwright stops.
   */
  webServer: [
    {
      command: 'npm run dev -w @nutwala/api',
      cwd: repoRoot,
      url: `${apiOrigin}/api/v1/health`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: clientDir,
      url: storefrontOrigin,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      cwd: adminDir,
      url: consoleOrigin,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
