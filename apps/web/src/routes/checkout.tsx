import { createFileRoute, Link } from "@tanstack/react-router";
import { ShoppingBag } from "lucide-react";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { CartError } from "@/features/cart/components/CartError";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { useCart } from "@/features/cart/CartProvider";
import { CheckoutForm } from "@/features/checkout/components/CheckoutForm";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/checkout")({ component: CheckoutPage });

function CheckoutPage() {
  useSeo({
    title: `Checkout — ${settings.brandName}`,
    description: "Confirm your delivery details and place your dry fruits order.",
  });

  const { lines, isLoading, error, reload } = useCart();

  return (
    <div className="container-page py-10">
      <nav className="text-muted-foreground text-xs">
        <Link to="/cart" className="hover:text-foreground">
          Cart
        </Link>{" "}
        / <span className="text-foreground">Checkout</span>
      </nav>
      <h1 className="font-display mt-3 text-4xl">Checkout</h1>

      {/* `isLoading` before the length, and an error surface beside it — the same reasoning
          `routes/cart.tsx` states, which this file did not carry. `CartProvider` starts at
          `lines: []` with `isLoading: true`, so an unloaded basket and an empty one are the same
          value: a customer who reloads checkout, or returns to it from an external step, was told
          there was nothing to buy. Worse than the cart page's version of the same bug, because
          this route rendered no error and offered no retry — so a failed `GET /cart` made the
          claim permanent rather than momentary. */}
      <CartError error={error} onRetry={reload} />

      {isLoading && lines.length === 0 ? (
        <div className="mt-8" role="status" aria-busy="true" aria-label="Loading your cart">
          <ProductGridSkeleton count={2} />
        </div>
      ) : lines.length === 0 ? (
        <EmptyState
          title="Your cart is waiting for something delicious."
          body="There is nothing to check out yet."
          icon={<ShoppingBag className="size-10" />}
          action={
            <Button asChild size="lg">
              <Link to="/shop">Explore Bestsellers</Link>
            </Button>
          }
        />
      ) : (
        <div className="mt-8">
          <CheckoutForm />
        </div>
      )}
    </div>
  );
}
