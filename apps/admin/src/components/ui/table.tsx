import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The table. This app's primary surface, so it gets its own opinions rather than the storefront's.
 *
 * - **`<caption>` is required, not optional.** A table is the one element where a screen reader
 *   user is genuinely lost without one, and this console is nothing but tables.
 * - **Rows are 32px, not 48.** Twenty-four orders on screen without scrolling at 1080p.
 * - **`overflow-x-auto` on the wrapper**, so a narrow window scrolls the table rather than
 *   reflowing seven columns into an unreadable stack. An operator on a laptop is the normal case
 *   and a phone is not; brief §40's mobile requirement is about the storefront.
 * - **A numeric column right-aligns and gets `tnum`.** Money only reads as a comparison when the
 *   digits line up.
 */
export function TableWrap({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("w-full overflow-x-auto", className)} {...props} />;
}

export function Table({
  caption,
  className,
  children,
  ...props
}: ComponentProps<"table"> & { caption: string }) {
  return (
    <table className={cn("w-full border-collapse text-[13px]", className)} {...props}>
      <caption className="sr-only">{caption}</caption>
      {children}
    </table>
  );
}

export function Th({ className, numeric, ...props }: ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "text-muted-foreground border-border border-b px-3 py-2 text-[11px] font-medium tracking-wide whitespace-nowrap uppercase",
        numeric === true ? "text-right" : "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, numeric, ...props }: ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "border-border border-b px-3 py-1.5 align-middle",
        numeric === true ? "tnum text-right" : "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("hover:bg-muted/60", className)} {...props} />;
}
