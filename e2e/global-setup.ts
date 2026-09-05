import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { repoRoot } from './support/env';
import { ensureSignedIn } from './support/sessions';

/**
 * Reseed, then sign in once per role.
 *
 * **The reseed happens before the run, not after.** `orders.seed.ts` deletes and re-inserts each
 * seeded order's items, events and payments, and `catalog.seed.ts` resets every `inventory.onHand`
 * to its opening figure — so a suite that tidied up afterwards would still be handing the *next*
 * run whatever the last one left behind at the moment it crashed. Seeding first is what makes a
 * journey's preconditions true rather than probable.
 *
 * It runs against the **development** database on 5442 (`npm run db:up`), deliberately. The
 * integration suite's testcontainer is a fresh, empty, randomly-mapped Postgres per invocation;
 * a browser journey needs a real, migrated, seeded, long-lived one, and that is the dev container.
 *
 * Playwright starts the three servers before this file runs — `webServer` is a plugin, and plugin
 * setup precedes `globalSetup` — so the sign-ins below have somewhere to sign in to.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.NUTWALA_E2E_SKIP_SEED !== '1') {
    execFileSync('npm', ['run', 'seed'], { cwd: repoRoot, stdio: 'inherit' });
  }

  const browser = await chromium.launch();
  try {
    await ensureSignedIn(browser, 'customer');
    await ensureSignedIn(browser, 'business');
    await ensureSignedIn(browser, 'admin');
  } finally {
    await browser.close();
  }
}
