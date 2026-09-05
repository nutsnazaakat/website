import { format } from "date-fns";
import { BadgeCheck, Star } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Review, ReviewSummary } from "../types";

function Stars({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex gap-0.5" role="img" aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          aria-hidden="true"
          className={cn("size-4", i < Math.round(value) ? "fill-gold text-gold" : "text-border")}
        />
      ))}
    </span>
  );
}

function Distribution({ summary }: { summary: ReviewSummary }) {
  return (
    <ul aria-label="Rating distribution" className="mt-5 space-y-2">
      {summary.distribution.map((row) => (
        <li key={row.stars} className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground w-12 shrink-0 tabular-nums">{row.stars} star</span>
          <span
            className="bg-sand h-2 flex-1 overflow-hidden rounded-full"
            role="meter"
            aria-label={`${row.stars} star reviews`}
            aria-valuenow={row.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="bg-gold block h-full rounded-full"
              style={{ width: `${row.percent}%` }}
            />
          </span>
          <span className="text-muted-foreground w-8 shrink-0 text-right tabular-nums">
            {row.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface ReviewListProps {
  reviews: Review[] | undefined;
  summary: ReviewSummary | undefined;
  /** Catalogue-level rating, shown when no written review has been approved yet. */
  fallbackRating: number;
  fallbackCount: number;
}

/**
 * Brief §27 and §10. Renders the approved reviews only — the API never hands back a
 * pending one, so there is no client-side filtering to forget here.
 */
export function ReviewList({ reviews, summary, fallbackRating, fallbackCount }: ReviewListProps) {
  if (reviews === undefined || summary === undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full max-w-sm rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="border-border bg-card shadow-soft rounded-2xl border p-6">
        <p className="font-display text-5xl leading-none">
          {(summary.total > 0 ? summary.average : fallbackRating).toFixed(1)}
        </p>
        <div className="mt-3">
          <Stars
            value={summary.total > 0 ? summary.average : fallbackRating}
            label={`${(summary.total > 0 ? summary.average : fallbackRating).toFixed(1)} out of 5`}
          />
        </div>
        <p className="text-muted-foreground mt-2 text-sm">
          {summary.total > 0
            ? `${summary.total} written ${summary.total === 1 ? "review" : "reviews"} · ${fallbackCount} ratings in total`
            : `${fallbackCount} ratings in total`}
        </p>
        {summary.verifiedCount > 0 && (
          <p className="text-leaf mt-1 flex items-center gap-1.5 text-sm">
            <BadgeCheck className="size-4" />
            {summary.verifiedCount} from verified purchases
          </p>
        )}
        {summary.total > 0 && <Distribution summary={summary} />}
      </div>

      {reviews.length === 0 ? (
        <EmptyState
          title="No written reviews yet"
          body="Be the first to describe how this one actually tasted."
        />
      ) : (
        <ul aria-label="Customer reviews" className="space-y-4">
          {reviews.map((r) => (
            <li key={r.id} className="border-border bg-card shadow-soft rounded-2xl border p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Stars value={r.rating} label={`${r.rating} out of 5`} />
                <span className="font-semibold">{r.author}</span>
                {r.verifiedPurchase && (
                  <span className="bg-leaf/10 text-leaf flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                    <BadgeCheck className="size-3.5" aria-hidden="true" />
                    Verified Purchase
                  </span>
                )}
                <time dateTime={r.createdAt} className="text-muted-foreground ml-auto text-xs">
                  {format(new Date(r.createdAt), "d MMM yyyy")}
                </time>
              </div>
              <p className="text-foreground/90 mt-3 text-sm leading-relaxed">{r.body}</p>
              {r.imageUrl && (
                <img
                  src={r.imageUrl}
                  alt={`Photo shared by ${r.author} with their review`}
                  loading="lazy"
                  width={120}
                  height={120}
                  className="border-border mt-4 size-24 rounded-xl border object-cover"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
