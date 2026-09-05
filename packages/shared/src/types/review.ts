/**
 * Brief §27. A customer rating with an optional photo, held behind admin moderation.
 *
 * The wire values stay lowercase to match what the Phase 1 frontend already types and renders,
 * exactly as `Role` does for `b2c`/`b2b`/`admin`. The database enum is `PENDING`/`APPROVED`/
 * `REJECTED` (spec §5.1); the backend maps between them in one place, the review mapper, as
 * `UserMapper` does for roles.
 *
 * Note that the database enum is *also* called `ReviewStatus` (`backend/src/entities/enums.ts`).
 * Every other wire/database pair in this repo is disambiguated by name — `Role`/`UserRole`,
 * `Channel`/`VariantChannel`, `PaymentStatus`/`PaymentStatusEnum` — so `user.mapper.ts` can import
 * both without ceremony. This one cannot: the name is fixed on the wire side by the frontend
 * modules that already export it, so the mapper must alias the entity import
 * (`import { ReviewStatus as ReviewStatusEnum }`) rather than the other way round. Aliasing the
 * wire type instead would leave the uppercase enum answering to the bare name inside a file whose
 * job is to keep the two apart.
 */
export type ReviewStatus = 'approved' | 'pending' | 'rejected';

/**
 * A customer review. Moved out of `frontend/src/features/reviews/types.ts` because the server now
 * produces it.
 */
export interface Review {
  id: string;
  productSlug: string;
  author: string;
  /** Whole stars, 1–5. */
  rating: number;
  body: string;
  /** Absent until a review carries a photo. */
  imageUrl?: string;
  /** Brief §27 requires the badge; only the backend can ever legitimately set it true. */
  verifiedPurchase: boolean;
  status: ReviewStatus;
  /** ISO 8601. */
  createdAt: string;
}

/** What a visitor submits. `productSlug` comes from the route, not the form. */
export interface ReviewDraft {
  productSlug: string;
  author: string;
  rating: number;
  body: string;
  imageUrl?: string;
}

/** One row of the rating-distribution bar chart. */
export interface RatingBucket {
  stars: number;
  count: number;
  /** Share of approved reviews at this star count, 0–100, rounded. */
  percent: number;
}

export interface ReviewSummary {
  /** Mean of the approved reviews, 0 when there are none. */
  average: number;
  total: number;
  verifiedCount: number;
  /** Five buckets, five stars down to one, always present even at zero count. */
  distribution: RatingBucket[];
}
