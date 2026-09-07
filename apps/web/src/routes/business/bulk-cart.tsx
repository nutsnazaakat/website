import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Minus, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteSettings } from "@/config/useSiteSettings";
import { cartTotals } from "@/features/cart/cart-math";
import { useCart } from "@/features/cart/CartProvider";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/business/bulk-cart")({ component: BulkCart });

/** Bulk quantities move in 5 kg steps, the same as the catalogue stepper. */
const STEP = 5;

function BulkCart() {
  const settings = useSiteSettings();
  const { lines, setKg, remove, lineTotalFor } = useCart();
  // Prices and names the bulk lines, so it needs the catalogue rather than a page of it.
  const { data: catalogue, isLoading } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];

  useSeo({
    title: `Bulk Cart | ${settings.brandName} for Business`,
    description:
      "Review your per-kg lines, adjust quantities and proceed to a GST-invoiced bulk checkout.",
  });

  const bulkLines = lines.filter((l) => l.mode === "bulk");
  /**
   * **Indicative, not authoritative — and rendered un-overwritten, because no endpoint totals
   * half a basket.** `CartProvider`'s own docblock says `cartTotals` is for the optimistic
   * window and nowhere else *inside that provider*; this screen is the one place outside it
   * that still calls the shared maths directly, for exactly the reason stated there: the
   * server's figures are authoritative, computed per-line GST in paise, while this accumulates
   * float rupees line by line and rounds once on the aggregate — so it cannot express the
   * server's own rounding, and can differ from it by a rupee on the same basket. `POST
   * /cart/validate` prices the *whole* basket, retail and bulk together, and inventing a
   * variant that totals a subset would be a second money path whose only caller is this one
   * screen. The label below is what makes that honest rather than silently approximate; the
   * number that actually binds is the order's own total once it is placed.
   */
  const totals = cartTotals(
    bulkLines,
    (slug) => products.find((p) => p.slug === slug),
    settings.freeShippingThreshold,
  );

  const quoteItems = bulkLines
    .filter((l) => lineTotalFor(l) === null)
    .map((l) => `${l.slug}:${l.kg ?? 0}`)
    .join(",");

  if (isLoading && products.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (bulkLines.length === 0) {
    return (
      <div>
        <h1 className="font-display text-4xl">Bulk Cart</h1>
        <EmptyState
          title="No bulk lines yet."
          body="Pick a quantity in the bulk catalogue and the applicable slab rate is applied for you."
          icon={<ShoppingCart className="size-10" />}
          action={
            <Button asChild size="lg">
              <Link to="/bulk/$category" params={{ category: "all" }}>
                Browse bulk products
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-display text-4xl">Bulk Cart</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {bulkLines.length} {bulkLines.length === 1 ? "line" : "lines"} · rates exclusive of GST
      </p>

      <section
        aria-label="Bulk cart lines"
        className="border-border mt-8 overflow-x-auto rounded-2xl border"
      >
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-sand text-left">
            <tr>
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 font-semibold">Grade</th>
              <th className="px-4 py-3 font-semibold">Quantity</th>
              <th className="px-4 py-3 text-right font-semibold">Price/kg</th>
              <th className="px-4 py-3 text-right font-semibold">Subtotal</th>
              <th className="px-4 py-3">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bulkLines.map((line) => {
              const product = products.find((p) => p.slug === line.slug);
              if (!product) return null;
              const kg = line.kg ?? 0;
              const total = lineTotalFor(line);
              const rate = total === null || kg === 0 ? null : total / line.qty / kg;

              return (
                <tr key={line.id} className="border-border border-t">
                  <td className="px-4 py-4 font-medium">
                    <Link
                      to="/product/$slug"
                      params={{ slug: product.slug }}
                      className="hover:underline"
                    >
                      {product.name}
                    </Link>
                  </td>
                  <td className="text-muted-foreground px-4 py-4">{product.grade}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={`Decrease quantity of ${product.name}`}
                        onClick={() => void setKg(line.id, Math.max(1, kg - STEP))}
                      >
                        <Minus className="size-3.5" />
                      </Button>
                      <output
                        aria-label={`Quantity of ${product.name}`}
                        className="border-border min-w-16 rounded-lg border px-2 py-1 text-center font-semibold"
                      >
                        {kg} kg
                      </output>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={`Increase quantity of ${product.name}`}
                        onClick={() => void setKg(line.id, kg + STEP)}
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {rate === null ? (
                      <span className="font-semibold">Quote Required</span>
                    ) : (
                      inr(rate)
                    )}
                  </td>
                  <td className="px-4 py-4 text-right font-semibold">
                    {total === null ? "Quote Required" : inr(total)}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${product.name}`}
                      onClick={() => void remove(line.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <aside
        aria-label="Bulk order summary"
        className="border-border mt-8 max-w-sm rounded-2xl border p-5"
      >
        <h2 className="font-display text-2xl">Order Summary</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Indicative — the order you place is what is actually invoiced.
        </p>
        <div className="mt-4 space-y-2.5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="font-semibold">{inr(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">GST</span>
            <span className="font-semibold">{inr(totals.gst)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Shipping</span>
            <span className="font-semibold">
              {totals.shipping === 0 ? "Free" : inr(totals.shipping)}
            </span>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="flex items-baseline justify-between">
          <span className="font-semibold">Total</span>
          <span className="text-2xl font-bold">{inr(totals.total)}</span>
        </div>

        {totals.hasQuoteLines ? (
          <>
            <p className="text-muted-foreground mt-3 text-xs">
              Some lines are above our published slabs, so this basket has to be quoted before it
              can be invoiced. The total above excludes them.
            </p>
            <Button asChild size="lg" className="mt-4 w-full">
              <Link to="/business/rfqs/new" search={{ items: quoteItems }}>
                Request Quote for these items <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>
          </>
        ) : (
          <Button asChild size="lg" className="mt-5 w-full">
            <Link to="/checkout">
              Proceed to Bulk Checkout <ArrowRight className="ml-1 size-4" />
            </Link>
          </Button>
        )}

        <Button asChild variant="ghost" size="sm" className="mt-3 w-full">
          <Link to="/bulk/$category" params={{ category: "all" }}>
            Add more products
          </Link>
        </Button>
      </aside>
    </div>
  );
}
