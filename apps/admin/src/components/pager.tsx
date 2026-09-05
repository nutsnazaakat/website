import { Button } from "@/components/ui/button";
import { count } from "@/lib/format";

/**
 * The footer under every paginated list.
 *
 * The same four lines `orders/index.tsx` and the catalogue screens write inline, extracted here
 * because plan 9.6b's people and operations screens add seven more lists — and eleven copies of
 * "Page 2 of 5" is eleven places for the last-page arithmetic to be off by one.
 * `Math.ceil(total / limit)` floored at 1 is the whole calculation, and an empty list still reads
 * "Page 1 of 1" rather than "Page 1 of 0".
 *
 * **The five earlier lists still inline it**, deliberately left alone: they were written on a
 * parallel branch and rewriting five working screens to prove a point about duplication is a change
 * with real risk and no user-visible benefit. Converting them is a tidy-up worth doing on purpose,
 * not as a side effect of adding screens.
 *
 * **Paging is a URL change, not component state**, so this takes a callback rather than owning a
 * page number: the caller writes it into its own search params, where the back button walks it and
 * a link to page three of a filter is shareable. That is 9.6a's rule and this component must not
 * quietly become an exception to it.
 */
export function Pager({
  page,
  total,
  pageSize,
  onPage,
  unit,
  plural,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (next: number) => void;
  /** What one row is, singular — "order", "customer". */
  unit: string;
  /**
   * The plural, when adding an `s` would be wrong.
   *
   * Required as a parameter rather than derived, because English pluralisation is not a function
   * and this console needs "enquiries" and "businesses" on its very first two screens. A helper
   * that guessed would be right until the first word it was not taught.
   */
  plural?: string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const noun = total === 1 ? unit : (plural ?? `${unit}s`);

  return (
    <div className="flex items-center justify-between px-3 py-2">
      <p className="text-muted-foreground tnum text-[11px]">
        Page {count(page)} of {count(lastPage)} · {count(total)} {noun} in total
      </p>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
