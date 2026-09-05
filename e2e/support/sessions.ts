import fs from 'node:fs';
import { request, type APIRequestContext, type Browser } from '@playwright/test';
import { accounts, storageStatePath, type Role } from './accounts';
import { apiBase, authDir, consoleOrigin, storefrontOrigin } from './env';

/**
 * One sign-in per role, per machine — not per test, and not even per run when it can be helped.
 *
 * `POST /auth/login` carries `@Throttle({ default: { limit: 5, ttl: 900_000 } })`: five attempts
 * per fifteen minutes per IP. A suite that signs in inside each test exhausts that in one run and
 * then reports 429s that read exactly like application defects. So the session is minted once,
 * saved as a Playwright `storageState`, and every test starts from it.
 *
 * The saved state is also reused **between** runs, which is what keeps a developer looping the
 * suite from tripping the same limit — and the margin is genuinely thin: **three** roles is three
 * logins, so a cold cache spends three of the five and a second cold run inside the same quarter
 * hour would be refused. Before re-using one, `GET /auth/me` is asked whether it still works, and a
 * merely-expired access token is repaired with `POST /auth/refresh` (10 per minute, not 5 per
 * fifteen) rather than by spending a login. That repair is the whole reason a warm cache costs
 * nothing: deleting `e2e/.auth/` is what makes the limit reachable.
 */

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

interface AuthMeEnvelope {
  success: boolean;
  data: { role: string } | null;
}

function readState(role: Role): StorageState | null {
  const file = storageStatePath(role);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<StorageState>;
    if (!Array.isArray(candidate.cookies) || !Array.isArray(candidate.origins)) return null;
    return { cookies: candidate.cookies, origins: candidate.origins };
  } catch {
    return null;
  }
}

function writeState(role: Role, state: StorageState): void {
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(storageStatePath(role), JSON.stringify(state, null, 2));
}

/** The wire role on the answer, or null for anything that is not a signed-in `/auth/me`. */
async function whoAmI(api: APIRequestContext): Promise<string | null> {
  const response = await api.get(`${apiBase}/auth/me`);
  if (!response.ok()) return null;
  const body: unknown = await response.json();
  const envelope = body as Partial<AuthMeEnvelope>;
  const role = envelope.data?.role;
  return typeof role === 'string' ? role : null;
}

/**
 * Whether the cached state still authenticates the expected account.
 *
 * The `origins` half of the file — the storefront's `nn.auth.v1` localStorage snapshot, which its
 * route guards read synchronously in `beforeLoad` — is carried over verbatim rather than re-derived:
 * an API request context has no localStorage of its own, so saving its state over the file would
 * strip the snapshot and leave a customer holding valid cookies bounced off `/account`.
 */
async function reuseIfLive(role: Role): Promise<boolean> {
  const cached = readState(role);
  if (cached === null) return false;

  const api = await request.newContext({ storageState: cached });
  try {
    let seen = await whoAmI(api);

    if (seen === null) {
      // An expired 15-minute access token is not an expired session: the refresh cookie lives for
      // thirty days, and rotating it costs nothing against the login limit.
      const refreshed = await api.post(`${apiBase}/auth/refresh`);
      if (!refreshed.ok()) return false;
      seen = await whoAmI(api);
    }

    if (seen !== accounts[role].wireRole) return false;

    const fresh = await api.storageState();
    writeState(role, { cookies: fresh.cookies, origins: cached.origins });
    return true;
  } finally {
    await api.dispose();
  }
}

/**
 * Signs in through the real form, so the session is exactly the one a person would get.
 *
 * Two branches, not three: the admin console and the storefront are separate applications with
 * separate sign-in screens, while `customer` and `business` are two accounts on the *same*
 * storefront form. `LoginForm` sends either of them to `/account` — only an admin is routed
 * elsewhere — so the wait below is correct for both.
 */
async function mint(browser: Browser, role: Role): Promise<void> {
  const account = accounts[role];
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (role === 'admin') {
      await page.goto(`${consoleOrigin}/login`);
      await page.getByLabel('Email').fill(account.email);
      await page.getByLabel('Password').fill(account.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    } else {
      await page.goto(`${storefrontOrigin}/login`);
      await page.getByLabel('Email').fill(account.email);
      await page.getByLabel('Password').fill(account.password);
      await page.getByRole('button', { name: 'Sign In' }).click();
      await page.waitForURL((url) => url.pathname === '/account');
    }

    writeState(role, await context.storageState());
  } finally {
    await context.close();
  }
}

export async function ensureSignedIn(browser: Browser, role: Role): Promise<void> {
  if (await reuseIfLive(role)) return;
  await mint(browser, role);
}
