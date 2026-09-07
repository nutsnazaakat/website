import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck, ShoppingBag } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { useSiteSettings } from "@/config/useSiteSettings";
import { CartError } from "@/features/cart/components/CartError";
import { CartLineRow } from "@/features/cart/components/CartLineRow";
import { UnavailableCartLine } from "@/features/cart/components/UnavailableCartLine";
import { useCart } from "@/features/cart/CartProvider";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useProducts, useRelated, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/cart")({ component: CartPage });

function CartPage() {
  const settings = useSiteSettings();
  useSeo({
    title: `Your Cart — ${settings.brandName}`,
    description: "Review your dry fruit selection, check bulk pricing and proceed to checkout.",
  });

  const { lines, totals, count, error, reload, isLoading: cartLoading } = useCart();
  // Prices and names the basket, so it needs the catalogue rather than a page of it.
  const { data: catalogue, isLoading } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];
  /**
   * Whether the catalogue has actually answered, which is not the same question as whether
   * `products` is empty — a failed listing leaves it empty too.
   *
   * "No longer available" is a claim about the catalogue, so it may only be made once the catalogue
   * has spoken. Keyed off the array alone, one failed `GET /catalog/products?limit=60` would tell
   * every customer that every line in their basket had been withdrawn.
   */
  const catalogueAnswered = catalogue !== undefined;
  // Hooks cannot be conditional; an empty slug resolves to an empty related list.
  const { data: related } = useRelated(lines[0]?.slug ?? "");

  const gap = Math.max(0, settings.freeShippingThreshold - totals.subtotal);
  const suggestions = (related?.items ?? []).filter((p) => !lines.some((l) => l.slug === p.slug));

  /**
   * `isLoading` as well as the length, for the same reason the catalogue check above gives.
   *
   * `CartProvider` starts at `lines: []` and `isLoading: true` — its own docblock calls the flag
   * "true until the first `GET /cart` has answered" — so an empty basket and a basket that has not
   * loaded are the same value. Keyed off the length alone, a signed-in customer with a full basket
   * is told "Your cart is waiting for something delicious." on every visit until the fetch
   * returns. Found by the Milestone 10 E2E suite, where it silently defeated basket cleanup and
   * carried a stranded line from one journey into the next.
   */
  if (cartLoading && lines.length === 0) {
    return (
      <div className="container-page py-10">
        <h1 className="page-h1">Your Cart</h1>
        <div className="mt-8" role="status" aria-busy="true" aria-label="Loading your cart">
          <ProductGridSkeleton count={2} />
        </div>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="container-page py-10">
        <h1 className="page-h1">Your Cart</h1>
        <CartError error={error} onRetry={reload} />
        <EmptyState
          title="Your cart is waiting for something delicious."
          body="Pick a pack size that suits you — or buy by the kilo and let the tier pricing do the work."
          icon={<ShoppingBag className="size-10" />}
          action={
            <Button asChild size="lg">
              <Link to="/shop">Explore Bestsellers</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="container-page py-10">
      <h1 className="page-h1">Your Cart</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {count} {count === 1 ? "item" : "items"} in your cart
      </p>
      <CartError error={error} onRetry={reload} />

      <div className="mt-8 grid items-start gap-8 max-md:grid-cols-1 md:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
        <section aria-label="Cart items">
          <div className="border-border bg-card border">
            {isLoading && products.length === 0 ? (
              <div className="py-10">
                <ProductGridSkeleton count={2} />
              </div>
            ) : (
              <ul>
                {lines.map((line) => {
                  const product = products.find((p) => p.slug === line.slug);
                  if (product) return <CartLineRow key={line.id} line={line} product={product} />;
                  /*
                   * The line the customer could not previously see. `count` counts it and the
                   * summary's notice already admits it is not in the total, so `return null` here
                   * left them a basket they could not empty — and since `3c56549` an admin
                   * withdrawing a product mid-season strands one in every basket that held it.
                   */
                  if (!catalogueAnswered) return null;
                  return (
                    <li key={line.id} className="border-border border-b py-5 last:border-0">
                      <UnavailableCartLine line={line} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Link
            to="/shop"
            className="mt-5 inline-flex items-center gap-2 text-sm underline underline-offset-4"
          >
            Continue shopping
          </Link>
        </section>

        <aside aria-label="Order summary" className="md:sticky md:top-24 md:self-start">
          <div className="border-border bg-sand border p-5">
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
              Order summary
            </p>
            <h2 className="sr-only">Order Summary</h2>

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

            <div className="border-sand my-4 border-t" />

            <div className="flex items-baseline justify-between">
              <span className="font-semibold">Total</span>
              <span className="text-2xl font-bold">{inr(totals.total)}</span>
            </div>

            {totals.hasQuoteLines ? (
              <p className="text-muted-foreground mt-2 text-xs">
                Quote-required items are not included in this total. We will send you a price
                against them separately.
              </p>
            ) : (
              totals.hasUnpriceableLines && (
                <p className="text-muted-foreground mt-2 text-xs">
                  Some items in your basket are unavailable and are not included in this total.
                </p>
              )
            )}

            <div className="border-sand mt-5 border-t pt-4">
              {gap > 0 ? (
                <p className="text-[12px]">Add {inr(gap)} more to unlock free shipping.</p>
              ) : (
                <p className="text-[12px]">
                  Free shipping applied. Dispatched within one working day.
                </p>
              )}
            </div>

            <Button asChild size="lg" className="mt-5 w-full">
              <Link to="/checkout">
                Proceed to Checkout <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>

            {totals.hasQuoteLines && (
              <Button asChild size="lg" variant="outline" className="mt-3 w-full">
                <Link to="/business/rfqs/new" search={{ product: lines[0]?.slug }}>
                  Request Quote
                </Link>
              </Button>
            )}

            <p className="text-muted-foreground mt-4 text-center text-[11px]">
              {settings.codEnabled ? "Cash on delivery available. " : ""}
              {settings.onlinePaymentEnabled
                ? "Online payment is available at checkout."
                : "Online payment opens once the gateway is live."}
            </p>
            <p className="text-muted-foreground mt-2 flex items-center justify-center gap-2 text-[11px]">
              <ShieldCheck className="size-3.5" /> GST invoice issued on every order
            </p>
          </div>
        </aside>
      </div>

      <section className="mt-16">
        <h2 className="font-display text-3xl">Frequently Bought Together</h2>
        <div className="mt-6">
          {related === undefined ? (
            <ProductGridSkeleton count={4} />
          ) : (
            suggestions.length > 0 && (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
                {suggestions.map((p) => (
                  <ProductCard key={p.slug} product={p} />
                ))}
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
}
