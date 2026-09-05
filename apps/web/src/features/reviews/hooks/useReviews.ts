import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reviewsApi } from "../api";
import type { ReviewDraft } from "../types";

export const reviewKeys = {
  all: ["reviews"] as const,
  list: (slug: string) => [...reviewKeys.all, "list", slug] as const,
  summary: (slug: string) => [...reviewKeys.all, "summary", slug] as const,
};

export const useProductReviews = (slug: string) =>
  useQuery({ queryKey: reviewKeys.list(slug), queryFn: () => reviewsApi.listForProduct(slug) });

export const useReviewSummary = (slug: string) =>
  useQuery({
    queryKey: reviewKeys.summary(slug),
    queryFn: () => reviewsApi.summaryForProduct(slug),
  });

/**
 * Deliberately does not invalidate the list: the created review is pending, so refetching
 * would return exactly the same approved rows and only cost a round trip. The form shows
 * its own awaiting-approval note instead.
 */
export function useCreateReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: ReviewDraft) => reviewsApi.create(draft),
    onSuccess: (created) => {
      if (created.status === "approved") {
        void qc.invalidateQueries({ queryKey: reviewKeys.all });
      }
    },
  });
}
