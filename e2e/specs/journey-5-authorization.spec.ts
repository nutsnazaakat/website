import type { APIRequestContext } from '@playwright/test';
import { visitConsole } from '../support/console';
import { apiBase, consoleOrigin } from '../support/env';
import { expect, test } from '../support/fixtures';
import { visitStorefront } from '../support/storefront';

/**
 * Spec §14 journey 5, and §13's "privilege escalation" row.
 *
 * **Two assertions, and they are not the same assertion.**
 *
 * The console refusing to render for a retail customer is **user experience**. `_console.tsx` says
 * so in its own docblock — "the guard here is UX, not security" — and it is: the check runs in the
 * browser, against a role the browser was told, and a tampered client can flip it. What it buys is
 * that a customer who follows a link to the console gets a sentence instead of nine cards of error
 * states. Nothing is protected by it.
 *
 * The **403 is the control.** `RolesGuard` is registered globally and reads the role off the signed
 * access token, never off a header or a body field, so it refuses the request whatever the client
 * believes about itself. That is why the second half of this journey leaves the browser behind and
 * asks the API directly, carrying the customer's own session cookies — first through the console's
 * own `/api` proxy, which is exactly the request the console would have made on their behalf, and
 * then straight at `:4400`, so the refusal cannot be mistaken for something a front-end did.
 *
 * A future reader who removes the redirect will not have removed the security boundary; a future
 * reader who removes the `@Roles(UserRole.ADMIN)` will have removed all of it. The two steps below
 * are labelled so that reader cannot confuse them.
 *
 * **Two controls guard against a hollow pass.** A 403 proves nothing on its own — an unroutable URL,
 * a dead session or a broken console would all fail to return data just as convincingly. So the
 * same URL is asked with the *admin's* session and must answer 200, and the customer's *own* orders
 * route is asked with the customer's session and must answer 200 too. The refusal is therefore
 * about this account and these routes, and about nothing else.
 *
 * **Nothing here signs anybody out.** The refusal screen offers "Sign out and use another account",
 * and clicking it would revoke server-side the very session `global-setup.ts` minted and every
 * other journey reuses — costing a login against a limit of five per fifteen minutes. Its presence
 * is asserted; it is deliberately not pressed.
 */

/** Every one of these is `@Roles(UserRole.ADMIN)` at the class, and every one has a root `@Get()`. */
const ADMIN_ROUTES = [
  '/admin/orders',
  '/admin/customers',
  '/admin/rfqs',
  '/admin/support/tickets',
  '/admin/dashboard',
] as const;

/** `GlobalExceptionFilter`'s `ApiError` shape, and whether the body carried a `data` key at all. */
interface Envelope {
  success: unknown;
  statusCode: unknown;
  message: unknown;
  carriesData: boolean;
}

function envelopeOf(body: unknown): Envelope | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  return {
    success: record['success'],
    statusCode: record['statusCode'],
    message: record['message'],
    carriesData: 'data' in record,
  };
}

/** `RolesGuard` throws Nest's own `ForbiddenException`, so the message is the guard's own words. */
const REFUSAL = 'You do not have permission to perform this action.';

async function refusalFor(api: APIRequestContext, url: string): Promise<Envelope> {
  const response = await api.get(url);
  expect(
    response.status(),
    `${url} answered ${String(response.status())}. A 401 would mean the session had lapsed rather than been refused`,
  ).toBe(403);

  const envelope = envelopeOf(await response.json());
  expect(envelope, `${url} answered with no JSON envelope`).not.toBeNull();
  if (envelope === null) throw new Error('unreachable — asserted above');
  return envelope;
}

test('Journey 5 — a customer is shown the door, and the server is what closes it', async ({
  customerPage,
  adminPage,
}) => {
  await test.step('the customer holds a perfectly good session', async () => {
    /*
     * Also the step that keeps the 403 below a 403.
     *
     * The access cookie lives fifteen minutes and this suite can run longer than that, so a raw API
     * call on a stale context would be answered 401 — "your session lapsed" — rather than 403,
     * which is a different fact about a different thing. Loading a storefront page first repairs
     * that in the browser, because `lib/http.ts` refreshes on a 401 and retries, and the rotated
     * cookies land in this context.
     */
    await visitStorefront(customerPage, '/account');
    await expect(customerPage.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    await expect(customerPage.getByText('Signed in as Asha Rao.')).toBeVisible();
  });

  await test.step('the console will not render for them — this is UX, not the control', async () => {
    await visitConsole(customerPage, '/');

    await expect(
      customerPage.getByRole('heading', {
        level: 1,
        name: 'This account cannot use the admin console.',
      }),
    ).toBeVisible();

    // Named, because "not authorised" without a name leaves somebody holding two accounts with no
    // idea which one they used — which is the most likely way to arrive here at all.
    await expect(customerPage.getByText('Asha Rao')).toBeVisible();
    await expect(customerPage.getByText('(b2c@demo.in)')).toBeVisible();
    await expect(customerPage.getByText('retail customer')).toBeVisible();

    // They are *not* signed out: a 403 means "this account cannot", not "your session expired".
    await expect(customerPage.getByText('Your session is valid')).toBeVisible();
    await expect(
      customerPage.getByRole('button', { name: 'Sign out and use another account' }),
    ).toBeVisible();

    // None of the console is on the page — not a disabled copy of it, none of it.
    await expect(customerPage.getByRole('navigation', { name: 'Console' })).toHaveCount(0);
    await expect(customerPage.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  });

  await test.step('the control: the API refuses that session with 403', async () => {
    for (const route of ADMIN_ROUTES) {
      // Through the console's own `/api` proxy: byte for byte the request the console would have
      // made on their behalf, from the origin it would have made it from.
      const proxied = await refusalFor(customerPage.request, `${consoleOrigin}/api/v1${route}`);
      expect(proxied.success).toBe(false);
      expect(proxied.statusCode).toBe(403);
      expect(proxied.message).toBe(REFUSAL);
      // The refusal carries no `data` key at all, so there is nothing to read past the status.
      expect(proxied.carriesData, `${route} answered a refusal carrying data`).toBe(false);
    }

    // And with both front-ends out of the way, so the 403 cannot be credited to a dev server.
    const direct = await refusalFor(customerPage.request, `${apiBase}/admin/orders`);
    expect(direct.message).toBe(REFUSAL);
  });

  await test.step('the route is not simply broken — the admin gets 200 on the same URL', async () => {
    // Loaded first for the same reason as the customer's `/account` above: an expired access cookie
    // would answer 401 and prove nothing about roles.
    await visitConsole(adminPage, '/');
    await expect(adminPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    const response = await adminPage.request.get(`${consoleOrigin}/api/v1/admin/orders`);
    expect(response.status()).toBe(200);
    const envelope = envelopeOf(await response.json());
    expect(envelope?.success).toBe(true);
    expect(envelope?.carriesData).toBe(true);
  });

  await test.step('and the customer can still read their own orders', async () => {
    // The refusal is about admin routes and this account, not about a session that stopped working.
    const response = await customerPage.request.get(`${consoleOrigin}/api/v1/account/orders`);
    expect(response.status()).toBe(200);
    expect(envelopeOf(await response.json())?.success).toBe(true);
  });
});
