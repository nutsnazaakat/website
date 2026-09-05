import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered surface. The console's one container.
 *
 * Called `Panel` rather than `Card` on purpose: the storefront's `Card` is a shadowed, generously
 * radiused thing built to sit next to product photography. This is a hairline border and a 6px
 * radius, because a dashboard grid of nine and a table beneath it should read as one instrument,
 * not nine floating objects. `--shadow-*` is deliberately absent from this app's tokens.
 */
export function Panel({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("border-border bg-card rounded-md border", className)} {...props} />;
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border flex items-baseline justify-between gap-3 border-b px-3 py-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {hint !== undefined && <span className="text-muted-foreground text-[11px]">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

/**
 * The empty state, the error state and the loading state — one component, because they are the
 * same shape and brief §42 asks for all three to be polished rather than bare.
 *
 * A dashboard against an empty database must render zeroes, not this: a zero *is* the answer. This
 * is for a list that genuinely has no rows, or a request that genuinely failed.
 */
export function Notice({
  title,
  body,
  tone = "muted",
  action,
}: {
  title: string;
  body?: string;
  tone?: "muted" | "error";
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center gap-2 px-4 py-10 text-center",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <p className="text-[13px] font-semibold">{title}</p>
      {body !== undefined && <p className="max-w-md text-[12px]">{body}</p>}
      {action}
    </div>
  );
}

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * `aria-busy` and a visually-hidden label rather than a bare pulsing rectangle, so a screen reader
 * is told the screen is working instead of reading nothing at all.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("bg-muted animate-pulse rounded", className)} />;
}

export function Loading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="px-4 py-10">
      <span className="sr-only">{label}</span>
      <div className="mx-auto flex max-w-md flex-col gap-2">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
