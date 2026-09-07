import { Link } from "@tanstack/react-router";
import { Minus, Plus } from "lucide-react";
import { useSiteSettings } from "@/config/useSiteSettings";
import { CatalogMedia } from "@/components/common/CatalogMedia";
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
  const settings = useSiteSettings();
  const { setQty, remove, switchLineToBulk, lineTotalFor } = useCart();
  const total = lineTotalFor(line);
  const promptBulk = shouldPromptBulk(line, settings.bulkPromptThresholdGrams);
  const meta = line.mode === "bulk" ? `Bulk · ${line.kg} kg` : line.size;

  return (
    <li className="border-sand border-b last:border-0">
      <div className="grid items-center gap-4 px-5 py-[18px] max-sm:grid-cols-[72px_minmax(0,1fr)] sm:grid-cols-[72px_minmax(0,1fr)_auto]">
        <Link
          to="/product/$slug"
          params={{ slug: product.slug }}
          className="bg-sand size-[72px] overflow-hidden"
        >
          <CatalogMedia src={product.images[0]} alt={product.name} className="size-[72px]" />
        </Link>

        <div className="min-w-0">
          <Link to="/product/$slug" params={{ slug: product.slug }}>
            <p className="text-[14px] leading-snug font-bold">{product.name}</p>
          </Link>
          <p className="text-muted-foreground mt-0.5 text-[12px]">{meta}</p>
          <button
            type="button"
            aria-label={`Remove ${product.name}`}
            onClick={() => void remove(line.id)}
            className="text-muted-foreground hover:text-gold mt-2 text-[11px] font-bold tracking-[0.14em] uppercase"
          >
            Remove
          </button>
          <div className="border-foreground mt-3 inline-flex items-center border">
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
          {promptBulk && <BulkUpsellPrompt onSwitch={() => void switchLineToBulk(line.id)} />}
        </div>

        <span className="text-right text-[15px] font-bold max-sm:col-span-2">
          {total === null ? "Quote Required" : inr(total)}
        </span>
      </div>
    </li>
  );
}
