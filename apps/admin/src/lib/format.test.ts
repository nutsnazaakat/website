import { describe, expect, it } from "vitest";
import { businessDay, count, inr, inrCompact, statusLabel } from "./format";

describe("inr", () => {
  it("groups digits the Indian way", () => {
    // ₹1,00,000 not ₹100,000 — the whole reason this is not `toLocaleString()` with a default.
    expect(inr(100000)).toBe("₹1,00,000");
  });

  it("shows paise only when the amount has any", () => {
    expect(inr(1020)).toBe("₹1,020");
    expect(inr(1020.85)).toBe("₹1,020.85");
  });

  it("formats a wire amount as-is, because the wire is already rupees", () => {
    // The guard against the mistake this codebase's brief invited: `AdminOrderSummary.total` is
    // `1020.85` rupees, not 102085 paise, so nothing here divides by a hundred.
    expect(inr(1020.85)).toBe("₹1,020.85");
    expect(inr(83492.55)).toBe("₹83,492.55");
  });
});

describe("inrCompact", () => {
  it("uses lakh and crore, not thousand-separated Western units", () => {
    expect(inrCompact(83492.55)).toBe("₹83.5K");
    expect(inrCompact(1_250_000)).toBe("₹12.5L");
    expect(inrCompact(34_000_000)).toBe("₹3.4Cr");
  });

  it("drops a trailing .0", () => {
    expect(inrCompact(200000)).toBe("₹2L");
  });

  it("falls back to the full figure below a thousand", () => {
    expect(inrCompact(0)).toBe("₹0");
    expect(inrCompact(940.5)).toBe("₹940.5");
  });
});

describe("count", () => {
  it("groups an order count the Indian way", () => {
    expect(count(0)).toBe("0");
    expect(count(125000)).toBe("1,25,000");
  });
});

describe("businessDay", () => {
  it("reads the server's calendar day rather than reinterpreting it", () => {
    // `new Date("2026-08-21")` is midnight UTC, so any timezone behind Greenwich would render
    // "20 Aug" and silently undo plan 9.4's server-side business-timezone bucketing.
    expect(businessDay("2026-08-21")).toBe("21 Aug");
    expect(businessDay("2026-01-01")).toBe("01 Jan");
  });

  it("hands back anything it cannot parse rather than rendering blank", () => {
    expect(businessDay("nonsense")).toBe("nonsense");
  });
});

describe("statusLabel", () => {
  it("renders brief §33's spellings", () => {
    expect(statusLabel("out-for-delivery")).toBe("Out for Delivery");
    expect(statusLabel("quote-requested")).toBe("Quote Requested");
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("awaiting-payment")).toBe("Awaiting Payment");
  });
});
