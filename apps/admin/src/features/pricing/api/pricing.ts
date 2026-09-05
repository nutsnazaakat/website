import type {
  AdminBusinessSummary,
  AdminPricingTier,
  CustomerSegment,
  Paginated,
} from "@/contract";
import { ApiRequestError, http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The B2B pricing seam — brief §31, spec §6.4's `GET`/`POST`/`PATCH /admin/pricing-tiers`.
 *
 * **There is no `DELETE` and none should be added.** §6.4 lists exactly three verbs, and
 * `AdminPricingTiersService` records the gap rather than inventing the route. The consequence is
 * visible on the screen: a rung created against the wrong product is fixed by *moving* it —
 * `productId` is on the PATCH shape deliberately, and moving one re-runs the overlap check against
 * the destination ladder.
 *
 * **Money is rupees on the wire and in the body.** `pricePerKg: 720` is ₹720 per kilo;
 * `pricePerKgPaise` is the column, and `CreatePricingTierDto`'s own comment says the request body is
 * the same spec §8 boundary read the other way. Nothing here converts.
 *
 * **`null` is a value, not an absence, in two places.** `pricePerKg: null` is brief §47's
 * quote-required slab — `CatalogService.quotePreview` answers `quoteRequired: true` for it — and
 * `maxKg: null` is brief §16's open-ended "50kg+" top slab. The DTO uses `@ValidateIf` rather than
 * `@IsOptional()` for exactly this: `@IsOptional()` treats `null` as absent and would accept the
 * value while discarding it, leaving no way to declare a slab quote-only at all.
 */

/**
 * `?businessId=none` is a **sentinel**, and the only one on this endpoint.
 *
 * A query string has no null: `businessId=` is the empty string and `businessId=null` is four
 * characters. `none` is refused by `@IsUUID` so the DTO checks it first and the service translates
 * it, and it earns its cost because "which rungs belong to nobody in particular" cannot be asked
 * without it. `AdminProductQueryDto` records the mirror-image decision — `all` is *not* a sentinel
 * there — for the same reason.
 */
export const BUSINESS_NONE = "none";

export interface PricingTierListQuery {
  productId?: string;
  segment?: CustomerSegment;
  /** A business uuid, or `none` for the rungs scoped to no business. */
  businessId?: string;
  page?: number;
  limit?: number;
}

/** `AdminPricingTierQueryDto`'s `@Min(1) @Max(60)`, and the service's `DEFAULT_LIMIT`. */
export const PRICING_PAGE_SIZE = 24;

export function fetchPricingTiers(
  query: PricingTierListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminPricingTier>> {
  return http.get<Paginated<AdminPricingTier>>(
    `/admin/pricing-tiers${toQueryString({ ...query })}`,
    signal,
  );
}

/**
 * A rung's fields, derived from the contract shape rather than restated.
 *
 * **MOQ is not here and is not missing.** Brief §31 lists it, and `products.moqKg` is where it
 * lives — already editable through `PATCH /admin/products/:id`. A second writer would be a second
 * answer to "what is the minimum for this product", so the screen points at the product instead.
 */
export interface PricingTierInput extends Pick<
  AdminPricingTier,
  "productId" | "minKg" | "maxKg" | "pricePerKg"
> {
  segment?: CustomerSegment;
  /**
   * Brief §31's customer-specific pricing, or absent for a segment ladder every business in that
   * band resolves.
   *
   * **A business-scoped rung is resolved by `businessId` alone, whatever its `segment`** —
   * `resolveTiers`' first rung filters on the business and never looks at the band. So a
   * `default`-segment rung scoped to a business is a legitimate row ("this business also gets
   * ordinary list pricing"), and the overlap check groups business rungs by business rather than by
   * band.
   */
  businessId?: string | null;
}

const TIER_FIELDS = ["productId", "minKg", "maxKg", "pricePerKg", "segment", "businessId"] as const;

/**
 * `null` is preserved; only `undefined` is dropped. The distinction is the whole point of this
 * resource — see the module docblock — so the usual "skip falsy" shortcut would silently turn a
 * quote-required slab into a validation failure for a missing `pricePerKg`.
 */
function tierBody(input: Partial<PricingTierInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of TIER_FIELDS) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/** `POST /admin/pricing-tiers` — 201, answering the rung it created. */
export function createPricingTier(input: PricingTierInput): Promise<AdminPricingTier> {
  return http.post<AdminPricingTier>("/admin/pricing-tiers", tierBody(input));
}

/** `PATCH /admin/pricing-tiers/:id` — an omitted field is left unchanged, and a request that
 * changes nothing writes no audit row. */
export function updatePricingTier(
  id: string,
  input: Partial<PricingTierInput>,
): Promise<AdminPricingTier> {
  return http.patch<AdminPricingTier>(
    `/admin/pricing-tiers/${encodeURIComponent(id)}`,
    tierBody(input),
  );
}

/**
 * The rung that blocked a write, read off a `409 PRICING_TIER_OVERLAP`.
 *
 * **This refusal is a normal case to render, not an error to report.** Two rows covering one
 * quantity make `resolveTiers`' answer depend on row order, and the resolved rate is snapshotted
 * onto order items — so an overlap is a money disagreement rather than a display one, and the
 * server refuses it under a `FOR UPDATE` lock on the product so two operators cannot each pass the
 * check on a ladder without the other's row.
 *
 * `details` carries `{ conflictingTierId, conflictingMinKg, conflictingMaxKg, minKg, maxKg }`,
 * measured from `AdminPricingTiersService.assertLadderIsWritable`. Every field is narrowed rather
 * than asserted — `details` is `Record<string, unknown>` because its shape depends on `code` — so a
 * server that sent something else degrades to the bare message instead of rendering `undefined` at
 * an operator.
 */
export interface TierOverlap {
  message: string;
  conflictingTierId: string | null;
  conflictingMinKg: number | null;
  /** `null` is the open-ended top slab, which is exactly the rung most likely to be in the way. */
  conflictingMaxKg: number | null;
}

function numberOrNull(details: Record<string, unknown> | undefined, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function pricingTierOverlap(error: unknown): TierOverlap | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code !== "PRICING_TIER_OVERLAP" || error.status !== 409) return null;

  const id = error.details?.["conflictingTierId"];
  return {
    message: error.message,
    conflictingTierId: typeof id === "string" ? id : null,
    conflictingMinKg: numberOrNull(error.details, "conflictingMinKg"),
    conflictingMaxKg: numberOrNull(error.details, "conflictingMaxKg"),
  };
}

/**
 * The business picker's options — `GET /admin/businesses`, read here as a **lookup**.
 *
 * Declared in this module rather than in a `features/businesses/` seam on purpose: brief §31's
 * customer-specific pricing needs a business by name (nobody types a uuid), while the
 * `/businesses` *screen* is plan 9.6b Group B's and owns the endpoint's list semantics. One `GET`
 * declared where it is used beats reaching across into another group's module for a single call.
 *
 * Capped at the endpoint's own ceiling of 60. The screen says so when there are more, rather than
 * silently offering a truncated list as if it were everybody.
 */
export const BUSINESS_OPTIONS_LIMIT = 60;

export function fetchBusinessOptions(
  signal?: AbortSignal,
): Promise<Paginated<AdminBusinessSummary>> {
  return http.get<Paginated<AdminBusinessSummary>>(
    `/admin/businesses${toQueryString({ limit: BUSINESS_OPTIONS_LIMIT })}`,
    signal,
  );
}
