import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface RatingProps {
  value: number;
  count?: number;
  showStars?: boolean;
  className?: string;
}

export function Rating({ value, count, showStars = false, className }: RatingProps) {
  return (
    <p className={cn("flex items-center gap-1 text-sm", className)}>
      {showStars ? (
        <span className="flex gap-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={cn(
                "size-4",
                i < Math.round(value) ? "fill-gold text-gold" : "text-border",
              )}
            />
          ))}
        </span>
      ) : (
        <Star className="fill-gold text-gold size-3.5" />
      )}
      <span className="text-foreground font-semibold">{value.toFixed(1)}</span>
      {count != null && <span className="text-muted-foreground">({count})</span>}
    </p>
  );
}
