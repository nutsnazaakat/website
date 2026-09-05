import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BadgeCheck,
  CakeSlice,
  ChefHat,
  Coffee,
  Croissant,
  Dumbbell,
  FileText,
  Gift,
  Hotel,
  MessageCircle,
  PackageCheck,
  PartyPopper,
  ShoppingBasket,
  Store,
  Truck,
  Warehouse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/bulk-orders")({ component: BulkOrders });

const perks = [
  {
    icon: PackageCheck,
    title: "Low-MOQ samples",
    body: "Test a 1 kg sample before committing to a bulk order.",
  },
  {
    icon: FileText,
    title: "GST invoices",
    body: "Compliant billing with HSN codes for input credit.",
  },
  {
    icon: Truck,
    title: "Pan-India dispatch",
    body: "Palletised and vacuum-packed for long transit.",
  },
  {
    icon: BadgeCheck,
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
  { icon: Store, label: "Retail stores", category: "all", blurb: "Full-range counters" },
  {
    icon: ShoppingBasket,
    label: "Kirana & general stores",
    category: "raisins",
    blurb: "Fast-moving staples",
  },
  { icon: CakeSlice, label: "Sweet shops", category: "cashews", blurb: "Mithai-grade kernels" },
  { icon: Croissant, label: "Bakeries", category: "almonds", blurb: "Slivers and wholes" },
  { icon: Coffee, label: "Cafés", category: "roasted-nuts", blurb: "Counter-side snacking" },
  { icon: Hotel, label: "Restaurants & hotels", category: "pistachios", blurb: "Kitchen volumes" },
  { icon: ChefHat, label: "Cloud kitchens", category: "makhana", blurb: "Light, high-turn packs" },
  { icon: PartyPopper, label: "Caterers", category: "dates", blurb: "Event-scale quantities" },
  { icon: Gift, label: "Corporate gifting", category: "combos", blurb: "Boxes and hampers" },
  { icon: Warehouse, label: "Distributors", category: "walnuts", blurb: "Repeat pallet volumes" },
  { icon: Dumbbell, label: "Health food brands", category: "seeds", blurb: "Seeds and mixes" },
] as const;

const slabHeadings = ["1–4 kg", "5–9 kg", "10–24 kg", "25–49 kg", "50 kg+"];

function BulkOrders() {
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
        <div className="container-page grid gap-8 py-16 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
              Wholesale &amp; B2B
            </p>
            <h1 className="font-display mt-3 text-5xl leading-[1.05]">
              Buy Better. Buy Bigger. Pay Smarter.
            </h1>
            <p className="text-muted-foreground mt-4 max-w-xl">
              Reliable dry-fruit supply for retailers, sweet shops, bakeries, cafés, restaurants,
              hotels, cloud kitchens, distributors and growing food businesses.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/bulk/$category" params={{ category: "all" }}>
                  Explore Bulk Products
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/business/rfqs/new">Get Bulk Pricing</Link>
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
          <div className="grid gap-3 sm:grid-cols-2">
            {perks.map((p) => (
              <div
                key={p.title}
                className="border-border bg-card shadow-soft rounded-2xl border p-5"
              >
                <p.icon className="text-leaf size-5" />
                <p className="mt-3 font-semibold">{p.title}</p>
                <p className="text-muted-foreground mt-1 text-sm">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="container-page py-16">
        <h2 className="font-display text-3xl">Who we supply</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Pick your line of business to jump into the per-kg catalogue that fits it.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {businessTypes.map((b) => (
            <Link
              key={b.label}
              to="/bulk/$category"
              params={{ category: b.category }}
              className="border-border bg-card hover:border-primary/50 rounded-2xl border p-5 transition-colors"
            >
              <b.icon className="text-leaf size-5" />
              <p className="mt-3 leading-snug font-semibold">{b.label}</p>
              <p className="text-muted-foreground mt-1 text-xs">{b.blurb}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="container-page pb-16">
        <h2 className="font-display text-3xl">Indicative slab pricing</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Prices per kg, exclusive of GST. Final rates confirmed on your quotation.
        </p>
        <div className="border-border mt-6 overflow-x-auto rounded-2xl border">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-sand text-left">
                <tr>
                  <th className="px-4 py-3 font-semibold">Product</th>
                  {slabHeadings.map((h) => (
                    <th key={h} className="px-4 py-3 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {slabRows.map((p) => (
                  <tr key={p.slug} className="border-border border-t">
                    <td className="px-4 py-3 font-medium">
                      <Link
                        to="/product/$slug"
                        params={{ slug: p.slug }}
                        className="hover:underline"
                      >
                        {p.name}
                      </Link>
                    </td>
                    {p.bulkTiers.map((t) => (
                      <td key={t.minKg} className="text-muted-foreground px-4 py-3">
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
        <div className="border-border bg-card shadow-soft mx-auto max-w-2xl rounded-3xl border p-8 text-center">
          <h2 className="font-display text-3xl">Request a quotation</h2>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            Tell us what you need and how often. We reply with pricing, samples and dispatch
            timelines against a numbered request you can track.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/business/rfqs/new">Start a Quote Request</Link>
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
