import { Link } from "@tanstack/react-router";
import { Heart } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Price } from "@/components/common/Price";
import { Rating } from "@/components/common/Rating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart } from "@/features/cart/CartProvider";
import { useWishlist } from "@/features/wishlist/WishlistProvider";
import { inr, pricePer100g } from "@/lib/format";
import { cn } from "@/lib/utils";
import { openingRetailSize } from "../selection";
import type { Product } from "../types";

export function ProductCard({ product }: { product: Product }) {
  // Bulk packs (5kg and up) belong on the bulk tab, never on a retail card.
  const retailVariants = product.variants.filter((v) => v.channel === "retail");
  // Open on a pack the customer can actually buy, rather than a fixed `"250g"` that may be out.
  const [size, setSize] = useState<string | undefined>(() => openingRetailSize(retailVariants));
  const { addRetail } = useCart();
  /**
   * The heart's state comes from the server, not from this component.
   *
   * It was `useState(false)`, which meant every navigation reset it: a customer could save five
   * products, walk to `/cart` and back, and find five grey hearts and an empty wishlist, with nothing
   * having been sent anywhere. `has` is an O(1) `Set` lookup, which matters because a 24-card shop
   * page calls it 24 times per render.
   */
  const { has, toggle } = useWishlist();
  const wished = has(product.slug);

  const variant = retailVariants.find((v) => v.size === size) ?? retailVariants[0]!;

  return (
    <article className="group border-border bg-card shadow-soft hover:shadow-lift relative flex flex-col overflow-hidden rounded-2xl border transition-all duration-300 hover:-translate-y-1">
      <button
        type="button"
        aria-pressed={wished}
        aria-label={
          wished ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`
        }
        onClick={() => void toggle(product.slug)}
        className="bg-background/90 text-foreground shadow-soft hover:bg-background absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full transition-colors"
      >
        <Heart className={cn("size-4", wished && "fill-primary text-primary")} />
      </button>

      <Link
        to="/product/$slug"
        params={{ slug: product.slug }}
        className="bg-sand relative block overflow-hidden"
      >
        <img
          src={product.images[0]}
          alt={product.name}
          loading="lazy"
          width={800}
          height={800}
          className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        {product.badge && (
          <span className="bg-background/90 text-foreground absolute top-3 left-3 rounded-full px-2.5 py-1 text-[10px] font-bold tracking-[0.12em]">
            {product.badge}
          </span>
        )}
        {/* `destructive`, so it reads the same as the cancelled-order badge in the account area. */}
        {product.soldOut && (
          <Badge
            variant="destructive"
            className="absolute bottom-3 left-3 rounded-full text-[10px] tracking-[0.12em]"
          >
            SOLD OUT
          </Badge>
        )}
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <Link to="/product/$slug" params={{ slug: product.slug }}>
          <h3 className="line-clamp-1 font-semibold">{product.name}</h3>
        </Link>
        <p className="text-muted-foreground mt-1 line-clamp-1 text-sm">{product.subtitle}</p>
        <Rating value={product.rating} count={product.reviewCount} className="mt-2 text-xs" />

        <div className="mt-3 flex flex-wrap gap-1.5">
          {retailVariants.map((v) => (
            <button
              key={v.size}
              disabled={v.soldOut}
              aria-pressed={v.size === variant.size}
              /**
               * Only when sold out, and only then: the state has to reach a screen reader rather
               * than living in a strikethrough, but an unconditional label would replace the
               * accessible name of every in-stock chip with a duplicate of its own text.
               */
              aria-label={v.soldOut ? `${v.size} — sold out` : undefined}
              onClick={() => setSize(v.size)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                v.size === variant.size
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/50",
                v.soldOut && "cursor-not-allowed line-through opacity-50",
              )}
            >
              {v.size}
            </button>
          ))}
        </div>

        <Price price={variant.price} mrp={variant.mrp} className="mt-3" />
        <p className="text-muted-foreground mt-1 text-xs">
          {inr(pricePer100g(variant.price, variant.grams))} / 100g
        </p>

        {/*
         * Guarded on the *selected* variant, not on `product.soldOut`: every retail pack can be
         * out while a 25kg bulk pack keeps the product itself in stock, and this button only ever
         * adds a retail pack.
         */}
        <Button
          className="mt-4 w-full"
          variant="secondary"
          disabled={variant.soldOut}
          onClick={() => {
            void addRetail(product.slug, variant.size, variant.grams);
            toast.success(`${product.name} (${variant.size}) added to cart`);
          }}
        >
          Add to Cart
        </Button>
      </div>
    </article>
  );
}
