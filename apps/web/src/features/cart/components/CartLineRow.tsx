import { Link } from "@tanstack/react-router";
import { Minus, Plus, Trash2 } from "lucide-react";
import { settings } from "@/config/settings";
import type { Product } from "@/features/catalog/types";
import { inr } from "@/lib/format";
import { shouldPromptBulk } from "../cart-math";
import { useCart } from "../CartProvider";
import type { CartLine } from "../types";
import { BulkUpsellPrompt } from "./BulkUpsellPrompt";

interface CartLineRowProps {
  line: CartLine;
  product: Product;
}

export function CartLineRow({ line, product }: CartLineRowProps) {
  const { setQty, remove, switchLineToBulk, lineTotalFor } = useCart();
  const total = lineTotalFor(line);
  const promptBulk = shouldPromptBulk(line, settings.bulkPromptThresholdGrams);

  return (
    <li className="border-border border-b py-5 last:border-0">
      <div className="flex gap-4">
        <Link
          to="/product/$slug"
          params={{ slug: product.slug }}
          className="bg-sand shrink-0 overflow-hidden rounded-xl"
        >
          <img
            src={product.images[0]}
            alt={product.name}
            loading="lazy"
            width={96}
            height={96}
            className="size-20 object-cover sm:size-24"
          />
        </Link>

        <div className="flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Link to="/product/$slug" params={{ slug: product.slug }}>
                <p className="leading-snug font-semibold">{product.name}</p>
              </Link>
              <p className="text-muted-foreground mt-0.5 text-sm">
                {line.mode === "bulk" ? `Bulk · ${line.kg} kg` : line.size}
              </p>
            </div>
            <button
              type="button"
              aria-label={`Remove ${product.name}`}
              onClick={() => void remove(line.id)}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="size-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="border-border flex items-center rounded-full border">
              <button
                type="button"
                className="grid size-8 place-items-center"
                aria-label={`Decrease quantity of ${product.name}`}
                onClick={() => void setQty(line.id, line.qty - 1)}
              >
                <Minus className="size-3.5" />
              </button>
              <span className="w-7 text-center text-sm font-semibold">{line.qty}</span>
              <button
                type="button"
                className="grid size-8 place-items-center"
                aria-label={`Increase quantity of ${product.name}`}
                onClick={() => void setQty(line.id, line.qty + 1)}
              >
                <Plus className="size-3.5" />
              </button>
            </div>

            <span className="ml-auto text-base font-semibold">
              {total === null ? "Quote Required" : inr(total)}
            </span>
          </div>

          {promptBulk && <BulkUpsellPrompt onSwitch={() => void switchLineToBulk(line.id)} />}
        </div>
      </div>
    </li>
  );
}
