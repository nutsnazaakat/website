import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Brief §46 — shown against a retail line whose total weight has crossed the
 * configurable bulk threshold. The copy is fixed by the brief; do not reword it.
 */
export function BulkUpsellPrompt({ onSwitch }: { onSwitch: () => void }) {
  return (
    <div className="bg-accent mt-3 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3">
      <p className="text-accent-foreground text-sm">
        Buying in bulk? You may qualify for better pricing.
      </p>
      <Button size="sm" variant="secondary" className="ml-auto" onClick={onSwitch}>
        View Bulk Pricing <ArrowRight className="ml-1 size-3.5" />
      </Button>
    </div>
  );
}
