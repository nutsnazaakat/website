import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminReview, ReviewStatus } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { errorMessage } from "@/features/orders/api/errors";
import {
  approveReview,
  fetchReviews,
  parseReviewStatus,
  rejectReview,
  REVIEW_STATUSES,
  REVIEWS_PAGE_SIZE,
} from "@/features/reviews/api/reviews";
import { count, dateTime, statusLabel } from "@/lib/format";

/**
 * `/reviews` — brief §27's moderation queue.
 *
 * **Defaults to `pending`, and there is no "all" option.** `AdminReviewsService.list` always
 * filters on exactly one status, so the queue *is* the default read; an "All statuses" entry would
 * have to send nothing and would silently show pending rows under a label promising everything.
 *
 * Rendered as cards rather than a table, which is the one place this console departs from its own
 * default. A moderator's decision needs the review body — often three or four sentences — and a
 * table cell either truncates it, which hides exactly what is being judged, or makes every row
 * different heights, which is a table in name only.
 */

interface ReviewsSearch {
  status?: ReviewStatus;
  productSlug?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/reviews/")({
  validateSearch: (search: Record<string, unknown>): ReviewsSearch => {
    const status = parseReviewStatus(search["status"]);
    const productSlug = search["productSlug"];
    const page = Number(search["page"]);

    return {
      ...(status === undefined ? {} : { status }),
      // `@MaxLength(120)` on the DTO.
      ...(typeof productSlug === "string" && productSlug.trim() !== ""
        ? { productSlug: productSlug.trim().slice(0, 120) }
        : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: ReviewsScreen,
});

function ReviewsScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;
  const status = search.status ?? "pending";

  const reviews = useQuery({
    queryKey: ["reviews", search],
    queryFn: ({ signal }) => fetchReviews({ ...search, page, limit: REVIEWS_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<ReviewsSearch>) {
    void navigate({
      search: (previous: ReviewsSearch): ReviewsSearch => {
        const next: ReviewsSearch = { ...previous, ...patch };
        delete next.page;
        for (const key of ["status", "productSlug"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: ReviewsSearch): ReviewsSearch => {
        const updated: ReviewsSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const rows = reviews.data?.items ?? [];
  const total = reviews.data?.total ?? 0;

  return (
    <Page
      title="Reviews"
      description={
        reviews.data === undefined
          ? "Loading…"
          : `${count(total)} ${statusLabel(status).toLowerCase()} ${total === 1 ? "review" : "reviews"}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Queue" htmlFor="filter-status" className="w-44">
            <Select
              id="filter-status"
              value={status}
              onChange={(event) => setFilter({ status: parseReviewStatus(event.target.value) })}
            >
              {REVIEW_STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {statusLabel(candidate)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Product slug" htmlFor="filter-slug" className="w-60">
            {/* Uncontrolled, keyed on the applied value, applied on blur and Enter — the shape
                `products/index.tsx` settled. */}
            <Input
              key={search.productSlug ?? ""}
              id="filter-slug"
              maxLength={120}
              placeholder="premium-california-almonds"
              defaultValue={search.productSlug ?? ""}
              onBlur={(event) => setFilter({ productSlug: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setFilter({ productSlug: event.currentTarget.value.trim() });
                }
              }}
            />
          </Field>

          {search.productSlug !== undefined && (
            <Button
              variant="ghost"
              className="mb-0.5"
              onClick={() => setFilter({ productSlug: undefined })}
            >
              Clear product
            </Button>
          )}

          <p className="text-muted-foreground mb-1.5 ml-auto max-w-md text-right text-[11px]">
            One queue at a time — the endpoint always filters on a single status, so there is no
            &ldquo;everything&rdquo; view to offer.
          </p>
        </Panel>

        {reviews.isPending ? (
          <Panel>
            <Loading label="Loading reviews" />
          </Panel>
        ) : reviews.isError ? (
          <Panel>
            <Notice
              tone="error"
              title="Reviews could not be loaded."
              body={errorMessage(reviews.error)}
              action={
                <Button variant="outline" onClick={() => void reviews.refetch()}>
                  Try again
                </Button>
              }
            />
          </Panel>
        ) : rows.length === 0 ? (
          <Panel>
            <Notice
              title={
                status === "pending"
                  ? "Nothing waiting for moderation."
                  : `No ${statusLabel(status).toLowerCase()} reviews.`
              }
              body={
                status === "pending"
                  ? "New reviews from the storefront land here, oldest first."
                  : "Switch the queue to see the others."
              }
            />
          </Panel>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((review) => (
              <li key={review.id}>
                <ReviewCard review={review} />
              </li>
            ))}
          </ul>
        )}

        {reviews.data !== undefined && rows.length > 0 && (
          <Panel>
            <Pager
              page={page}
              total={total}
              pageSize={REVIEWS_PAGE_SIZE}
              onPage={goToPage}
              unit="review"
            />
          </Panel>
        )}

        <p className="text-muted-foreground text-[11px]">
          Approving a review publishes it on the product page{" "}
          <strong className="font-medium">and adds its rating to the public average</strong> —
          `products.ratingAvg` counts approved rows only. Rejecting keeps the review in the database
          and off the storefront, and removes its rating again if it had been approved.
        </p>
      </div>
    </Page>
  );
}

function ReviewCard({ review }: { review: AdminReview }) {
  const client = useQueryClient();
  const [reason, setReason] = useState(review.rejectionReason ?? "");
  const [rejecting, setRejecting] = useState(false);

  function settled(updated: AdminReview, verb: string) {
    void client.invalidateQueries({ queryKey: ["reviews"] });
    setRejecting(false);
    toast.success(`Review ${verb}.`);
    return updated;
  }

  const approve = useMutation({
    mutationFn: () => approveReview(review.id),
    onSuccess: (updated) => settled(updated, "approved and published"),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: () => rejectReview(review.id, reason),
    onSuccess: (updated) => settled(updated, "rejected"),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const busy = approve.isPending || reject.isPending;

  return (
    <Panel className="flex flex-col gap-3 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            <Stars rating={review.rating} />
            <span>{review.author}</span>
            {review.verifiedPurchase && (
              <ToneBadge
                tone="done"
                title="The server sets this; it cannot be claimed by the author."
              >
                Verified purchase
              </ToneBadge>
            )}
            <ToneBadge
              tone={
                review.status === "approved"
                  ? "done"
                  : review.status === "rejected"
                    ? "stopped"
                    : "attention"
              }
            >
              {statusLabel(review.status)}
            </ToneBadge>
          </p>
          <p className="text-muted-foreground tnum text-[11px]">
            {review.productSlug} · {dateTime(review.createdAt)}
          </p>
        </div>
      </div>

      <p className="text-[13px] whitespace-pre-wrap">{review.body}</p>

      {review.imageUrl !== undefined && review.imageUrl !== "" && (
        <a
          href={review.imageUrl}
          target="_blank"
          rel="noreferrer"
          className="text-primary max-w-full truncate text-[11px] hover:underline"
        >
          Photo: {review.imageUrl}
        </a>
      )}

      {review.moderatedAt !== null && (
        <p className="text-muted-foreground text-[11px]">
          Moderated {dateTime(review.moderatedAt)}
          {review.rejectionReason === null ? "" : ` — “${review.rejectionReason}”`}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Button
          disabled={busy || review.status === "approved"}
          onClick={() => approve.mutate()}
          title={
            review.status === "approved"
              ? "Already approved. A second approve writes nothing at all."
              : undefined
          }
        >
          {approve.isPending ? "Approving…" : "Approve"}
        </Button>

        {rejecting ? (
          <>
            <Field label="Reason (optional)" htmlFor={`reject-${review.id}`} className="w-72">
              <Input
                id={`reject-${review.id}`}
                maxLength={200}
                placeholder="For the next moderator — never shown to the author"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button variant="destructive" disabled={busy} onClick={() => reject.mutate()}>
              {reject.isPending ? "Rejecting…" : "Confirm reject"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={busy || review.status === "rejected"}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
        )}
      </div>
    </Panel>
  );
}

/** Whole stars, 1–5, with the number beside them so the count is readable rather than counted. */
function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${String(rating)} out of 5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <Star
          key={step}
          aria-hidden="true"
          className={
            step <= rating ? "fill-gold text-gold size-3.5" : "text-muted-foreground size-3.5"
          }
        />
      ))}
    </span>
  );
}
