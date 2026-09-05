import type { RfqKind, RfqStatus } from "@/contract";
import { nextRfqStatuses } from "@/contract";
import { ToneBadge, type Tone } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { statusLabel } from "@/lib/format";

/**
 * Brief §34's seven-state pipeline, in the console's four tones.
 *
 * The question a colour answers is the one the order table's badge answers: *does this row need
 * me?* So the split is by **whose move it is**, not by how far along the pipeline the enquiry is —
 * an operator triaging a queue of thirty is looking for the ones waiting on the sales desk.
 *
 * - **`new`, `contacted`, `negotiation`, `approved`** — the desk owes the next action: ring them,
 *   send the quote, agree the price, raise the order. Gold.
 * - **`quote-sent`** — the ball is with the prospect. Neutral; nothing to do but wait.
 * - **`converted`** — it became an order. Leaf.
 * - **`rejected`** — it did not. Destructive.
 *
 * Written as a subset check against `readonly RfqStatus[]` rather than a
 * `Record<RfqStatus, Tone>`, exactly as `components/status-badge.tsx` argues for order statuses: a
 * status added to the contract falls through to the safe default instead of silently becoming
 * "needs attention", and a status *misspelt* here stops compiling.
 */
const NEEDS_ATTENTION: readonly RfqStatus[] = ["new", "contacted", "negotiation", "approved"];

function toneFor(status: RfqStatus): Tone {
  if (status === "rejected") return "stopped";
  if (status === "converted") return "done";
  if (NEEDS_ATTENTION.includes(status)) return "attention";
  return "working";
}

export function RfqStatusBadge({ status }: { status: RfqStatus }) {
  const terminal = nextRfqStatuses(status).length === 0;
  return (
    <ToneBadge
      tone={toneFor(status)}
      {...(terminal ? { title: "No further transitions are possible." } : {})}
    >
      {statusLabel(status)}
    </ToneBadge>
  );
}

/**
 * Bulk or gifting.
 *
 * Not a tone badge: the kind is not a state and nothing about it needs the operator's attention.
 * It reads as a label because that is what it is — and the two kinds genuinely carry different
 * fields, so the marker earns its place beside the number.
 */
export function RfqKindBadge({ kind }: { kind: RfqKind }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        kind === "gifting" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {kind === "gifting" ? "Gifting" : "Bulk"}
    </span>
  );
}
