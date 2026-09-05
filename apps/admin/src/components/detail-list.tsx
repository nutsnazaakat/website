import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A label/value block, as `<dl>`.
 *
 * Every detail screen in the console shows one — an order's totals, a customer's account, a
 * business's profile, a ticket's header — and a `<dl>` is the element that actually says "these
 * labels name these values". A grid of `<div><span>` pairs looks identical and tells a screen
 * reader nothing.
 *
 * `hint` is for the sentence a figure needs in order not to be misread: "excludes cancelled and
 * refunded" beside a spend, "not editable from this console" beside a price band. It renders under
 * the value rather than as a `title`, because an operator reconciling two numbers is not hovering.
 */
export function DetailList({
  columns = 2,
  className,
  children,
}: {
  columns?: 1 | 2;
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-4 gap-y-2 px-3 py-3 text-[12px]",
        columns === 1 ? "grid-cols-1" : "grid-cols-[minmax(0,auto)_minmax(0,1fr)]",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Detail({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground whitespace-nowrap">{label}</dt>
      <dd className="min-w-0">
        {children}
        {hint !== undefined && (
          <span className="text-muted-foreground mt-0.5 block text-[11px]">{hint}</span>
        )}
      </dd>
    </>
  );
}
