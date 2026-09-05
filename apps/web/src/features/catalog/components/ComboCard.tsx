import { Link } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
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
    <li className="border-border bg-card shadow-soft hover:shadow-lift flex flex-col overflow-hidden rounded-3xl border transition-shadow">
      <div className="bg-sand relative">
        <img
          src={combo.image}
          alt={`${combo.name} — ${combo.components.map((c) => c.name).join(", ")}`}
          loading="lazy"
          width={800}
          height={600}
          className="aspect-[4/3] w-full object-cover"
        />
        <span className="bg-background/90 absolute top-4 left-4 rounded-full px-3 py-1 text-[10px] font-bold tracking-[0.14em] uppercase">
          {combo.occasion}
        </span>
        {combo.savings > 0 && (
          <span className="bg-leaf text-primary-foreground absolute top-4 right-4 rounded-full px-3 py-1 text-[11px] font-bold">
            {combo.savingsPercent}% off MRP
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-6">
        <h3 className="font-display text-2xl">{combo.name}</h3>
        <p className="text-muted-foreground mt-2 text-sm">{combo.blurb}</p>

        <p className="text-muted-foreground mt-5 text-xs font-semibold tracking-[0.16em] uppercase">
          What&apos;s inside · {combo.totalGrams / 1000} kg
        </p>
        <ul aria-label={`Products in ${combo.name}`} className="mt-3 space-y-2 text-sm">
          {combo.components.map((c) => (
            <li key={`${c.slug}-${c.size}`} className="flex items-baseline gap-2">
              <PackageCheck className="text-leaf size-4 shrink-0 translate-y-0.5" />
              <Link
                to="/product/$slug"
                params={{ slug: c.slug }}
                className="underline-offset-4 hover:underline"
              >
                {c.name}
              </Link>
              <span className="text-muted-foreground">{c.size}</span>
              <span className="text-muted-foreground ml-auto shrink-0 line-through">
                {inr(c.mrp)}
              </span>
            </li>
          ))}
        </ul>

        <dl className="bg-sand mt-5 rounded-2xl p-4 text-sm">
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">MRP of the parts</dt>
            <dd className="line-through">{inr(combo.partsMrp)}</dd>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <dt className="text-muted-foreground">Bought separately</dt>
            <dd>{inr(combo.partsPrice)}</dd>
          </div>
          <div className="border-border/70 mt-2 flex items-baseline justify-between border-t pt-2">
            <dt className="font-semibold">Combo price</dt>
            <dd className="font-display text-2xl">{inr(combo.price)}</dd>
          </div>
          {combo.savings > 0 && (
            <p className="text-leaf mt-2 font-semibold">You save {inr(combo.savings)}</p>
          )}
        </dl>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button
            className="flex-1"
            onClick={() => {
              void addRetail(combo.slug, "1kg", combo.totalGrams);
              toast.success(`${combo.name} added to cart`);
            }}
          >
            Add to Cart
          </Button>
          <Button asChild variant="outline" className="flex-1">
            <Link to="/product/$slug" params={{ slug: combo.slug }}>
              View details
            </Link>
          </Button>
        </div>
      </div>
    </li>
  );
}
