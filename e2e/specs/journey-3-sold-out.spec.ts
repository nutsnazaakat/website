import {
  ledgerCell,
  openStockRow,
  setAvailableStock,
  stockCell,
  visitConsole,
} from '../support/console';
import { expect, test } from '../support/fixtures';
import {
  addToCartButton,
  ensureEmptyCart,
  fillCheckoutAddress,
  packChip,
  placeOrder,
  retailPanel,
  visitStorefront,
} from '../support/storefront';

/**
 * Spec §14 journey 3, and §10.1's sold-out semantics.
 *
 * The point of this journey is the **negative** as much as the positive. A test that only checked
 * that the bought-out pack said SOLD OUT would pass just as happily if the whole product had
 * vanished from the catalogue, and it would pass if the storefront had simply stopped rendering
 * pack chips. So the other packs of the same product are asserted to still be buyable, the product
 * is asserted to still be listed under the shop's own `inStockOnly` filter, and the ledger's `SALE`
 * row is read rather than only the zero it produced — `onHand` reaching zero says the column moved,
 * the ledger row says *why*, against which order, and to what balance.
 *
 * `gurbandi-almonds`, so that nothing here touches the product journeys 1 and 2 buy.
 */

const PRODUCT = { slug: 'gurbandi-almonds', name: 'Gurbandi Almonds', category: 'almonds' } as const;

const ALL_PACKS = ['100g', '250g', '500g', '1kg'] as const;
type Pack = (typeof ALL_PACKS)[number];

/** `slugToSku` in `catalog.seed.ts`: three letters per slug word, then the pack. */
const SKU: Readonly<Record<Pack, string>> = {
  '100g': 'GURALM-100G',
  '250g': 'GURALM-250G',
  '500g': 'GURALM-500G',
  '1kg': 'GURALM-1KG',
};

/** The pack that will be bought out, and the three that must survive it. */
const SOLD_OUT_PACK: Pack = '250g';
const SOLD_OUT_SKU = SKU[SOLD_OUT_PACK];
const OTHER_PACKS: readonly Pack[] = ['100g', '500g', '1kg'];

/** `count(-1)` goes through `Intl`, which may render the sign as U+2212 rather than a hyphen. */
const MINUS_ONE = /^[-−]1$/;

test('Journey 3 — the last pack sells out, and only that pack', async ({
  adminPage,
  customerPage,
}) => {
  await ensureEmptyCart(customerPage);

  await test.step('the admin leaves one pack on the shelf', async () => {
    await setAvailableStock(
      adminPage,
      SOLD_OUT_SKU,
      1,
      'E2E journey 3 — down to the last pack on the shelf',
    );
    await expect(stockCell(adminPage, SOLD_OUT_SKU, 'available')).toHaveText('1');
    // `available (1) <= lowStockThreshold (10)`, so the console flags it before it is gone.
    await expect(stockCell(adminPage, SOLD_OUT_SKU, 'position')).toContainText('Low');
  });

  let orderNumber = '';

  await test.step('the customer buys it', async () => {
    await visitStorefront(customerPage, `/product/${PRODUCT.slug}`);
    await packChip(customerPage, SOLD_OUT_PACK).click();
    await expect(packChip(customerPage, SOLD_OUT_PACK)).toHaveAttribute('aria-pressed', 'true');
    await expect(addToCartButton(customerPage)).toBeEnabled();
    await addToCartButton(customerPage).click();

    // `addRetail` opens the drawer before it writes, so the line appearing there is the write
    // having landed. Navigating on the click alone would race the `PUT /cart` it started.
    await expect(customerPage.getByRole('dialog').getByText(SOLD_OUT_PACK, { exact: true }))
      .toBeVisible();

    await visitStorefront(customerPage, '/checkout');
    await fillCheckoutAddress(customerPage);
    orderNumber = await placeOrder(customerPage);
  });

  await test.step('SOLD OUT on that pack, and only that pack', async () => {
    await visitStorefront(customerPage, `/product/${PRODUCT.slug}`);

    const soldOut = packChip(customerPage, SOLD_OUT_PACK);
    await expect(soldOut).toBeDisabled();
    await expect(soldOut).toHaveAttribute('aria-label', /sold out/);
    // The picker never opens on a pack that cannot be bought, so the bought-out one is not selected.
    await expect(soldOut).toHaveAttribute('aria-pressed', 'false');

    for (const pack of OTHER_PACKS) {
      const chip = packChip(customerPage, pack);
      await expect(chip, `${pack} must stay buyable`).toBeEnabled();
      await expect(chip).not.toHaveAttribute('aria-label', /sold out/);
    }

    // The product itself is not sold out — one pack going is not the product going.
    await expect(addToCartButton(customerPage)).toBeEnabled();
    await expect(retailPanel(customerPage).getByText('SOLD OUT')).toHaveCount(0);

    // …and it is still on the shelf under the shop's own in-stock filter, which since Phase 2
    // filters on real stock: `EXISTS (… onHand - reserved > 0)` over the product's active variants.
    await visitStorefront(customerPage, `/shop?category=${PRODUCT.category}&inStockOnly=true`);
    await expect(
      customerPage.getByRole('link', { name: PRODUCT.name, exact: true }).first(),
    ).toBeVisible();
  });

  await test.step('the console shows zero available and the SALE row behind it', async () => {
    await openStockRow(adminPage, SOLD_OUT_SKU);

    await expect(stockCell(adminPage, SOLD_OUT_SKU, 'onHand')).toHaveText('0');
    await expect(stockCell(adminPage, SOLD_OUT_SKU, 'available')).toHaveText('0');
    await expect(stockCell(adminPage, SOLD_OUT_SKU, 'position')).toContainText('Out of stock');

    // Newest first, so the sale is row 0 and the adjustment that set up this journey is row 1.
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 0, 'movement')).toHaveText('SALE');
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 0, 'change')).toHaveText(MINUS_ONE);
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 0, 'balance')).toHaveText('0');
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 0, 'reason')).toContainText(
      `Order ${orderNumber}`,
    );
    // A sale is written by checkout on a customer's behalf, so no admin is attributed.
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 0, 'admin')).toHaveText('System');

    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 1, 'movement')).toHaveText('ADJUSTMENT');
    await expect(ledgerCell(adminPage, SOLD_OUT_SKU, 1, 'balance')).toHaveText('1');
  });

  await test.step('with every retail pack gone, Add to Cart is disabled', async () => {
    for (const pack of OTHER_PACKS) {
      await setAvailableStock(adminPage, SKU[pack], 0, 'E2E journey 3 — clear the retail shelf');
    }

    await visitStorefront(customerPage, `/product/${PRODUCT.slug}`);
    for (const pack of ALL_PACKS) {
      await expect(packChip(customerPage, pack)).toBeDisabled();
    }
    await expect(addToCartButton(customerPage)).toBeDisabled();
    await expect(retailPanel(customerPage).getByRole('button', { name: 'Buy Now' })).toBeDisabled();
  });

  await test.step('the console agrees that all four retail packs are out', async () => {
    await visitConsole(adminPage, '/inventory?status=out&q=GURALM-');
    for (const pack of ALL_PACKS) {
      await expect(stockCell(adminPage, SKU[pack], 'available')).toHaveText('0');
    }
  });
});
