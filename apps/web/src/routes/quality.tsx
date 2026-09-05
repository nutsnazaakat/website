import { createFileRoute, Link } from "@tanstack/react-router";
import { TrustSection } from "@/components/common/TrustSection";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/quality")({ component: Quality });

/**
 * Brief §25's journey, in the brief's own order and with its own labels:
 * Source → Quality Check → Sorting → Packing → Dispatch → Delivery.
 *
 * Each body describes a process. None of them asserts a certification, an accreditation
 * or a laboratory result — the brief forbids exactly that, and a quality page is where
 * such a claim slips in most easily. Anything of that kind belongs in
 * `settings.certifications`, which `TrustSection` renders and which is empty until an
 * admin fills it.
 */
const journey = [
  {
    title: "Source",
    body: "We buy at origin rather than through a chain of resellers, because the variety and the growing region decide most of what a kernel will taste like. Californian and Afghan almonds, W-grade cashews from India and Vietnam, makhana from Bihar, medjool from Jordan.",
    detail: [
      "Origin and variety fixed per product, not per consignment",
      "Grades locked so a repeat order matches the first one",
      "Harvest timing planned around festival demand",
    ],
  },
  {
    title: "Quality Check",
    body: "Every intake lot is examined before it is accepted into stock. What we look at is what determines how the product behaves on your shelf six weeks later — not a marketing attribute.",
    detail: [
      "Colour and uniformity across the lot",
      "Moisture, judged on snap rather than bend",
      "Breakage and split percentage against the grade sold",
      "Smell, which is the fastest way to catch turned oil",
    ],
  },
  {
    title: "Sorting",
    body: "Accepted lots are cleaned and graded before packing. Mechanical destoning and colour sorting do the volume work; a final hand pass removes what a machine reads as acceptable and a person does not.",
    detail: [
      "Destoning and foreign-matter removal",
      "Colour sorting to even out the lot",
      "Hand pass for shrivels, splits and discolouration",
    ],
  },
  {
    title: "Packing",
    body: "Retail packs are filled and sealed after an order is placed rather than held pre-packed on a shelf. Stock is kept in a cool, dry store between sorting and packing, because heat and humidity are what turn oil and soften kernels.",
    detail: [
      "Filled to order, sealed immediately",
      "Batch code on every pouch for traceability",
      "Cool, dry storage between sorting and packing",
    ],
  },
  {
    title: "Dispatch",
    body: "Packs go out in a protective outer carton within one working day. Bulk consignments are vacuum-packed or sacked according to what you asked for on the order, so the quality survives a long road journey.",
    detail: [
      "Dispatched within one working day",
      "Vacuum packs or 25 kg sacks for bulk",
      "Protective outer carton on every shipment",
    ],
  },
  {
    title: "Delivery",
    body: "Tracked delivery across India, typically in two to six days depending on the pincode. If something arrives damaged or wrong, tell us within seven days and we replace it.",
    detail: [
      "Tracking from dispatch to doorstep",
      "Two to six working days pan-India",
      "Damaged or incorrect items replaced within seven days",
    ],
  },
] as const;

function Quality() {
  useSeo({
    title: `Quality & Sourcing — Source to Delivery | ${settings.brandName}`,
    description:
      "How a consignment moves from origin to your door: sourcing, quality checking on intake, sorting, packing to order, dispatch and delivery.",
  });

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page py-16">
          <p className="kicker mb-5">Quality &amp; Sourcing</p>
          <h1 className="page-h1 max-w-[760px]">
            Good dry fruit is a supply-chain problem. We treat it like one.
          </h1>
          <p className="text-body mt-4 max-w-2xl text-[16px] leading-[1.65]">
            Grade, moisture and storage decide how a kernel tastes six weeks after packing. Here is
            exactly what happens between the farm and your shelf, step by step.
          </p>
        </div>
      </section>

      <section className="container-page py-16">
        <h2 className="heading-shout">Source to delivery</h2>
        <ol
          aria-label="Source to delivery journey"
          className="mt-8 grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]"
        >
          {journey.map((step, i) => (
            <li key={step.title} className="border-border bg-card flex flex-col border px-6 py-[26px]">
              <span className="numeral">0{i + 1}</span>
              <h3 className="font-display mt-3 text-[26px] leading-[1.1]">{step.title}</h3>
              <p className="text-body mt-2 text-[14px] leading-[1.6]">{step.body}</p>
              <ul className="mt-4 text-[13px]">
                {step.detail.map((d) => (
                  <li key={d} className="border-sand border-t py-2">
                    {d}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <TrustSection heading="What we stand behind" />

      <section className="container-page pb-16">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="font-display text-[clamp(28px,3.2vw,42px)]">Questions we get asked</h2>
            <p className="text-muted-foreground mt-3 text-sm">
              If yours is not here, the FAQ page covers ordering, shipping and returns in more
              detail.
            </p>
            <Button asChild variant="outline" className="mt-5">
              <Link to="/faq">Read the FAQs</Link>
            </Button>
          </div>

          <Accordion type="single" collapsible className="self-start">
            <AccordionItem value="a">
              <AccordionTrigger>How do you grade almonds and cashews?</AccordionTrigger>
              <AccordionContent>
                Cashews follow the standard count of whole kernels per pound — W240 kernels are
                larger than W320, which is a size measure rather than a quality one. Almonds are
                graded by variety and kernel size: Independence, Mamra and Gurbandi each behave
                differently in mithai, baking and raw snacking.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="b">
              <AccordionTrigger>What do you check on intake?</AccordionTrigger>
              <AccordionContent>
                Colour and uniformity, moisture judged by whether a kernel snaps or bends, breakage
                against the grade sold, and smell. A lot that fails on any of those is rejected
                rather than blended into the good stock.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="c">
              <AccordionTrigger>Can I get a sample before a bulk order?</AccordionTrigger>
              <AccordionContent>
                Yes. We ship 1 kg samples of any grade so you can check colour, crunch and yield
                before committing to a consignment. Request one on your quote request.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="d">
              <AccordionTrigger>How long will a pack keep?</AccordionTrigger>
              <AccordionContent>
                Nine months from packing while sealed. Once opened, decant into an airtight jar and
                keep it away from heat and light — the storage guide in our journal goes through
                this properly.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        <div className="border-border bg-sand mt-14 grid items-center gap-6 border p-8 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          <div>
            <h2 className="font-display text-[clamp(28px,3.2vw,42px)]">
              Want the spec sheet for a specific grade?
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Our B2B desk shares full specifications and sample pricing against a numbered request.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 md:justify-end">
            <Button asChild size="lg">
              <Link to="/bulk-orders">Talk to our B2B desk</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/faq">Read the FAQs</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
