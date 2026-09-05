import type { ReactNode } from "react";
import {
  type OrderChannel,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
  isTerminalStatus,
} from "@/contract";
import { statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A status, rendered so seventeen of them stay distinguishable in one column.
 *
 * **Four tones, not seventeen colours.** Brief §33 names nine retail and eight bulk statuses, and a
 * palette with one hue each turns the order table into confetti — the operator ends up reading the
 * text anyway, having paid for the noise. So the tones answer the only question a colour can
 * usefully answer at a glance: *does this row need me?*
 *
 * - **`attention`** — waiting on the operator to do something (`pending`, `quote-requested`,
 *   `awaiting-payment`, …). Gold.
 * - **`working`** — in flight, nothing to do. Neutral.
 * - **`done`** — `delivered`. Leaf.
 * - **`stopped`** — `cancelled`, `refunded`. Destructive.
 *
 * The **tone is derived, not tabulated**. `isTerminalStatus` comes from the contract, and the
 * attention set is named explicitly because there is no structural way to derive "needs a human"
 * from the transition graph. A hand-written `Record<OrderStatus, Tone>` would be a second
 * vocabulary that stops compiling only if a status is *removed*, never if one is added — spec
 * §7.1's drift, one level down.
 */
export type Tone = "attention" | "working" | "done" | "stopped";

/**
 * The statuses where the order is waiting on an operator rather than on a courier or a customer.
 *
 * Typed `readonly OrderStatus[]` so a value that is not a real status fails to compile, while
 * remaining a *subset* — adding a status to the contract does not silently become "attention", it
 * becomes "working", which is the safe default for a value this file has not been taught about.
 */
const NEEDS_ATTENTION: readonly OrderStatus[] = [
  "pending",
  "confirmed",
  "packed",
  "quote-requested",
  "quote-accepted",
  "awaiting-payment",
];

const STOPPED: readonly OrderStatus[] = ["cancelled", "refunded"];

function toneFor(status: OrderStatus): Tone {
  if (STOPPED.includes(status)) return "stopped";
  if (status === "delivered") return "done";
  if (NEEDS_ATTENTION.includes(status)) return "attention";
  return "working";
}

const TONE_CLASS: Record<Tone, string> = {
  attention: "bg-gold/25 text-gold-foreground dark:text-gold",
  working: "bg-muted text-muted-foreground",
  done: "bg-leaf/15 text-leaf",
  stopped: "bg-destructive/12 text-destructive",
};

export function StatusBadge({ channel, status }: { channel: OrderChannel; status: OrderStatus }) {
  /**
   * `isTerminalStatus` throws on a status that does not belong to the channel — deliberately, per
   * its own docblock, because a yes/no claim about garbage would be indistinguishable from a
   * genuinely finished order. A badge is a display, not a claim, so it degrades: a cross-channel
   * value renders its label with the neutral tone instead of crashing the order list.
   */
  let terminal = false;
  try {
    terminal = isTerminalStatus(channel, status);
  } catch {
    terminal = false;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONE_CLASS[toneFor(status)],
      )}
      title={terminal ? "No further transitions are possible." : undefined}
    >
      {statusLabel(status)}
    </span>
  );
}

/** Brief §33's B2C/B2B column. The wire says `retail`/`bulk`; the brief's own column says B2C/B2B. */
export function ChannelBadge({ channel }: { channel: OrderChannel }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
        channel === "bulk" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {channel === "bulk" ? "B2B" : "B2C"}
    </span>
  );
}

/**
 * Brief §33's **Payment** column, which the wire splits in two — `paymentMethod` and
 * `paymentStatus` — because "COD" and "collected" are different facts. The contract's own note says
 * a console that wants one cell can join them, and this is that join.
 */
/**
 * The four tones on their own, for the vocabularies that are not order statuses.
 *
 * Plan 9.6b adds four more status columns — the RFQ pipeline, review moderation, support tickets,
 * and a coupon's live/expired/off state — and the question a colour answers stays the one this file
 * already settled: *does this row need me?* So they share these four tones rather than each
 * choosing a palette, and the mapping from a vocabulary to a tone lives beside that vocabulary,
 * where the reasoning for it belongs (`features/rfqs/rfq-status-badge.tsx`,
 * `features/support/ticket-badges.tsx`, `features/coupons/coupon-badge.tsx`).
 *
 * Exported from here rather than reimplemented per feature, because four copies of
 * `bg-gold/25 text-gold-foreground` is how two of them end up differing by a shade nobody chose.
 */
export function ToneBadge({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap",
        TONE_CLASS[tone],
      )}
      // Spread rather than `title={title}`, because `exactOptionalPropertyTypes` makes an explicit
      // `undefined` a type error rather than an omitted attribute.
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </span>
  );
}

export function PaymentBadge({ method, status }: { method: PaymentMethod; status: PaymentStatus }) {
  const outstanding = status === "pending";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-muted-foreground text-[11px] uppercase">{method}</span>
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-[11px] font-medium",
          outstanding
            ? "bg-gold/25 text-gold-foreground dark:text-gold"
            : status === "refunded"
              ? "bg-destructive/12 text-destructive"
              : "bg-leaf/15 text-leaf",
        )}
      >
        {statusLabel(status)}
      </span>
    </span>
  );
}
