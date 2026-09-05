import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Adapted from the storefront's shadcn `button.tsx`, against the same tokens, with two departures.
 *
 * **No `asChild`, so no `@radix-ui/react-slot`.** The storefront uses it to render a `<Link>` as a
 * button. Nothing here needs it: the console's in-console links are text links, which is the right
 * affordance for them anyway. `buttonVariants` is deliberately *not* exported either — an export
 * with no caller is code nobody reviews, and it can be exported the day something wants it.
 *
 * **Smaller.** `h-8` default against the storefront's `h-9`, and `sm` is `h-7`. Operator density:
 * a filter bar with four controls and two buttons has to fit on one line at 1280px.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-border bg-card hover:bg-muted",
        ghost: "hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button
      // Defaulted explicitly. HTML's own default is `submit`, so a button placed in a form to open
      // a dialog submits it instead — the classic version of this bug is a "Cancel" that saves.
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
