import { CUSTOMER_SEGMENTS, type CustomerSegment } from "@/contract";

/**
 * Brief §31's four price bands, and the one place their labels live.
 *
 * The wire vocabulary is lowercase (`horeca`) and the column is a Postgres enum; neither is what an
 * operator should read. `statusLabel` in `lib/format.ts` cannot do this one — "horeca" would come
 * back as "Horeca", and HORECA is an initialism (Hotel/Restaurant/Café). So this is a genuine
 * presentation table rather than a second vocabulary: the keys are the contract's own tuple, so a
 * band added there is a compile error here rather than a blank cell.
 */
const LABELS: Record<CustomerSegment, string> = {
  default: "List price",
  retailer: "Retailer",
  distributor: "Distributor",
  horeca: "HORECA",
};

export const SEGMENTS: readonly CustomerSegment[] = CUSTOMER_SEGMENTS;

export function segmentLabel(segment: CustomerSegment): string {
  return LABELS[segment];
}

const SEGMENT_LOOKUP: ReadonlySet<string> = new Set<string>(CUSTOMER_SEGMENTS);

/**
 * Narrowed through the contract's own tuple, never asserted: this value arrives from the address
 * bar and from a `<select>` that can be cleared to the empty string.
 */
export function parseSegment(value: unknown): CustomerSegment | undefined {
  return typeof value === "string" && SEGMENT_LOOKUP.has(value)
    ? CUSTOMER_SEGMENTS.find((segment) => segment === value)
    : undefined;
}
