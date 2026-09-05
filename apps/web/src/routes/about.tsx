import { createFileRoute, Link } from "@tanstack/react-router";
import { Scale, Sprout, Store, Users } from "lucide-react";
import { TrustSection } from "@/components/common/TrustSection";
import { Button } from "@/components/ui/button";
import { settings } from "@/config/settings";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/about")({ component: About });

/**
 * Brand story only. No founding year, no founder biography, no "since 19xx", no store
 * count, no tonnage — none of that is known, and inventing it would put a fabricated
 * claim on the most-quoted page of the site. Everything below describes how the shop
 * works today, which is verifiable by using it.
 */
const principles = [
  {
    icon: Scale,
    title: "One price list, two kinds of buyer",
    body: "A household buying 250g and a bakery buying 50 kg see the same catalogue, the same grades and the same origins. The only thing that changes is the rate per kilogram.",
  },
  {
    icon: Sprout,
    title: "Origin stated, not implied",
    body: "Every product page names the variety, the grade and where the lot came from. If a product is a blend of origins, it says so rather than picking the flattering one.",
  },
  {
    icon: Store,
    title: "Quantities people actually want",
    body: "100g to 50 kg, with the per-100g and per-kilogram rate shown next to every pack price so a bigger pack is a decision rather than a guess.",
  },
  {
    icon: Users,
    title: "One account for both",
    body: "A café owner who also buys for their kitchen at home does not need a second login. Switch between retail and bulk inside the same account.",
  },
] as const;

function About() {
  useSeo({
    title: `Our Story | ${settings.brandName}`,
    description:
      "Why Nuts & Nazaakat exists: graded dry fruit with the origin stated, sold in whatever quantity you actually need — a 100g pouch or a 50 kg consignment.",
  });

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page py-16">
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
            Our Story
          </p>
          <h1 className="font-display mt-3 max-w-3xl text-5xl leading-[1.05]">
            Small packs for home. Bulk supply for business.
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            {settings.brandName} exists because buying dry fruit well is unreasonably hard. The same
            kernel is sold as four different things at four different prices, the grade is rarely
            stated, and the moment you want more than a kilo you are told to call someone.
          </p>
        </div>
      </section>

      <section className="container-page py-16">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="text-foreground/85 space-y-5 text-[15px] leading-relaxed">
            <h2 className="font-display text-foreground text-3xl">What we set out to fix</h2>
            <p>
              Walk into most dry-fruit shops and you are shown a tray. Nobody tells you whether the
              cashews are W240 or W320, whether the almonds are Californian or Gurbandi, or how long
              the lot has been open to the air. The price is negotiable, which sounds generous and
              usually means the starting number was invented.
            </p>
            <p>
              We wanted the opposite: a catalogue where the variety, the grade and the origin are
              printed next to the price, where the per-kilogram rate is shown so pack sizes can be
              compared honestly, and where wanting fifty kilograms is a normal thing to do on a
              website rather than a reason to be handed a phone number.
            </p>
            <h2 className="font-display text-foreground pt-4 text-3xl">
              Why one shop for homes and businesses
            </h2>
            <p>
              Retail and wholesale are usually run as separate businesses with separate stock,
              separate quality and separate websites. That split is convenient for the seller and
              nobody else. A sweet shop that buys 100 kg of kaju a month is buying the same kernel
              as the person buying 250g for a Sunday halwa — the difference is the quantity and the
              rate, not the product.
            </p>
            <p>
              So the catalogue is shared. Pick a pack size and check out, or pick a quantity in
              kilograms and see the slab rate move as you go. Above the published slabs, or on
              anything that needs a specification conversation, you get a numbered quote request
              instead of a dead end.
            </p>
            <h2 className="font-display text-foreground pt-4 text-3xl">What we will not do</h2>
            <p>
              We will not print a claim we cannot stand behind. If a page here does not show a
              certification badge, that is deliberate — it means the certification is not
              configured, and a plausible-looking placeholder is worse than an empty space. The same
              goes for founding stories, tonnage figures and awards.
            </p>
          </div>

          <div className="space-y-5">
            {principles.map((p) => (
              <div
                key={p.title}
                className="border-border bg-card shadow-soft rounded-2xl border p-6"
              >
                <p.icon className="text-leaf size-5" aria-hidden="true" />
                <p className="mt-4 font-semibold">{p.title}</p>
                <p className="text-muted-foreground mt-1.5 text-sm">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <TrustSection />

      <section className="container-page pb-20">
        <div className="border-border bg-sand rounded-3xl border p-8">
          <h2 className="font-display text-3xl">Start where it suits you</h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Browse the retail catalogue, look at per-kilogram wholesale rates, or read how a
            consignment gets from origin to your shelf.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/shop">Shop Dry Fruits</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/bulk-orders">Buy in Bulk</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link to="/quality">How we source</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
