import type { Review, ReviewDraft, ReviewSummary } from "@/contract";
import { http } from "@/lib/http";

const base = (slug: string): string => `/catalog/products/${encodeURIComponent(slug)}/reviews`;

/**
 * Reviews over the real API.
 *
 * The mock's `create` pushed onto the imported `reviews` array and handed back a `pending` row — so a
 * submitted review vanished on reload and the array grew for the lifetime of the tab. The server now
 * persists it as `PENDING`, which means a submission legitimately does **not** appear in the list, and
 * `useCreateReview`'s existing "only invalidate when approved" logic is correct rather than incidental.
 *
 * `summarise` is gone from here: the server owns that arithmetic now, and a second copy on the client
 * is a second answer to the same question. Anything that wants the figures reads `useReviewSummary`.
 */
export const reviewsApi = {
  listForProduct: (slug: string): Promise<Review[]> => http.get(base(slug)),
  summaryForProduct: (slug: string): Promise<ReviewSummary> => http.get(`${base(slug)}/summary`),
  create: ({ productSlug, ...draft }: ReviewDraft): Promise<Review> =>
    http.post(base(productSlug), draft),
};
