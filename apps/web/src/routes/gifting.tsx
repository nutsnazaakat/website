import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, Building2, Gem, PartyPopper, Sparkles } from "lucide-react";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useProducts } from "@/features/catalog/hooks/useCatalog";
import { CorporateGiftingForm } from "@/features/gifting/components/CorporateGiftingForm";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/gifting")({ component: Gifting });

/**
 * Brief §24's five sections, in the order the brief lists them. `anchor` is what the
 * jump links target; Corporate Gifts owns the enquiry form further down the page.
 */
const sections = [
  {
    anchor: "corporate",
    icon: Building2,
    title: "Corporate Gifts",
    body: "Diwali hampers, joining kits and client boxes at volume. Branded sleeves, printed cards and a single GST invoice for the whole consignment.",
    points: ["Branded sleeve or card", "One invoice, many addresses", "Written quotation in a day"],
  },
  {
    anchor: "festive",
    icon: PartyPopper,
    title: "Festive Gifts",
    body: "Diwali, Eid, Raksha Bandhan and New Year boxes built around the assortments people actually eat rather than the ones that look good in a photograph.",
    points: ["Seasonal assortments", "Ready to gift as-is", "Dispatch before the rush"],
  },
  {
    anchor: "wedding",
    icon: Gem,
    title: "Wedding Gifts",
    body: "Return gifts and welcome-hamper contents for guests, at counts that run into the hundreds. Tell us the guest list size and the per-box budget.",
    points: ["High-count orders", "Consistent presentation", "Staggered delivery dates"],
  },
  {
    anchor: "boxes",
    icon: Sparkles,
    title: "Premium Gift Boxes",
    body: "Our top grades — mamra almonds, W240 kernels, jumbo pistachios — in a keepsake box for the gift that has to land on its own.",
    points: ["Top-grade kernels only", "Keepsake outer box", "Buy one or a hundred"],
  },
  {
    anchor: "hampers",
    icon: Boxes,
    title: "Custom Gift Hampers",
    body: "Pick the contents, the pack sizes and the box. Useful when a standard assortment does not fit the brief or the budget.",
    points: ["Choose every pack", "Match a fixed budget", "Add your own inserts"],
  },
] as const;

function Gifting() {
  const { data: giftBoxes } = useProducts({ category: "combos" });
  const boxes = giftBoxes?.items ?? [];

  useSeo({
    title: `Corporate & Festive Dry Fruit Gifting | ${settings.brandName}`,
    description:
      "Corporate, festive, wedding and custom dry fruit gift boxes. Share your box count, budget per box, branding needs and delivery date for a written quotation.",
  });

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page py-16">
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
            Gifting
          </p>
          <h1 className="font-display mt-3 max-w-3xl text-5xl leading-[1.05]">
            A gift people finish, not one they pass on.
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            The same graded kernels we sell by the kilo, boxed for the occasion. One box or two
            thousand, with branding, cards and dispatch handled from a single quotation.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#enquiry">Get a Gifting Quote</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/combos">See combo boxes</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="container-page py-16">
        <h2 className="font-display text-3xl">What we put together</h2>
        <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <article
              key={s.anchor}
              id={s.anchor}
              className="border-border bg-card shadow-soft flex flex-col rounded-2xl border p-6"
            >
              <s.icon className="text-leaf size-5" />
              <h3 className="font-display mt-4 text-2xl">{s.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{s.body}</p>
              <ul className="mt-4 space-y-1.5 text-sm">
                {s.points.map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="bg-leaf mt-2 size-1.5 shrink-0 rounded-full"
                    />
                    {p}
                  </li>
                ))}
              </ul>
              <Button asChild variant="ghost" className="mt-5 self-start px-0 hover:bg-transparent">
                <a href="#enquiry" className="underline underline-offset-4">
                  Enquire about {s.title.toLowerCase()}
                </a>
              </Button>
            </article>
          ))}
        </div>
      </section>

      <section className="container-page pb-16">
        <h2 className="font-display text-3xl">Boxes you can order right now</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Ready assortments, available in single units. Anything larger goes through the enquiry
          form below so we can quote branding and volume.
        </p>
        <div className="mt-6">
          {giftBoxes === undefined ? (
            <ProductGridSkeleton count={4} />
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
              {boxes.slice(0, 4).map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="enquiry" className="container-page scroll-mt-24 pb-20">
        <div className="mx-auto max-w-3xl">
          <CorporateGiftingForm />
        </div>
      </section>
    </div>
  );
}
