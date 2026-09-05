import { test as base, type Page } from '@playwright/test';
import { storageStatePath } from './accounts';

/**
 * Three browser contexts, each starting from a session minted once in `global-setup.ts`.
 *
 * No test signs in. `POST /auth/login` allows five attempts per fifteen minutes per IP, and a suite
 * that spends one per test reports 429s that look exactly like broken authentication. The customer
 * and business states also carry the storefront's `nn.auth.v1` localStorage snapshot, which
 * `guards.ts` reads synchronously in `beforeLoad` — cookies alone would leave `/account/*` and
 * `/business/*` bouncing to sign-in.
 *
 * Playwright builds a fixture only for the tests that name it, so a journey that needs one context
 * still opens one: three roles here does not mean three contexts per test.
 */
export const test = base.extend<{ customerPage: Page; businessPage: Page; adminPage: Page }>({
  customerPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStatePath('customer') });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  businessPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStatePath('business') });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  adminPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: storageStatePath('admin') });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect } from '@playwright/test';
