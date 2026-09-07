import { createFileRoute, Link } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { RfqStatusBadge } from "@/features/rfq/components/RfqStatusBadge";
import { useRfq } from "@/features/rfq/hooks/useRfqs";
import { useSeo } from "@/hooks/useSeo";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/business/rfqs/$id")({ component: RfqDetail });

function RfqDetail() {
  const settings = useSiteSettings();
  const { id } = Route.useParams();
  const { data: rfq, isLoading } = useRfq(id);
  // Names the lines of this quote request, so it needs the catalogue, not a page of it.
  const { data: catalogue } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];

  useSeo({
    title: `${id} | ${settings.brandName} for Business`,
    description: "Quote request detail, line items and current status.",
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (!rfq) {
    return (
      <div className="py-16 text-center">
        <h1 className="font-display text-3xl">Quote request not found</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          {id} is not on file. It may have been raised from a different account.
        </p>
        <Link
          to="/business/rfqs"
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          Back to quote requests
        </Link>
      </div>
    );
  }

  const nameFor = (slug: string) => products.find((p) => p.slug === slug)?.name ?? slug;

  return (
    <div>
      <nav className="text-muted-foreground text-xs">
        <Link to="/business/rfqs" className="hover:text-foreground">
          Quote Requests
        </Link>{" "}
        / <span className="text-foreground">{rfq.id}</span>
      </nav>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-4xl">{rfq.id}</h1>
        <RfqStatusBadge status={rfq.status} />
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        Raised {new Date(rfq.createdAt).toLocaleString("en-IN")}
      </p>

      <section className="border-border mt-8 overflow-hidden rounded-2xl border">
        <table className="w-full text-sm">
          <thead className="bg-sand text-left">
            <tr>
              <th className="px-4 py-3 font-semibold">Product</th>
              <th className="px-4 py-3 text-right font-semibold">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {rfq.lines.map((l) => (
              <tr key={`${l.productSlug}-${l.kg}`} className="border-border border-t">
                <td className="px-4 py-3">
                  <Link
                    to="/product/$slug"
                    params={{ slug: l.productSlug }}
                    className="hover:underline"
                  >
                    {nameFor(l.productSlug)}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right font-semibold">{l.kg} kg</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border-border mt-6 rounded-2xl border p-5">
        <h2 className="font-display text-2xl">Request details</h2>
        <dl className="mt-4 grid gap-y-2 text-sm sm:grid-cols-[200px_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Business</dt>
          <dd>{rfq.businessName}</dd>
          <dt className="text-muted-foreground">Business type</dt>
          <dd>{rfq.businessType}</dd>
          <dt className="text-muted-foreground">Contact</dt>
          <dd>
            {rfq.contactPerson} · {rfq.mobile} · {rfq.email}
          </dd>
          {rfq.gstin && (
            <>
              <dt className="text-muted-foreground">GSTIN</dt>
              <dd>{rfq.gstin}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Delivery pincode</dt>
          <dd>{rfq.pincode}</dd>
          {rfq.packaging && (
            <>
              <dt className="text-muted-foreground">Packaging</dt>
              <dd>{rfq.packaging}</dd>
            </>
          )}
          {rfq.frequency && (
            <>
              <dt className="text-muted-foreground">Expected frequency</dt>
              <dd>{rfq.frequency}</dd>
            </>
          )}
          {rfq.notes && (
            <>
              <dt className="text-muted-foreground">Additional requirements</dt>
              <dd>{rfq.notes}</dd>
            </>
          )}
        </dl>
      </section>

      {/* Brief §24. A gifting enquiry carries five extra answers; without this block the
          gifting form would write them somewhere nobody can read them back. */}
      {rfq.gifting && (
        <section className="border-border mt-6 rounded-2xl border p-5">
          <h2 className="font-display text-2xl">Gifting brief</h2>
          <dl className="mt-4 grid gap-y-2 text-sm sm:grid-cols-[200px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Number of boxes</dt>
            <dd>{rfq.gifting.boxes}</dd>
            <dt className="text-muted-foreground">Budget per box</dt>
            <dd>{inr(rfq.gifting.budgetPerBox)}</dd>
            <dt className="text-muted-foreground">Branding required</dt>
            <dd>{rfq.gifting.brandingRequired ? "Yes" : "No"}</dd>
            <dt className="text-muted-foreground">Delivery date</dt>
            <dd>{rfq.gifting.deliveryDate}</dd>
            {rfq.gifting.message !== "" && (
              <>
                <dt className="text-muted-foreground">Custom message</dt>
                <dd>{rfq.gifting.message}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      <p className="text-muted-foreground mt-6 text-sm">
        Our B2B desk replies with pricing, samples and dispatch timelines within one working day.
      </p>
    </div>
  );
}
