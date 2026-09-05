import type { EntityManager } from 'typeorm';
import { Setting } from '../../entities/ops/setting.entity';

/**
 * The `settings` key holding the business's own timezone — spec §5b.
 *
 * Dotted, unlike every other key in `settings.seed.ts` (`brandName`, `codEnabled`,
 * `freeShippingThreshold`), and deliberately so. Those fifteen are the storefront's configuration:
 * they are the keys `nutwala-client`'s `src/config/settings.ts` declares, so their spelling is a
 * contract with a front-end. This one is an operational setting that no storefront ever reads
 * — it is `isPublic: false` — and the prefix says which family it belongs to before anyone has to
 * look at the flag. It is also the first of what will be several: a business address, a fiscal
 * year start and an invoice series all sit in the same space.
 */
export const BUSINESS_TIMEZONE_KEY = 'business.timezone';

/**
 * `Asia/Kolkata`, per spec §5b — the user's decision, and the only sensible default for a business
 * whose brief is written in rupees and whose pincode table is Indian.
 *
 * Used as the fallback as well as the seeded value, so a database whose `settings` table was
 * truncated behaves identically to a fresh one — the same argument `SettingsService`'s `FALLBACK`
 * makes about the payment flags.
 */
export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';

/**
 * Whether Postgres and JavaScript would both accept this as a timezone.
 *
 * `Intl.DateTimeFormat` throws `RangeError` for a name the IANA database does not have, which is
 * the cheapest complete check available without a round trip — and it matters because the value
 * reaches SQL as an `AT TIME ZONE` operand. That operand is always a **bound parameter**, never
 * interpolated, so this is not an injection guard; it is a guard against a `settings` row someone
 * typed by hand turning every dated admin figure into a 500. An unknown zone name makes Postgres
 * raise `invalid value for parameter "TimeZone"`, and a dashboard that fails is worse than a
 * dashboard that is briefly in the wrong zone.
 *
 * Anything that is not a string fails here too: `Setting.value` is `jsonb` typed `unknown`, so the
 * column can legitimately hold a number or an array, exactly as `SettingsService.payment` guards
 * against for its booleans.
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    // Constructing the formatter is what validates the zone; the instance is not needed.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The business timezone, or `Asia/Kolkata` if the row is missing or holds something unusable.
 *
 * **A plain exported function rather than a method on an injected service**, and the precedent is
 * explicit: `DashboardService` already imports `OPEN_RFQ_STATUSES` from `business-stats.service`
 * and `SQL_LOW_STOCK` from `inventory/stock-sql` on exactly this footing, and its docblock records
 * the rule — "a plain exported const, so nothing is injected and no module import is needed;
 * `CatalogService` imports `bulkTierFor` from the cart module on the same footing".
 *
 * Here it is load-bearing rather than stylistic. The two callers are `DashboardService`, which
 * lives in `AdminModule`, and `AdminOrdersService`, which lives in `OrdersModule` — and
 * `SettingsModule` **imports** `AdminModule`, because `AdminSettingsService` needs
 * `AuditLogService`. Putting this on `SettingsService` would therefore need `AdminModule` to import
 * `SettingsModule` back, which is a module cycle Nest refuses without `forwardRef`. A function that
 * takes the caller's own manager has no module to belong to and no cycle to create.
 *
 * It takes an `EntityManager` for the same reason `AuditLogService.record` does: the caller already
 * has one, and a reader that opened a connection of its own could observe a different snapshot from
 * the query whose days it is grouping.
 *
 * **One query per request that needs it, deliberately uncached.** The alternative — a process-level
 * cache — would mean an operator changing the timezone in one browser tab and seeing the old
 * grouping in another for an unpredictable interval, on precisely the figure they had just gone to
 * fix. A single-row primary-key lookup against a fifteen-row table is not the cost worth optimising
 * against that.
 */
export async function businessTimezone(manager: EntityManager): Promise<string> {
  const row = await manager
    .getRepository(Setting)
    .findOne({ where: { key: BUSINESS_TIMEZONE_KEY } });
  return isValidTimezone(row?.value) ? row.value : DEFAULT_BUSINESS_TIMEZONE;
}

/**
 * Whether a `?from` / `?to` bound is a bare calendar date rather than an instant.
 *
 * This is the distinction that decides whether a bound gets the business timezone at all, and it is
 * the narrower of the two readings on purpose. `?from=2026-08-27T00:00:00.000Z` names a moment, and
 * a caller who sent one means it — reinterpreting it in IST would move a bound the client had
 * already resolved, and would break any console that computes its own ranges. `?from=2026-08-27`
 * names a **day**, and a day only exists in some timezone: until now it silently meant a UTC day,
 * so an IST operator asking for the 27th lost the first five and a half hours of it.
 *
 * Anchored, so `2026-08-27T00:00` does not match: `@IsISO8601` has already refused anything that is
 * not a valid ISO-8601 string, so what reaches here is either a full instant or exactly this.
 */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
