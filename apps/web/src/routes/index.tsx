import { createFileRoute, Link } from "@tanstack/react-router";
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
  { n: "01", label: "Quality Checked" },
  { n: "02", label: "Hygienically Packed" },
  { n: "03", label: "Pan-India Delivery" },
  { n: "04", label: "Bulk Pricing" },
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
      <section className="bg-sand border-border border-b">
        <div className="container-page grid items-center gap-10 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
          <div className="max-w-[560px] py-16">
            <p className="kicker mb-5">Retail &amp; Wholesale</p>
            <h1 className="hero-h1">
              Premium Dry Fruits,
              <br />
              <em className="font-serif font-normal italic">Made Simple.</em>
            </h1>
            <p className="text-body mt-[22px] max-w-[430px] text-[17px] leading-[1.6]">
              From your kitchen to your business — shop premium dry fruits in the quantity you
              actually need.
            </p>
            <div className="mt-[30px] flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/shop">Shop dry fruits</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/bulk-orders">Buy in bulk</Link>
              </Button>
            </div>
          </div>
          <div className="py-8">
            <img
              src={heroImg}
              alt="Assorted premium dry fruits in a ceramic bowl on linen"
              width={1600}
              height={1104}
              className="border-border h-[clamp(280px,38vw,440px)] w-full border object-cover"
            />
          </div>
        </div>
        <div className="border-border bg-background border-t">
          <div className="container-page grid gap-3.5 py-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            {trust.map((t) => (
              <div key={t.label} className="flex items-baseline gap-2.5">
                <span className="numeral">{t.n}</span>
                <span className="text-[12px] font-semibold tracking-[0.1em] uppercase">{t.label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container-page pt-16">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-6">
          <h2 className="heading-shout">Shop by category</h2>
          <Link to="/shop" className="section-link hover:text-foreground">
            View all
          </Link>
        </div>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
          {categoriesLoading
            ? Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="border-border bg-card overflow-hidden border">
                  <Skeleton className="aspect-square w-full" />
                  <div className="border-border space-y-2 border-t p-3">
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
                  className="border-border bg-card hover:bg-sand block overflow-hidden border"
                >
                  <img
                    src={c.image}
                    alt={c.name}
                    loading="lazy"
                    width={800}
                    height={800}
                    className="aspect-square w-full object-cover"
                  />
                  <div className="border-border border-t px-[13px] pt-3 pb-3.5">
                    <p className="text-[13px] font-bold">{c.name}</p>
                    <p className="text-muted-foreground mt-[3px] line-clamp-1 text-[11px] leading-[1.4]">
                      {c.blurb}
                    </p>
                  </div>
                </Link>
              ))}
        </div>
      </section>

      <section className="container-page pt-16">
        <h2 className="heading-shout">Best sellers</h2>
        <p className="text-body mt-1.5 mb-[26px] text-[14px]">What our customers reorder most.</p>
        {bestsellersLoading ? (
          <ProductGridSkeleton />
        ) : (
          <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
            {(bestsellers?.items ?? []).map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>
        )}
      </section>

      <section className="container-page py-16">
        <div className="bg-foreground text-background grid gap-10 p-[clamp(28px,4vw,56px)] [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
          <div>
            <p className="text-gold-light mb-4 text-[11px] font-semibold tracking-[0.24em] uppercase">
              For business
            </p>
            <h2 className="font-display text-[clamp(28px,3.4vw,44px)] leading-[1.04]">
              Buying for your business?
            </h2>
            <p className="text-ink-muted mt-[18px] mb-7 max-w-[420px] text-[15px] leading-[1.7]">
              Better pricing on bulk orders with flexible quantities, GST invoices and dedicated
              support — for retailers, sweet shops, bakeries, cafés, hotels and distributors.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="lg" variant="gold" asChild>
                <Link to="/bulk-orders">Get bulk pricing</Link>
              </Button>
              <Link
                to="/bulk-orders"
                className="border-gold-light text-background hover:text-gold-light border-b-[1.5px] py-[15px] text-[12px] font-bold tracking-[0.16em] uppercase"
              >
                Explore bulk products →
              </Link>
            </div>
          </div>
          <div className="border-ink-border border p-[26px]">
            <p className="mb-[18px] text-[12px] font-bold tracking-[0.12em] uppercase">
              Example: tiered per-kg pricing
            </p>
            <ul>
              {[
                ["1–4 kg", inr(999)],
                ["5–9 kg", inr(949)],
                ["10–24 kg", inr(899)],
                ["25–49 kg", inr(849)],
                ["50 kg+", "Contact for quote"],
              ].map(([q, p]) => (
                <li
                  key={q}
                  className="border-ink-border flex justify-between gap-4 border-b py-[11px] text-[14px]"
                >
                  <span className="text-ink-muted">{q}</span>
                  <span className="font-bold">{p}</span>
                </li>
              ))}
            </ul>
            <p className="text-ink-faint mt-4 text-[11px] leading-[1.5]">
              Indicative values. All tiers are configurable per product.
            </p>
          </div>
        </div>
      </section>

      <section className="container-page pb-16">
        <h2 className="heading-shout">Know what you&apos;re buying</h2>
        <p className="text-body mt-2 mb-[26px] max-w-[620px] text-[14px] leading-[1.65]">
          Every lot is graded, sorted and packed under hygienic conditions. Origin and grade are
          printed on every pack, and sourcing claims are only shown when verified.
        </p>
        <ol className="hairline-grid [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
          {journey.map((step, i) => (
            <li key={step} className="bg-card px-[18px] py-5">
              <span className="numeral">0{i + 1}</span>
              <p className="mt-1.5 text-[13px] font-bold">{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-border bg-sand border-y">
        <div className="container-page py-16">
          <h2 className="font-display mb-[30px] text-center text-[clamp(28px,3.2vw,42px)]">
            Customer reviews
          </h2>
          <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            {reviews.map((r) => (
              <figure key={r.name} className="border-border bg-card border px-6 py-[26px]">
                <div className="text-gold mb-4 text-[13px] tracking-[0.3em]">★★★★★</div>
                <blockquote className="text-on-card text-[14px] leading-[1.65]">{r.text}</blockquote>
                <figcaption className="text-muted-foreground mt-[18px] text-[11px] tracking-[0.06em]">
                  {r.name} · {r.city} · Verified Purchase
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="container-page py-16">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-6">
          <h2 className="heading-shout">Combos &amp; gift boxes</h2>
          <Link to="/combos" className="section-link hover:text-foreground">
            See all
          </Link>
        </div>
        <p className="text-body mb-[26px] text-[14px]">
          Value packs for home, keepsake boxes for gifting.
        </p>
        {combosLoading ? (
          <ProductGridSkeleton count={4} />
        ) : (
          <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
            {(combos?.items ?? []).slice(0, 4).map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
