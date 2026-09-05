import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Form controls, native.
 *
 * **`<select>` is the real HTML element, not a Radix listbox, and that is a decision rather than a
 * shortcut.** For an operator tool the native control is the better one: it opens on the first
 * keystroke of an option's name, it is reachable with the keyboard without any roving-tabindex
 * implementation to get wrong, it costs no dependency and no portal, and on a laptop trackpad it
 * beats a scrolling popup. It also *renders and responds in jsdom*, so this app's route tests can
 * drive a filter for real instead of asserting around a component that measures itself to zero.
 *
 * The storefront's editorial surfaces want the styled listbox; six hours of order triage does not.
 */

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "border-border bg-card placeholder:text-muted-foreground h-8 w-full rounded-md border px-2 text-[13px] outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-border bg-card h-8 w-full rounded-md border px-2 text-[13px] outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "text-muted-foreground text-[11px] font-medium tracking-wide uppercase",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled control, stacked. The filter bar and every form use it so nothing is unlabelled. */
export function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/**
 * The multi-line twin of `Input`, added by plan 9.6b for the catalogue forms.
 *
 * `description`, `ingredients` and a stock-adjustment reason are all prose an operator writes in
 * sentences, and a single-line input turns a 500-character description into a horizontally
 * scrolling slot. Native `<textarea>` for `Select`'s reason: it works in jsdom, needs no
 * dependency, and resizes without a measurement hook.
 */
export function Textarea({ className, rows, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={rows ?? 3}
      className={cn(
        "border-border bg-card placeholder:text-muted-foreground w-full rounded-md border px-2 py-1.5 text-[13px] outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
