import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminSupportTicket } from "@/contract";
import { Detail, DetailList } from "@/components/detail-list";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { useAuth } from "@/features/auth/auth-context";
import { errorMessage } from "@/features/orders/api/errors";
import {
  addTicketNote,
  fetchTicket,
  parseTicketStatus,
  TICKET_STATUSES,
  updateTicket,
} from "@/features/support/api/tickets";
import { PriorityBadge, TicketStatusBadge } from "@/features/support/ticket-badges";
import { dateTime, statusLabel } from "@/lib/format";

/**
 * `/support/$ticketNumber` — one ticket, its message, and the triage on it.
 *
 * `$ticketNumber` rather than `$id` for the reason `orders/$orderNumber` and `rfqs/$rfqNumber` give:
 * `ST-2026-000123` is what the controller is addressed by, with no `ParseUUIDPipe` near it.
 *
 * In `routes/_console/support/` beside `index.tsx`, with no `support.tsx` next to the directory —
 * a sibling file would become the layout route and, without an `<Outlet />`, this child would
 * resolve and paint nothing.
 */
export const Route = createFileRoute("/_console/support/$ticketNumber")({
  component: TicketDetailScreen,
});

function TicketDetailScreen() {
  const { ticketNumber } = Route.useParams();

  const ticket = useQuery({
    queryKey: ["ticket", ticketNumber],
    queryFn: ({ signal }) => fetchTicket(ticketNumber, signal),
  });

  if (ticket.isPending) {
    return (
      <Page title={ticketNumber}>
        <Loading label="Loading the ticket" />
      </Page>
    );
  }

  if (ticket.isError) {
    return (
      <Page title={ticketNumber}>
        <Panel>
          <Notice
            tone="error"
            title="This ticket could not be loaded."
            body={errorMessage(ticket.error)}
            action={
              <Link to="/support" className="text-primary text-[12px] hover:underline">
                Back to support
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const record = ticket.data;

  return (
    <Page
      title={record.ticketNumber}
      description={record.topic}
      actions={
        <>
          <TicketStatusBadge status={record.status} />
          <PriorityBadge priority={record.priority} />
          <Link to="/support">
            <Button variant="outline" size="sm">
              <ArrowLeft />
              All tickets
            </Button>
          </Link>
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <Panel>
            <PanelHeader title="The message" hint={dateTime(record.createdAt)} />
            <p className="px-3 py-3 text-[13px] whitespace-pre-wrap">{record.message}</p>
          </Panel>

          <Panel>
            <PanelHeader title="Who raised it" />
            <DetailList>
              <Detail label="Name">{record.name}</Detail>
              <Detail label="Email">{record.email}</Detail>
              <Detail label="Phone">
                <span className="tnum">{record.phone ?? "Not given"}</span>
              </Detail>
              <Detail label="Topic">{record.topic}</Detail>
              <Detail
                label="Order quoted"
                hint="What the customer typed. It is a soft link — not checked against the orders table — so it may name no real order."
              >
                <span className="tnum">{record.orderNumber ?? "None"}</span>
              </Detail>
              <Detail label="Account">
                {record.userId === null ? (
                  <span className="text-muted-foreground">
                    Raised without signing in — the contact form is public.
                  </span>
                ) : (
                  <Link
                    to="/customers/$id"
                    params={{ id: record.userId }}
                    className="text-primary hover:underline"
                  >
                    Open the account
                  </Link>
                )}
              </Detail>
              <Detail label="Resolved">
                <span className="tnum">
                  {record.resolvedAt === null ? "Not resolved" : dateTime(record.resolvedAt)}
                </span>
              </Detail>
              <Detail label="Last change">
                <span className="tnum">{dateTime(record.updatedAt)}</span>
              </Detail>
            </DetailList>
          </Panel>

          <TicketNotes ticket={record} />
        </div>

        <TicketTriage ticket={record} />
      </div>
    </Page>
  );
}

function useTicketWrite(ticketNumber: string) {
  const client = useQueryClient();
  return (ticket: AdminSupportTicket) => {
    client.setQueryData(["ticket", ticketNumber], ticket);
    void client.invalidateQueries({ queryKey: ["tickets"] });
  };
}

/**
 * Status, priority and assignment.
 *
 * **There are no illegal moves here** — unlike an order or an enquiry, a ticket has no transition
 * table, so every status is reachable from every other. A ticket genuinely does get reopened.
 *
 * The resolution date follows the status and cannot be set directly, which is the point: entering
 * `resolved` stamps it, leaving `resolved` for an open state clears it, and `resolved -> closed`
 * keeps it. So "closed" without a resolution date is a real and meaningful combination — the
 * customer stopped replying.
 */
function TicketTriage({ ticket }: { ticket: AdminSupportTicket }) {
  const apply = useTicketWrite(ticket.ticketNumber);
  const { user } = useAuth();

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof updateTicket>[1]) =>
      updateTicket(ticket.ticketNumber, input),
    onSuccess: (updated) => {
      apply(updated);
      toast.success("Ticket updated.");
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const assignedToMe = user !== null && ticket.assignedToUserId === user.id;

  return (
    <Panel className="h-fit">
      <PanelHeader title="Triage" hint={statusLabel(ticket.status)} />
      <div className="flex flex-col gap-3 px-3 py-3">
        <Field label="Status" htmlFor="ticket-status">
          <Select
            id="ticket-status"
            value={ticket.status}
            disabled={mutation.isPending}
            onChange={(event) => {
              const next = parseTicketStatus(event.target.value);
              if (next !== undefined && next !== ticket.status) mutation.mutate({ status: next });
            }}
          >
            {TICKET_STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Priority" htmlFor="ticket-priority">
          <Select
            id="ticket-priority"
            value={String(ticket.priority)}
            disabled={mutation.isPending}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isInteger(next) && next !== ticket.priority) {
                mutation.mutate({ priority: next });
              }
            }}
          >
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={String(level)}>
                P{level}
                {level === 1 ? " — most urgent" : level === 2 ? " — default" : ""}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-[12px]">
            <span className="text-muted-foreground">Assigned: </span>
            {ticket.assignedToUserId === null
              ? "Nobody"
              : assignedToMe
                ? "You"
                : "Another operator"}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={mutation.isPending || user === null || assignedToMe}
              onClick={() => {
                if (user === null) return;
                mutation.mutate({ assignedToUserId: user.id });
              }}
            >
              Assign to me
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={mutation.isPending || ticket.assignedToUserId === null}
              onClick={() => mutation.mutate({ assignedToUserId: null })}
            >
              Unassign
            </Button>
          </div>
          <p className="text-muted-foreground text-[11px]">
            Only these two: no endpoint lists operator accounts, so the console cannot name anybody
            but the person signed in. Another operator&rsquo;s ticket shows as assigned without a
            name for the same reason — the wire carries a uuid and nothing resolves it.
          </p>
        </div>

        <p className="text-muted-foreground border-border border-t pt-2 text-[11px]">
          Marking a ticket <em>Resolved</em> stamps the resolution time. Moving it back to an open
          state clears it again, because a resolution date on an open ticket would be false. Closing
          a resolved ticket keeps it.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Brief §38's internal notes.
 *
 * Staff-only, and there is no control to make one customer-visible: `isInternal` defaults to true
 * at the column and nothing in this milestone delivers a note to anybody. A tick that promised
 * otherwise would be a promise no code keeps.
 */
function TicketNotes({ ticket }: { ticket: AdminSupportTicket }) {
  const apply = useTicketWrite(ticket.ticketNumber);
  const [body, setBody] = useState("");

  const mutation = useMutation({
    mutationFn: () => addTicketNote(ticket.ticketNumber, body.trim()),
    onSuccess: (updated) => {
      setBody("");
      apply(updated);
      toast.success("Note added.");
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <Panel>
      <PanelHeader
        title="Internal notes"
        hint={ticket.notes.length === 0 ? "None yet" : `${String(ticket.notes.length)} recorded`}
      />
      <div className="flex flex-col gap-3 px-3 py-3">
        {ticket.notes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {ticket.notes.map((note) => (
              <li key={note.id} className="border-border rounded border px-2 py-1.5 text-[12px]">
                <p className="whitespace-pre-wrap">{note.body}</p>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  {note.authorName} · <span className="tnum">{dateTime(note.createdAt)}</span>
                  {note.isInternal ? "" : " · marked customer-visible"}
                </p>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() === "") return;
            mutation.mutate();
          }}
        >
          <Field label="New internal note" htmlFor="ticket-note">
            <Textarea
              id="ticket-note"
              maxLength={4000}
              rows={3}
              placeholder="Called back; customer wants the 5 kg pack instead. Awaiting confirmation."
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={mutation.isPending || body.trim() === ""}>
            {mutation.isPending ? "Saving…" : "Add internal note"}
          </Button>
          <p className="text-muted-foreground text-[11px]">
            Staff-only. Nothing sends a note to the customer, so notes written now cannot be
            published retrospectively if that ever ships. Adding one does not move the ticket.
          </p>
        </form>
      </div>
    </Panel>
  );
}
