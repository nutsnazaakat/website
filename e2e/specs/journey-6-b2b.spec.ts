import { businessProfile } from '../support/accounts';
import { consoleStatusBadge, visitConsole } from '../support/console';
import { detailValue } from '../support/details';
import { storefrontOrigin } from '../support/env';
import { expect, test } from '../support/fixtures';
import { cartTotalsAfter, ensureEmptyCart, visitStorefront } from '../support/storefront';

/**
 * Spec §14 journey 6 — the bulk track, end to end, with brief §16's slabs and §34's sales trail.
 *
 * **The point is that the price recalculates, not that a tier table renders.** A screen showing five
 * slabs proves a join. So the quantity is walked *across* a boundary twice and the money is read on
 * both sides of it, each time from two independent places:
 *
 * - the **page's** figure, drawn by `features/bulk/pricing.ts` from the ladder
 *   `GET /catalog/products` published;
 * - the **server's** figure, from the `totals` on the `PUT /cart` the click provoked, where
 *   `CartReadService` resolves the ladder again from the database for this viewer at this weight.
 *
 * The first is what a buyer sees; the second is what they would be billed. A test that asserted only
 * the first would pass against a server that priced every weight at the base rate.
 *
 * **The second crossing has no price on purpose.** Brief §16's top slab — 50kg and over — carries a
 * null rate for every product, and `catalog.seed.ts`'s own docblock calls that null load-bearing:
 * it is what routes a large enquiry to the RFQ form. So 50 kg is where the basket stops being
 * checkout-able and starts being a quote, which is exactly the hand-off §14 describes.
 *
 * **And the privacy assertion is the reason this journey exists at all.** An RFQ carries two note
 * fields. `rfqs.notes` is the *prospect's* own "additional requirements" and is rendered back to
 * them; `rfq_notes` is the sales desk's private trail. Nothing in the database keeps them apart —
 * `RfqDetail`'s docblock says so: "keeping them off this type is the only thing standing between an
 * internal sales note and a customer's browser". So after the desk writes one, the customer's own
 * enquiry view is asserted **not** to carry it, on the screen *and* in the body of the endpoint that
 * screen reads. Confusing the two would be a privacy bug, and this is the only test that would see
 * it.
 *
 * **`POST /rfqs` is five per hour per IP** (`RfqsController`), a separate bucket from journey 4's
 * `POST /contact` because the throttler keys per handler. Five runs an hour; the submit asserts the
 * status so a sixth reports the 429 by name.
 *
 * `w240-cashews`, so nothing here touches the products journeys 1–3 buy or sell out.
 */

const PRODUCT = {
  slug: 'w240-cashews',
  name: 'W240 Cashews',
  category: 'Cashews',
  categorySlug: 'cashews',
  grade: 'W240',
} as const;

/**
 * `buildTiers(1399)` in `catalog.seed.ts` — the per-kg price of `w240-cashews` down brief §16's five
 * slabs, and `moqKg` 10 (the seeder's default), which is where the stepper opens.
 *
 * Stated as the arithmetic rather than as four literals, because the figures *are* the rule: the
 * slab multipliers are the seeder's, and a test carrying copied numbers would keep passing if the
 * seeder's ladder changed underneath it.
 */
const KG_PRICE = 1399;
const RATE = {
  base: KG_PRICE,
  tenToTwentyFour: Math.round(KG_PRICE * 0.9),
  twentyFiveToFortyNine: Math.round(KG_PRICE * 0.85),
} as const;

/** The console's and the storefront's shared `inr()`: Indian grouping, paise only when there are any. */
const inr = (rupees: number): string =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(rupees);

/** Bulk quantities move in 5 kg steps on both the catalogue and the bulk cart. */
const STEP = 5;
const OPENING_KG = 10;
const CROSSED_KG = 25;
const QUOTE_KG = 50;

/** `RFQ_NUMBER_PATTERN`, as the confirmation screen renders it. */
const RFQ_NUMBER = /^RFQ-\d{4}-\d{6}$/;

/**
 * The two notes, deliberately in plain ASCII.
 *
 * The last step asserts against the *raw text* of a JSON response, and an em dash or a curly quote
 * would make a containment check depend on how the encoder happened to escape it.
 */
const PROSPECT_NOTE =
  'E2E journey 6: 25 kg vacuum packs please, delivered before the 5th of each month.';
const INTERNAL_NOTE =
  'E2E journey 6: internal only. Buyer squeezed us on rate last quarter, hold at 5 percent.';

const PACKAGING = 'Bulk sacks (25 kg)';
const FREQUENCY = 'Monthly';

/** The `{ success, data: RfqDetail }` envelope `POST /rfqs` answers with, defensively. */
function rfqNumberIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

test('Journey 6 — a bulk enquiry, priced by slab, quoted by the desk, and the note the buyer never sees', async ({
  businessPage,
  adminPage,
}) => {
  // The basket lives on the server and survives a reseed, so a run that died mid-journey would
  // otherwise hand this one an extra line and a subtotal it did not predict.
  await ensureEmptyCart(businessPage);

  let rfqNumber = '';

  await test.step('the bulk landing page leads to the per-kg catalogue', async () => {
    await visitStorefront(businessPage, '/bulk-orders');
    await expect(
      businessPage.getByRole('heading', { level: 1, name: 'Buy Better. Buy Bigger. Pay Smarter.' }),
    ).toBeVisible();

    await businessPage.getByRole('link', { name: 'Explore Bulk Products' }).click();
    await businessPage.waitForURL((url) => url.pathname === '/bulk/all');
    await expect(businessPage.getByRole('heading', { level: 1 })).toHaveText('Bulk dry fruits');

    // Narrowed to one category so the row is on the first page of twenty-four. `main`, because the
    // header's own Categories menu offers a link with the same name.
    await businessPage
      .getByRole('main')
      .getByRole('link', { name: PRODUCT.category, exact: true })
      .click();
    await businessPage.waitForURL((url) => url.pathname === `/bulk/${PRODUCT.categorySlug}`);
  });

  const row = businessPage
    .getByRole('listitem')
    .filter({ has: businessPage.getByRole('link', { name: PRODUCT.name, exact: true }) });
  // `exact`, because `getByLabel` matches a substring by default and "Quantity for W240 Cashews"
  // sits inside both stepper buttons' own labels — "Decrease quantity for W240 Cashews" and its
  // twin — which resolves to three elements and fails in strict mode rather than reading the value.
  const quantity = row.getByLabel(`Quantity for ${PRODUCT.name}`, { exact: true });
  // `for` on the catalogue and `of` in the basket — the two components word their labels
  // differently, and one locator for both would silently match nothing on one of the screens.
  const increaseOnCatalogue = row.getByRole('button', {
    name: `Increase quantity for ${PRODUCT.name}`,
  });

  await test.step('the row opens at the minimum order quantity and its own slab rate', async () => {
    await expect(row).toBeVisible();
    await expect(row).toContainText(PRODUCT.grade);
    await expect(row).toContainText(`${String(OPENING_KG)} kg`);
    await expect(quantity).toHaveText(`${String(OPENING_KG)} kg`);

    await expect(row).toContainText(`${inr(RATE.tenToTwentyFour)} / kg`);
    await expect(row).toContainText(inr(RATE.tenToTwentyFour * OPENING_KG));
    await expect(row).toContainText(
      `You save ${inr((RATE.base - RATE.tenToTwentyFour) * OPENING_KG)}`,
    );
  });

  await test.step('crossing into the next slab recalculates the rate, the total and the saving', async () => {
    for (let kg = OPENING_KG + STEP; kg <= CROSSED_KG; kg += STEP) {
      await increaseOnCatalogue.click();
      await expect(quantity).toHaveText(`${String(kg)} kg`);
    }

    // 25 kg is the first kilo of the 25–49 slab, so this is the boundary itself and not a step
    // safely inside it.
    await expect(row).toContainText(`${inr(RATE.twentyFiveToFortyNine)} / kg`);
    await expect(row).toContainText(inr(RATE.twentyFiveToFortyNine * CROSSED_KG));
    await expect(row).toContainText(
      `You save ${inr((RATE.base - RATE.twentyFiveToFortyNine) * CROSSED_KG)}`,
    );
    // The rate it left behind is gone from the row, so this is a recalculation and not a second
    // figure rendered beside the first.
    await expect(row).not.toContainText(`${inr(RATE.tenToTwentyFour)} / kg`);
  });

  await test.step('and the server prices the same slab, which is the figure that would be billed', async () => {
    const totals = await cartTotalsAfter(businessPage, async () => {
      await row.getByRole('button', { name: 'Add to Bulk Cart' }).click();
    });

    expect(totals.subtotal).toBe(RATE.twentyFiveToFortyNine * CROSSED_KG);
    expect(totals.hasQuoteLines).toBe(false);
  });

  /*
   * Nothing touches the catalogue page after that click.
   *
   * `addBulk` calls `setOpen(true)` before it writes, so adding to the basket *is* the thing that
   * opens the cart drawer — and while that Radix modal is open the rest of the document is
   * `aria-hidden`, which means a locator for anything behind it does not fail, it hangs. Journeys 1
   * and 3 record the same trap. A navigation is not a locator, so this is safe.
   */
  await visitStorefront(businessPage, '/business/bulk-cart');

  const lines = businessPage.getByRole('region', { name: 'Bulk cart lines' });
  // A `<section aria-label>` is a `region`; the summary beside it is an `<aside aria-label>`, which
  // is a `complementary` landmark. Two roles because they are two elements, not an inconsistency.
  const summary = businessPage.getByRole('complementary', { name: 'Bulk order summary' });
  const line = lines.getByRole('row').filter({ hasText: PRODUCT.name });
  const increaseInBasket = line.getByRole('button', {
    name: `Increase quantity of ${PRODUCT.name}`,
  });

  await test.step('the bulk cart shows the slab rate and offers a checkout', async () => {
    await expect(businessPage.getByRole('heading', { level: 1, name: 'Bulk Cart' })).toBeVisible();
    await expect(line.getByLabel(`Quantity of ${PRODUCT.name}`, { exact: true })).toHaveText(
      `${String(CROSSED_KG)} kg`,
    );
    await expect(line).toContainText(PRODUCT.grade);
    await expect(line).toContainText(inr(RATE.twentyFiveToFortyNine));
    await expect(line).toContainText(inr(RATE.twentyFiveToFortyNine * CROSSED_KG));

    // A priced basket, so it is a basket: brief §18's "Quote Required instead of normal checkout"
    // has not been triggered.
    await expect(summary.getByRole('link', { name: /Proceed to Bulk Checkout/ })).toBeVisible();
    await expect(summary).not.toContainText('Quote Required');
  });

  await test.step('stepping past the published slabs turns the basket into a quote', async () => {
    const priced: number[] = [];
    let last = { subtotal: -1, hasQuoteLines: false };

    for (let kg = CROSSED_KG + STEP; kg <= QUOTE_KG; kg += STEP) {
      last = await cartTotalsAfter(businessPage, async () => {
        await increaseInBasket.click();
      });
      await expect(line.getByLabel(`Quantity of ${PRODUCT.name}`, { exact: true })).toHaveText(
        `${String(kg)} kg`,
      );
      if (kg < QUOTE_KG) priced.push(last.subtotal);
    }

    // Every weight up to 49 kg is still the 25–49 slab, re-resolved by the server on each write.
    expect(priced).toEqual([30, 35, 40, 45].map((kg) => RATE.twentyFiveToFortyNine * kg));

    // At 50 kg the resolved slab carries no rate, so the server prices nothing and says why. A
    // subtotal of zero *with* `hasQuoteLines` is the honest answer; zero on its own would read as
    // a free basket.
    expect(last.hasQuoteLines).toBe(true);
    expect(last.subtotal).toBe(0);

    await expect(line).toContainText('Quote Required');
    await expect(summary.getByRole('link', { name: /Proceed to Bulk Checkout/ })).toHaveCount(0);
  });

  await test.step('the basket hands the buyer to the enquiry form, already filled in', async () => {
    await summary.getByRole('link', { name: /Request Quote for these items/ }).click();
    await businessPage.waitForURL((url) => url.pathname === '/business/rfqs/new');

    await expect(
      businessPage.getByRole('heading', { level: 1, name: 'Request a Quote' }),
    ).toBeVisible();
    // Carried in the link as `items=w240-cashews:50`, which is what `prefillLines` parses.
    await expect(businessPage.getByLabel('Product', { exact: true })).toHaveValue(PRODUCT.slug);
    await expect(businessPage.getByLabel('Quantity (kg)', { exact: true })).toHaveValue(
      String(QUOTE_KG),
    );
  });

  await test.step('the buyer submits it and gets a real RFQ number', async () => {
    await businessPage
      .getByLabel('Business name', { exact: true })
      .fill(businessProfile.companyName);
    await businessPage
      .getByLabel('Contact person', { exact: true })
      .fill(businessProfile.contactPerson);
    await businessPage.getByLabel('Mobile number', { exact: true }).fill(businessProfile.mobile);
    await businessPage.getByLabel('Email', { exact: true }).fill(businessProfile.email);
    await businessPage.getByLabel('GSTIN (optional)', { exact: true }).fill(businessProfile.gstin);
    await businessPage
      .getByLabel('Business type', { exact: true })
      .selectOption(businessProfile.businessType);
    await businessPage
      .getByLabel('Delivery pincode', { exact: true })
      .fill(businessProfile.pincode);
    await businessPage.getByLabel('Packaging preference', { exact: true }).selectOption(PACKAGING);
    await businessPage.getByLabel('Expected frequency', { exact: true }).selectOption(FREQUENCY);
    // The prospect's own field — brief §17's "additional requirements", `rfqs.notes` on the wire.
    await businessPage
      .getByLabel('Additional requirements (optional)', { exact: true })
      .fill(PROSPECT_NOTE);

    const [response] = await Promise.all([
      businessPage.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === '/api/v1/rfqs' &&
          candidate.request().method() === 'POST',
      ),
      businessPage.getByRole('button', { name: 'Request Bulk Quote' }).click(),
    ]);
    expect(
      response.status(),
      'POST /rfqs is 5 per hour per IP — a 429 here means this journey has already run five times this hour',
    ).toBe(201);

    const allocated = rfqNumberIn(await response.json());
    expect(allocated).toMatch(RFQ_NUMBER);

    await expect(
      businessPage.getByRole('heading', { level: 1, name: 'Quote Request Submitted' }),
    ).toBeVisible();
    rfqNumber = (await businessPage.getByText(RFQ_NUMBER).innerText()).trim();
    expect(rfqNumber).toBe(allocated);
  });

  await test.step('their own enquiry view shows what they asked for, in their own words', async () => {
    await businessPage.getByRole('link', { name: 'View this request' }).click();
    await businessPage.waitForURL((url) => url.pathname === `/business/rfqs/${rfqNumber}`);

    await expect(businessPage.getByRole('heading', { level: 1, name: rfqNumber })).toBeVisible();
    // `RfqStatusBadge`'s customer-facing wording for `new`.
    await expect(businessPage.getByText('Received', { exact: true })).toBeVisible();

    const enquiryLine = businessPage.getByRole('row').filter({ hasText: PRODUCT.name });
    await expect(enquiryLine).toContainText(`${String(QUOTE_KG)} kg`);

    await expect(detailValue(businessPage, 'Business')).toHaveText(businessProfile.companyName);
    await expect(detailValue(businessPage, 'GSTIN')).toHaveText(businessProfile.gstin);
    await expect(detailValue(businessPage, 'Packaging')).toHaveText(PACKAGING);
    await expect(detailValue(businessPage, 'Additional requirements')).toHaveText(PROSPECT_NOTE);
  });

  await test.step('the desk finds it in the queue', async () => {
    await visitConsole(adminPage, '/');
    await adminPage
      .getByRole('navigation', { name: 'Console' })
      .getByRole('link', { name: 'Quote requests' })
      .click();
    await adminPage.waitForURL((url) => url.pathname === '/rfqs');

    // Searched rather than scrolled: the queue accumulates an enquiry per run, and `q` is the
    // console's own filter over the number, the company and the contact.
    await adminPage.getByLabel('RFQ number, company or contact', { exact: true }).fill(rfqNumber);
    await adminPage.getByLabel('RFQ number, company or contact', { exact: true }).press('Enter');

    const queueRow = adminPage
      .getByRole('row')
      .filter({ has: adminPage.getByRole('link', { name: rfqNumber }) });
    await expect(queueRow).toBeVisible();
    await expect(queueRow).toContainText(businessProfile.companyName);
    await expect(queueRow).toContainText(businessProfile.mobile);
    await expect(queueRow).toContainText(`${String(QUOTE_KG)} kg`);
    await expect(queueRow).toContainText('New');
    // Brief §34's two commercial fields are the desk's to set and nothing invents them.
    await expect(queueRow).toContainText('Not set');
    await expect(queueRow).toContainText('Unassigned');

    await queueRow.getByRole('link', { name: rfqNumber }).click();
    await adminPage.waitForURL((url) => url.pathname === `/rfqs/${rfqNumber}`);
  });

  await test.step('the enquiry reads the same on the desk’s side', async () => {
    await expect(adminPage.getByRole('heading', { level: 1, name: rfqNumber })).toBeVisible();
    await expect(detailValue(adminPage, 'Company')).toHaveText(businessProfile.companyName);
    await expect(detailValue(adminPage, 'Business type')).toHaveText(businessProfile.businessType);
    await expect(detailValue(adminPage, 'GSTIN')).toHaveText(businessProfile.gstin);
    await expect(detailValue(adminPage, 'Pincode')).toHaveText(businessProfile.pincode);
    await expect(detailValue(adminPage, 'Packaging')).toHaveText(PACKAGING);
    await expect(detailValue(adminPage, 'Frequency')).toHaveText(FREQUENCY);
    // Attributed to the account that raised it, not to a name that happens to match.
    await expect(
      detailValue(adminPage, 'Account').getByRole('link', { name: 'Open the account' }),
    ).toBeVisible();

    const productRow = adminPage
      .getByRole('table', { name: 'Products on this enquiry' })
      .getByRole('row')
      .filter({ hasText: PRODUCT.slug });
    await expect(productRow).toContainText(`${String(QUOTE_KG)} kg`);

    // The prospect's own text, under a heading that says whose it is. This panel is read-only:
    // there is no admin route that edits `rfqs.notes`.
    await expect(adminPage.getByText(PROSPECT_NOTE)).toBeVisible();
  });

  await test.step('the desk writes a private note and sends the quote', async () => {
    await adminPage.getByLabel('New internal note', { exact: true }).fill(INTERNAL_NOTE);
    await adminPage.getByRole('button', { name: 'Add internal note' }).click();

    const note = adminPage.getByRole('listitem').filter({ hasText: INTERNAL_NOTE });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Nazaakat Admin');

    /*
     * `new -> quote-sent` is **not** a legal move, and spec §14's wording ("adds an internal note
     * and sends a quote") skips the step that makes it one. `RFQ_TRANSITIONS` in
     * `shared/src/constants/order-status.ts`'s sibling `rfq-status.ts` allows `new -> contacted |
     * rejected` and only then `contacted -> quote-sent`, and the server answers 422 for anything
     * else — so the console offers only the legal buttons, and the desk rings the buyer before it
     * quotes them. The same class of error as journey 2's `shipped -> delivered`.
     */
    await expect(adminPage.getByRole('button', { name: 'Mark Quote Sent' })).toHaveCount(0);
    await adminPage.getByRole('button', { name: 'Mark Contacted' }).click();
    await expect(
      consoleStatusBadge(adminPage).getByText('Contacted', { exact: true }),
    ).toBeVisible();

    await adminPage.getByRole('button', { name: 'Mark Quote Sent' }).click();
    await expect(
      consoleStatusBadge(adminPage).getByText('Quote Sent', { exact: true }),
    ).toBeVisible();
  });

  await test.step('the buyer sees the quote — and never the note behind it', async () => {
    await visitStorefront(businessPage, `/business/rfqs/${rfqNumber}`);

    // One truth, two applications: the desk's move shows on the buyer's own page, in the buyer's
    // wording rather than the pipeline's.
    await expect(businessPage.getByText('Quote sent', { exact: true })).toBeVisible();
    // Their own words are still theirs.
    await expect(detailValue(businessPage, 'Additional requirements')).toHaveText(PROSPECT_NOTE);

    // **The privacy assertion.** The sales trail is a different field from the prospect's note, and
    // nothing in the database keeps them apart — only `RfqDetail`'s shape does.
    await expect(businessPage.getByText(INTERNAL_NOTE)).toHaveCount(0);
    await expect(businessPage.getByText('Internal notes')).toHaveCount(0);

    /*
     * And not merely absent from the render — absent from the wire.
     *
     * A screen assertion alone would pass against an endpoint that sent the note and a component
     * that happened not to draw it, which is one careless `JSON.stringify` in a debug panel away
     * from being visible. So the endpoint the screen reads is asked directly, with the buyer's own
     * session, and its raw body is searched. The positive half matters as much: the prospect's own
     * note *is* there, so this is not a check that passes because the response was empty.
     */
    const response = await businessPage.request.get(`${storefrontOrigin}/api/v1/rfqs/${rfqNumber}`);
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain(PROSPECT_NOTE);
    expect(body).not.toContain(INTERNAL_NOTE);
    expect(body).not.toContain('internalNotes');
    // Brief §34's other two staff-only fields, off the same type for the same reason.
    expect(body).not.toContain('assignedSalesperson');
    expect(body).not.toContain('expectedValue');
  });
});
