import { storageStatePath } from '../support/accounts';
import {
  advanceOrderStatus,
  consoleStatusBadge,
  dashboardCard,
  visitConsole,
} from '../support/console';
import { expect, test } from '../support/fixtures';
import {
  addToCartButton,
  customerTimeline,
  ensureEmptyCart,
  fillCheckoutAddress,
  packChip,
  placeOrder,
  visitStorefront,
} from '../support/storefront';

/**
 * Spec §14 journeys 1 and 2, in one file because they are one order.
 *
 * Journey 2 is *"the admin console shows the order journey 1 placed"*, so the order number has to
 * survive from one to the other. `mode: 'serial'` is what makes that legitimate rather than a
 * hidden dependency between files: the two run in declaration order in one worker, and if journey 1
 * fails, journey 2 is reported as not run instead of failing for a reason that is not its own.
 *
 * **Journey 2's assertions are made on the customer's screen, not only the operator's.** An admin
 * page reading "Delivered" proves the admin page works. The customer's own timeline showing all
 * seven steps is what proves the two applications share one truth.
 */

const PRODUCT = {
  slug: 'w320-cashews',
  name: 'W320 Cashews',
  category: 'Cashews',
  pack: '250g',
} as const;

/**
 * The retail ladder, and it is **not** the one the milestone plan writes.
 *
 * `RETAIL_TRANSITIONS` in `shared/src/constants/order-status.ts` has `shipped -> out-for-delivery`
 * and `out-for-delivery -> delivered`; there is no `shipped -> delivered` edge, so the plan's
 * "advance confirmed → processing → packed → shipped → delivered" cannot be walked as written and
 * the server would answer 422. A fresh COD order also starts at `pending`, one step before
 * `confirmed`. Both are recorded here rather than worked around silently.
 */
const CONSOLE_LADDER = [
  'Confirmed',
  'Processing',
  'Packed',
  'Shipped',
  'Out for Delivery',
  'Delivered',
] as const;

/** The same ladder in the storefront's own wording, `features/account/status.ts`. */
const CUSTOMER_TIMELINE = [
  'Payment pending',
  'Confirmed',
  'Processing',
  'Packed',
  'Shipped',
  'Out for delivery',
  'Delivered',
] as const;

test.describe.configure({ mode: 'serial' });

test.describe('Journeys 1 and 2 — one order, seen from both applications', () => {
  let orderNumber = '';
  let ordersBefore = 0;
  let pendingBefore = 0;

  /**
   * The dashboard's figures *before* the order exists.
   *
   * The dashboard has no list of orders on it — nine cards and four charts — so "the dashboard
   * shows the new order" can only honestly mean "its counts moved by exactly one". Reading the
   * baseline here, rather than asserting some absolute number, also keeps the journey re-runnable
   * against a database that already holds the previous run's orders.
   */
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: storageStatePath('admin') });
    const page = await context.newPage();
    try {
      await visitConsole(page, '/');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      ordersBefore = await dashboardCard(page, 'Orders');
      pendingBefore = await dashboardCard(page, 'Pending Orders');
    } finally {
      await context.close();
    }
  });

  test('Journey 1 — a customer buys a pack of cashews and can track the order', async ({
    customerPage,
  }) => {
    await ensureEmptyCart(customerPage);

    await test.step('home → shop', async () => {
      await visitStorefront(customerPage, '/');
      await expect(customerPage.getByRole('heading', { level: 1 })).toContainText(
        'Premium Dry Fruits',
      );
      await customerPage.getByRole('banner').getByRole('link', { name: 'Shop', exact: true }).click();
      await expect(customerPage.getByRole('heading', { name: 'Shop dry fruits' })).toBeVisible();
    });

    await test.step('filter the shop', async () => {
      await customerPage.getByRole('button', { name: PRODUCT.category, exact: true }).click();
      await expect(customerPage).toHaveURL(/category=cashews/);

      // Spec §10.1: this filter used to be decorative and now filters real stock.
      await customerPage.getByLabel('In stock only').check();
      await expect(customerPage).toHaveURL(/inStockOnly=true/);
      await expect(customerPage.getByRole('link', { name: PRODUCT.name, exact: true }).first())
        .toBeVisible();
    });

    await test.step('product → pack size → add to cart', async () => {
      await customerPage.getByRole('link', { name: PRODUCT.name, exact: true }).first().click();
      await customerPage.waitForURL((url) => url.pathname === `/product/${PRODUCT.slug}`);
      await expect(
        customerPage.getByRole('heading', { level: 1, name: PRODUCT.name }),
      ).toBeVisible();

      await packChip(customerPage, PRODUCT.pack).click();
      await expect(packChip(customerPage, PRODUCT.pack)).toHaveAttribute('aria-pressed', 'true');

      await addToCartButton(customerPage).click();
    });

    await test.step('cart drawer → cart → checkout', async () => {
      /*
       * The drawer is already open, and nothing here opened it: `CartProvider.addRetail` calls
       * `setOpen(true)` before it writes, so adding to the cart *is* the thing that shows the
       * basket. Clicking the header's "Open cart" button here would hang — the open Radix modal
       * marks the rest of the document `aria-hidden`, so the control is not merely covered, it has
       * no role left to find.
       */
      const drawer = customerPage.getByRole('dialog');
      await expect(drawer.getByRole('heading', { name: 'Your Cart' })).toBeVisible();
      await expect(drawer.getByText(PRODUCT.name)).toBeVisible();
      await expect(drawer.getByText(PRODUCT.pack, { exact: true })).toBeVisible();

      await drawer.getByRole('link', { name: 'Proceed to Checkout' }).click();
      await customerPage.waitForURL((url) => url.pathname === '/cart');
      await expect(customerPage.getByText('1 item in your cart')).toBeVisible();

      await customerPage.getByRole('link', { name: 'Proceed to Checkout' }).click();
      await customerPage.waitForURL((url) => url.pathname === '/checkout');
      await expect(customerPage.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    });

    await test.step('address, pincode and COD', async () => {
      await fillCheckoutAddress(customerPage);

      // Only COD is offered: `settings.onlinePaymentEnabled` is false and the server answers 422
      // `PAYMENT_METHOD_UNAVAILABLE` for `online`, so the form never shows a door that is shut.
      const cod = customerPage.getByRole('radio', { name: /Cash on Delivery/ });
      await expect(cod).toBeChecked();
      await expect(customerPage.getByRole('radio')).toHaveCount(1);
    });

    orderNumber = await placeOrder(customerPage);
    expect(orderNumber).toMatch(/^NN-\d{4}-\d{6}$/);

    await test.step('the order exists and can be tracked', async () => {
      // Scoped to `main`: the site footer carries its own "Track Order" link to `/account/orders`.
      await customerPage.getByRole('main').getByRole('link', { name: 'Track Order' }).click();
      await customerPage.waitForURL((url) => url.pathname === `/account/orders/${orderNumber}`);

      await expect(
        customerPage.getByRole('heading', { level: 1, name: `Order ${orderNumber}` }),
      ).toBeVisible();
      await expect(
        customerPage.getByRole('region', { name: 'Order items' }).getByText(PRODUCT.name),
      ).toBeVisible();

      const timeline = customerTimeline(customerPage);
      await expect(timeline.getByRole('listitem')).toHaveCount(1);
      await expect(timeline.getByRole('listitem').first()).toContainText('Payment pending');
    });
  });

  test('Journey 2 — the admin fulfils it and the customer sees every step', async ({
    adminPage,
    customerPage,
  }) => {
    await test.step('the dashboard counts the new order', async () => {
      await visitConsole(adminPage, '/');
      await expect(adminPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      expect(await dashboardCard(adminPage, 'Orders')).toBe(ordersBefore + 1);
      expect(await dashboardCard(adminPage, 'Pending Orders')).toBe(pendingBefore + 1);
    });

    await test.step('/orders lists it', async () => {
      await adminPage
        .getByRole('navigation', { name: 'Console' })
        .getByRole('link', { name: 'Orders' })
        .click();
      await adminPage.waitForURL((url) => url.pathname === '/orders');

      const row = adminPage
        .getByRole('row')
        .filter({ has: adminPage.getByRole('link', { name: orderNumber }) });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Asha Rao');
      await expect(row).toContainText('B2C');
      await expect(row).toContainText('Pending');

      await row.getByRole('link', { name: orderNumber }).click();
      await adminPage.waitForURL((url) => url.pathname === `/orders/${orderNumber}`);
      await expect(adminPage.getByRole('heading', { level: 1, name: orderNumber })).toBeVisible();
    });

    await test.step('advance the whole retail ladder', async () => {
      for (const label of CONSOLE_LADDER) {
        await advanceOrderStatus(adminPage, label);
      }
      await expect(consoleStatusBadge(adminPage).getByText('Delivered', { exact: true }))
        .toBeVisible();
    });

    await test.step('record the cash the courier collected', async () => {
      const receipt = `E2E-${orderNumber}`;
      await adminPage.getByLabel('Receipt number (optional)', { exact: true }).fill(receipt);
      await adminPage.getByRole('button', { name: 'Record COD collected' }).click();

      // The control is replaced by what was actually recorded, because the endpoint is idempotent
      // and a second click would report success having written nothing.
      // `main`, because the success toast repeats the receipt number and would make this ambiguous.
      await expect(adminPage.getByRole('main').getByText('COD collected')).toBeVisible();
      await expect(adminPage.getByRole('main').getByText(receipt)).toBeVisible();
      await expect(adminPage.getByRole('button', { name: 'Record COD collected' })).toHaveCount(0);
    });

    await test.step("the customer's own tracking page reflects every step", async () => {
      await visitStorefront(customerPage, `/account/orders/${orderNumber}`);

      const timeline = customerTimeline(customerPage);
      await expect(timeline.getByRole('listitem')).toHaveCount(CUSTOMER_TIMELINE.length);
      for (const [index, label] of CUSTOMER_TIMELINE.entries()) {
        await expect(timeline.getByRole('listitem').nth(index)).toContainText(label);
      }

      // An order that has been delivered can no longer be cancelled — `nextStatuses` for retail
      // `delivered` is `['refunded']` — so the button the customer had at `pending` is gone.
      await expect(customerPage.getByRole('button', { name: 'Cancel Order' })).toHaveCount(0);

      await visitStorefront(customerPage, '/account/orders');
      const row = customerPage
        .getByRole('row')
        .filter({ has: customerPage.getByRole('link', { name: orderNumber, exact: true }) });
      await expect(row).toContainText('Delivered');
    });
  });
});
