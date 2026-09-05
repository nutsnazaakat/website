import type {
  AdminCategory,
  AdminCoupon,
  AdminCouponChannel,
  AdminCouponScope,
  AdminCouponType,
  Paginated,
} from "@/contract";
import { ApiRequestError, http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The coupons seam — brief §36's nine levers. `GET`/`POST`/`PATCH`/`DELETE /admin/coupons`.
 *
 * **Addressed by `code`, not by uuid, and the code is immutable.** Spec §6.4 spells these
 * `/admin/coupons/:id`; the shipped controller takes `:code`, and it is right to. Three things key
 * on the code — `orders.couponCode` snapshots it as the permanent record of which coupon an order
 * used, the audit trail records it as the entity id, and this screen's URL uses it — so a rename
 * would orphan all three. `UpdateCouponDto` is `PartialType(OmitType(CreateCouponDto, ['code']))`:
 * the field is not merely discouraged, it is not accepted.
 *
 * The server upper-cases and trims a code on the way in, exactly as `CouponService.preview` does,
 * so `/admin/coupons/save10` and `/admin/coupons/SAVE10` address one row.
 *
 * **Money is rupees.** `flatValue`, `minOrderValue` and `maxDiscount` arrive converted and are sent
 * back as rupees — `@IsNumber({ maxDecimalPlaces: 2 })` on every one. Nothing here converts.
 */

export const COUPON_TYPES: readonly AdminCouponType[] = ["percent", "flat"];
export const COUPON_SCOPES: readonly AdminCouponScope[] = ["all", "category"];
export const COUPON_CHANNELS: readonly AdminCouponChannel[] = ["all", "retail", "bulk"];

export interface CouponListQuery {
  /** `AdminCouponQueryDto` accepts this as `true`/`false`; anything else is a 400. */
  isActive?: boolean;
  page?: number;
  limit?: number;
}

/** `AdminCouponQueryDto`'s `@Min(1) @Max(60)`. */
export const COUPONS_PAGE_SIZE = 24;

export function fetchCoupons(
  query: CouponListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminCoupon>> {
  return http.get<Paginated<AdminCoupon>>(`/admin/coupons${toQueryString({ ...query })}`, signal);
}

/**
 * The whole coupon, as `CreateCouponDto` accepts it.
 *
 * Every optional field is `| null` as well as optional, because the two mean different things to
 * `PATCH`: `null` clears a value, an absent key leaves it unchanged. The server's own docblock is
 * explicit that "an omitted field is left unchanged".
 */
export interface CouponInput {
  type: AdminCouponType;
  percentValue?: number | null;
  flatValue?: number | null;
  minOrderValue?: number | null;
  maxDiscount?: number | null;
  appliesTo?: AdminCouponScope;
  categoryId?: string | null;
  channel?: AdminCouponChannel;
  firstOrderOnly?: boolean;
  usageLimit?: number | null;
  usageLimitPerUser?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  isActive?: boolean;
}

export function createCoupon(code: string, input: CouponInput): Promise<AdminCoupon> {
  return http.post<AdminCoupon>("/admin/coupons", { code, ...input });
}

/** `code` is deliberately not a parameter of the body: `UpdateCouponDto` omits it. */
export function updateCoupon(code: string, input: Partial<CouponInput>): Promise<AdminCoupon> {
  return http.patch<AdminCoupon>(`/admin/coupons/${encodeURIComponent(code)}`, input);
}

/**
 * `DELETE /admin/coupons/:code` — a **hard** delete, answering 204.
 *
 * Refused with `409 ENTITY_IN_USE` once the coupon has been redeemed, because
 * `coupon_redemptions.coupon_id` is `ON DELETE RESTRICT` and redemption history is meant to outlive
 * the campaign. The server counts the redemptions *before* attempting the delete precisely so the
 * operator gets an instruction rather than a 500 naming a Postgres constraint. See
 * `redemptionsBlocking`.
 */
export function deleteCoupon(code: string): Promise<void> {
  return http.delete<void>(`/admin/coupons/${encodeURIComponent(code)}`);
}

/**
 * The number of redemptions standing in the way of a delete, or `null` when this is not that
 * refusal.
 *
 * **A refusal here is a normal case to render, not an error to hide.** `details` carries
 * `{ code, redemptions }`, and the count is the whole point: "this coupon has been used 14 times"
 * tells an operator that switching it off is the operation they actually want, where "delete
 * failed" tells them the console is broken.
 *
 * `0` is not a possible answer — the server only raises this when the count is above zero — so a
 * `null` return unambiguously means "some other error".
 */
export function redemptionsBlocking(error: unknown): number | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code !== "ENTITY_IN_USE" || error.status !== 409) return null;

  const redemptions = error.details?.["redemptions"];
  return typeof redemptions === "number" ? redemptions : null;
}

/**
 * `GET /admin/categories`, read here only to fill the category picker on a `category`-scoped
 * coupon.
 *
 * **Deliberately not a shared `features/categories/api/` module**, though `/categories` is a screen
 * of its own being built in parallel by plan 9.6b's other group. Two branches creating one file at
 * the same path is a merge conflict on a file neither has seen the other's version of; one extra
 * `http.get` is not. The consolidation — this function moving to that module once both have landed
 * — is a two-line change somebody can make in daylight, and is noted here so it is not forgotten.
 *
 * Unpaginated, matching the endpoint: the category list is a fixed navigation surface, not a
 * growing collection.
 */
export function fetchCategoryOptions(signal?: AbortSignal): Promise<AdminCategory[]> {
  return http.get<AdminCategory[]>("/admin/categories", signal);
}
