import type { AdminReview } from '@nutwala/shared';
import type { Review } from '../../../entities/content/review.entity';
import { toWireReview } from './review.mapper';

/**
 * `Review` to `AdminReview` — the storefront shape plus the moderation trail.
 *
 * **Built on `toWireReview` rather than beside it**, per spec §5a: `AdminReview extends Review`, so
 * the body, rating, image and `verifiedPurchase` badge a moderator judges are produced by the one
 * function that produces them for a shopper. A second mapper would be the first place the two could
 * disagree about what a moderator was approving — including the `imageUrl` spread, which
 * `review.mapper.ts` handles specially because an explicit `undefined` serialises as a present key
 * with a null value.
 *
 * `moderatedByUserId` is exposed and `moderatedByUser` is not: the name behind it is a lookup the
 * console can make once for a page, and putting an admin's name on a review row would be the first
 * step towards it reaching a customer-facing shape by inheritance.
 */
export function toAdminReview(review: Review): AdminReview {
  return {
    ...toWireReview(review),
    userId: review.userId,
    moderatedByUserId: review.moderatedByUserId,
    moderatedAt: review.moderatedAt?.toISOString() ?? null,
    rejectionReason: review.rejectionReason,
  };
}
