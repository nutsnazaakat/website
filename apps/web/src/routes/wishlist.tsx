import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useSavedProducts } from "@/features/wishlist/hooks/useWishlist";
import { useWishlist } from "@/features/wishlist/WishlistProvider";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/wishlist")({ component: WishlistPage });

function WishlistPage() {
  useSeo({
    title: `Your Wishlist — ${settings.brandName}`,
    description: "The dry fruits you have saved for later, priced as they are today.",
  });

  const { has, error, reload } = useWishlist();
  const { data: saved, isLoading } = useSavedProducts();

  /**
   * The server's list, narrowed by the live membership set.
   *
   * Unsaving a product has to remove its card immediately, and the toggle's authority is the slug
   * set — so filtering on it means the card goes on the click rather than a refetch later. It also
   * means an optimistic save cannot conjure a card the server has never sent, which is the right
   * asymmetry: removing something on screen is safe, inventing a product is not.
   */
  const products = (saved ?? []).filter((p) => has(p.slug));

  return (
    <div className="container-page py-10">
      <h1 className="font-display text-4xl">Your Wishlist</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {products.length === 0
          ? "Saved products live here, on this device and in your account."
          : `${String(products.length)} saved ${products.length === 1 ? "product" : "products"}, newest first`}
      </p>

      {/*
       * A failed save is otherwise invisible: the card calls `void toggle(slug)`, so the rejection
       * has nowhere to go, and the heart simply rolls back. A failed *load* is worse than invisible
       * — the empty state below would tell a customer with a full list that they have saved nothing.
       */}
      {error && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm font-medium">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="mt-8">
          <ProductGridSkeleton />
        </div>
      ) : products.length > 0 ? (
        /*
         * The same `ProductCard` the shop uses, deliberately. A saved product that has since sold
         * out therefore says SOLD OUT, which is the most useful thing a saved list can tell anyone,
         * and its size chips and Add to Cart work from here without a second component to maintain.
         */
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
          {products.map((p) => (
            <ProductCard key={p.slug} product={p} />
          ))}
        </div>
      ) : (
        <EmptyState
          title="Nothing saved yet."
          body="Tap the heart on any product and it will be waiting here — before you sign in as well as after."
          icon={<Heart className="size-10" />}
          action={
            <Button asChild size="lg">
              <Link to="/shop">Browse the shop</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}
