import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCart } from "@/features/cart/CartProvider";
import { inr } from "@/lib/format";
import type { Combo } from "../types";

/**
 * Brief §23. One combo box: what is inside it, what those packs cost apart, and what
 * the box costs. Every figure arrives pre-computed from the catalogue, so this component
 * never does pricing arithmetic of its own.
 */
export function ComboCard({ combo }: { combo: Combo }) {
  const { addRetail } = useCart();

  return (
    <li className="border-border bg-card flex flex-col border">
      <div className="border-border flex items-baseline justify-between gap-3 border-b px-[22px] py-[18px]">
        <span className="text-gold text-[10px] font-bold tracking-[0.16em] uppercase">
          {combo.occasion}
        </span>
        {combo.savings > 0 && (
          <span className="text-[11px] font-semibold">You save {inr(combo.savings)}</span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-[22px]">
        <h3 className="font-display text-[26px] leading-[1.1]">{combo.name}</h3>
        <p className="text-body mt-2 text-[14px] leading-[1.6]">{combo.blurb}</p>

        <p className="text-muted-foreground mt-5 text-[10px] font-semibold tracking-[0.16em] uppercase">
          Inside the box
        </p>
        <ul aria-label={`Products in ${combo.name}`} className="mt-2 text-[13px]">
          {combo.components.map((c) => (
            <li
              key={`${c.slug}-${c.size}`}
              className="border-sand flex items-baseline justify-between gap-3 border-b py-2 last:border-0"
            >
              <Link
                to="/product/$slug"
                params={{ slug: c.slug }}
                className="underline-offset-4 hover:underline"
              >
                {c.name}
              </Link>
              <span className="text-muted-foreground shrink-0">
                {c.size} · {inr(c.price)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border mt-auto flex flex-wrap items-center gap-3 border-t px-[22px] py-4">
        <div>
          <p className="text-[20px] font-bold">{inr(combo.price)}</p>
          <p className="text-placeholder text-[12px] line-through">{inr(combo.partsMrp)}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => {
              void addRetail(combo.slug, "1kg", combo.totalGrams);
              toast.success(`${combo.name} added to cart`);
            }}
          >
            Add to Cart
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/product/$slug" params={{ slug: combo.slug }}>
              View box
            </Link>
          </Button>
        </div>
      </div>
    </li>
  );
}
