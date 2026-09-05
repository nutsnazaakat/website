import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { RfqKind, RfqStatus } from "@/contract";
import { RFQ_STATUSES } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import {
  fetchRfqs,
  parseRfqKind,
  parseRfqStatus,
  RFQ_KINDS,
  RFQS_PAGE_SIZE,
} from "@/features/rfqs/api/rfqs";
import { RfqKindBadge, RfqStatusBadge } from "@/features/rfqs/rfq-status-badge";
import { count, dateOnly, inr, statusLabel } from "@/lib/format";

/**
 * `/rfqs` — brief §34's queue: RFQ ID, business, contact, products, quantity, expected value,
 * status, assigned salesperson.
 *
 * **The lines are in the row, unlike an order's basket.** §33 gives an order seven columns and none
 * of them is what was bought; §34 asks for "products, quantity", so the lines *are* two of the
 * columns. `AdminRfqSummary` carries them for that reason — an enquiry holds at most twenty lines
 * against an order's unbounded basket, which is what makes the join affordable.
 *
 * **A gifting enquiry has no lines and no kilos.** Its quantity is a number of boxes, which lives
 * on the detail (`AdminRfq.gifting`), so the row says so rather than printing a misleading `0 kg`.
 */

interface RfqsSearch {
  status?: RfqStatus;
  kind?: RfqKind;
  q?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/rfqs/")({
  validateSearch: (search: Record<string, unknown>): RfqsSearch => {
    const status = parseRfqStatus(search["status"]);
    const kind = parseRfqKind(search["kind"]);
    const q = search["q"];
    const page = Number(search["page"]);

    return {
      ...(status === undefined ? {} : { status }),
      ...(kind === undefined ? {} : { kind }),
      ...(typeof q === "string" && q.trim() !== "" ? { q: q.trim().slice(0, 200) } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: RfqsScreen,
});

function RfqsScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;

  const rfqs = useQuery({
    queryKey: ["rfqs", search],
    queryFn: ({ signal }) => fetchRfqs({ ...search, page, limit: RFQS_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<RfqsSearch>) {
    void navigate({
      search: (previous: RfqsSearch): RfqsSearch => {
        const next: RfqsSearch = { ...previous, ...patch };
        delete next.page;
        for (const key of ["status", "kind", "q"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: RfqsSearch): RfqsSearch => {
        const updated: RfqsSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered =
    search.status !== undefined || search.kind !== undefined || search.q !== undefined;
  const total = rfqs.data?.total ?? 0;

  return (
    <Page
      title="Quote requests"
      description={
        rfqs.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "enquiry" : "enquiries"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="RFQ number, company or contact" htmlFor="filter-q" className="w-64">
            {/* Uncontrolled, keyed on the applied term, applied on blur and Enter — the shape
                `products/index.tsx` settled. */}
            <Input
              key={search.q ?? ""}
              id="filter-q"
              maxLength={200}
              placeholder="RFQ-2026-000412"
              defaultValue={search.q ?? ""}
              onBlur={(event) => setFilter({ q: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ q: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Status" htmlFor="filter-status" className="w-44">
            <Select
              id="filter-status"
              value={search.status ?? ""}
              onChange={(event) => setFilter({ status: parseRfqStatus(event.target.value) })}
            >
              <option value="">All statuses</option>
              {RFQ_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Kind" htmlFor="filter-kind" className="w-32">
            <Select
              id="filter-kind"
              value={search.kind ?? ""}
              onChange={(event) => setFilter({ kind: parseRfqKind(event.target.value) })}
            >
              <option value="">Both kinds</option>
              {RFQ_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind === "gifting" ? "Gifting" : "Bulk"}
                </option>
              ))}
            </Select>
          </Field>

          {isFiltered && (
            <Button
              variant="ghost"
              onClick={() => void navigate({ search: {} })}
              className="mb-0.5"
            >
              Clear filters
            </Button>
          )}
        </Panel>

        <Panel>
          {rfqs.isPending ? (
            <Loading label="Loading quote requests" />
          ) : rfqs.isError ? (
            <Notice
              tone="error"
              title="Quote requests could not be loaded."
              body={errorMessage(rfqs.error)}
              action={
                <Button variant="outline" onClick={() => void rfqs.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rfqs.data.items.length === 0 ? (
            <Notice
              title={isFiltered ? "No enquiries match these filters." : "No enquiries yet."}
              body={
                isFiltered
                  ? "Widen the status filter, or clear the filters to see everything."
                  : "Bulk and corporate-gifting enquiries raised on the storefront appear here."
              }
              action={
                isFiltered ? (
                  <Button variant="outline" onClick={() => void navigate({ search: {} })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableWrap>
              <Table caption="Quote requests, newest first">
                <thead>
                  <tr>
                    <Th>RFQ ID</Th>
                    <Th>Business</Th>
                    <Th>Contact</Th>
                    <Th>Products</Th>
                    <Th numeric>Quantity</Th>
                    <Th numeric>Expected value</Th>
                    <Th>Status</Th>
                    <Th>Salesperson</Th>
                    <Th>Raised</Th>
                  </tr>
                </thead>
                <tbody>
                  {rfqs.data.items.map((rfq) => (
                    <Tr key={rfq.id}>
                      <Td>
                        <Link
                          to="/rfqs/$rfqNumber"
                          params={{ rfqNumber: rfq.id }}
                          className="text-primary tnum font-medium hover:underline"
                        >
                          {rfq.id}
                        </Link>
                        <span className="mt-0.5 block">
                          <RfqKindBadge kind={rfq.kind} />
                        </span>
                      </Td>
                      <Td>
                        <span className="block max-w-48 truncate">{rfq.businessName}</span>
                      </Td>
                      <Td>
                        <span className="block max-w-48 truncate">{rfq.contactPerson}</span>
                        <span className="text-muted-foreground tnum block text-[11px]">
                          {rfq.mobile}
                        </span>
                      </Td>
                      <Td>
                        {rfq.lines.length === 0 ? (
                          <span className="text-muted-foreground text-[11px]">
                            {rfq.kind === "gifting" ? "Gift boxes" : "None listed"}
                          </span>
                        ) : (
                          <span className="block max-w-56 truncate" title={productList(rfq.lines)}>
                            {productList(rfq.lines)}
                          </span>
                        )}
                      </Td>
                      <Td numeric>
                        {rfq.kind === "gifting" ? (
                          <span className="text-muted-foreground text-[11px]">
                            Boxes — see detail
                          </span>
                        ) : (
                          `${count(rfq.totalKg)} kg`
                        )}
                      </Td>
                      <Td numeric>
                        {rfq.expectedValue === null ? (
                          <span className="text-muted-foreground text-[11px]">Not set</span>
                        ) : (
                          inr(rfq.expectedValue)
                        )}
                      </Td>
                      <Td>
                        <RfqStatusBadge status={rfq.status} />
                      </Td>
                      <Td className="text-muted-foreground">
                        {rfq.assignedSalesperson?.name ?? "Unassigned"}
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateOnly(rfq.createdAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {rfqs.data !== undefined && rfqs.data.items.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={RFQS_PAGE_SIZE}
              onPage={goToPage}
              unit="enquiry"
              plural="enquiries"
            />
          )}
        </Panel>
      </div>
    </Page>
  );
}

/** The slugs, comma-separated. Slugs rather than names because the summary carries no names. */
function productList(lines: readonly { productSlug: string; kg: number }[]): string {
  return lines.map((line) => `${line.productSlug} (${String(line.kg)} kg)`).join(", ");
}
