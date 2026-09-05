import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { OrderChannel, OrderStatus } from "@/contract";
import { Page } from "@/components/page";
import { ChannelBadge, PaymentBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, Td, Th, TableWrap, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import { fetchOrders, ORDERS_PAGE_SIZE } from "@/features/orders/api/orders";
import {
  ALL_ORDER_STATUSES,
  ORDER_CHANNELS,
  parseOrderChannel,
  parseOrderStatus,
} from "@/features/orders/statuses";
import { count, dateTime, inr, statusLabel } from "@/lib/format";

/**
 * `/orders` — brief §33's seven columns, filtered from the URL.
 *
 * **The filters live in the search params, not in component state.** A filtered view is then a link
 * an operator can paste into a message, the back button walks the filter history, and a reload
 * keeps the view. The storefront's shop page is the precedent. `validateSearch` is also the only
 * defence that matters against the backend's `forbidNonWhitelisted`: a hand-edited `?status=nonsense`
 * would otherwise be sent verbatim and answered with a 400 the operator cannot interpret.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface OrdersSearch {
  status?: OrderStatus;
  channel?: OrderChannel;
  from?: string;
  to?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/orders/")({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => {
    // Narrowed through the contract's own tuples, never asserted: these values come from the
    // address bar. A hand-edited `?status=nonsense` is dropped here rather than sent to a
    // `forbidNonWhitelisted` endpoint and answered with a 400 nobody can interpret.
    const status = parseOrderStatus(search["status"]);
    const channel = parseOrderChannel(search["channel"]);
    const from = search["from"];
    const to = search["to"];
    const page = Number(search["page"]);

    return {
      ...(status === undefined ? {} : { status }),
      ...(channel === undefined ? {} : { channel }),
      // Date-only, always. `AdminOrderQueryDto` accepts a full instant too, but the service then
      // uses it verbatim rather than resolving it in the business timezone — which would make this
      // screen disagree with the dashboard about which day an order belongs to. Plan 9.4 exists to
      // have one answer to that, server-side.
      ...(typeof from === "string" && DATE_ONLY.test(from) ? { from } : {}),
      ...(typeof to === "string" && DATE_ONLY.test(to) ? { to } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: OrdersScreen,
});

function OrdersScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const page = search.page ?? 1;

  const orders = useQuery({
    queryKey: ["orders", search],
    queryFn: ({ signal }) => fetchOrders({ ...search, page, limit: ORDERS_PAGE_SIZE }, signal),
    // The table keeps its rows while the next page loads, so paging does not collapse the layout
    // to a spinner and back. An operator comparing two pages loses their place otherwise.
    placeholderData: keepPreviousData,
  });

  /** Any filter change resets to page 1: page 4 of a different filter is rarely where anyone meant to be. */
  function setFilter(patch: Partial<OrdersSearch>) {
    void navigate({
      search: (previous: OrdersSearch): OrdersSearch => {
        const next: OrdersSearch = { ...previous, ...patch };
        delete next.page;
        // An empty string from a cleared `<select>` or date input must become *absent*, not
        // `status=`: `toQueryString` would send the empty value and the backend would reject it.
        for (const key of ["status", "channel", "from", "to"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  /**
   * Paging is a search-param change like any other, so the back button walks it and a link to page
   * 3 of a filter is shareable. Page 1 drops the parameter entirely rather than writing `?page=1`,
   * which keeps the unfiltered URL clean.
   */
  function goToPage(next: number) {
    void navigate({
      search: (previous: OrdersSearch): OrdersSearch => {
        const updated: OrdersSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered =
    search.status !== undefined ||
    search.channel !== undefined ||
    search.from !== undefined ||
    search.to !== undefined;

  const total = orders.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));

  return (
    <Page
      title="Orders"
      description={
        orders.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "order" : "orders"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Status" htmlFor="filter-status" className="w-44">
            <Select
              id="filter-status"
              value={search.status ?? ""}
              onChange={(event) => setFilter({ status: parseOrderStatus(event.target.value) })}
            >
              <option value="">All statuses</option>
              {ALL_ORDER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Channel" htmlFor="filter-channel" className="w-32">
            <Select
              id="filter-channel"
              value={search.channel ?? ""}
              onChange={(event) => setFilter({ channel: parseOrderChannel(event.target.value) })}
            >
              <option value="">All channels</option>
              {ORDER_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel === "bulk" ? "B2B (bulk)" : "B2C (retail)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Placed from" htmlFor="filter-from" className="w-36">
            <Input
              id="filter-from"
              type="date"
              value={search.from ?? ""}
              onChange={(event) => setFilter({ from: event.target.value || undefined })}
            />
          </Field>

          <Field label="Placed to" htmlFor="filter-to" className="w-36">
            <Input
              id="filter-to"
              type="date"
              value={search.to ?? ""}
              onChange={(event) => setFilter({ to: event.target.value || undefined })}
            />
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

          <p className="text-muted-foreground mb-1.5 ml-auto text-[11px]">
            {/*
              Said out loud because it is the first thing an operator reaches for and it is not
              there. `AdminOrderQueryDto` has no free-text parameter, and `forbidNonWhitelisted`
              turns an invented one into a 400 rather than an ignored filter.
            */}
            No order-number search yet — the API has no search parameter.
          </p>
        </Panel>

        <Panel>
          {orders.isPending ? (
            <Loading label="Loading orders" />
          ) : orders.isError ? (
            <Notice
              tone="error"
              title="Orders could not be loaded."
              body={errorMessage(orders.error)}
              action={
                <Button variant="outline" onClick={() => void orders.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : orders.data.items.length === 0 ? (
            <Notice
              title={isFiltered ? "No orders match these filters." : "No orders yet."}
              body={
                isFiltered
                  ? "Widen the date range, or clear the filters to see everything."
                  : "Orders placed on the storefront appear here."
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
              <Table caption="Orders, newest first">
                <thead>
                  <tr>
                    <Th>Order ID</Th>
                    <Th>Customer</Th>
                    <Th>B2C/B2B</Th>
                    <Th numeric>Amount</Th>
                    <Th>Payment</Th>
                    <Th>Status</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((order) => (
                    <Tr key={order.id}>
                      <Td>
                        <Link
                          to="/orders/$orderNumber"
                          params={{ orderNumber: order.id }}
                          className="text-primary tnum font-medium hover:underline"
                        >
                          {order.id}
                        </Link>
                      </Td>
                      <Td>
                        <span className="block max-w-56 truncate">{order.customer.name}</span>
                        <span className="text-muted-foreground block max-w-56 truncate text-[11px]">
                          {order.customer.companyName ?? order.customer.email}
                        </span>
                      </Td>
                      <Td>
                        <ChannelBadge channel={order.channel} />
                      </Td>
                      <Td numeric>{inr(order.total)}</Td>
                      <Td>
                        <PaymentBadge method={order.paymentMethod} status={order.paymentStatus} />
                      </Td>
                      <Td>
                        <StatusBadge channel={order.channel} status={order.status} />
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateTime(order.placedAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {orders.data !== undefined && orders.data.items.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-muted-foreground tnum text-[11px]">
                Page {count(page)} of {count(lastPage)} · {count(total)} in total
              </p>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}
