import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { CustomerSegment } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  BUSINESSES_PAGE_SIZE,
  fetchBusinesses,
  parseSegment,
  SEGMENT_LABELS,
  SEGMENTS,
} from "@/features/businesses/api/businesses";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateOnly, inr } from "@/lib/format";

/**
 * `/businesses` — brief §35's B2B profile as a list: company, GSTIN, business type, orders, total
 * spend, RFQs, last order, assigned salesperson.
 *
 * **The three trading figures are account-wide, not bulk-only.** `orders`, `totalSpend` and
 * `lastOrderAt` are the same numbers `/customers` reports for the same person, across both
 * channels — brief §46 puts retail and bulk shopping on one account, so a bulk-only total would
 * make the two screens disagree about what one customer has spent. Stated on the screen because an
 * operator looking at a *business* list would reasonably assume otherwise.
 */

interface BusinessesSearch {
  q?: string;
  segment?: CustomerSegment;
  page?: number;
}

export const Route = createFileRoute("/_console/businesses/")({
  validateSearch: (search: Record<string, unknown>): BusinessesSearch => {
    const q = search["q"];
    const segment = parseSegment(search["segment"]);
    const page = Number(search["page"]);

    return {
      ...(typeof q === "string" && q.trim() !== "" ? { q: q.trim().slice(0, 200) } : {}),
      ...(segment === undefined ? {} : { segment }),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: BusinessesScreen,
});

function BusinessesScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;

  const businesses = useQuery({
    queryKey: ["businesses", search],
    queryFn: ({ signal }) =>
      fetchBusinesses({ ...search, page, limit: BUSINESSES_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<BusinessesSearch>) {
    void navigate({
      search: (previous: BusinessesSearch): BusinessesSearch => {
        const next: BusinessesSearch = { ...previous, ...patch };
        delete next.page;
        for (const key of ["q", "segment"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: BusinessesSearch): BusinessesSearch => {
        const updated: BusinessesSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered = search.q !== undefined || search.segment !== undefined;
  const total = businesses.data?.total ?? 0;

  return (
    <Page
      title="Businesses"
      description={
        businesses.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "business" : "businesses"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Company, contact or GSTIN" htmlFor="filter-q" className="w-64">
            {/* Uncontrolled, keyed on the applied term, applied on blur and Enter — the shape
                `products/index.tsx` settled. */}
            <Input
              key={search.q ?? ""}
              id="filter-q"
              maxLength={200}
              placeholder="sweets"
              defaultValue={search.q ?? ""}
              onBlur={(event) => setFilter({ q: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ q: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Price band" htmlFor="filter-segment" className="w-52">
            <Select
              id="filter-segment"
              value={search.segment ?? ""}
              onChange={(event) => setFilter({ segment: parseSegment(event.target.value) })}
            >
              <option value="">All bands</option>
              {SEGMENTS.map((segment) => (
                <option key={segment} value={segment}>
                  {SEGMENT_LABELS[segment]}
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
          {businesses.isPending ? (
            <Loading label="Loading businesses" />
          ) : businesses.isError ? (
            <Notice
              tone="error"
              title="Businesses could not be loaded."
              body={errorMessage(businesses.error)}
              action={
                <Button variant="outline" onClick={() => void businesses.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : businesses.data.items.length === 0 ? (
            <Notice
              title={isFiltered ? "No businesses match these filters." : "No businesses yet."}
              body={
                isFiltered
                  ? "Try a shorter search term, or clear the filters to see everything."
                  : "A B2B registration on the storefront creates the record here."
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
              <Table caption="Businesses, newest first">
                <thead>
                  <tr>
                    <Th>Company</Th>
                    <Th>GSTIN</Th>
                    <Th>Business type</Th>
                    <Th>Price band</Th>
                    <Th numeric>Orders</Th>
                    <Th numeric>Total spend</Th>
                    <Th numeric>RFQs</Th>
                    <Th>Last order</Th>
                    <Th>Salesperson</Th>
                  </tr>
                </thead>
                <tbody>
                  {businesses.data.items.map((business) => (
                    <Tr key={business.id}>
                      <Td>
                        <Link
                          to="/businesses/$id"
                          params={{ id: business.id }}
                          className="text-primary block max-w-56 truncate font-medium hover:underline"
                        >
                          {business.companyName}
                        </Link>
                        <span className="text-muted-foreground block max-w-56 truncate text-[11px]">
                          {business.contactPerson}
                        </span>
                      </Td>
                      <Td className="tnum">{business.gstin ?? "—"}</Td>
                      <Td>{business.businessType}</Td>
                      <Td>
                        <span className="capitalize">{business.segment}</span>
                      </Td>
                      <Td numeric>{count(business.orders)}</Td>
                      <Td
                        numeric
                        title="Excludes cancelled and refunded orders, across both retail and bulk."
                      >
                        {inr(business.totalSpend)}
                      </Td>
                      <Td numeric title="Open enquiries out of the total this account has raised.">
                        {/* One string rather than three children, so it reads as one figure to a
                            screen reader and to a test rather than as "2", "/", "3". */}
                        {`${count(business.openRfqs)} / ${count(business.rfqs)}`}
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {business.lastOrderAt === null ? "—" : dateOnly(business.lastOrderAt)}
                      </Td>
                      <Td className="text-muted-foreground">
                        {business.assignedSalesperson?.name ?? "Unassigned"}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {businesses.data !== undefined && businesses.data.items.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={BUSINESSES_PAGE_SIZE}
              onPage={goToPage}
              unit="business"
              plural="businesses"
            />
          )}
        </Panel>

        <p className="text-muted-foreground text-[11px]">
          <strong className="font-medium">Orders</strong>,{" "}
          <strong className="font-medium">Total spend</strong> and{" "}
          <strong className="font-medium">Last order</strong> cover the whole account, retail and
          bulk together — one account shops both ways, so a bulk-only total would disagree with the
          customer screen about the same person. <strong className="font-medium">RFQs</strong> shows
          open out of total. The <strong className="font-medium">price band</strong> and the{" "}
          <strong className="font-medium">salesperson</strong> are read-only here: there is no
          endpoint that changes them.
        </p>
      </div>
    </Page>
  );
}
