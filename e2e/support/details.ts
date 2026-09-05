import type { Locator, Page } from '@playwright/test';

/**
 * Reading a value out of a `<dl>`, on either front-end.
 *
 * Both applications render real definition lists for their label/value blocks — the console's
 * `DetailList`/`Detail` pair, the storefront's "Request details" and "Gifting brief" sections — and
 * that is what makes them readable this way. A grid of `<div><span>` pairs looks identical and would
 * leave nothing to address but nth-child arithmetic.
 *
 * Its own module rather than `console.ts` or `storefront.ts`, because journey 6 needs it on both
 * sides of the same fact: the prospect's own note appears under *their* label on *their* enquiry
 * page, and the sales desk's note appears under a different one in the console. A helper that lived
 * on one surface would have to be imported into the other under a misleading name.
 */

/**
 * The value beside one label — the `<dd>` immediately following the `<dt>` that names it.
 *
 * Addressed through the `term` and `definition` roles the two elements carry in the accessibility
 * tree, which is what `<dt>` and `<dd>` inside a `<dl>` map to. `getByText(value)` alone would
 * assert only that the value is *somewhere* on a screen that may also carry other people's words,
 * and that is precisely the confusion journey 6 exists to catch.
 *
 * Anchored on the label, because these panels carry both "Topic" and "Order quoted", both "Name"
 * and "Business name" — a substring match would pick whichever came first.
 */
export function detailValue(page: Page, label: string): Locator {
  return page
    .getByRole('term')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');
}
