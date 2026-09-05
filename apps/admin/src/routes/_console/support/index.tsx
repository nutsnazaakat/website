import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ContactTopic, SupportTicketStatus } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { errorMessage } from "@/features/orders/api/errors";
import {
  fetchTickets,
  parseContactTopic,
  parseTicketStatus,
  TICKET_STATUSES,
  TICKET_TOPICS,
  TICKETS_PAGE_SIZE,
} from "@/features/support/api/tickets";
import { PriorityBadge, TicketStatusBadge } from "@/features/support/ticket-badges";
import { count, dateTime, statusLabel } from "@/lib/format";

/**
 * `/support` — brief §38's queue, newest first.
 *
 * Newest first rather than oldest, unlike the review moderation queue, and the difference is the
 * server's and deliberate: a review queue is worked to exhaustion in order, while a support desk
 * triages what has just arrived and uses the filters to find the rest.
 *
 * **The assignment filter offers "mine" and nothing else.** `assignedToUserId` takes a uuid, and no
 * endpoint in this service enumerates operator accounts — `GET /admin/customers` excludes admins by
 * design. So the one assignment this app can name is the signed-in operator's own.
 */

interface SupportSearch {
  status?: SupportTicketStatus;
  topic?: ContactTopic;
  mine?: boolean;
  page?: number;
}

export const Route = createFileRoute("/_console/support/")({
  validateSearch: (search: Record<string, unknown>): SupportSearch => {
    const status = parseTicketStatus(search["status"]);
    const topic = parseContactTopic(search["topic"]);
    const mine = search["mine"];
    const page = Number(search["page"]);

    return {
      ...(status === undefined ? {} : { status }),
      ...(topic === undefined ? {} : { topic }),
      // `mine` never reaches the API as itself — it is resolved to `assignedToUserId` below, from
      // the session. Keeping a uuid out of the address bar is the point: a shared link should mean
      // "assigned to whoever opens it", not "assigned to the person who sent it".
      ...(mine === true || mine === "true" ? { mine: true } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: SupportScreen,
});

function SupportScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { user } = useAuth();
  const page = search.page ?? 1;

  const assignedToUserId = search.mine === true && user !== null ? user.id : undefined;

  const tickets = useQuery({
    queryKey: ["tickets", { ...search, assignedToUserId, page }],
    queryFn: ({ signal }) =>
      fetchTickets(
        {
          ...(search.status === undefined ? {} : { status: search.status }),
          ...(search.topic === undefined ? {} : { topic: search.topic }),
          ...(assignedToUserId === undefined ? {} : { assignedToUserId }),
          page,
          limit: TICKETS_PAGE_SIZE,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<SupportSearch>) {
    void navigate({
      search: (previous: SupportSearch): SupportSearch => {
        const next: SupportSearch = { ...previous, ...patch };
        delete next.page;
        if (next.status === undefined) delete next.status;
        if (next.topic === undefined) delete next.topic;
        if (next.mine !== true) delete next.mine;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: SupportSearch): SupportSearch => {
        const updated: SupportSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered =
    search.status !== undefined || search.topic !== undefined || search.mine === true;
  const rows = tickets.data?.items ?? [];
  const total = tickets.data?.total ?? 0;

  return (
    <Page
      title="Support"
      description={
        tickets.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "ticket" : "tickets"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Status" htmlFor="filter-status" className="w-40">
            <Select
              id="filter-status"
              value={search.status ?? ""}
              onChange={(event) => setFilter({ status: parseTicketStatus(event.target.value) })}
            >
              <option value="">All statuses</option>
              {TICKET_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Topic" htmlFor="filter-topic" className="w-60">
            <Select
              id="filter-topic"
              value={search.topic ?? ""}
              onChange={(event) => setFilter({ topic: parseContactTopic(event.target.value) })}
            >
              <option value="">All topics</option>
              {TICKET_TOPICS.map((topic) => (
                <option key={topic} value={topic}>
                  {topic}
                </option>
              ))}
            </Select>
          </Field>

          <label className="mb-1.5 flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={search.mine === true}
              disabled={user === null}
              onChange={(event) => setFilter({ mine: event.target.checked ? true : undefined })}
            />
            Assigned to me
          </label>

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
          {tickets.isPending ? (
            <Loading label="Loading tickets" />
          ) : tickets.isError ? (
            <Notice
              tone="error"
              title="Tickets could not be loaded."
              body={errorMessage(tickets.error)}
              action={
                <Button variant="outline" onClick={() => void tickets.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title={isFiltered ? "No tickets match these filters." : "No tickets yet."}
              body={
                isFiltered
                  ? "Clear the filters to see the whole queue."
                  : "Messages from the storefront's contact form arrive here."
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
              <Table caption="Support tickets, newest first">
                <thead>
                  <tr>
                    <Th>Ticket</Th>
                    <Th>From</Th>
                    <Th>Topic</Th>
                    <Th>Order</Th>
                    <Th>Priority</Th>
                    <Th>Status</Th>
                    <Th>Raised</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ticket) => (
                    <Tr key={ticket.ticketNumber}>
                      <Td>
                        <Link
                          to="/support/$ticketNumber"
                          params={{ ticketNumber: ticket.ticketNumber }}
                          className="text-primary tnum font-medium hover:underline"
                        >
                          {ticket.ticketNumber}
                        </Link>
                        {ticket.assignedToUserId !== null && (
                          <span className="text-muted-foreground block text-[11px]">
                            {user !== null && ticket.assignedToUserId === user.id
                              ? "Assigned to you"
                              : "Assigned"}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <span className="block max-w-48 truncate">{ticket.name}</span>
                        <span className="text-muted-foreground block max-w-48 truncate text-[11px]">
                          {ticket.email}
                        </span>
                      </Td>
                      <Td className="max-w-56">{ticket.topic}</Td>
                      <Td className="tnum text-muted-foreground text-[11px]">
                        {ticket.orderNumber ?? "—"}
                      </Td>
                      <Td>
                        <PriorityBadge priority={ticket.priority} />
                      </Td>
                      <Td>
                        <TicketStatusBadge status={ticket.status} />
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateTime(ticket.createdAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {tickets.data !== undefined && rows.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={TICKETS_PAGE_SIZE}
              onPage={goToPage}
              unit="ticket"
            />
          )}
        </Panel>

        <p className="text-muted-foreground text-[11px]">
          The order number is what the customer typed and is{" "}
          <strong className="font-medium">not</strong> checked against the orders table — a ticket
          is created either way so the desk can answer, so it may name no real order.
        </p>
      </div>
    </Page>
  );
}
