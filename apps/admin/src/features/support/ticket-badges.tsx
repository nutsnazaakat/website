import type { SupportTicketStatus } from "@/contract";
import { ToneBadge, type Tone } from "@/components/status-badge";
import { statusLabel } from "@/lib/format";

/**
 * A ticket's status in the console's four tones — the same question as everywhere else: *does this
 * row need me?*
 *
 * - **`new`, `open`** — the desk owes a reply. Gold.
 * - **`waiting`** — waiting on the customer. Neutral; there is nothing to do but wait.
 * - **`resolved`** — fixed. Leaf.
 * - **`closed`** — over, and **not** the same thing as resolved: a ticket closed without ever being
 *   resolved is one where the customer stopped replying. Destructive, so it does not read as a
 *   success beside the ones that were.
 */
const NEEDS_ATTENTION: readonly SupportTicketStatus[] = ["new", "open"];

function toneFor(status: SupportTicketStatus): Tone {
  if (status === "resolved") return "done";
  if (status === "closed") return "stopped";
  if (NEEDS_ATTENTION.includes(status)) return "attention";
  return "working";
}

export function TicketStatusBadge({ status }: { status: SupportTicketStatus }) {
  return <ToneBadge tone={toneFor(status)}>{statusLabel(status)}</ToneBadge>;
}

/**
 * Priority 1–5, 1 most urgent, defaulting to 2 at the column.
 *
 * Only 1 and 2 get a tone. Three through five are all "not urgent" and colouring them would spend
 * the operator's attention on a distinction the desk does not act on.
 */
export function PriorityBadge({ priority }: { priority: number }) {
  if (priority >= 3) {
    return (
      <ToneBadge tone="working" title="Priority 3–5: not urgent.">
        P{priority}
      </ToneBadge>
    );
  }
  return (
    <ToneBadge tone="attention" title={priority === 1 ? "Most urgent." : "Normal urgency."}>
      P{priority}
    </ToneBadge>
  );
}
