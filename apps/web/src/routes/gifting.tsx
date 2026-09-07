import { createFileRoute, Link } from "@tanstack/react-router";
import { PageBand } from "@/components/common/PageBand";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { useSiteSettings } from "@/config/useSiteSettings";
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
    title: "Corporate Gifts",
    body: "Diwali hampers, joining kits and client boxes at volume. Branded sleeves, printed cards and a single GST invoice for the whole consignment.",
    points: ["Branded sleeve or card", "One invoice, many addresses", "Written quotation in a day"],
  },
  {
    anchor: "festive",
    title: "Festive Gifts",
    body: "Diwali, Eid, Raksha Bandhan and New Year boxes built around the assortments people actually eat rather than the ones that look good in a photograph.",
    points: ["Seasonal assortments", "Ready to gift as-is", "Dispatch before the rush"],
  },
  {
    anchor: "wedding",
    title: "Wedding Gifts",
    body: "Return gifts and welcome-hamper contents for guests, at counts that run into the hundreds. Tell us the guest list size and the per-box budget.",
    points: ["High-count orders", "Consistent presentation", "Staggered delivery dates"],
  },
  {
    anchor: "boxes",
    title: "Premium Gift Boxes",
    body: "Our top grades — mamra almonds, W240 kernels, jumbo pistachios — in a keepsake box for the gift that has to land on its own.",
    points: ["Top-grade kernels only", "Keepsake outer box", "Buy one or a hundred"],
  },
  {
    anchor: "hampers",
    title: "Custom Gift Hampers",
    body: "Pick the contents, the pack sizes and the box. Useful when a standard assortment does not fit the brief or the budget.",
    points: ["Choose every pack", "Match a fixed budget", "Add your own inserts"],
  },
] as const;

function Gifting() {
  const settings = useSiteSettings();
  const { data: giftBoxes } = useProducts({ category: "combos" });
  const boxes = giftBoxes?.items ?? [];

  useSeo({
    title: `Corporate & Festive Dry Fruit Gifting | ${settings.brandName}`,
    description:
      "Corporate, festive, wedding and custom dry fruit gift boxes. Share your box count, budget per box, branding needs and delivery date for a written quotation.",
  });

  return (
    <div>
      <PageBand
        kicker="Gifting"
        title="A gift people finish, not one they pass on."
        intro="The same graded kernels we sell by the kilo, boxed for the occasion. One box or two thousand, with branding, cards and dispatch handled from a single quotation."
      >
        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <a href="#enquiry">Get a gifting quote</a>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/combos">See combo boxes</Link>
          </Button>
        </div>
      </PageBand>

      <div className="container-page pt-10">
        <img
          src="/assets/brand-gifting.webp"
          alt="Nuts & Nazaakat gift assortment"
          width="1536"
          height="1024"
          className="max-h-[520px] w-full object-cover"
        />
      </div>
      <section className="container-page py-16">
        <h2 className="heading-shout">What we put together</h2>
        <div className="mt-6 grid [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))] gap-[18px]">
          {sections.map((s, i) => (
            <article
              key={s.anchor}
              id={s.anchor}
              className="border-border bg-card flex flex-col border px-6 py-[26px]"
            >
              <span className="numeral">0{i + 1}</span>
              <h3 className="font-display mt-3 text-2xl leading-[1.1]">{s.title}</h3>
              <p className="text-body mt-2 text-[14px] leading-[1.6]">{s.body}</p>
              <ul className="mt-4 text-[13px]">
                {s.points.map((p) => (
                  <li key={p} className="border-sand border-t py-2">
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
        <h2 className="heading-shout">Boxes you can order right now</h2>
        <p className="text-body mt-2 text-[14px]">
          Ready assortments, available in single units. Anything larger goes through the enquiry
          form below so we can quote branding and volume.
        </p>
        <div className="mt-6">
          {giftBoxes === undefined ? (
            <ProductGridSkeleton count={4} />
          ) : (
            <div className="grid [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] gap-[18px]">
              {boxes.slice(0, 4).map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      <section id="enquiry" className="container-page scroll-mt-24 pb-20">
        <div className="bg-foreground text-background p-[clamp(28px,4vw,52px)]">
          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))] items-start gap-9">
            <div>
              <h2 className="font-display text-[clamp(28px,3.2vw,42px)]">
                Request a gifting quote
              </h2>
              <p className="text-ink-muted mt-3 max-w-md text-[15px] leading-[1.7]">
                Tell us the volume, budget and date. We come back with box options and a written
                quotation against a request number you can track.
              </p>
            </div>
            <CorporateGiftingForm />
          </div>
        </div>
      </section>
    </div>
  );
}
