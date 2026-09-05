import { PackageX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCart } from "../CartProvider";
import type { CartLine } from "../types";

/**
 * A basket line whose product the catalogue no longer serves.
 *
 * The server keeps such a row rather than dropping it — `cart-read.service.ts` states the reason in
 * full: dropping it would have emptied every basket holding a product an admin withdrew for a week.
 * It reports the line `unavailable` with a `NOT_FOUND` code and a null `lineTotal`, leaves it out of
 * the money, and blocks checkout. So `GET /cart` still carries the line and `count` still counts it,
 * and the customer needs somewhere to *act* on it. Both baskets used to `return null` on the failed
 * catalogue lookup, which left a header badge and an "items in your basket are unavailable" notice
 * pointing at a row that was not on the page — nothing to remove, and no way to reach checkout.
 *
 * Everything here comes off the `CartLine` itself, which is the only honest source: the line carries
 * a slug, a mode and a size or a kilogram figure, and deliberately no name, price or image. So the
 * slug is shown raw — the same fallback `CheckoutForm` and the two RFQ screens already use for an
 * unresolvable slug — rather than title-cased into a product name the catalogue never confirmed. And
 * there is **no price**: `lineTotalFor` answers `0` for a product it cannot find, because
 * `cart-math.ts`'s `lineTotal` returns 0 for a missing product, and rendering that would tell the
 * customer the item is free.
 *
 * The icon is a generic "gone" glyph, not a stand-in product photograph.
 *
 * Rendered by both the cart page and the cart drawer, and it deliberately brings no list wrapper of
 * its own: the page nests it in an `<li>` inside its `<ul>`, the drawer drops it straight into a
 * `<div>` stack, and a component that hard-coded either would put an `<li>` outside a list on one of
 * the two surfaces.
 */
export function UnavailableCartLine({ line }: { line: CartLine }) {
  const { remove } = useCart();
  const descriptor = line.mode === "bulk" ? `Bulk · ${line.kg} kg` : line.size;

  return (
    <div className="flex gap-4">
      <div className="bg-muted text-muted-foreground grid size-20 shrink-0 place-items-center rounded-xl sm:size-24">
        <PackageX className="size-6" />
      </div>

      <div className="flex-1">
        <p className="leading-snug font-semibold break-all">{line.slug}</p>
        <p className="text-destructive mt-0.5 text-sm font-medium">
          This item is no longer available.
        </p>
        <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-1.5 text-sm">
          {descriptor !== undefined && <span>{descriptor}</span>}
          <span>Qty {line.qty}</span>
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Remove ${line.slug}`}
          onClick={() => void remove(line.id)}
          className="mt-3"
        >
          <Trash2 /> Remove
        </Button>
      </div>
    </div>
  );
}
