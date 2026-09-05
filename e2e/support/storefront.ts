import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { customerAddress } from './accounts';
import { storefrontOrigin } from './env';

/** `NN-{year}-{six digits}` — `order-number.ts`, and the only identifier a customer ever quotes. */
export const ORDER_NUMBER = /NN-\d{4}-\d{6}/;

export async function visitStorefront(page: Page, path: string): Promise<void> {
  await page.goto(`${storefrontOrigin}${path}`);
}

/**
 * The retail tab's panel on a product page.
 *
 * Scoped rather than addressed from the page root, because "You may also like" renders four more
 * `ProductCard`s at the bottom of the same document — each with its own pack chips and its own
 * **Add to Cart**. Radix unmounts the inactive tab, so exactly one `tabpanel` exists at a time.
 */
export const retailPanel = (page: Page): Locator => page.getByRole('tabpanel');

/**
 * One pack chip on a product page, by size.
 *
 * The accessible name differs by stock, deliberately, and `product.$slug.tsx` says why: an in-stock
 * chip is named by its own text — `1kg₹1,099` — while a sold-out one carries an explicit
 * `aria-label` of `1kg ₹1,099 — sold out`, so the state reaches a screen reader instead of living
 * in a strikethrough. Anchoring on the size and allowing either continuation matches both, which is
 * what lets one locator assert that a pack became unbuyable.
 */
export function packChip(page: Page, size: string): Locator {
  return retailPanel(page).getByRole('button', {
    name: new RegExp(`^${size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*₹`),
  });
}

export const addToCartButton = (page: Page): Locator =>
  retailPanel(page).getByRole('button', { name: 'Add to Cart' });

/**
 * Fills checkout's contact and delivery sections and waits for the pincode to be answered.
 *
 * The ETA line is the observable proof that `GET /checkout/pincode/:pincode` ran and said yes —
 * `CheckoutForm` renders "Enter your pincode for a delivery date." until it has an answer, and
 * "We don't deliver to … yet." when the answer is no.
 */
export async function fillCheckoutAddress(page: Page): Promise<void> {
  await page.getByLabel('Email', { exact: true }).fill('b2c@demo.in');
  await page.getByLabel('Mobile number', { exact: true }).fill(customerAddress.phone);
  await page.getByLabel('Full name', { exact: true }).fill(customerAddress.fullName);
  await page.getByLabel('Address', { exact: true }).fill(customerAddress.line1);
  await page.getByLabel('Landmark (optional)', { exact: true }).fill(customerAddress.line2);
  await page.getByLabel('City', { exact: true }).fill(customerAddress.city);
  await page.getByLabel('State', { exact: true }).selectOption(customerAddress.state);
  await page.getByLabel('Pincode', { exact: true }).fill(customerAddress.pincode);

  await expect(page.getByText(/Estimated arrival by/)).toBeVisible();
}

/**
 * Places the order and returns the real order number.
 *
 * Both sources are compared rather than one trusted: the confirmation pill renders `order.id` off
 * the placement response, while the path segment is the parameter that was navigated to. They are
 * equal by construction, and a screen that rendered a number the URL disagreed with would be the
 * exact defect `/order-success/$id`'s own docblock describes.
 */
export async function placeOrder(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Place Order' }).click();

  await page.waitForURL((url) => ORDER_NUMBER.test(url.pathname), { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Order Confirmed!' })).toBeVisible();

  const pill = await page.getByText(/^Order ID: NN-\d{4}-\d{6}$/).innerText();
  const fromPill = pill.replace('Order ID:', '').trim();

  const fromUrl = ORDER_NUMBER.exec(new URL(page.url()).pathname)?.[0];
  expect(fromUrl).toBe(fromPill);

  return fromPill;
}

/** The customer's own timeline, which is the only list on the page with an accessible name. */
export const customerTimeline = (page: Page): Locator =>
  page.getByRole('list', { name: 'Status timeline' });

/** The basket's own endpoint, as the browser sees it through each front-end's `/api` proxy. */
const CART_PATH = '/api/v1/cart';

const cartResponse = (page: Page, method: 'GET' | 'PUT'): Promise<Response> =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === CART_PATH && response.request().method() === method,
  );

/** How many lines a `{ success, data: { lines, totals } }` envelope reports, defensively. */
function linesIn(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return 0;
  const lines = (data as { lines?: unknown }).lines;
  return Array.isArray(lines) ? lines.length : 0;
}

/**
 * Leaves the signed-in customer's basket empty before a journey starts.
 *
 * The basket lives on the server and survives a reseed — `users.seed.ts` upserts accounts and never
 * touches `carts` — so a run that died between "add to cart" and "place order" would otherwise hand
 * the next run an extra line and a total it did not expect.
 *
 * **The server's answer decides, not the screen.** `CartProvider` starts with an empty `lines`
 * array and fills it when `GET /cart` returns, and `/cart` renders "Your cart is waiting for
 * something delicious." for an empty array — so the empty state is also what a *loading* basket
 * looks like, and a check that trusted it emptied nothing while reporting success. That is exactly
 * how a leftover line from one journey reached the next one's cart drawer. So the line count is
 * read off the response body, and each removal waits for the `PUT` that carried it out.
 *
 * Both line components name their button `Remove <something>`, the withdrawn-product one included,
 * so one locator empties either shape.
 */
export async function ensureEmptyCart(page: Page): Promise<void> {
  const fetched = cartResponse(page, 'GET');
  await visitStorefront(page, '/cart');
  let remaining = linesIn(await (await fetched).json());

  const remove = page.getByRole('button', { name: /^Remove / });
  while (remaining > 0) {
    const written = cartResponse(page, 'PUT');
    await remove.first().click();
    remaining = linesIn(await (await written).json());
  }

  await expect(page.getByText('Your cart is waiting for something delicious.')).toBeVisible();
}

/**
 * The server's own money for a basket, as reported by the `PUT /cart` a click provokes.
 *
 * Every bulk figure on a storefront screen is drawn by `cart-math.ts` from the tier ladder
 * `GET /catalog/products` published — the bulk cart's own docblock says so and calls its summary
 * "indicative". That makes the rendered rate proof that the *page* resolved a tier, which is not
 * the same claim as "the price recalculated". `CartReadService` resolves the ladder again from the
 * database on every write, per viewer and per weight, and answers with `totals`; that is the figure
 * an order would be billed at. Journey 6 asserts both, and this is how it reads the second.
 */
export interface ServerCartTotals {
  /** Rupees. Excludes any line the server could not price. */
  subtotal: number;
  /** True when a line resolved to a slab with no published rate — brief §16's open-ended 50kg+. */
  hasQuoteLines: boolean;
}

function serverTotalsIn(body: unknown): ServerCartTotals | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const totals = (data as { totals?: unknown }).totals;
  if (typeof totals !== 'object' || totals === null) return null;
  const { subtotal, hasQuoteLines } = totals as { subtotal?: unknown; hasQuoteLines?: unknown };
  if (typeof subtotal !== 'number' || typeof hasQuoteLines !== 'boolean') return null;
  return { subtotal, hasQuoteLines };
}

/**
 * Runs `act`, waits for the basket write it starts, and returns what the server priced.
 *
 * The response is awaited rather than the screen polled, deliberately: `CartProvider` applies an
 * optimistic basket *before* the request and replaces it with the reply, so a screen assertion
 * cannot tell the two apart, and a locator that matched the optimistic figure would pass on a write
 * the server refused.
 */
export async function cartTotalsAfter(
  page: Page,
  act: () => Promise<void>,
): Promise<ServerCartTotals> {
  const written = cartResponse(page, 'PUT');
  await act();
  const response = await written;
  const totals = serverTotalsIn(await response.json());
  if (totals === null) {
    throw new Error(
      `PUT /cart answered ${String(response.status())} with no numeric totals.subtotal`,
    );
  }
  return totals;
}
