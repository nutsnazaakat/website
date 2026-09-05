import { discountPercent, inr } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PriceProps {
  price: number;
  mrp?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { price: "text-base", mrp: "text-xs", off: "text-[11px]" },
  md: { price: "text-lg", mrp: "text-sm", off: "text-xs" },
  lg: { price: "text-3xl", mrp: "text-base", off: "text-sm" },
} as const;

export function Price({ price, mrp, size = "md", className }: PriceProps) {
  const s = sizes[size];
  const off = mrp ? discountPercent(price, mrp) : 0;

  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      <span className={cn("font-bold", s.price)}>{inr(price)}</span>
      {mrp && off > 0 && (
        <>
          <span className={cn("text-muted-foreground line-through", s.mrp)}>{inr(mrp)}</span>
          <span className={cn("text-leaf font-semibold", s.off)}>{off}% off</span>
        </>
      )}
    </div>
  );
}
