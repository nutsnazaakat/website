import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RFQ_STATUSES } from "../types";
import { label, variant, RfqStatusBadge } from "./RfqStatusBadge";

/**
 * Milestone 7, Task 7. `it.each(RFQ_STATUSES)` rather than a hand-typed list of seven strings —
 * so an eighth status added to the shared union is covered here automatically, and a status this
 * suite never mentions by name cannot quietly slip through with an empty badge.
 */
describe("RfqStatusBadge", () => {
  it.each(RFQ_STATUSES)("renders a non-empty label for %s", (status) => {
    expect(label[status]).not.toBe("");
    expect(label[status].length).toBeGreaterThan(0);
  });

  it.each(RFQ_STATUSES)("renders a defined variant for %s", (status) => {
    expect(variant[status]).toBeDefined();
  });

  it.each(RFQ_STATUSES)("actually renders that label for %s, not just the map entry", (status) => {
    render(<RfqStatusBadge status={status} />);
    expect(screen.getByText(label[status])).toBeInTheDocument();
  });

  /**
   * `contacted` and `negotiation` are deliberately the same customer-facing word — two internal
   * pipeline stages, one signal: the enquiry is moving. Pinned so a future edit to one does not
   * silently un-pair them without a reviewer noticing why.
   */
  it("gives contacted and negotiation the identical label on purpose", () => {
    expect(label.contacted).toBe(label.negotiation);
  });
});
