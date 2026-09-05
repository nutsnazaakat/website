import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

interface PagerProps {
  /** The page currently shown, 1-based — `Paginated.page` as the server answered it. */
  page: number;
  /** `Paginated.total`: the size of the whole result, not of this page. */
  total: number;
  /** `Paginated.limit`: how many rows a page holds. */
  limit: number;
  /** The URL for a page, so each control is a real anchor. */
  hrefForPage: (page: number) => string;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Page controls for a `Paginated<T>` list.
 *
 * One component rather than a copy in each list page, because both of them would otherwise derive
 * `Math.ceil(total / limit)` themselves — and `Paginated<T>` deliberately carries no `totalPages`,
 * so two derivations is two places for the last page to be off by one.
 *
 * Renders nothing at all when everything fits on one page, which is the state every category page
 * is in today.
 *
 * The controls are anchors with real `href`s **and** a click handler that prevents default: the
 * anchor is what makes them keyboard reachable and the URL shareable, the handler is what keeps the
 * navigation client-side. `href` is built by the caller through the router, because only the route
 * knows its own params.
 */
export function Pager({ page, total, limit, hrefForPage, onPageChange, className }: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <Pagination className={cn("mt-10", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={hrefForPage(Math.max(1, page - 1))}
            aria-disabled={page === 1}
            className={cn(page === 1 && "pointer-events-none opacity-50")}
            onClick={(e) => {
              e.preventDefault();
              if (page > 1) onPageChange(page - 1);
            }}
          />
        </PaginationItem>

        {pages.map((n) => (
          <PaginationItem key={n}>
            <PaginationLink
              href={hrefForPage(n)}
              isActive={n === page}
              aria-label={`Go to page ${String(n)}`}
              onClick={(e) => {
                e.preventDefault();
                onPageChange(n);
              }}
            >
              {n}
            </PaginationLink>
          </PaginationItem>
        ))}

        <PaginationItem>
          <PaginationNext
            href={hrefForPage(Math.min(totalPages, page + 1))}
            aria-disabled={page === totalPages}
            className={cn(page === totalPages && "pointer-events-none opacity-50")}
            onClick={(e) => {
              e.preventDefault();
              if (page < totalPages) onPageChange(page + 1);
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
