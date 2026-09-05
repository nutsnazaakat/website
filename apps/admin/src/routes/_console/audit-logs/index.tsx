import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AdminAuditLogEntry } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { AUDIT_PAGE_SIZE, fetchAuditLogs, KNOWN_ENTITIES } from "@/features/audit/api/audit-logs";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateTime } from "@/lib/format";

/**
 * `/audit-logs` — spec §5's trail of what admins did.
 *
 * **§7.1 does not name this a screen.** Plan 9.6b's task B9 says to put it where it is useful, and
 * the sidebar is where an operator will look for it — a trail nobody can reach is a trail nobody
 * reads.
 *
 * **Stock movements are deliberately absent, and the screen says so before the table rather than
 * after.** The failure this prevents is specific: an operator opens this page to find out who wrote
 * off 40 kg of cashews, finds nothing, and concludes the trail is broken. It is not — plan 9.2
 * decided the `inventory_transactions` ledger *is* the audit trail for stock, and it carries the
 * delta, the reason, the resulting balance and the acting admin. Two trails saying the same thing
 * would be two things to keep in step.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface AuditSearch {
  entity?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/audit-logs/")({
  validateSearch: (search: Record<string, unknown>): AuditSearch => {
    const entity = search["entity"];
    const entityId = search["entityId"];
    const action = search["action"];
    const from = search["from"];
    const to = search["to"];
    const page = Number(search["page"]);

    return {
      // The DTO's own `@MaxLength`es — 40, 60, 60. A longer string is a 400, not a truncated filter.
      ...(typeof entity === "string" && entity.trim() !== ""
        ? { entity: entity.trim().slice(0, 40) }
        : {}),
      ...(typeof entityId === "string" && entityId.trim() !== ""
        ? { entityId: entityId.trim().slice(0, 60) }
        : {}),
      ...(typeof action === "string" && action.trim() !== ""
        ? { action: action.trim().slice(0, 60) }
        : {}),
      // Date-only, always: the service resolves a bare `YYYY-MM-DD` in the business timezone and
      // uses a full instant verbatim. Sending an instant computed here would reintroduce the
      // browser's timezone as a second answer to "what day is it".
      ...(typeof from === "string" && DATE_ONLY.test(from) ? { from } : {}),
      ...(typeof to === "string" && DATE_ONLY.test(to) ? { to } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: AuditLogScreen,
});

function AuditLogScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;

  const logs = useQuery({
    queryKey: ["audit-logs", search],
    queryFn: ({ signal }) => fetchAuditLogs({ ...search, page, limit: AUDIT_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<AuditSearch>) {
    void navigate({
      search: (previous: AuditSearch): AuditSearch => {
        const next: AuditSearch = { ...previous, ...patch };
        delete next.page;
        for (const key of ["entity", "entityId", "action", "from", "to"] as const) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: AuditSearch): AuditSearch => {
        const updated: AuditSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered =
    search.entity !== undefined ||
    search.entityId !== undefined ||
    search.action !== undefined ||
    search.from !== undefined ||
    search.to !== undefined;
  const rows = logs.data?.items ?? [];
  const total = logs.data?.total ?? 0;

  return (
    <Page
      title="Audit log"
      description={
        logs.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "entry" : "entries"}${isFiltered ? " matching these filters" : ""}`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="px-3 py-3">
          <p className="text-[12px]">
            <strong className="font-medium">Stock movements are not in this trail.</strong> The
            inventory ledger is their record — it is append-only and carries the change, the reason,
            the resulting balance and who made it, which is more than a row here would say. Look for
            a receipt, a write-off or an adjustment on{" "}
            <Link to="/inventory" className="text-primary hover:underline">
              Inventory
            </Link>
            , under the variant. What <em>is</em> here for stock is <code>inventory.update</code>,
            which is a change to a low-stock threshold and moves no goods.
          </p>
          <p className="text-muted-foreground mt-2 text-[11px]">
            Customers&rsquo; own actions are not here either — placing an order, writing a review —
            because this table is about what operators did. An order&rsquo;s own history is its
            timeline.
          </p>
        </Panel>

        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          {/* Uncontrolled, keyed on the applied value, applied on blur and Enter — the shape
              `products/index.tsx` settled, so every list in the console behaves the same way. */}
          <Field label="Entity" htmlFor="filter-entity" className="w-44">
            <Input
              key={search.entity ?? ""}
              id="filter-entity"
              list="audit-entities"
              maxLength={40}
              placeholder="coupon"
              defaultValue={search.entity ?? ""}
              onBlur={(event) => setFilter({ entity: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ entity: event.currentTarget.value.trim() });
              }}
            />
          </Field>
          {/*
            A datalist, not a select: `AuditEntity` gains a member with every admin write path
            that ships, and a closed list would make a newly-added kind unfilterable until this
            file caught up.
          */}
          <datalist id="audit-entities">
            {KNOWN_ENTITIES.map((known) => (
              <option key={known} value={known} />
            ))}
          </datalist>

          <Field label="Action" htmlFor="filter-action" className="w-44">
            <Input
              key={search.action ?? ""}
              id="filter-action"
              maxLength={60}
              placeholder="coupon.delete"
              defaultValue={search.action ?? ""}
              onBlur={(event) => setFilter({ action: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ action: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Entity id" htmlFor="filter-entity-id" className="w-56">
            <Input
              key={search.entityId ?? ""}
              id="filter-entity-id"
              maxLength={60}
              placeholder="WELCOME10, or a uuid"
              defaultValue={search.entityId ?? ""}
              onBlur={(event) => setFilter({ entityId: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setFilter({ entityId: event.currentTarget.value.trim() });
                }
              }}
            />
          </Field>

          <Field label="From" htmlFor="filter-from" className="w-36">
            <Input
              id="filter-from"
              type="date"
              value={search.from ?? ""}
              onChange={(event) => setFilter({ from: event.target.value || undefined })}
            />
          </Field>
          <Field label="To" htmlFor="filter-to" className="w-36">
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
            Dates are whole days in the business timezone, like the order list.
          </p>
        </Panel>

        <Panel>
          {logs.isPending ? (
            <Loading label="Loading the audit log" />
          ) : logs.isError ? (
            <Notice
              tone="error"
              title="The audit log could not be loaded."
              body={errorMessage(logs.error)}
              action={
                <Button variant="outline" onClick={() => void logs.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title={isFiltered ? "No entries match these filters." : "Nothing recorded yet."}
              body={
                isFiltered
                  ? "Widen the dates, or clear the filters. Remember that a stock movement would not appear here at all — it is in the inventory ledger."
                  : "Every destructive admin action writes a row here. An action that changes nothing writes none."
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
              <Table caption="Admin actions, newest first">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Who</Th>
                    <Th>Action</Th>
                    <Th>On</Th>
                    <Th>What changed</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <Tr key={entry.id}>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateTime(entry.createdAt)}
                      </Td>
                      <Td>{entry.actorName}</Td>
                      <Td className="tnum">{entry.action}</Td>
                      <Td>
                        <span className="block">{entry.entity}</span>
                        <span className="text-muted-foreground tnum block max-w-56 truncate text-[11px]">
                          {entry.entityId ?? "—"}
                        </span>
                      </Td>
                      <Td>
                        <Change entry={entry} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {logs.data !== undefined && rows.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={AUDIT_PAGE_SIZE}
              onPage={goToPage}
              unit="entry"
              plural="entries"
            />
          )}
        </Panel>
      </div>
    </Page>
  );
}

/**
 * The changed fields, before and after.
 *
 * **Only the fields that changed are stored** — never the whole row — so a create has no `before`
 * and a delete no `after`, and those two absences are the row's shape rather than missing data. The
 * values are `unknown` because they come from a `jsonb` column that legitimately holds anything, so
 * they are stringified rather than narrowed: this is a record to read, not data to compute with.
 */
function Change({ entry }: { entry: AdminAuditLogEntry }) {
  const keys = [
    ...new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]),
  ];

  if (keys.length === 0) {
    return <span className="text-muted-foreground text-[11px]">Nothing recorded</span>;
  }

  return (
    <dl className="grid max-w-md grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 text-[11px]">
      {keys.map((key) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground whitespace-nowrap">{key}</dt>
          <dd className="tnum min-w-0 truncate">
            {entry.before === null ? (
              <span>{render(entry.after?.[key])}</span>
            ) : entry.after === null ? (
              <span className="line-through">{render(entry.before[key])}</span>
            ) : (
              <>
                <span className="line-through">{render(entry.before[key])}</span>
                {" → "}
                <span>{render(entry.after[key])}</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function render(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  return JSON.stringify(value);
}
