import type { Review as WireReview, ReviewStatus } from '@nutwala/shared';
import { ReviewStatus as ReviewStatusEnum } from '../../../entities/enums';
import type { Review } from '../../../entities/content/review.entity';

/**
 * Database enum to wire vocabulary, same translation shape as roles and channels.
 *
 * **The entity import is the aliased one, not the wire type.** Every other wire/DB pair in this repo
 * is distinguished by name — `Role`/`UserRole`, `Channel`/`VariantChannel`,
 * `PaymentMethod`/`PaymentMethodEnum` — so the bare name always means the wire vocabulary and every
 * mapper imports both without ceremony. `ReviewStatus`/`ReviewStatus` is the one colliding pair, and
 * aliasing the entity keeps that rule intact: inside the file whose whole job is keeping the two
 * apart, the uppercase enum never answers to the bare name.
 *
 * The mismatch is compiler-caught either way — `'APPROVED'` is not assignable to `'approved'` — so
 * this is about which reading is harder to misread, not about correctness.
 */
const TO_WIRE_STATUS: Record<ReviewStatusEnum, ReviewStatus> = {
  [ReviewStatusEnum.PENDING]: 'pending',
  [ReviewStatusEnum.APPROVED]: 'approved',
  [ReviewStatusEnum.REJECTED]: 'rejected',
};

export function toWireReview(review: Review): WireReview {
  return {
    id: review.id,
    // `productSlug` is a non-null snapshot column: a review survives its product being deleted
    // (`product_id` is `ON DELETE SET NULL`), so the slug is what identifies what was reviewed.
    productSlug: review.productSlug,
    author: review.author,
    rating: review.rating,
    body: review.body,
    // Spread rather than `imageUrl: review.imageUrl ?? undefined`, because the wire type declares
    // `imageUrl?: string` and an explicit `undefined` serialises as a present key with a null value.
    ...(review.imageUrl ? { imageUrl: review.imageUrl } : {}),
    verifiedPurchase: review.verifiedPurchase,
    status: TO_WIRE_STATUS[review.status],
    createdAt: review.createdAt.toISOString(),
  };
}
