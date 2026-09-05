/**
 * Re-export shim. The definitions moved to `shared/src/types/review.ts` in this plan, because the
 * server now produces these shapes and both sides must compile against one contract. Components keep
 * importing from here, so no call site changed.
 */
export type {
  RatingBucket,
  Review,
  ReviewDraft,
  ReviewStatus,
  ReviewSummary,
} from "@/contract";
