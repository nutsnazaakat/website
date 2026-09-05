/**
 * Display formatting for the operator console.
 *
 * **Money on the wire is rupees, not paise.** Backend design spec §8: every monetary column is
 * `bigint` paise *in the database*, and `toRupees` converts once at the mapper boundary — so
 * `AdminOrderSummary.total` is already `1020.85`, and `AdminDashboardCards.totalSales` is already
 * `83492.55`. Confirmed against the running service on 2026-08-27. The contract's own
 * `types/admin.ts` says so in its header ("**Money is rupees**, per spec §8"), and `money.ts`'s
 * `toPaise`/`toRupees` are therefore **not** for this app to call on a response: passing an
 * already-rupee figure through `toRupees` would divide it by a hundred a second time.
 *
 * That is the whole reason this file exists rather than a `/100` at a call site.
 */

/**
 * A rupee amount with Indian digit grouping (₹1,00,000 — not ₹100,000).
 *
 * Paise are shown only when there are any. An order list where every row reads `₹1,020.00` wastes
 * three characters per row on information the operator does not have; one that reads `₹1,020.85`
 * where it matters keeps the exception visible. `maximumFractionDigits: 2` with
 * `minimumFractionDigits: 0` does exactly that.
 */
export function inr(rupees: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * A rupee amount shortened for a dashboard card — ₹83.5K, ₹1.2Cr.
 *
 * Indian units, not Western ones: an operator reading a sales figure thinks in lakh and crore, and
 * `Intl`'s `notation: "compact"` with `en-IN` produces "T" for thousand and does not know crore at
 * all. The exact figure is still available: every card renders this with the full amount as its
 * `title`.
 */
export function inrCompact(rupees: number): string {
  const abs = Math.abs(rupees);
  if (abs >= 10_000_000) return `₹${trimZero(rupees / 10_000_000)}Cr`;
  if (abs >= 100_000) return `₹${trimZero(rupees / 100_000)}L`;
  if (abs >= 1_000) return `₹${trimZero(rupees / 1_000)}K`;
  return inr(rupees);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** A plain count with Indian digit grouping. */
export function count(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

/**
 * An ISO-8601 instant as a date and time an operator can read.
 *
 * **Rendered in the browser's own timezone, deliberately.** Plan 9.4 made the *business* timezone
 * a server-side setting and applies it to every dated admin figure — `salesOverTime`'s day buckets
 * and `GET /admin/orders`' `from`/`to` bounds are both resolved in `Asia/Kolkata` before they reach
 * this app. Those are already-bucketed calendar days and must not be re-derived here. An order's
 * `placedAt`, by contrast, is a genuine instant with no bucketing applied, so formatting it locally
 * is not undoing anything — and an operator sitting in the business's timezone, which is the case
 * this app is built for, sees the same wall clock either way.
 */
export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Just the date part of an instant. */
export function dateOnly(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * A `YYYY-MM-DD` day label for a chart axis.
 *
 * Takes the string apart rather than constructing a `Date`, and that is the point.
 * `new Date("2026-08-21")` parses as **midnight UTC**, so an operator west of Greenwich would see
 * every bar shifted to the previous day — undoing exactly the server-side business-timezone
 * bucketing that plan 9.4 introduced. `AdminSalesPoint.date` is already the business's calendar
 * day; the only correct thing to do with it is read it, not reinterpret it.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function businessDay(date: string): string {
  const [, month, day] = date.split("-");
  const index = Number(month) - 1;
  const name = MONTHS[index];
  if (day === undefined || name === undefined) return date;
  return `${day} ${name}`;
}

/**
 * A wire status like `out-for-delivery` as brief §33 writes it: "Out for Delivery".
 *
 * The brief's own spellings are normative and the wire vocabulary is derived from them, so this is
 * a presentation transform of a value that is already correct — never a second vocabulary. A
 * lookup table keyed by status would be exactly the second definition spec §7.1 forbids, and would
 * silently render an unmapped status as blank.
 */
export function statusLabel(status: string): string {
  return status
    .split("-")
    .map((word) => (word === "for" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
