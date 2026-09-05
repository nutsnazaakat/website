import type { AdminBusiness, AdminBusinessSummary, CustomerSegment, Paginated } from "@/contract";
import { CUSTOMER_SEGMENTS } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The businesses seam — `GET /admin/businesses` and `GET /admin/businesses/:id`. Brief §35's B2B
 * profile.
 *
 * **There is no `PATCH /admin/businesses/:id`, and this module has no write.** Backend design spec
 * §6.4 lists one; nothing implements it, which plan 9.3 recorded as a real gap. The consequence is
 * on the screen rather than hidden here: `segment` (brief §31's price band) and
 * `assignedSalespersonId` are readable and cannot be changed from this console. A form that posted
 * to a route which does not exist would answer 404 and look like a bug in the console instead of
 * the missing endpoint it is.
 *
 * **Money is rupees.** `totalSpend` arrives converted.
 */

export const SEGMENTS: readonly CustomerSegment[] = CUSTOMER_SEGMENTS;

const SEGMENT_LOOKUP: ReadonlySet<string> = new Set<string>(CUSTOMER_SEGMENTS);

/**
 * Narrowed through the contract's own tuple rather than asserted — the value arrives from the
 * address bar, and `AdminBusinessQueryDto`'s `@IsIn(CUSTOMER_SEGMENTS)` turns an invented one into
 * a 400 under `forbidNonWhitelisted` rather than an ignored filter.
 *
 * A type predicate rather than a cast, exactly as `features/orders/statuses.ts` does for an order
 * status and for the same reason: `value as CustomerSegment` would be a claim about data this app
 * did not produce.
 */
export function isSegment(value: unknown): value is CustomerSegment {
  return typeof value === "string" && SEGMENT_LOOKUP.has(value);
}

/** `undefined` for anything that is not a segment — including the empty string a cleared select emits. */
export function parseSegment(value: unknown): CustomerSegment | undefined {
  return isSegment(value) ? value : undefined;
}

/** Brief §31's four bands, spelled for an operator. `default` is list pricing, not "unset". */
export const SEGMENT_LABELS: Readonly<Record<CustomerSegment, string>> = {
  default: "Default (list pricing)",
  retailer: "Retailer",
  distributor: "Distributor",
  horeca: "HORECA",
};

export interface BusinessListQuery {
  q?: string;
  segment?: CustomerSegment;
  page?: number;
  limit?: number;
}

/** `AdminBusinessQueryDto`'s `@Min(1) @Max(60)`. */
export const BUSINESSES_PAGE_SIZE = 24;

export function fetchBusinesses(
  query: BusinessListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminBusinessSummary>> {
  return http.get<Paginated<AdminBusinessSummary>>(
    `/admin/businesses${toQueryString({ ...query })}`,
    signal,
  );
}

export function fetchBusiness(id: string, signal?: AbortSignal): Promise<AdminBusiness> {
  return http.get<AdminBusiness>(`/admin/businesses/${encodeURIComponent(id)}`, signal);
}
