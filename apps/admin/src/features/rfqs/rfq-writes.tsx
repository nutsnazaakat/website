import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminRfq, RfqStatus } from "@/contract";
import { nextRfqStatuses } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { useAuth } from "@/features/auth/auth-context";
import { errorMessage } from "@/features/orders/api/errors";
import { allowedRfqTransitionsFrom, isConcurrentRfqModification } from "@/features/rfqs/api/errors";
import { addRfqNote, updateRfq } from "@/features/rfqs/api/rfqs";
import { dateTime, inr, statusLabel } from "@/lib/format";

/**
 * The writes on an enquiry: the pipeline move, the two commercial fields, and the sales trail.
 *
 * All three answer **200 with the whole re-read `AdminRfq`**, so each replaces the detail query's
 * cache from its own result rather than refetching — the same arrangement `order-writes.tsx` uses,
 * for the same reason.
 */

function useRfqWrite(rfqNumber: string) {
  const client = useQueryClient();
  return (rfq: AdminRfq) => {
    client.setQueryData(["rfq", rfqNumber], rfq);
    // The queue's status column and its `total` under a status filter have both moved, and this
    // screen does not know which cached filter combinations this enquiry belongs to.
    void client.invalidateQueries({ queryKey: ["rfqs"] });
    // `pendingRfqs` on the dashboard counts the open ones.
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

/**
 * The pipeline move — brief §34's seven states.
 *
 * The buttons come from `nextRfqStatuses` in the contract, which is **the same table the server
 * validates against**, so an illegal move is not normally offerable. That is UX, not enforcement:
 * when the server refuses with a 422, `allowed` from its own answer replaces the buttons, because
 * by then this screen's idea of the status is the stale one.
 *
 * A **409** is different: same code, no `allowed`, and it means another operator moved the enquiry
 * first. Nothing derived from a stale read can be trusted, so the enquiry is refetched rather than
 * re-offered.
 */
export function RfqStatusWrite({ rfq }: { rfq: AdminRfq }) {
  const apply = useRfqWrite(rfq.id);
  const client = useQueryClient();
  const [serverAllowed, setServerAllowed] = useState<RfqStatus[] | null>(null);

  const mutation = useMutation({
    mutationFn: (status: RfqStatus) => updateRfq(rfq.id, { status }),
    onSuccess: (updated) => {
      setServerAllowed(null);
      apply(updated);
      toast.success(`Enquiry is now ${statusLabel(updated.status)}.`);
    },
    onError: (error: unknown) => {
      const allowed = allowedRfqTransitionsFrom(error);
      if (allowed !== null) {
        setServerAllowed(allowed);
        toast.error(errorMessage(error));
        return;
      }
      if (isConcurrentRfqModification(error)) {
        void client.invalidateQueries({ queryKey: ["rfq", rfq.id] });
        toast.error("Somebody else moved this enquiry. It has been reloaded.");
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const options = serverAllowed ?? nextRfqStatuses(rfq.status);

  return (
    <Panel>
      <PanelHeader title="Pipeline" hint={statusLabel(rfq.status)} />
      <div className="flex flex-col gap-3 px-3 py-3">
        {options.length === 0 ? (
          <p className="text-muted-foreground text-[12px]">
            {serverAllowed === null
              ? `An enquiry that is ${statusLabel(rfq.status)} is finished — nothing moves it backwards.`
              : "The server reports no legal transitions from here."}
          </p>
        ) : (
          <>
            {serverAllowed !== null && (
              <p role="status" className="text-muted-foreground text-[12px]">
                The server refused that move. From {statusLabel(rfq.status)} it allows only what is
                shown below.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {options.map((status) => (
                <Button
                  key={status}
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(status)}
                >
                  {mutation.isPending && mutation.variables === status
                    ? "Saving…"
                    : `Mark ${statusLabel(status)}`}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-[11px]">
              Moving an enquiry notifies the prospect and writes an audit row. Marking it{" "}
              <em>Converted</em> records that it became an order; it does not create one.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * Brief §34's expected value and assigned salesperson — the two facts that *are* editable here,
 * unlike on `/businesses/$id`, where the equivalent fields have no endpoint at all.
 *
 * **There is no salesperson picker, because there is no endpoint that lists salespeople.** A
 * salesperson is an admin *user* (`business.entity.ts` settled that rather than a staff table), and
 * `GET /admin/customers` deliberately excludes admins — its `role` filter is `b2c|b2b` and the
 * service filters `role <> 'ADMIN'` regardless. Nothing else enumerates operator accounts. So this
 * offers the two assignments it can make honestly: **the signed-in operator**, whose id this app
 * already holds, and **nobody**. Anything else needs `GET /admin/salespeople`, which §6.4 never
 * specified.
 *
 * `null` clears the assignment and `undefined` leaves it alone — `UpdateRfqDto` guards both fields
 * with `@ValidateIf((_o, value) => value !== null)` precisely so the two can be told apart.
 */
export function RfqCommercialWrite({ rfq }: { rfq: AdminRfq }) {
  const apply = useRfqWrite(rfq.id);
  const { user } = useAuth();
  const [value, setValue] = useState(rfq.expectedValue === null ? "" : String(rfq.expectedValue));

  const mutation = useMutation({
    mutationFn: (input: { expectedValue?: number | null; assignedSalespersonId?: string | null }) =>
      updateRfq(rfq.id, input),
    onSuccess: (updated) => {
      setValue(updated.expectedValue === null ? "" : String(updated.expectedValue));
      apply(updated);
      toast.success("Enquiry updated.");
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const assignedToMe = user !== null && rfq.assignedSalesperson?.id === user.id;

  return (
    <Panel>
      <PanelHeader
        title="Commercial"
        hint={rfq.expectedValue === null ? "No value set" : inr(rfq.expectedValue)}
      />
      <form
        className="flex flex-col gap-3 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (trimmed === "") {
            // An emptied box means "clear it", which is a real write and not a no-op.
            mutation.mutate({ expectedValue: null });
            return;
          }
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed) || parsed < 0) {
            toast.error("Expected value must be a number of rupees, or blank to clear it.");
            return;
          }
          mutation.mutate({ expectedValue: Math.round(parsed * 100) / 100 });
        }}
      >
        <Field label="Expected value (₹)" htmlFor="rfq-value">
          <Input
            id="rfq-value"
            inputMode="decimal"
            placeholder="Blank clears it"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save expected value"}
        </Button>
        <p className="text-muted-foreground text-[11px]">
          Rupees, up to two decimals, capped at ₹1,00,00,000 by the server. This is the sales
          desk&rsquo;s own estimate — nothing computes it from the lines.
        </p>
      </form>

      <div className="border-border flex flex-col gap-2 border-t px-3 py-3">
        <p className="text-[12px]">
          <span className="text-muted-foreground">Salesperson: </span>
          {rfq.assignedSalesperson === null ? (
            "Unassigned"
          ) : (
            <span className="font-medium">
              {rfq.assignedSalesperson.name}{" "}
              <span className="text-muted-foreground font-normal">
                ({rfq.assignedSalesperson.email})
              </span>
            </span>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || user === null || assignedToMe}
            onClick={() => {
              if (user === null) return;
              mutation.mutate({ assignedSalespersonId: user.id });
            }}
          >
            Assign to me
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={mutation.isPending || rfq.assignedSalesperson === null}
            onClick={() => mutation.mutate({ assignedSalespersonId: null })}
          >
            Unassign
          </Button>
        </div>
        <p className="text-muted-foreground text-[11px]">
          Only these two, because no endpoint lists operator accounts — a salesperson is an admin
          user, and the customer list deliberately excludes admins. Assigning somebody else needs a
          route that does not exist yet.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Brief §34's internal notes — **the private sales trail, and never the prospect's own text**.
 *
 * The two are different fields and confusing them is a privacy bug, not a display one.
 * `rfqs.notes` is what the prospect typed into the public form's "additional requirements" box and
 * is rendered back to them on their enquiry page; `rfq_notes` is what the desk writes about them.
 * `POST /admin/rfqs/:rfqNumber/notes` only ever writes the second — there is no admin route that
 * edits the first, which is the correct arrangement — so the heading, the placeholder and the
 * sentence under the box all say "internal" out loud rather than relying on the reader knowing.
 */
export function RfqNoteWrite({ rfq }: { rfq: AdminRfq }) {
  const apply = useRfqWrite(rfq.id);
  const [body, setBody] = useState("");

  const mutation = useMutation({
    mutationFn: () => addRfqNote(rfq.id, body.trim()),
    onSuccess: (updated) => {
      setBody("");
      apply(updated);
      toast.success("Internal note added.");
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  return (
    <Panel>
      <PanelHeader
        title="Internal notes"
        hint={
          rfq.internalNotes.length === 0
            ? "None yet"
            : `${String(rfq.internalNotes.length)} recorded`
        }
      />
      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="text-muted-foreground text-[11px]">
          Staff only. These are never shown to the customer and are not reachable from any
          customer-facing endpoint.
        </p>

        {rfq.internalNotes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rfq.internalNotes.map((note) => (
              <li key={note.id} className="border-border rounded border px-2 py-1.5 text-[12px]">
                <p className="whitespace-pre-wrap">{note.body}</p>
                <p className="text-muted-foreground mt-1 text-[11px]">
                  {note.authorName} · <span className="tnum">{dateTime(note.createdAt)}</span>
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
          <Field label="New internal note" htmlFor="rfq-note">
            <Textarea
              id="rfq-note"
              maxLength={4000}
              rows={3}
              placeholder="Rang the buyer; wants 200 kg a month from October."
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={mutation.isPending || body.trim() === ""}>
            {mutation.isPending ? "Saving…" : "Add internal note"}
          </Button>
        </form>
      </div>
    </Panel>
  );
}
