import { discountPercent, inr } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PriceProps {
  price: number;
  mrp?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { price: "text-[14px]", mrp: "text-[11px]", off: "text-[11px]" },
  md: { price: "text-[16px]", mrp: "text-[12px]", off: "text-[12px]" },
  lg: { price: "text-[20px]", mrp: "text-[14px]", off: "text-[14px]" },
} as const;

export function Price({ price, mrp, size = "md", className }: PriceProps) {
  const s = sizes[size];
  const off = mrp ? discountPercent(price, mrp) : 0;

  return (
    <div className={cn("flex items-baseline gap-2", className)}>
      <span className={cn("font-bold", s.price)}>{inr(price)}</span>
      {mrp && off > 0 && (
        <>
          <span className={cn("text-placeholder line-through", s.mrp)}>{inr(mrp)}</span>
          <span className={cn("text-gold font-semibold", s.off)}>−{off}%</span>
        </>
      )}
    </div>
  );
}
