import { createFileRoute, Link } from "@tanstack/react-router";
import { PageBand } from "@/components/common/PageBand";
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
      <PageBand
        kicker="Combos"
        title="Four packs, one box, one price."
        intro="Each combo is built from the same packs you can buy on their own, so the saving is arithmetic rather than a claim. Every card shows the MRP of the parts, what they cost separately, and what the box costs."
      />

      <section className="container-page py-16">
        {isLoading || combos === undefined ? (
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[420px] w-full" />
            ))}
          </div>
        ) : (
          <ul
            aria-label="Combo boxes"
            className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]"
          >
            {combos.map((c) => (
              <ComboCard key={c.slug} combo={c} />
            ))}
          </ul>
        )}
      </section>

      <section className="container-page pb-20">
        <div className="border-border bg-card border p-8">
          <h2 className="font-display text-[clamp(28px,3.2vw,42px)]">
            Need a combo built to your own spec?
          </h2>
          <p className="text-body mt-2 max-w-2xl text-[15px]">
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
