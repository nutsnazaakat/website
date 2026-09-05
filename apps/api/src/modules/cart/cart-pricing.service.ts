import { Injectable } from '@nestjs/common';
import { gstOn, sumPaise, toPaise, toRupees, type CartTotals, type Paise } from '@nutwala/shared';

/**
 * One line, already resolved to a **line total** in paise — not a unit price.
 *
 * An earlier version of this carried `pricePaise` per unit, which forced the caller to divide a line
 * total by the quantity and forced this service to multiply it back. That round trip loses paise
 * whenever the total is not divisible by the quantity: measured, ₹100 across qty 3 gives a unit of 3333
 * paise, which recomputes to 9999 — **a paise short of the ₹100 the customer was quoted.** Small, and
 * exactly the kind of discrepancy that makes an invoice fail to reconcile against its own lines.
 *
 * Carrying the total removes the division entirely. `lineTotalPaise` is null when the line has no
 * price to bill: normally a quote-required bulk tier, but `quoteRequired` and a null total are
 * separate signals and nothing here enforces that they agree — so both are treated as unpriceable.
 * See `isPriceable` below.
 */
export interface PricedLine {
  mode: 'RETAIL' | 'BULK';
  qty: number;
  kg: string | null;
  lineTotalPaise: Paise | null;
  gstRate: number;
  quoteRequired: boolean;
}

export interface ShippingSettings {
  freeShippingThreshold: number;
  flatShippingRate: number;
}

/**
 * Whether a line can be billed at all.
 *
 * Two independent ways a line can fail to be priceable — `quoteRequired`, and a `lineTotalPaise` the
 * caller could not resolve — and both must exclude it, because the money path cannot survive either:
 * a null reaching `sumPaise` throws `TypeError: Cannot mix BigInt and other types`, and billing a
 * quote line charges for a basket the customer was told needed a quote.
 *
 * Named and shared so `hasUnpriceableLines` is derived from the *same* predicate that decides the money.
 * Written as two separate expressions they drift: a flag reading only `quoteRequired` lets an
 * unpriced line contribute zero to the subtotal and still clear checkout, which is the 50kg order
 * for the cost of shipping by a different route.
 */
const isPriceable = (line: PricedLine): boolean =>
  !line.quoteRequired && line.lineTotalPaise !== null;

@Injectable()
export class CartPricingService {
  /**
   * Totals in rupees, computed in paise.
   *
   * GST is per line and summed, never applied to the aggregate subtotal — spec §8. The frontend's
   * `cart-math.ts` accumulates float rupees and rounds once, so the two figures can differ by a
   * rupee. This one is authoritative; the client replaces its optimistic total with this reply.
   */
  totals(lines: readonly PricedLine[], settings: ShippingSettings): CartTotals {
    const billable = lines.filter(isPriceable);

    // No multiplication: the line total arrives already computed, so there is no unit price to
    // reconstruct and no rounding to lose.
    const lineTotals = billable.map((line) => line.lineTotalPaise as Paise);
    const subtotalPaise = sumPaise(lineTotals);

    const gstPaise = sumPaise(
      billable.map((line, index) => gstOn(lineTotals[index] as Paise, line.gstRate)),
    );

    // Free shipping is decided on the subtotal, matching `cart-math.ts` — not on the GST-inclusive
    // total, or a basket could cross the threshold on tax alone.
    const thresholdPaise = toPaise(settings.freeShippingThreshold);
    const shippingPaise =
      subtotalPaise === 0n || subtotalPaise >= thresholdPaise
        ? 0n
        : toPaise(settings.flatShippingRate);

    return {
      subtotal: toRupees(subtotalPaise),
      gst: toRupees(gstPaise),
      shipping: toRupees(shippingPaise),
      total: toRupees(subtotalPaise + gstPaise + shippingPaise),
      // "Needs a quote", which is what routes a basket to the business track — not "was left out of
      // the money", which is the broader question `hasUnpriceableLines` answers below.
      hasQuoteLines: lines.some((line) => line.quoteRequired),
      // Exactly "some line was left out of the money", by construction rather than by a second
      // predicate that has to be kept in step with `isPriceable`.
      hasUnpriceableLines: billable.length !== lines.length,
    };
  }
}
