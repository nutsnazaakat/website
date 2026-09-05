import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BadgeCheck, PackageCheck, Star, Truck, Warehouse } from "lucide-react";
import heroImg from "@/assets/hero-dryfruits.jpg";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useBestsellers, useCategories, useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/")({
  component: Home,
});

const trust = [
  { icon: BadgeCheck, label: "Quality Checked" },
  { icon: PackageCheck, label: "Hygienically Packed" },
  { icon: Truck, label: "Pan-India Delivery" },
  { icon: Warehouse, label: "Bulk Pricing" },
];

const journey = ["Source", "Quality Check", "Sorting", "Packing", "Dispatch", "Your Door"];

const reviews = [
  {
    name: "Aparna R.",
    text: "Fresh and properly packed. The 1kg almonds lasted us a month.",
    city: "Pune",
  },
  {
    name: "Sweet Bites Bakery",
    text: "Bulk cashews arrive consistent in grade. Invoicing is clean.",
    city: "Indore",
  },
  {
    name: "Nikhil S.",
    text: "Makhana is genuinely crisp, not chewy like the ones I used to buy.",
    city: "Delhi",
  },
];

function Home() {
  useSeo({
    title: "Nuts & Nazaakat — Premium Dry Fruits for Home & Bulk Business Orders",
    description:
      "Shop premium almonds, cashews, pistachios, makhana and more in 100g to 1kg packs — or buy in bulk with tiered per-kg pricing, GST invoices and quotes.",
  });

  const { data: categories, isLoading: categoriesLoading } = useCategories();
  const { data: bestsellers, isLoading: bestsellersLoading } = useBestsellers(8);
  const { data: combos, isLoading: combosLoading } = useProducts({ category: "combos" });

  return (
    <div>
      {/* Hero */}
      <section className="bg-sand relative overflow-hidden">
        <div className="container-page grid items-center gap-10 py-14 md:grid-cols-2 md:py-20">
          <div className="reveal">
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.22em] uppercase">
              Retail &amp; Wholesale
            </p>
            <h1 className="font-display mt-4 text-4xl leading-[1.05] sm:text-5xl lg:text-6xl">
              Premium Dry Fruits,
              <br />
              Made Simple.
            </h1>
            <p className="text-muted-foreground mt-5 max-w-md text-base">
              From your kitchen to your business — shop premium dry fruits in the quantity you
              actually need.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/shop">Shop Dry Fruits</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/bulk-orders">Buy in Bulk</Link>
              </Button>
            </div>
          </div>
          <div className="reveal shadow-lift overflow-hidden rounded-3xl">
            <img
              src={heroImg}
              alt="Assorted premium dry fruits in a ceramic bowl on linen"
              width={1600}
              height={1104}
              className="h-full w-full object-cover"
            />
          </div>
        </div>
        <div className="border-border/70 bg-background/60 border-y">
          <div className="container-page grid grid-cols-2 gap-4 py-4 text-sm md:grid-cols-4">
            {trust.map((t) => (
              <div key={t.label} className="text-muted-foreground flex items-center gap-2">
                <t.icon className="text-leaf size-4" />
                {t.label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="container-page py-16">
        <div className="flex items-end justify-between gap-4">
          <h2 className="font-display text-3xl">Shop by category</h2>
          <Link to="/shop" className="text-sm font-medium underline underline-offset-4">
            View all
          </Link>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {categoriesLoading
            ? Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="border-border bg-card overflow-hidden rounded-2xl border">
                  <Skeleton className="aspect-square w-full rounded-none" />
                  <div className="space-y-2 p-3">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))
            : (categories ?? []).map((c) => (
                <Link
                  key={c.slug}
                  to="/category/$slug"
                  params={{ slug: c.slug }}
                  className="group border-border bg-card shadow-soft hover:shadow-lift overflow-hidden rounded-2xl border transition-all hover:-translate-y-1"
                >
                  <img
                    src={c.image}
                    alt={c.name}
                    loading="lazy"
                    width={800}
                    height={800}
                    className="aspect-square w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="p-3">
                    <p className="text-sm font-semibold">{c.name}</p>
                    <p className="text-muted-foreground line-clamp-1 text-xs">{c.blurb}</p>
                  </div>
                </Link>
              ))}
        </div>
      </section>

      {/* Bestsellers */}
      <section className="container-page py-6">
        <h2 className="font-display text-3xl">Best sellers</h2>
        <p className="text-muted-foreground mt-2 text-sm">What our customers reorder most.</p>
        <div className="mt-8">
          {bestsellersLoading ? (
            <ProductGridSkeleton />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {(bestsellers?.items ?? []).map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* B2B band */}
      <section className="container-page py-16">
        <div className="bg-primary text-primary-foreground grid gap-8 rounded-3xl p-8 md:grid-cols-2 md:p-14">
          <div>
            <p className="text-xs font-semibold tracking-[0.22em] uppercase opacity-70">
              For Business
            </p>
            <h2 className="font-display mt-4 text-3xl md:text-4xl">Buying for your business?</h2>
            <p className="mt-4 max-w-md opacity-85">
              Better pricing on bulk orders with flexible quantities, GST invoices and dedicated
              support — for retailers, sweet shops, bakeries, cafés, hotels and distributors.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" variant="secondary" asChild>
                <Link to="/bulk-orders">Get Bulk Pricing</Link>
              </Button>
              <Link
                to="/bulk-orders"
                className="inline-flex items-center gap-2 self-center text-sm font-medium underline underline-offset-4"
              >
                Explore bulk products <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
          <div className="bg-primary-foreground/10 rounded-2xl p-6">
            <p className="text-sm font-semibold">Example: tiered per-kg pricing</p>
            <ul className="mt-4 space-y-2 text-sm">
              {[
                ["1–4 kg", inr(999)],
                ["5–9 kg", inr(949)],
                ["10–24 kg", inr(899)],
                ["25–49 kg", inr(849)],
                ["50 kg+", "Contact for quote"],
              ].map(([q, p]) => (
                <li
                  key={q}
                  className="border-primary-foreground/15 flex justify-between border-b pb-2"
                >
                  <span className="opacity-80">{q}</span>
                  <span className="font-semibold">{p}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs opacity-70">
              Indicative values. All tiers are configurable per product.
            </p>
          </div>
        </div>
      </section>

      {/* Journey */}
      <section className="container-page py-10">
        <h2 className="font-display text-3xl">Know what you&apos;re buying</h2>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
          Every lot is graded, sorted and packed under hygienic conditions. Origin and grade are
          printed on every pack, and sourcing claims are only shown when verified.
        </p>
        <ol className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {journey.map((step, i) => (
            <li key={step} className="border-border bg-card shadow-soft rounded-2xl border p-4">
              <span className="text-muted-foreground text-xs font-semibold">0{i + 1}</span>
              <p className="mt-1 font-semibold">{step}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Reviews */}
      <section className="container-page py-16">
        <h2 className="font-display text-3xl">Customer reviews</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {reviews.map((r) => (
            <figure
              key={r.name}
              className="border-border bg-card shadow-soft rounded-2xl border p-6"
            >
              <div className="flex gap-0.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="fill-gold text-gold size-4" />
                ))}
              </div>
              <blockquote className="mt-4 text-sm">{r.text}</blockquote>
              <figcaption className="text-muted-foreground mt-4 text-xs">
                {r.name} · {r.city} · Verified Purchase
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* Gifting / combos */}
      <section className="container-page py-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl">Combos &amp; gift boxes</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Value packs for home, keepsake boxes for gifting.
            </p>
          </div>
          <Link to="/shop" className="text-sm font-medium underline underline-offset-4">
            See all
          </Link>
        </div>
        <div className="mt-8">
          {combosLoading ? (
            <ProductGridSkeleton count={4} />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {(combos?.items ?? []).slice(0, 4).map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
