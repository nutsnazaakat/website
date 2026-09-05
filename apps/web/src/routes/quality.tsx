import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, Home, Leaf, PackageCheck, ScanSearch, Truck } from "lucide-react";
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
    icon: Leaf,
    title: "Source",
    body: "We buy at origin rather than through a chain of resellers, because the variety and the growing region decide most of what a kernel will taste like. Californian and Afghan almonds, W-grade cashews from India and Vietnam, makhana from Bihar, medjool from Jordan.",
    detail: [
      "Origin and variety fixed per product, not per consignment",
      "Grades locked so a repeat order matches the first one",
      "Harvest timing planned around festival demand",
    ],
  },
  {
    icon: ScanSearch,
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
    icon: Boxes,
    title: "Sorting",
    body: "Accepted lots are cleaned and graded before packing. Mechanical destoning and colour sorting do the volume work; a final hand pass removes what a machine reads as acceptable and a person does not.",
    detail: [
      "Destoning and foreign-matter removal",
      "Colour sorting to even out the lot",
      "Hand pass for shrivels, splits and discolouration",
    ],
  },
  {
    icon: PackageCheck,
    title: "Packing",
    body: "Retail packs are filled and sealed after an order is placed rather than held pre-packed on a shelf. Stock is kept in a cool, dry store between sorting and packing, because heat and humidity are what turn oil and soften kernels.",
    detail: [
      "Filled to order, sealed immediately",
      "Batch code on every pouch for traceability",
      "Cool, dry storage between sorting and packing",
    ],
  },
  {
    icon: Truck,
    title: "Dispatch",
    body: "Packs go out in a protective outer carton within one working day. Bulk consignments are vacuum-packed or sacked according to what you asked for on the order, so the quality survives a long road journey.",
    detail: [
      "Dispatched within one working day",
      "Vacuum packs or 25 kg sacks for bulk",
      "Protective outer carton on every shipment",
    ],
  },
  {
    icon: Home,
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
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
            Quality &amp; Sourcing
          </p>
          <h1 className="font-display mt-3 max-w-3xl text-5xl leading-[1.05]">
            Good dry fruit is a supply-chain problem. We treat it like one.
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            Grade, moisture and storage decide how a kernel tastes six weeks after packing. Here is
            exactly what happens between the farm and your shelf, step by step.
          </p>
        </div>
      </section>

      <section className="container-page py-16">
        <h2 className="font-display text-3xl">Source to delivery</h2>
        <ol
          aria-label="Source to delivery journey"
          className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3"
        >
          {journey.map((step, i) => (
            <li
              key={step.title}
              className="border-border bg-card shadow-soft flex flex-col rounded-2xl border p-6"
            >
              <div className="flex items-center gap-3">
                <step.icon className="text-leaf size-5" aria-hidden="true" />
                <span className="text-muted-foreground text-xs font-semibold tracking-[0.2em]">
                  0{i + 1}
                </span>
              </div>
              <h3 className="font-display mt-4 text-2xl">{step.title}</h3>
              <p className="text-muted-foreground mt-2 text-sm">{step.body}</p>
              <ul className="mt-4 space-y-1.5 text-sm">
                {step.detail.map((d) => (
                  <li key={d} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="bg-leaf mt-2 size-1.5 shrink-0 rounded-full"
                    />
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
            <h2 className="font-display text-3xl">Questions we get asked</h2>
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
              <AccordionContent className="text-muted-foreground text-sm">
                Cashews follow the standard count of whole kernels per pound — W240 kernels are
                larger than W320, which is a size measure rather than a quality one. Almonds are
                graded by variety and kernel size: Independence, Mamra and Gurbandi each behave
                differently in mithai, baking and raw snacking.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="b">
              <AccordionTrigger>What do you check on intake?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm">
                Colour and uniformity, moisture judged by whether a kernel snaps or bends, breakage
                against the grade sold, and smell. A lot that fails on any of those is rejected
                rather than blended into the good stock.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="c">
              <AccordionTrigger>Can I get a sample before a bulk order?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm">
                Yes. We ship 1 kg samples of any grade so you can check colour, crunch and yield
                before committing to a consignment. Request one on your quote request.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="d">
              <AccordionTrigger>How long will a pack keep?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground text-sm">
                Nine months from packing while sealed. Once opened, decant into an airtight jar and
                keep it away from heat and light — the storage guide in our journal goes through
                this properly.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        <div className="border-border bg-sand mt-14 flex flex-wrap items-center gap-4 rounded-3xl border p-8">
          <div>
            <p className="font-display text-2xl">Want the spec sheet for a specific grade?</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Our B2B desk shares full specifications and sample pricing against a numbered request.
            </p>
          </div>
          <Button asChild size="lg" className="ml-auto">
            <Link to="/bulk-orders">Talk to our B2B desk</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
