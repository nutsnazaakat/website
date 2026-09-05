import type { AdminReview, Paginated, ReviewStatus } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The moderation seam — brief §27. `GET /admin/reviews`, `POST /:id/approve`, `POST /:id/reject`.
 *
 * **There is no "all statuses" read, and that is the endpoint's shape rather than an omission.**
 * `AdminReviewsService.list` always filters on exactly one status and defaults to `pending`, so an
 * omitted parameter is the pending queue and not everything. The screen therefore offers three
 * choices, never "All" — an option that quietly returned only pending rows would be worse than no
 * option at all.
 *
 * The queue is ordered **oldest first**, unlike every other admin list, because a moderation queue
 * is worked from the front.
 */

export const REVIEW_STATUSES: readonly ReviewStatus[] = ["pending", "approved", "rejected"];

const STATUS_LOOKUP: ReadonlySet<string> = new Set<string>(REVIEW_STATUSES);

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && STATUS_LOOKUP.has(value);
}

export function parseReviewStatus(value: unknown): ReviewStatus | undefined {
  return isReviewStatus(value) ? value : undefined;
}

export interface ReviewListQuery {
  status?: ReviewStatus;
  productSlug?: string;
  page?: number;
  limit?: number;
}

/** `AdminReviewQueryDto`'s `@Min(1) @Max(60)`. */
export const REVIEWS_PAGE_SIZE = 24;

export function fetchReviews(
  query: ReviewListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminReview>> {
  return http.get<Paginated<AdminReview>>(`/admin/reviews${toQueryString({ ...query })}`, signal);
}

/**
 * `POST /admin/reviews/:id/approve` — **this is what puts the review on the storefront.**
 *
 * It also moves the product's public rating: `products.ratingAvg` and `reviewCount` are computed
 * from approved rows only, and the recompute runs in the same transaction. So approving is not a
 * display flag, it is a change to a number shoppers see on the product card.
 *
 * A second approve writes nothing at all — not the recompute, not an audit row — because a trail
 * showing two approvals of one review would read as two moderators disagreeing.
 *
 * Answers 200 with the whole re-read review. Addressed by uuid (`ParseUUIDPipe`).
 */
export function approveReview(id: string): Promise<AdminReview> {
  return http.post<AdminReview>(`/admin/reviews/${encodeURIComponent(id)}/approve`, {});
}

/**
 * `POST /admin/reviews/:id/reject` — the review stays in the database and off the storefront.
 *
 * `reason` is optional and is **for the next moderator, not for the customer**: nothing renders it
 * to the author. `@MaxLength(200)`.
 *
 * Rejecting a review that had been approved removes its rating from the public average, in the same
 * transaction — the mirror of approving.
 */
export function rejectReview(id: string, reason?: string): Promise<AdminReview> {
  return http.post<AdminReview>(
    `/admin/reviews/${encodeURIComponent(id)}/reject`,
    reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() },
  );
}
