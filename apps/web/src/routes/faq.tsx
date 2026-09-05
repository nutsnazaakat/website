import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/faq")({ component: Faq });

/**
 * Twelve questions across the four areas the brief calls out: ordering, shipping, bulk
 * and returns. Every answer describes behaviour this site actually implements — the
 * pincode checker, the free-shipping threshold, the slab table, the RFQ flow — so the
 * page stays true as the app changes rather than drifting into marketing copy.
 *
 * The free-shipping figure reads from settings rather than being typed in, because it is
 * the same number the cart enforces.
 */
const groups = [
  {
    title: "Ordering",
    items: [
      {
        q: "Do I need an account to place an order?",
        a: "No. Retail checkout works without one — you only need a delivery address and a mobile number. An account is worth having if you want order history, saved addresses and the ability to reorder, and it is the only way to reach the bulk and quote-request area.",
      },
      {
        q: "What pack sizes can I buy?",
        a: "Retail packs run 100g, 250g, 500g and 1kg. Above that you are into per-kilogram bulk pricing, which starts at 1 kg and steps down in slabs as the quantity rises. Every product page shows both the pack price and the per-100g and per-kilogram rate so you can compare properly.",
      },
      {
        q: "Are prices inclusive of GST?",
        a: "Retail prices shown on product pages are inclusive of taxes. Bulk per-kilogram rates are quoted before GST, and the tax is added on the bulk cart and checkout summary. Both produce a proper invoice with HSN codes.",
      },
      {
        q: "Can I change or cancel an order after placing it?",
        a: "Until it moves to Packed, yes — contact us with the order ID and we will change or cancel it. Once a pack has been filled and sealed against your order it has left our hands, and the returns process applies instead.",
      },
    ],
  },
  {
    title: "Shipping",
    items: [
      {
        q: "How long does delivery take?",
        a: "Two to six working days across India, depending on the pincode. The pincode checker on every product page gives an estimated date and the shipping charge before you add anything to the cart.",
      },
      {
        q: "Is there free shipping?",
        a: `Yes, on retail orders above ${inr(settings.freeShippingThreshold)}. Below that a flat shipping charge applies, and the cart tells you exactly how much more you would need to add to clear the threshold.`,
      },
      {
        q: "Do you deliver everywhere in India?",
        a: "Most pincodes, but not all. Rather than take an order we cannot fulfil, the pincode checker tells you up front whether we serve your area. If we do not, it is worth checking again later — coverage expands.",
      },
      {
        q: "How is the product packed for transit?",
        a: "Retail packs are sealed pouches inside a protective outer carton. Bulk consignments go out as vacuum packs or 25 kg sacks depending on what you selected, which is what keeps quality intact over a long road journey.",
      },
    ],
  },
  {
    title: "Bulk and business",
    items: [
      {
        q: "What is the minimum order for bulk pricing?",
        a: "Per-kilogram slab pricing starts at 1 kg, but each product carries its own minimum order quantity — usually 10 kg, higher on a few specialised grades. The product page states the MOQ next to the quantity selector.",
      },
      {
        q: "How does the slab pricing work?",
        a: "Rates step down as quantity rises, typically across 1–4 kg, 5–9 kg, 10–24 kg, 25–49 kg and 50 kg and above. The rate recalculates as you change the quantity and shows what you save against the base slab. The top slab is usually unpriced, because at that volume the rate depends on grade and schedule — that is what the quote request is for.",
      },
      {
        q: "Can I get a sample before committing to a large order?",
        a: "Yes. We ship 1 kg samples of any grade so you can check colour, crunch and yield first. Ask for one in your quote request and we will price it with the consignment.",
      },
    ],
  },
  {
    title: "Returns and refunds",
    items: [
      {
        q: "What if something arrives damaged or wrong?",
        a: "Tell us within seven days of delivery, with the order ID and a photo where the packaging is involved, and we replace it free. Because these are food products we cannot accept returns on opened packs where nothing is wrong with them.",
      },
    ],
  },
] as const;

function Faq() {
  const questionCount = groups.reduce((n, g) => n + g.items.length, 0);

  useSeo({
    title: `Frequently Asked Questions | ${settings.brandName}`,
    description:
      "Ordering, pack sizes, shipping times, free-shipping threshold, bulk slab pricing, minimum order quantities, samples and the returns window — answered.",
    // Brief §39: FAQPage structured data is the standard fit for this page.
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: groups.flatMap((g) =>
        g.items.map((i) => ({
          "@type": "Question",
          name: i.q,
          acceptedAnswer: { "@type": "Answer", text: i.a },
        })),
      ),
    },
  });

  return (
    <div className="container-page py-14">
      <div className="max-w-2xl">
        <h1 className="font-display text-5xl leading-[1.05]">Frequently asked questions</h1>
        <p className="text-muted-foreground mt-4">
          {questionCount} answers covering ordering, shipping, bulk supply and returns. If yours is
          not here, the contact form reaches us directly.
        </p>
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-10">
          {groups.map((g) => (
            <section key={g.title}>
              <h2 className="font-display text-3xl">{g.title}</h2>
              <Accordion type="single" collapsible className="mt-3">
                {g.items.map((item) => (
                  <AccordionItem key={item.q} value={item.q}>
                    <AccordionTrigger className="text-left">{item.q}</AccordionTrigger>
                    <AccordionContent className="text-muted-foreground text-sm leading-relaxed">
                      {item.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
          ))}
        </div>

        <aside className="space-y-5 lg:sticky lg:top-28 lg:self-start">
          <div className="border-border bg-sand rounded-2xl border p-6">
            <p className="font-display text-xl">Still stuck?</p>
            <p className="text-muted-foreground mt-2 text-sm">
              Send us the order ID and what went wrong. We reply within one working day.
            </p>
            <Button asChild className="mt-4">
              <Link to="/contact">Contact us</Link>
            </Button>
          </div>
          <div className="border-border rounded-2xl border p-6">
            <p className="font-semibold">Related pages</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link to="/shipping" className="underline underline-offset-4">
                  Shipping policy
                </Link>
              </li>
              <li>
                <Link to="/returns" className="underline underline-offset-4">
                  Returns &amp; refunds
                </Link>
              </li>
              <li>
                <Link to="/bulk-orders" className="underline underline-offset-4">
                  Bulk &amp; wholesale
                </Link>
              </li>
              <li>
                <Link to="/quality" className="underline underline-offset-4">
                  Quality &amp; sourcing
                </Link>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
