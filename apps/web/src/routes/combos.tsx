import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { ComboCard } from "@/features/catalog/components/ComboCard";
import { useCombos } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/combos")({ component: Combos });

function Combos() {
  const { data: combos, isLoading } = useCombos();

  useSeo({
    title: `Dry Fruit Combo Boxes — Six Ready Assortments | ${settings.brandName}`,
    description:
      "Six ready-made dry fruit combos: daily nutrition, premium nuts, family, office snacking, trail mix and festive. Every box shows the MRP of its parts against the combo price.",
  });

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page py-16">
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
            Combos
          </p>
          <h1 className="font-display mt-3 max-w-3xl text-5xl leading-[1.05]">
            One box. Four packs. One price that beats buying them apart.
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            Each combo is built from the same packs you can buy on their own, so the saving is
            arithmetic rather than a claim. Every card shows the MRP of the parts, what they cost
            separately, and what the box costs.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg" variant="outline">
              <Link to="/shop" search={{ category: "combos" }}>
                Browse all combo products
              </Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <Link to="/gifting">
                Gifting boxes <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="container-page py-16">
        {isLoading || combos === undefined ? (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[560px] w-full rounded-3xl" />
            ))}
          </div>
        ) : (
          <ul aria-label="Combo boxes" className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {combos.map((c) => (
              <ComboCard key={c.slug} combo={c} />
            ))}
          </ul>
        )}
      </section>

      <section className="container-page pb-20">
        <div className="border-border bg-card shadow-soft rounded-3xl border p-8">
          <h2 className="font-display text-3xl">Need a combo built to your own spec?</h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Offices, resellers and event planners order assortments we do not stock as standard.
            Tell us the contents, pack sizes and volume and we will quote the box.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/business/rfqs/new">Request a custom combo</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/bulk-orders">See bulk pricing</Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
