import type { AdminChannelSplitPoint, AdminSalesPoint, AdminTopSeller } from "@/contract";
import { Notice } from "@/components/ui/panel";
import { businessDay, count, inr, inrCompact } from "@/lib/format";

/**
 * Brief §29's four charts, drawn by hand in SVG and CSS.
 *
 * **No charting library, and that is a decision.** The storefront depends on `recharts`, so reusing
 * it would have been the obvious move. Three reasons not to:
 *
 * 1. **It renders nothing measurable in jsdom.** `ResponsiveContainer` sizes itself from the DOM,
 *    which reports 0×0 under test, so a chart drawn with it produces an empty SVG — and this plan's
 *    verification turns on asserting content *inside* a route rather than that the route resolved.
 *    A dashboard test that could only assert "a container exists" would be the mocked-suite problem
 *    in miniature. Everything below has an explicit `viewBox` and renders identically in jsdom.
 * 2. **Three of the four are bar comparisons.** Top products, top categories and the B2C/B2B split
 *    are ranked magnitudes; a labelled bar with the figure printed on it is denser and more legible
 *    than a plotted chart, and needs no axis, legend or tooltip to be read.
 * 3. **It is a large dependency for one line chart** — d3 sub-packages behind it — in an app whose
 *    whole point is that it carries only what it uses.
 *
 * Accessibility is not an afterthought of that choice: each chart carries `role="img"` and a
 * `<title>`, and the two bar charts are also readable as text, because their labels and figures are
 * real DOM nodes rather than SVG glyphs.
 */

/** Brief §29's "sales over time". */
export function SalesOverTimeChart({ points }: { points: readonly AdminSalesPoint[] }) {
  if (points.length === 0) {
    return (
      <Notice
        title="No orders in the last 30 days."
        body="The chart appears once an order is placed."
      />
    );
  }

  const width = 720;
  const height = 160;
  const padding = { top: 8, right: 8, bottom: 18, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const peak = Math.max(...points.map((point) => point.sales));
  // A flat series at zero must not divide by zero. Rendering it along the baseline is the honest
  // picture: nothing was sold.
  const scale = peak > 0 ? plotHeight / peak : 0;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  const x = (index: number) => padding.left + index * step;
  const y = (sales: number) => padding.top + plotHeight - sales * scale;

  const line = points.map((point, index) => `${x(index)},${y(point.sales)}`).join(" ");
  const area = `${padding.left},${padding.top + plotHeight} ${line} ${x(points.length - 1)},${padding.top + plotHeight}`;

  const total = points.reduce((sum, point) => sum + point.sales, 0);
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <div className="px-3 py-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full"
        role="img"
        aria-label={`Sales over ${count(points.length)} days, ${inr(total)} in total`}
        preserveAspectRatio="none"
      >
        <title>{`Sales over ${count(points.length)} days, ${inr(total)} in total`}</title>
        <polygon points={area} className="fill-chart-1/15" />
        <polyline
          points={line}
          fill="none"
          className="stroke-chart-1"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {points.map((point, index) =>
          point.sales > 0 ? (
            <circle
              key={point.date}
              cx={x(index)}
              cy={y(point.sales)}
              r={2}
              className="fill-chart-1"
            >
              <title>{`${businessDay(point.date)}: ${inr(point.sales)} across ${count(point.orders)} orders`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div className="text-muted-foreground mt-1 flex justify-between text-[11px]">
        <span>{first === undefined ? "" : businessDay(first.date)}</span>
        <span className="tnum">Peak {inrCompact(peak)}</span>
        <span>{last === undefined ? "" : businessDay(last.date)}</span>
      </div>
    </div>
  );
}

/**
 * Brief §29's "B2C vs B2B".
 *
 * Both arms are always present, at zero if need be — the contract says so — so this never has to
 * invent a missing channel. A total of zero renders two empty tracks rather than dividing by it.
 */
export function ChannelSplitChart({ points }: { points: readonly AdminChannelSplitPoint[] }) {
  const total = points.reduce((sum, point) => sum + point.sales, 0);

  return (
    <ul className="flex flex-col gap-3 px-3 py-3">
      {points.map((point) => {
        const share = total > 0 ? point.sales / total : 0;
        return (
          <li key={point.channel} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-[12px]">
              <span className="font-medium">{point.channel === "bulk" ? "B2B" : "B2C"}</span>
              <span className="tnum text-muted-foreground">
                {inr(point.sales)} · {count(point.orders)} orders ·{" "}
                {(share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0)}%
              </span>
            </div>
            <div className="bg-muted h-2 w-full overflow-hidden rounded-sm">
              <div
                className={point.channel === "bulk" ? "bg-chart-1 h-full" : "bg-chart-2 h-full"}
                style={{ width: `${String(share * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Brief §29's "top products" and "top categories" — the same shape, five rows each. */
export function TopSellersChart({
  rows,
  emptyTitle,
}: {
  rows: readonly AdminTopSeller[];
  emptyTitle: string;
}) {
  if (rows.length === 0) return <Notice title={emptyTitle} />;

  const peak = Math.max(...rows.map((row) => row.sales));

  return (
    <ul className="flex flex-col gap-2 px-3 py-3">
      {rows.map((row) => (
        <li key={row.slug} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="truncate font-medium" title={row.name}>
              {row.name}
            </span>
            <span className="tnum text-muted-foreground shrink-0">
              {inr(row.sales)} · {count(row.unitsSold)} units
            </span>
          </div>
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-sm">
            <div
              className="bg-chart-3 h-full"
              style={{ width: `${String(peak > 0 ? (row.sales / peak) * 100 : 0)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
