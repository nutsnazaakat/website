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
      <div className="border-border overflow-hidden rounded-xl border">
        {tiers.map((t) => (
          <div
            key={t.minKg}
            className={cn(
              "border-border flex items-center justify-between border-b px-4 py-2.5 text-sm last:border-0",
              t === tier && "bg-sand font-semibold",
            )}
          >
            <span>
              {t.minKg}
              {t.maxKg ? `–${t.maxKg}` : "+"} kg
            </span>
            <span>{t.pricePerKg ? `${inr(t.pricePerKg)} / kg` : "Custom quote"}</span>
          </div>
        ))}
      </div>

      {savings > 0 && (
        <p className="text-leaf mt-3 text-sm font-semibold">You save {inr(savings)}</p>
      )}
    </div>
  );
}
