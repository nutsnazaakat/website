import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/bulk-orders")({ component: BulkOrders });

const perks = [
  {
    title: "Low-MOQ samples",
    body: "Test a 1 kg sample before committing to a bulk order.",
  },
  {
    title: "GST invoices",
    body: "Compliant billing with HSN codes for input credit.",
  },
  {
    title: "Pan-India dispatch",
    body: "Palletised and vacuum-packed for long transit.",
  },
  {
    title: "Consistent grades",
    body: "Locked specifications across every repeat order.",
  },
];

/**
 * Brief §14. Each card drops the buyer straight into the bulk catalogue filtered to
 * the category that line of business actually reorders — the bulk catalogue is keyed
 * by product category, so the mapping belongs here rather than in the route.
 */
const businessTypes = [
  { label: "Retail stores", category: "all", blurb: "Full-range counters" },
  { label: "Kirana & general stores", category: "raisins", blurb: "Fast-moving staples" },
  { label: "Sweet shops", category: "cashews", blurb: "Mithai-grade kernels" },
  { label: "Bakeries", category: "almonds", blurb: "Slivers and wholes" },
  { label: "Cafés", category: "roasted-nuts", blurb: "Counter-side snacking" },
  { label: "Restaurants & hotels", category: "pistachios", blurb: "Kitchen volumes" },
  { label: "Cloud kitchens", category: "makhana", blurb: "Light, high-turn packs" },
  { label: "Caterers", category: "dates", blurb: "Event-scale quantities" },
  { label: "Corporate gifting", category: "combos", blurb: "Boxes and hampers" },
  { label: "Distributors", category: "walnuts", blurb: "Repeat pallet volumes" },
  { label: "Health food brands", category: "seeds", blurb: "Seeds and mixes" },
] as const;

const slabHeadings = ["1–4 kg", "5–9 kg", "10–24 kg", "25–49 kg", "50 kg+"];

function BulkOrders() {
  const settings = useSiteSettings();
  useSeo({
    title: `Bulk & Wholesale Dry Fruits — Per-kg Pricing, GST Invoice | ${settings.brandName}`,
    description:
      "Wholesale dry fruits for retailers, sweet shops, bakeries, cafés, HORECA and distributors. Transparent slab pricing from 1 kg, samples, GST invoices and pan-India dispatch.",
  });

  const { data: products, isLoading } = useProducts();
  const slabRows = (products?.items ?? []).slice(0, 12);

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page grid [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))] gap-8 py-16">
          <div>
            <p className="kicker mb-5">Wholesale &amp; B2B</p>
            <h1 className="page-h1">Buy Better. Buy Bigger. Pay Smarter.</h1>
            <p className="text-body mt-4 max-w-xl text-[16px] leading-[1.65]">
              Reliable dry-fruit supply for retailers, sweet shops, bakeries, cafés, restaurants,
              hotels, cloud kitchens, distributors and growing food businesses.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/bulk/$category" params={{ category: "all" }}>
                  Explore bulk products
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/business/rfqs/new">Get bulk pricing</Link>
              </Button>
              {/* Rendered only once an admin has configured a number — the brief forbids
                  hardcoding contact details into a component. */}
              {settings.whatsappNumber !== "" && (
                <Button asChild size="lg" variant="secondary">
                  <a
                    href={`https://wa.me/${settings.whatsappNumber}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle className="mr-2 size-4" /> Talk to Bulk Sales
                  </a>
                </Button>
              )}
            </div>
          </div>
          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))] gap-3">
            {perks.map((p, i) => (
              <div key={p.title} className="border-border bg-card border p-5">
                <span className="numeral">0{i + 1}</span>
                <p className="mt-3 text-[13px] font-bold">{p.title}</p>
                <p className="text-muted-foreground mt-1 text-[12px] leading-[1.5]">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container-page py-16">
        <h2 className="heading-shout">Who we supply</h2>
        <p className="text-body mt-2 text-[14px]">
          Pick your line of business to jump into the per-kg catalogue that fits it.
        </p>
        <div className="hairline-grid mt-6 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          {businessTypes.map((b) => (
            <Link
              key={b.label}
              to="/bulk/$category"
              params={{ category: b.category }}
              className="bg-card hover:bg-sand px-5 py-5"
            >
              <p className="text-[13px] leading-snug font-bold">{b.label}</p>
              <p className="text-muted-foreground mt-1 text-[12px]">{b.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="container-page pb-16">
        <h2 className="heading-shout">Indicative slab pricing</h2>
        <p className="text-body mt-2 text-[14px]">
          Prices per kg, exclusive of GST. Final rates confirmed on your quotation.
        </p>
        <div className="border-border mt-6 overflow-x-auto border">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-sand text-left">
                <tr>
                  <th className="px-4 py-3 text-[11px] font-bold tracking-[0.1em] uppercase">
                    Product
                  </th>
                  {slabHeadings.map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-right text-[11px] font-bold tracking-[0.1em] uppercase"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slabRows.map((p) => (
                  <tr key={p.slug} className="border-sand border-t">
                    <td className="px-4 py-3 text-[13px] font-semibold">
                      <Link to="/product/$slug" params={{ slug: p.slug }}>
                        {p.name}
                      </Link>
                    </td>
                    {p.bulkTiers.map((t) => (
                      <td key={t.minKg} className="text-data px-4 py-3 text-right">
                        {t.pricePerKg ? inr(t.pricePerKg) : "On request"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="container-page pb-20">
        <div className="border-border bg-card mx-auto max-w-[680px] border p-8 text-center">
          <h2 className="font-display text-[clamp(28px,3.2vw,42px)]">Request a quotation</h2>
          <p className="text-body mx-auto mt-2 max-w-md text-[15px]">
            Tell us what you need and how often. We reply with pricing, samples and dispatch
            timelines against a numbered request you can track.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/business/rfqs/new">Start a quote request</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/bulk/$category" params={{ category: "all" }}>
                Browse per-kg pricing
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
