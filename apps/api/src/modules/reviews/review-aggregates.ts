import type { EntityManager } from 'typeorm';

/**
 * Recomputes `products.ratingAvg` and `products.reviewCount` from **approved** rows only.
 *
 * A plain exported function rather than a method, so `ReviewsService` (a customer submitting a
 * review) and `AdminReviewsService` (a moderator approving or rejecting one) run the identical
 * statement. Extracted in plan 9.4 for exactly that reason: moderation is the *other* half of the
 * lifecycle that moves these columns, and a second copy of the SQL is how the star rating on a
 * product card comes to disagree with the histogram beneath it.
 *
 * **Approved-only is the whole point.** A pending review must not move the public star rating, or a
 * single unmoderated one-star submission drops a product's rating before anyone has read it. It is
 * also why approving is not merely a status flip: an approval *adds* a rating to the average and a
 * rejection *removes* one that had been counted while the review sat approved. Both directions run
 * through here.
 *
 * `content.seed.ts` computes the same figures the same way, so a seeded database and a moderated
 * one cannot disagree.
 *
 * Takes the caller's `EntityManager`, always, so the recompute commits or rolls back with the
 * status change that caused it — the same contract `AuditLogService.record` states, for the same
 * reason: a rating that no longer matches the reviews behind it is worse than a stale one, because
 * it gets trusted.
 */
export async function recomputeProductReviewAggregates(
  manager: EntityManager,
  productId: string,
): Promise<void> {
  await manager.query(
    `
      UPDATE products p
         SET "ratingAvg" = COALESCE(agg.avg_rating, 0),
             "reviewCount" = COALESCE(agg.review_count, 0)
        FROM (
          SELECT ROUND(AVG(r.rating)::numeric, 2) AS avg_rating,
                 COUNT(*)                          AS review_count
            FROM reviews r
           WHERE r.product_id = $1 AND r.status = 'APPROVED'
        ) agg
       WHERE p.id = $1
      `,
    [productId],
  );
}
