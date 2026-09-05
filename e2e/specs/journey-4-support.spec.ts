import { customerAddress } from '../support/accounts';
import { consoleStatusBadge, visitConsole } from '../support/console';
import { detailValue } from '../support/details';
import { expect, test } from '../support/fixtures';
import { visitStorefront } from '../support/storefront';

/**
 * Spec §14 journey 4, and §11's support queue.
 *
 * **The ticket number is `ST-`, not `SUP-`.** Spec §11 writes "a `SUP-2026-NNNNNN` number";
 * `TICKET_NUMBER_PATTERN` in `shared/src/constants/identifiers.ts` is `/^ST-\d{4}-\d{6,}$/` and
 * `formatTicketNumber` produces `ST-2026-000123`. The code is the contract — the console's route is
 * addressed by it and a unique index enforces it — so the spec is what is wrong here, and this is
 * the same class of error journeys 1 and 2 recorded about the status ladder.
 *
 * **The order link is soft, and the journey checks what the server does not.** `SupportTicket`
 * carries `orderNumber` as the string the customer typed, with no foreign key and no lookup: a
 * ticket is created whether or not the number names a real order, because a desk that cannot take a
 * message about a mistyped order number is worse than one that shows an unresolvable reference. So
 * the console is asserted to carry the number through, *and* the number is then opened as an order —
 * which is the part no code guarantees and the part an operator actually relies on.
 *
 * **Reopening clears the resolution stamp, and that is deliberately not the blog's rule.**
 * `resolvedAtFor` in `admin-support-tickets.service.ts` stamps on entering `resolved`, clears on
 * leaving it for an open state, and keeps it on `resolved -> closed`; `publishedAt` on a post is
 * stamp-once-never-clear. The two are asserted here in one journey because the difference is only
 * visible when both directions are walked, and a "time to resolve" report reads this column.
 *
 * **`POST /contact` is five per hour per IP** (`SupportTicketsController`), so this journey can run
 * five times an hour and no more. The submit below asserts the response status rather than only the
 * screen, so the sixth run in an hour reports a 429 by name instead of a locator that timed out.
 */

/** A seeded retail order belonging to `b2c@demo.in`, restored by the reseed before every run. */
const ORDER = 'NN-2026-005107';

/** One of `CONTACT_TOPICS`; `CreateContactMessageDto` validates with `@IsIn`, so it is not free text. */
const TOPIC = 'An order I have placed';

const MESSAGE =
  'The tracking page says out for delivery but nobody has arrived. Could you check with the courier?';

const NOTE = 'E2E journey 4 — rang the courier, redelivery booked for tomorrow morning.';

/** `TICKET_NUMBER_PATTERN`, as the confirmation screen renders it. */
const TICKET_NUMBER = /^ST-\d{4}-\d{6}$/;

/** `dateTime()` in the console's `format.ts` — `27 Aug 2026, 14:03`. A stamp, whatever the clock. */
const A_TIMESTAMP = /\d{2}\s\w{3}\s\d{4}/;

/** The `{ success, data: { ticketNumber } }` envelope `POST /contact` answers with, defensively. */
function ticketNumberIn(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const ticketNumber = (data as { ticketNumber?: unknown }).ticketNumber;
  return typeof ticketNumber === 'string' ? ticketNumber : null;
}

test('Journey 4 — a support query becomes a ticket the desk works and resolves', async ({
  customerPage,
  adminPage,
}) => {
  let ticketNumber = '';

  await test.step('the customer sends a message about an order they placed', async () => {
    await visitStorefront(customerPage, '/contact');
    await expect(customerPage.getByRole('heading', { level: 1, name: 'Talk to us' })).toBeVisible();

    const form = customerPage.getByRole('form', { name: 'Contact form' });
    await form.getByLabel('Your name', { exact: true }).fill(customerAddress.fullName);
    await form.getByLabel('Email', { exact: true }).fill('b2c@demo.in');
    await form.getByLabel('Mobile number (optional)', { exact: true }).fill(customerAddress.phone);
    await form.getByLabel('What is this about?', { exact: true }).selectOption(TOPIC);
    await form.getByLabel('Order number (optional)', { exact: true }).fill(ORDER);
    await form.getByLabel('Message', { exact: true }).fill(MESSAGE);

    /*
     * The response is awaited alongside the click rather than the screen alone, for two reasons.
     * `POST /contact` is throttled at 5/hour/IP and `Contact.onSubmit` turns a 429 into a sentence
     * about waiting an hour — which a locator waiting for "Message received" would report as a
     * timeout on an unrelated element. And the number the screen renders is worth comparing against
     * the one the server allocated, exactly as `placeOrder` compares the confirmation pill with the
     * path segment.
     */
    const [response] = await Promise.all([
      customerPage.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname === '/api/v1/contact' &&
          candidate.request().method() === 'POST',
      ),
      form.getByRole('button', { name: 'Send Message' }).click(),
    ]);
    expect(
      response.status(),
      'POST /contact is 5 per hour per IP — a 429 here means this journey has already run five times this hour',
    ).toBe(201);

    const allocated = ticketNumberIn(await response.json());
    expect(allocated).toMatch(TICKET_NUMBER);

    const confirmation = customerPage.getByRole('status');
    await expect(confirmation.getByRole('heading', { name: 'Message received' })).toBeVisible();
    ticketNumber = (await confirmation.getByText(TICKET_NUMBER).innerText()).trim();
    expect(ticketNumber).toBe(allocated);
  });

  await test.step('the queue shows it with its topic and the order it names', async () => {
    await visitConsole(adminPage, '/');
    await adminPage
      .getByRole('navigation', { name: 'Console' })
      .getByRole('link', { name: 'Support' })
      .click();
    await adminPage.waitForURL((url) => url.pathname === '/support');

    // Newest first — `AdminSupportTicketsService.list` orders `createdAt DESC, ticketNumber DESC` —
    // so the ticket just raised is on the first page however many earlier runs left behind.
    const row = adminPage
      .getByRole('row')
      .filter({ has: adminPage.getByRole('link', { name: ticketNumber }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(customerAddress.fullName);
    await expect(row).toContainText(TOPIC);
    await expect(row).toContainText(ORDER);
    await expect(row).toContainText('New');

    await row.getByRole('link', { name: ticketNumber }).click();
    await adminPage.waitForURL((url) => url.pathname === `/support/${ticketNumber}`);
  });

  await test.step('the ticket carries the message, the topic and the account', async () => {
    await expect(adminPage.getByRole('heading', { level: 1, name: ticketNumber })).toBeVisible();
    await expect(adminPage.getByText(MESSAGE)).toBeVisible();

    await expect(detailValue(adminPage, 'Topic')).toHaveText(TOPIC);
    await expect(detailValue(adminPage, 'Order quoted')).toContainText(ORDER);
    await expect(detailValue(adminPage, 'Name')).toHaveText(customerAddress.fullName);
    await expect(detailValue(adminPage, 'Email')).toHaveText('b2c@demo.in');
    await expect(detailValue(adminPage, 'Resolved')).toHaveText('Not resolved');

    // Raised by a signed-in customer, so the ticket is attributed to their account rather than
    // sitting as an anonymous message that happens to carry a familiar email address.
    await expect(
      detailValue(adminPage, 'Account').getByRole('link', { name: 'Open the account' }),
    ).toBeVisible();
  });

  await test.step('the number the customer typed opens a real order of theirs', async () => {
    // Nothing on the server checked this — the link is a string. So the journey does.
    await visitConsole(adminPage, `/orders/${ORDER}`);
    await expect(adminPage.getByRole('heading', { level: 1, name: ORDER })).toBeVisible();
    await expect(detailValue(adminPage, 'Name')).toHaveText(customerAddress.fullName);
    await expect(detailValue(adminPage, 'Account')).toHaveText('Registered');

    await visitConsole(adminPage, `/support/${ticketNumber}`);
    await expect(adminPage.getByRole('heading', { level: 1, name: ticketNumber })).toBeVisible();
  });

  await test.step('the desk records what it did, and the note does not move the ticket', async () => {
    const changedBefore = await detailValue(adminPage, 'Last change').innerText();

    await adminPage.getByLabel('New internal note', { exact: true }).fill(NOTE);
    await adminPage.getByRole('button', { name: 'Add internal note' }).click();

    const note = adminPage.getByRole('listitem').filter({ hasText: NOTE });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Nazaakat Admin');

    // `addNote` deliberately leaves the ticket alone: a note is a record of work, not triage. The
    // status is still `new` and `updatedAt` has not moved, which is the observable half of that.
    await expect(consoleStatusBadge(adminPage).getByText('New', { exact: true })).toBeVisible();
    await expect(detailValue(adminPage, 'Last change')).toHaveText(changedBefore);
  });

  await test.step('resolving it stamps a resolution', async () => {
    await adminPage.getByLabel('Status', { exact: true }).selectOption('resolved');
    await expect(
      consoleStatusBadge(adminPage).getByText('Resolved', { exact: true }),
    ).toBeVisible();
    await expect(detailValue(adminPage, 'Resolved')).toHaveText(A_TIMESTAMP);
  });

  await test.step('reopening it clears the stamp again — unlike a post’s publishedAt', async () => {
    await adminPage.getByLabel('Status', { exact: true }).selectOption('open');
    await expect(consoleStatusBadge(adminPage).getByText('Open', { exact: true })).toBeVisible();
    await expect(detailValue(adminPage, 'Resolved')).toHaveText('Not resolved');

    // Left resolved, because that is what the journey claims happened. The second stamp is a fresh
    // one rather than the first one restored — `resolvedAtFor` re-stamps on every entry into
    // `resolved` — which is why a reopened-and-resolved ticket reports the resolution that held.
    await adminPage.getByLabel('Status', { exact: true }).selectOption('resolved');
    await expect(detailValue(adminPage, 'Resolved')).toHaveText(A_TIMESTAMP);
  });

  await test.step('and the queue agrees it is resolved', async () => {
    await visitConsole(adminPage, '/support?status=resolved');
    const row = adminPage
      .getByRole('row')
      .filter({ has: adminPage.getByRole('link', { name: ticketNumber }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Resolved');
  });
});
