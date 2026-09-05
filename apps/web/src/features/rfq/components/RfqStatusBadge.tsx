import { Badge } from "@/components/ui/badge";
import type { RfqStatus } from "../types";

/**
 * Customer-facing wording for the sales desk's seven-state pipeline (brief §34).
 *
 * `contacted` and `negotiation` deliberately share a label: a customer does not need to know
 * whether the desk has phoned them or is haggling internally, only that the enquiry is moving.
 * Exported so `RfqStatusBadge.test.tsx` can assert every entry directly rather than only through
 * a render, the same way a missing key here is a compile error and not a badge that renders
 * nothing.
 */
export const label: Record<RfqStatus, string> = {
  new: "Received",
  contacted: "In progress",
  "quote-sent": "Quote sent",
  negotiation: "In progress",
  approved: "Approved",
  rejected: "Closed",
  converted: "Ordered",
};

/** Badge tone. `destructive` is reserved for the one state that ends the enquiry unfavourably. */
export const variant: Record<RfqStatus, "default" | "secondary" | "outline" | "destructive"> = {
  new: "outline",
  contacted: "secondary",
  "quote-sent": "default",
  negotiation: "secondary",
  approved: "secondary",
  rejected: "destructive",
  converted: "secondary",
};

export function RfqStatusBadge({ status }: { status: RfqStatus }) {
  return <Badge variant={variant[status]}>{label[status]}</Badge>;
}
