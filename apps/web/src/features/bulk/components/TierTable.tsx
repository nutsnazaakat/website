import type { BulkTier } from "@/features/catalog/types";
import { inr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { savingsAgainstBaseTier, tierFor } from "../pricing";

interface TierTableProps {
  tiers: BulkTier[];
  /** Quantity currently selected — its tier row is highlighted. */
  kg: number;
}

export function TierTable({ tiers, kg }: TierTableProps) {
  const tier = tierFor(tiers, kg);
  const savings = savingsAgainstBaseTier(tiers, kg);

  return (
    <div>
      <div className="border-border border">
        <div className="bg-sand text-muted-foreground grid grid-cols-2 px-4 py-2.5 text-[11px] font-bold tracking-[0.1em] uppercase">
          <span>Quantity</span>
          <span className="text-right">Rate per kg</span>
        </div>
        {tiers.map((t) => (
          <div
            key={t.minKg}
            className={cn(
              "border-sand flex items-center justify-between border-t px-4 py-2.5 text-sm",
              t === tier && "bg-sand font-semibold",
            )}
          >
            <span>
              {t.minKg}
              {t.maxKg ? `–${t.maxKg}` : "+"} kg
            </span>
            <span className={cn("text-right font-bold", !t.pricePerKg && "text-gold")}>
              {t.pricePerKg ? `${inr(t.pricePerKg)} / kg` : "On request"}
            </span>
          </div>
        ))}
      </div>

      {savings > 0 && (
        <p className="text-gold mt-3 text-sm font-semibold">You save {inr(savings)}</p>
      )}
    </div>
  );
}
