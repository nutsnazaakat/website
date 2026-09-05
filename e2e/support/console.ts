import { expect, type Locator, type Page } from '@playwright/test';
import { consoleOrigin } from './env';

export async function visitConsole(page: Page, path: string): Promise<void> {
  await page.goto(`${consoleOrigin}${path}`);
}

/**
 * One dashboard card's figure.
 *
 * Read from the `title` attribute rather than the rendered text: money cards render through
 * `inrCompact` (₹83.5K), and every card carries the exact figure as its title precisely so the
 * shortened form is never the only place the number exists. The counts use Indian digit grouping,
 * so the separators come out before parsing.
 */
export async function dashboardCard(page: Page, label: string): Promise<number> {
  const card = page
    .getByRole('list', { name: 'Dashboard cards' })
    .getByRole('listitem')
    .filter({ has: page.getByText(label, { exact: true }) });

  const title = await card.locator('span[title]').getAttribute('title');
  const digits = (title ?? '').replace(/[^\d.]/g, '');
  return Number(digits);
}

/** The page frame's status badge, which is where the console states the order's current status. */
export const consoleStatusBadge = (page: Page): Locator => page.locator('header');

/**
 * One legal step of the retail ladder, driven from the buttons the contract's own transition table
 * produces, and confirmed by the status the page frame then reports.
 */
export async function advanceOrderStatus(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: `Mark ${label}` }).click();
  await expect(consoleStatusBadge(page).getByText(label, { exact: true })).toBeVisible();
}

/** A row of `/inventory`, found by its SKU cell. */
export function inventoryRow(page: Page, sku: string): Locator {
  return page
    .getByRole('table', { name: 'Stock, most urgent first' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: sku, exact: true }) });
}

/** The columns of `/inventory`, in the order `inventory/index.tsx` declares them. */
export const STOCK_COLUMN = {
  sku: 0,
  product: 1,
  pack: 2,
  onHand: 3,
  reserved: 4,
  available: 5,
  threshold: 6,
  position: 7,
} as const;

export function stockCell(page: Page, sku: string, column: keyof typeof STOCK_COLUMN): Locator {
  return inventoryRow(page, sku).getByRole('cell').nth(STOCK_COLUMN[column]);
}

async function readStockCell(
  page: Page,
  sku: string,
  column: keyof typeof STOCK_COLUMN,
): Promise<number> {
  const text = await stockCell(page, sku, column).innerText();
  return Number(text.replace(/[^\d-]/g, ''));
}

export async function openStockRow(page: Page, sku: string): Promise<void> {
  await visitConsole(page, `/inventory?status=all&q=${encodeURIComponent(sku)}`);
  await expect(inventoryRow(page, sku)).toBeVisible();
  await page.getByRole('button', { name: `Adjust ${sku}` }).click();
  await expect(page.getByRole('table', { name: `Stock movements for ${sku}` })).toBeVisible();
}

/**
 * Moves a pack's stock to exactly `target` **available**, through the console's own adjustment form.
 *
 * The form takes a signed delta rather than an absolute figure, on purpose — `stock-panel.tsx` says
 * why: an adjustment is a movement, and a movement has a size and a reason. So the delta is
 * computed from what the screen currently reports, which also means this helper asserts the
 * starting figure it reasoned about rather than assuming the seed.
 */
export async function setAvailableStock(
  page: Page,
  sku: string,
  target: number,
  reason: string,
): Promise<void> {
  await openStockRow(page, sku);

  const available = await readStockCell(page, sku, 'available');
  const delta = target - available;
  expect(delta, `${sku} is already at ${String(target)} available`).not.toBe(0);

  await page.getByLabel('Change (packs)', { exact: true }).fill(String(delta));
  await page.getByLabel('Reason', { exact: true }).fill(reason);
  await page.getByRole('button', { name: 'Record adjustment' }).click();

  await expect(stockCell(page, sku, 'available')).toHaveText(String(target));
}

/** The stock ledger rows for one pack, newest first — the table's own caption says so. */
export function ledgerRow(page: Page, sku: string, index: number): Locator {
  return page
    .getByRole('table', { name: `Stock movements for ${sku}` })
    .locator('tbody tr')
    .nth(index);
}

/** The columns of the stock ledger, in the order `stock-panel.tsx` declares them. */
export const LEDGER_COLUMN = {
  when: 0,
  movement: 1,
  change: 2,
  balance: 3,
  reason: 4,
  admin: 5,
} as const;

export function ledgerCell(
  page: Page,
  sku: string,
  index: number,
  column: keyof typeof LEDGER_COLUMN,
): Locator {
  return ledgerRow(page, sku, index).getByRole('cell').nth(LEDGER_COLUMN[column]);
}
