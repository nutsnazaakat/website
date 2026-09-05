import { Link } from "@tanstack/react-router";
import { Minus, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart } from "@/features/cart/CartProvider";
import type { Product } from "@/features/catalog/types";
import { inr } from "@/lib/format";
import { bulkTotal, isQuoteRequired, savingsAgainstBaseTier, tierFor } from "../pricing";

/**
 * Shared by the card and the column headings above it so the dense desktop layout
 * stays aligned. Below `lg` the same markup stacks into a card, because a six-column
 * table is unreadable on a phone.
 */
export const BULK_ROW_GRID =
  "lg:grid lg:grid-cols-[minmax(0,2.1fr)_0.9fr_0.6fr_1.1fr_1fr_1.5fr] lg:items-center lg:gap-4";

/** Bulk quantities move in 5 kg steps — the tier boundaries all sit on multiples of 5. */
const STEP = 5;

interface BulkProductCardProps {
  product: Product;
}

export function BulkProductCard({ product }: BulkProductCardProps) {
  const { addBulk } = useCart();
  const [kg, setKg] = useState(product.moqKg);

  const tier = tierFor(product.bulkTiers, kg);
  const total = bulkTotal(product.bulkTiers, kg);
  const savings = savingsAgainstBaseTier(product.bulkTiers, kg);
  // A quoteOnly product never shows a rate, whatever tier the quantity lands in.
  const needsQuote = product.quoteOnly === true || isQuoteRequired(product.bulkTiers, kg);

  return (
    <li className={`border-border border-b px-4 py-5 last:border-0 ${BULK_ROW_GRID}`}>
      <div className="flex items-center gap-3">
        <Link
          to="/product/$slug"
          params={{ slug: product.slug }}
          className="bg-sand shrink-0 overflow-hidden rounded-xl"
        >
          <img
            src={product.images[0]}
            alt={product.name}
            loading="lazy"
            width={56}
            height={56}
            className="size-14 object-cover"
          />
        </Link>
        <div className="min-w-0">
          <h3 className="leading-snug font-semibold">
            <Link to="/product/$slug" params={{ slug: product.slug }} className="hover:underline">
              {product.name}
            </Link>
          </h3>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{product.origin}</p>
          {/*
           * Product-level only. This row has no size buttons — a kg stepper priced off
           * `bulkTiers[].pricePerKg` — so there is no per-variant control to disable and no
           * selected variant to read.
           */}
          {product.soldOut && (
            <Badge variant="destructive" className="mt-1 rounded-full tracking-[0.12em]">
              SOLD OUT
            </Badge>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm lg:mt-0">
        <span className="text-muted-foreground lg:hidden">Grade: </span>
        {product.grade}
      </p>

      <p className="mt-1 text-sm lg:mt-0">
        <span className="text-muted-foreground lg:hidden">MOQ: </span>
        {product.moqKg} kg
      </p>

      <div className="mt-3 flex items-center gap-2 lg:mt-0">
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`Decrease quantity for ${product.name}`}
          onClick={() => setKg(Math.max(product.moqKg, kg - STEP))}
        >
          <Minus className="size-3.5" />
        </Button>
        <output
          aria-label={`Quantity for ${product.name}`}
          className="border-border min-w-16 rounded-lg border px-2 py-1 text-center text-sm font-semibold"
        >
          {kg} kg
        </output>
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`Increase quantity for ${product.name}`}
          onClick={() => setKg(kg + STEP)}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="mt-3 lg:mt-0">
        {needsQuote || tier?.pricePerKg == null ? (
          <p className="text-sm font-semibold">Custom quote</p>
        ) : (
          <>
            <p className="text-sm font-semibold">{inr(tier.pricePerKg)} / kg</p>
            {total !== null && <p className="text-muted-foreground text-xs">{inr(total)} + GST</p>}
            {savings > 0 && (
              <p className="text-leaf text-xs font-semibold">You save {inr(savings)}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2 lg:mt-0 lg:justify-end">
        {!needsQuote && (
          <Button
            size="sm"
            disabled={product.soldOut}
            onClick={() => {
              void addBulk(product.slug, kg);
              toast.success(`${kg} kg ${product.name} added to your bulk cart`);
            }}
          >
            Add to Bulk Cart
          </Button>
        )}
        {/*
         * Request Quote stays enabled while sold out, deliberately. An RFQ for something out of
         * stock is a legitimate order to place — that is what a lead time is for — and a `quoteOnly`
         * product has no purchasable stock at all.
         */}
        <Button asChild size="sm" variant={needsQuote ? "default" : "outline"}>
          <Link to="/business/rfqs/new" search={{ product: product.slug, kg }}>
            Request Quote
          </Link>
        </Button>
      </div>
    </li>
  );
}
