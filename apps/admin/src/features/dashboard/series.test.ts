import { describe, expect, it } from "vitest";
import { fillSalesSeries } from "./series";

describe("fillSalesSeries", () => {
  it("inserts the days the server left out", () => {
    // The real failure this prevents: the seeded database returns 2026-07-28, 08-08, 08-12, 08-21
    // and nothing between. Joining those four points draws steady trade across a fortnight of
    // silence.
    const filled = fillSalesSeries([
      { date: "2026-08-08", sales: 40572, orders: 1 },
      { date: "2026-08-12", sales: 1476.3, orders: 1 },
    ]);

    expect(filled.map((point) => point.date)).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
    expect(filled[1]).toEqual({ date: "2026-08-09", sales: 0, orders: 0 });
    expect(filled[4]).toEqual({ date: "2026-08-12", sales: 1476.3, orders: 1 });
  });

  it("steps across a month boundary", () => {
    const filled = fillSalesSeries([
      { date: "2026-07-30", sales: 100, orders: 1 },
      { date: "2026-08-02", sales: 200, orders: 1 },
    ]);
    expect(filled.map((point) => point.date)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("steps across a leap day and a year boundary", () => {
    expect(
      fillSalesSeries([
        { date: "2028-02-28", sales: 1, orders: 1 },
        { date: "2028-03-01", sales: 1, orders: 1 },
      ]).map((point) => point.date),
    ).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);

    expect(
      fillSalesSeries([
        { date: "2026-12-31", sales: 1, orders: 1 },
        { date: "2027-01-01", sales: 1, orders: 1 },
      ]).map((point) => point.date),
    ).toEqual(["2026-12-31", "2027-01-01"]);
  });

  it("returns nothing for an empty series rather than thirty invented zeroes", () => {
    // An empty database must say "no orders yet". A flat line at zero reads as measured trade.
    expect(fillSalesSeries([])).toEqual([]);
  });

  it("handles a single day", () => {
    expect(fillSalesSeries([{ date: "2026-08-21", sales: 5, orders: 1 }])).toEqual([
      { date: "2026-08-21", sales: 5, orders: 1 },
    ]);
  });

  it("sorts before filling, so an out-of-order response still spans correctly", () => {
    const filled = fillSalesSeries([
      { date: "2026-08-03", sales: 2, orders: 1 },
      { date: "2026-08-01", sales: 1, orders: 1 },
    ]);
    expect(filled.map((point) => point.date)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });
});
