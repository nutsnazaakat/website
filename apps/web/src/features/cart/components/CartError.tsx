import { Button } from "@/components/ui/button";

/**
 * A failed cart read or write, with a retry.
 *
 * Every cart mutator is fire-and-forget at the call site — `onClick={() => void addRetail(...)}` —
 * so a rejected write goes nowhere visible unless something renders `error`. A silent failure is a
 * customer clicking Add to Cart, seeing nothing happen, and clicking again.
 *
 * A failed *load* is worse than silent: the cart page renders its empty-basket copy, so saying
 * nothing tells the customer their basket was lost. That is why the cart page renders this in both
 * branches, and why `reload` is on the cart context at all.
 */
export function CartError({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  if (!error) return null;
  return (
    <div role="alert" className="mt-4 flex flex-wrap items-center gap-3">
      <p className="text-destructive text-sm font-medium">{error}</p>
      <Button variant="outline" size="sm" onClick={() => void onRetry()}>
        Try again
      </Button>
    </div>
  );
}
