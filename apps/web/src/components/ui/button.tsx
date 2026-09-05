import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-[12px] font-bold tracking-[0.16em] uppercase cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-gold hover:text-primary-foreground",
        destructive: "bg-primary text-primary-foreground hover:bg-gold",
        outline:
          "border-[1.5px] border-foreground bg-transparent text-foreground hover:bg-foreground hover:text-background",
        secondary: "bg-sand text-foreground hover:bg-border",
        ghost: "hover:text-gold",
        link: "tracking-normal font-semibold underline-offset-4 hover:text-gold hover:underline",
        gold: "bg-gold-light text-foreground hover:bg-gold hover:text-background",
      },
      size: {
        default: "px-5 py-3",
        sm: "px-4 py-2.5 text-[11px] tracking-[0.14em]",
        lg: "px-7 py-4",
        icon: "size-9 p-0 tracking-normal",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
