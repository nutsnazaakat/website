import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, Minus, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Price } from "@/components/common/Price";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Rating } from "@/components/common/Rating";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { settings } from "@/config/settings";
import { TierTable } from "@/features/bulk/components/TierTable";
import { bulkTotal, isQuoteRequired } from "@/features/bulk/pricing";
import { useCart } from "@/features/cart/CartProvider";
import { PincodeChecker } from "@/features/catalog/components/PincodeChecker";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { ProductGallery } from "@/features/catalog/components/ProductGallery";
import { useProduct, useRelated } from "@/features/catalog/hooks/useCatalog";
import { openingRetailSize } from "@/features/catalog/selection";
import { ReviewForm } from "@/features/reviews/components/ReviewForm";
import { ReviewList } from "@/features/reviews/components/ReviewList";
import { useProductReviews, useReviewSummary } from "@/features/reviews/hooks/useReviews";
import { useSeo } from "@/hooks/useSeo";
import { inr, pricePer100g, pricePerKg } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/product/$slug")({ component: ProductPage });

function ProductPage() {
  const { slug } = Route.useParams();
  const { data: product, isLoading, isError } = useProduct(slug);
  const { data: related } = useRelated(slug);
  const { data: reviews } = useProductReviews(slug);
  const { data: reviewSummary } = useReviewSummary(slug);
  const { addRetail, addBulk, setOpen, error: cartError } = useCart();
  const navigate = useNavigate();

  /**
   * Held as null until the product loads, for the same reason as `kgInput` below: the opening size
   * has to be a pack that is in stock, and no stock is known on the first render.
   */
  const [sizeInput, setSizeInput] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  // Held as null until the product loads so the stepper can start at its MOQ.
  const [kgInput, setKgInput] = useState<number | null>(null);

  useSeo({
    title: product?.seo.title ?? "Product — Nuts & Nazaakat",
    description: product?.seo.description ?? "",
    ogImage: product?.seo.ogImage,
    jsonLd: product
      ? {
          "@context": "https://schema.org",
          "@type": "Product",
          name: product.name,
          image: product.images,
          description: product.description,
          sku: product.variants[0]?.sku,
          brand: { "@type": "Brand", name: settings.brandName },
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: product.rating,
            reviewCount: product.reviewCount,
          },
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "INR",
            lowPrice: Math.min(...product.variants.map((v) => v.price)),
            highPrice: Math.max(...product.variants.map((v) => v.price)),
          },
        }
      : undefined,
  });

  if (isLoading) {
    return (
      <div className="container-page py-8">
        <div className="grid gap-10 lg:grid-cols-2">
          <Skeleton className="aspect-square w-full rounded-3xl" />
          <div className="space-y-4">
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !product) {
    return (
      <div className="container-page py-24 text-center">
        <h1 className="font-display text-3xl">Product not found</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          This product may have been renamed or is no longer stocked.
        </p>
        <Link to="/shop" className="mt-6 inline-block text-sm underline underline-offset-4">
          Back to shop
        </Link>
      </div>
    );
  }

  const retailVariants = product.variants.filter((v) => v.channel === "retail");
  const size = sizeInput ?? openingRetailSize(retailVariants);
  const variant = retailVariants.find((v) => v.size === size) ?? retailVariants[0]!;
  const kg = kgInput ?? product.moqKg;
  const total = bulkTotal(product.bulkTiers, kg);
  // A quote-only product never shows a price, whatever tier the quantity lands in.
  const needsQuote = product.quoteOnly === true || isQuoteRequired(product.bulkTiers, kg);
  const countryOfOrigin = product.origin.split(",").pop()?.trim() ?? product.origin;

  return (
    <div className="container-page py-8">
      <nav className="text-muted-foreground text-xs">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>{" "}
        /{" "}
        <Link to="/shop" className="hover:text-foreground">
          Shop
        </Link>{" "}
        /{" "}
        <Link
          to="/category/$slug"
          params={{ slug: product.category }}
          className="hover:text-foreground"
        >
          {product.category}
        </Link>{" "}
        / <span className="text-foreground">{product.name}</span>
      </nav>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <ProductGallery
          images={product.images}
          alt={`${product.name} — ${product.grade} grade from ${product.origin}`}
        />

        <div>
          {product.badge && (
            <span className="bg-sand rounded-full px-3 py-1 text-[10px] font-bold tracking-[0.14em]">
              {product.badge}
            </span>
          )}
          {/* `destructive`, matching the cancelled-order badge the account area already renders. */}
          {product.soldOut && (
            <Badge variant="destructive" className="ml-2 rounded-full tracking-[0.14em]">
              SOLD OUT
            </Badge>
          )}
          <h1 className="font-display mt-3 text-4xl leading-tight">{product.name}</h1>
          <p className="text-muted-foreground mt-2">{product.subtitle}</p>
          <Rating value={product.rating} count={product.reviewCount} className="mt-3" />

          <Tabs defaultValue="retail" className="mt-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="retail">Buy Retail</TabsTrigger>
              <TabsTrigger value="bulk">Buy in Bulk</TabsTrigger>
            </TabsList>

            <TabsContent value="retail" className="mt-5">
              <div className="flex flex-wrap gap-2">
                {retailVariants.map((v) => (
                  <button
                    key={v.size}
                    disabled={v.soldOut}
                    aria-pressed={v.size === variant.size}
                    /**
                     * Only when sold out. An unconditional label would replace each in-stock
                     * button's accessible name — "1kg₹1,099" — with a hand-written copy of it.
                     */
                    aria-label={v.soldOut ? `${v.size} ${inr(v.price)} — sold out` : undefined}
                    onClick={() => setSizeInput(v.size)}
                    className={cn(
                      "rounded-xl border px-4 py-2 text-sm transition-colors",
                      v.size === variant.size
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:border-primary/50",
                      v.soldOut && "cursor-not-allowed line-through opacity-50",
                    )}
                  >
                    <span className="font-semibold">{v.size}</span>
                    <span className="ml-2 opacity-80">{inr(v.price)}</span>
                  </button>
                ))}
              </div>

              <Price price={variant.price} mrp={variant.mrp} size="lg" className="mt-5" />
              <p className="text-muted-foreground mt-1 text-sm">
                {inr(pricePer100g(variant.price, variant.grams))} / 100g ·{" "}
                {inr(pricePerKg(variant.price, variant.grams))} / kg
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Inclusive of all taxes · GST invoice available
              </p>

              <div className="mt-5 flex items-center gap-3">
                <span className="text-muted-foreground text-sm">Quantity</span>
                <div className="border-border flex items-center rounded-xl border">
                  <button
                    className="grid size-9 place-items-center disabled:opacity-50"
                    aria-label="Decrease quantity"
                    disabled={variant.soldOut}
                    onClick={() => setQty((q) => Math.max(1, q - 1))}
                  >
                    <Minus className="size-4" />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold">{qty}</span>
                  <button
                    className="grid size-9 place-items-center disabled:opacity-50"
                    aria-label="Increase quantity"
                    disabled={variant.soldOut}
                    onClick={() => setQty((q) => q + 1)}
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
                <span className="ml-auto text-sm font-semibold">{inr(variant.price * qty)}</span>
              </div>

              {/*
               * Both guarded on the *selected* variant, not on `product.soldOut`: every retail pack
               * can be out while a 25kg bulk pack keeps the product in stock, and these two buttons
               * only ever add a retail pack.
               */}
              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={variant.soldOut}
                  onClick={() => {
                    void addRetail(product.slug, variant.size, variant.grams, qty);
                    toast.success(`${product.name} (${variant.size}) added to cart`);
                  }}
                >
                  Add to Cart
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  className="flex-1"
                  disabled={variant.soldOut}
                  onClick={() => {
                    void addRetail(product.slug, variant.size, variant.grams, qty);
                    setOpen(false);
                    void navigate({ to: "/checkout" });
                  }}
                >
                  Buy Now
                </Button>
              </div>

              {/*
               * A rejected add-to-cart has nowhere to go otherwise: the handlers above discard
               * their promise, so without this the customer clicks, nothing happens, and they
               * click again. Cleared by the provider on the next successful mutation.
               */}
              {cartError && (
                <p role="alert" className="text-destructive mt-3 text-sm font-medium">
                  {cartError}
                </p>
              )}
            </TabsContent>

            <TabsContent value="bulk" className="mt-5">
              <p className="text-muted-foreground text-sm">
                Minimum order quantity:{" "}
                <span className="text-foreground font-semibold">{product.moqKg} kg</span>
              </p>

              <div className="mt-4 flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Decrease bulk quantity"
                  onClick={() => setKgInput(Math.max(product.moqKg, kg - 5))}
                >
                  <Minus className="size-4" />
                </Button>
                <div className="border-border min-w-24 rounded-xl border px-5 py-2 text-center font-semibold">
                  {kg} kg
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Increase bulk quantity"
                  onClick={() => setKgInput(kg + 5)}
                >
                  <Plus className="size-4" />
                </Button>
              </div>

              <div className="mt-5">
                <TierTable tiers={product.bulkTiers} kg={kg} />
              </div>

              {needsQuote || total === null ? (
                // asChild so the anchor *is* the styled button. A <button> nested inside
                // an <a> is invalid HTML and gives one action two focusable stops.
                <Button asChild size="lg" className="mt-4 w-full">
                  <Link to="/business/rfqs/new" search={{ product: product.slug, kg }}>
                    Request a Quote
                  </Link>
                </Button>
              ) : (
                <>
                  <p className="mt-4 text-2xl font-bold">
                    {inr(total)}{" "}
                    <span className="text-muted-foreground text-sm font-normal">+ GST</span>
                  </p>
                  <Button
                    size="lg"
                    className="mt-4 w-full"
                    onClick={() => {
                      void addBulk(product.slug, kg);
                      toast.success(`${kg} kg ${product.name} added to cart`);
                    }}
                  >
                    Add {kg} kg to Cart
                  </Button>
                </>
              )}
            </TabsContent>
          </Tabs>

          {settings.certifications.length > 0 && (
            <ul className="text-muted-foreground mt-6 grid gap-2 text-sm sm:grid-cols-2">
              {settings.certifications.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <Check className="text-leaf size-4" /> {c}
                </li>
              ))}
            </ul>
          )}

          <PincodeChecker orderValue={variant.price * qty} />

          <Accordion type="single" collapsible className="mt-8">
            <AccordionItem value="spec">
              <AccordionTrigger>Product specifications</AccordionTrigger>
              <AccordionContent>
                <dl className="grid grid-cols-2 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Origin</dt>
                  <dd>{product.origin}</dd>
                  <dt className="text-muted-foreground">Grade</dt>
                  <dd>{product.grade}</dd>
                  <dt className="text-muted-foreground">Ingredients</dt>
                  <dd>{product.ingredients}</dd>
                  <dt className="text-muted-foreground">Processing</dt>
                  <dd>{product.processing}</dd>
                  <dt className="text-muted-foreground">Shelf life</dt>
                  <dd>{product.shelfLife}</dd>
                  <dt className="text-muted-foreground">Storage</dt>
                  <dd>{product.storage}</dd>
                  <dt className="text-muted-foreground">Net weight</dt>
                  <dd>{variant.size}</dd>
                  <dt className="text-muted-foreground">Country of origin</dt>
                  <dd>{countryOfOrigin}</dd>
                </dl>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="storage">
              <AccordionTrigger>Storage &amp; handling</AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm">
                {product.storage}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="ship">
              <AccordionTrigger>Shipping &amp; returns</AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm">
                Dispatched within 24 hours on working days. Pan-India delivery in 2–6 days. Damaged
                or incorrect items are replaced free within 7 days of delivery.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </div>

      <section className="mt-20">
        <h2 className="font-display text-3xl">Customer reviews</h2>
        <div className="mt-6">
          <ReviewList
            reviews={reviews}
            summary={reviewSummary}
            fallbackRating={product.rating}
            fallbackCount={product.reviewCount}
          />
        </div>
        <div className="mt-8 max-w-2xl">
          <ReviewForm productSlug={product.slug} />
        </div>
      </section>

      <section className="mt-20">
        <h2 className="font-display text-3xl">You may also like</h2>
        <div className="mt-6">
          {related === undefined ? (
            <ProductGridSkeleton count={4} />
          ) : (
            related.items.length > 0 && (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
                {related.items.map((p) => (
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
