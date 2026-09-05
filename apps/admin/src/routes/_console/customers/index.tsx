import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  CUSTOMER_ROLES,
  CUSTOMERS_PAGE_SIZE,
  fetchCustomers,
  parseCustomerRole,
} from "@/features/customers/api/customers";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateOnly, inr } from "@/lib/format";

/**
 * `/customers` — brief §35's customer list, B2C and B2B separable by the role filter.
 *
 * **`Total spend` excludes cancelled and refunded orders; `Orders` counts every one.** The two
 * figures pull in opposite directions and the column headers say so, because an operator who adds
 * up the order column and divides is reconciling two different questions. The rule is the
 * dashboard's and the customer's own account page's — `AdminCustomerSummary`'s docblock records
 * that revenue must agree across all three — so this screen must not invent a fourth answer by
 * summing anything itself.
 *
 * **Search submits rather than filtering as you type.** Filters live in the URL (9.6a's rule), and
 * writing a search box into the address bar on every keystroke would push a history entry per
 * character — the back button would then walk backwards through a half-typed word — and fire a
 * request per character against a 120/min limit. Enter, or the button, commits it.
 */

interface CustomersSearch {
  q?: string;
  role?: "b2c" | "b2b";
  page?: number;
}

export const Route = createFileRoute("/_console/customers/")({
  validateSearch: (search: Record<string, unknown>): CustomersSearch => {
    const q = search["q"];
    const role = parseCustomerRole(search["role"]);
    const page = Number(search["page"]);

    return {
      // `@MaxLength(200)` on the DTO; a longer string is a 400 rather than a truncated search.
      ...(typeof q === "string" && q.trim() !== "" ? { q: q.trim().slice(0, 200) } : {}),
      ...(role === undefined ? {} : { role }),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: CustomersScreen,
});

function CustomersScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;

  const customers = useQuery({
    queryKey: ["customers", search],
    queryFn: ({ signal }) =>
      fetchCustomers({ ...search, page, limit: CUSTOMERS_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<CustomersSearch>) {
    void navigate({
      search: (previous: CustomersSearch): CustomersSearch => {
        const next: CustomersSearch = { ...previous, ...patch };
        // Page 4 of one filter is rarely where anyone meant to land under another.
        delete next.page;
        for (const key of ["q", "role"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: CustomersSearch): CustomersSearch => {
        const updated: CustomersSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered = search.q !== undefined || search.role !== undefined;
  const total = customers.data?.total ?? 0;

  return (
    <Page
      title="Customers"
      description={
        customers.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "customer" : "customers"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Name, email or phone" htmlFor="filter-q" className="w-64">
            <Input
              // Uncontrolled and remounted when the URL's `q` changes, because the box holds what
              // was typed while the URL holds what is filtering. Without the key, "Clear filters"
              // would empty the query string and leave the old text sitting there, reading as a
              // filter that failed to clear. `products/index.tsx` settled this shape; copied
              // rather than redesigned so the console behaves the same way on every list.
              key={search.q ?? ""}
              id="filter-q"
              maxLength={200}
              placeholder="asha"
              defaultValue={search.q ?? ""}
              // On blur and on Enter rather than on every keystroke: a request per character
              // against a 120/min limit is how an operator rate-limits themselves mid-search.
              onBlur={(event) => setFilter({ q: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ q: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Type" htmlFor="filter-role" className="w-40">
            <Select
              id="filter-role"
              value={search.role ?? ""}
              onChange={(event) => setFilter({ role: parseCustomerRole(event.target.value) })}
            >
              <option value="">Everyone</option>
              {CUSTOMER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role === "b2b" ? "B2B (business)" : "B2C (retail)"}
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

          <p className="text-muted-foreground mb-1.5 ml-auto max-w-md text-right text-[11px]">
            Operator accounts are never listed here — an admin is not a customer, and the
            dashboard&rsquo;s customer count leaves them out too.
          </p>
        </Panel>

        <Panel>
          {customers.isPending ? (
            <Loading label="Loading customers" />
          ) : customers.isError ? (
            <Notice
              tone="error"
              title="Customers could not be loaded."
              body={errorMessage(customers.error)}
              action={
                <Button variant="outline" onClick={() => void customers.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : customers.data.items.length === 0 ? (
            <Notice
              title={isFiltered ? "No customers match these filters." : "No customers yet."}
              body={
                isFiltered
                  ? "Try a shorter search term, or clear the filters to see everyone."
                  : "Accounts registered on the storefront appear here."
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
              <Table caption="Customers, newest first">
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Contact</Th>
                    <Th>Type</Th>
                    <Th numeric>Orders</Th>
                    <Th numeric>Total spend</Th>
                    <Th>Last order</Th>
                    <Th>Joined</Th>
                  </tr>
                </thead>
                <tbody>
                  {customers.data.items.map((customer) => (
                    <Tr key={customer.id}>
                      <Td>
                        <Link
                          to="/customers/$id"
                          params={{ id: customer.id }}
                          className="text-primary font-medium hover:underline"
                        >
                          {customer.name}
                        </Link>
                      </Td>
                      <Td>
                        <span className="block max-w-56 truncate">{customer.email}</span>
                        <span className="text-muted-foreground tnum block text-[11px]">
                          {customer.phone}
                        </span>
                      </Td>
                      <Td>
                        <span className="text-muted-foreground text-[11px] uppercase">
                          {customer.role === "b2b" ? "B2B" : "B2C"}
                        </span>
                      </Td>
                      <Td numeric title="Every order, whatever its status.">
                        {count(customer.orders)}
                      </Td>
                      <Td
                        numeric
                        title="Excludes cancelled and refunded orders, matching the dashboard and the customer's own account page."
                      >
                        {inr(customer.totalSpend)}
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {customer.lastOrderAt === null ? "—" : dateOnly(customer.lastOrderAt)}
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateOnly(customer.createdAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {customers.data !== undefined && customers.data.items.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={CUSTOMERS_PAGE_SIZE}
              onPage={goToPage}
              unit="customer"
            />
          )}
        </Panel>

        <p className="text-muted-foreground text-[11px]">
          <strong className="font-medium">Orders</strong> counts every order this account has
          placed, whatever its status. <strong className="font-medium">Total spend</strong> leaves
          out cancelled and refunded ones, so the two do not reconcile — deliberately. Spend is the
          figure the dashboard and the customer&rsquo;s own account page report.
        </p>
      </div>
    </Page>
  );
}
