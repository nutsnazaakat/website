import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Plus } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { RfqStatusBadge } from "@/features/rfq/components/RfqStatusBadge";
import { useRfqs } from "@/features/rfq/hooks/useRfqs";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/business/rfqs/")({ component: RfqList });

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/**
 * `GET /rfqs`'s row shape — `RfqSummary` — carries `id`, `kind`, `status`, `businessName` and
 * `createdAt`, and nothing about a request's lines or its gifting brief. Task 9 kept it that
 * lean deliberately: a queue list is not the place to spend a join, and the line-item preview
 * this page used to render (`r.lines.map(...)`, needing the whole catalogue just to name a slug)
 * described the mock's shape, not the server's. The detail page still renders every line — that
 * is what `GET /rfqs/:rfqNumber`'s relations are for.
 */
function RfqList() {
  const { data: rfqs, isLoading } = useRfqs();

  useSeo({
    title: `Quote Requests | ${settings.brandName} for Business`,
    description: "Track every bulk quote request you have raised and the status of each.",
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl">Quote Requests</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Every request we have on file for you, newest first.
          </p>
        </div>
        <Button asChild>
          <Link to="/business/rfqs/new">
            <Plus className="mr-1 size-4" /> New Request
          </Link>
        </Button>
      </div>

      <div className="mt-8">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-2xl" />
            ))}
          </div>
        ) : (rfqs ?? []).length === 0 ? (
          <EmptyState
            title="No quote requests yet."
            body="Raise one and we will come back with written pricing within a working day."
            icon={<ClipboardList className="size-10" />}
            action={
              <Button asChild>
                <Link to="/business/rfqs/new">Request a Quote</Link>
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {(rfqs ?? []).map((r) => (
              <li key={r.id}>
                <Link
                  to="/business/rfqs/$id"
                  params={{ id: r.id }}
                  className="border-border hover:border-primary/50 block rounded-2xl border p-5 transition-colors"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="font-semibold tracking-wide">{r.id}</span>
                    <RfqStatusBadge status={r.status} />
                  </div>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {r.kind === "gifting" ? "Corporate gifting enquiry" : "Bulk quote request"}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {r.businessName} · raised {day(r.createdAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
