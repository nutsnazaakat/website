import { Link } from "@tanstack/react-router";
import { Minus, Plus, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { UnavailableCartLine } from "@/features/cart/components/UnavailableCartLine";
import { useCart } from "@/features/cart/CartProvider";
import { inr } from "@/lib/format";

export function CartDrawer() {
  const settings = useSiteSettings();
  const { open, setOpen, lines, setQty, remove, totals, lineTotalFor, error, isLoading } =
    useCart();
  // A slug-to-name lookup, so it needs the catalogue rather than a page of it.
  const { data: catalogue } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];
  /**
   * As on the cart page, and it matters more here: this drawer has no loading branch at all, so
   * `products` is empty on first paint of every page as well as after a failed listing. Claiming
   * "no longer available" off an empty array would flash that on every line of a restored basket.
   */
  const catalogueAnswered = catalogue !== undefined;
  const gap = Math.max(0, settings.freeShippingThreshold - totals.subtotal);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-border border-b px-5 py-4">
          <SheetTitle className="font-display text-xl">Your Cart</SheetTitle>
        </SheetHeader>

        {/*
         * Every mutator here discards its promise, so a rejected write has nowhere to go unless it
         * is rendered. Outside the empty/non-empty branch on purpose: a rolled-back removal leaves
         * lines and a rolled-back add leaves none, and the customer needs the reason either way.
         */}
        {error && (
          <p
            role="alert"
            className="text-destructive border-border border-b px-5 py-3 text-sm font-medium"
          >
            {error}
          </p>
        )}

        {/* `isLoading` first, for the reason `routes/cart.tsx` states: an unloaded basket and an
            empty one are the same value, so the length alone tells a customer with items that they
            have none. */}
        {isLoading && lines.length === 0 ? (
          <div className="flex flex-1 items-center justify-center" aria-busy="true">
            <p className="text-muted-foreground text-sm">Loading your cart…</p>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              title="Your cart is waiting for something delicious."
              action={
                <Button onClick={() => setOpen(false)} asChild>
                  <Link to="/shop">Explore Bestsellers</Link>
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {gap > 0 && (
                <p className="bg-sand px-3 py-2 text-sm">
                  Add {inr(gap)} more to unlock free shipping.
                </p>
              )}
              {lines.map((l) => {
                const p = products.find((x) => x.slug === l.slug);
                // Same hole the cart page had, with the same consequence: the drawer is where
                // add-to-cart lands, so a stranded line was invisible on both surfaces.
                if (!p) {
                  return catalogueAnswered ? <UnavailableCartLine key={l.id} line={l} /> : null;
                }
                const total = lineTotalFor(l);
                return (
                  <div key={l.id} className="flex gap-3">
                    <img
                      src={p.images[0]}
                      alt={p.name}
                      loading="lazy"
                      width={80}
                      height={80}
                      className="size-20 object-cover"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold">{p.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {l.mode === "bulk" ? `Bulk · ${l.kg}kg` : l.size}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="border-foreground flex items-center border">
                          <button
                            className="grid size-7 place-items-center"
                            aria-label="Decrease quantity"
                            onClick={() => void setQty(l.id, l.qty - 1)}
                          >
                            <Minus className="size-3.5" />
                          </button>
                          <span className="w-6 text-center text-sm">{l.qty}</span>
                          <button
                            className="grid size-7 place-items-center"
                            aria-label="Increase quantity"
                            onClick={() => void setQty(l.id, l.qty + 1)}
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </div>
                        <span className="ml-auto text-sm font-semibold">
                          {total === null ? "Quote Required" : inr(total)}
                        </span>
                        <button aria-label="Remove item" onClick={() => void remove(l.id)}>
                          <Trash2 className="text-muted-foreground size-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="border-border space-y-3 border-t px-5 py-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-semibold">{inr(totals.subtotal)}</span>
              </div>
              <p className="text-muted-foreground text-xs">
                GST and shipping are calculated at checkout.
              </p>
              <Button className="w-full" size="lg" onClick={() => setOpen(false)} asChild>
                <Link to="/cart">Proceed to Checkout</Link>
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
