import {
  RFQ_STATUSES,
  toRupees,
  type RfqDetail,
  type RfqGiftingDetail as WireRfqGiftingDetail,
  type RfqKind as WireRfqKind,
  type RfqLine,
  type RfqStatus,
  type RfqSummary,
} from '@nutwala/shared';
import type { RfqItem } from '../../../entities/b2b/rfq-item.entity';
import type { Rfq } from '../../../entities/b2b/rfq.entity';
import { RfqKind } from '../../../entities/enums';

/** Backend `RfqKind` is `UPPERCASE`; the wire vocabulary is lowercase, the same split every other
 * Postgres enum in this codebase draws against its wire counterpart (`channel`, `paymentMethod`). */
const KIND: Record<RfqKind, WireRfqKind> = {
  [RfqKind.BULK]: 'bulk',
  [RfqKind.GIFTING]: 'gifting',
};

/** `rfqs.status` is `varchar(20)`, not a Postgres enum, so nothing but this check stands between
 * a stray value and a cast that would compile regardless of what the column actually holds —
 * `order.mapper.ts`'s `toOrderStatus` draws the identical line for the identical reason. */
const RFQ_STATUS_SET: ReadonlySet<string> = new Set<string>(RFQ_STATUSES);

function toRfqStatus(value: string, subject: string): RfqStatus {
  if (!RFQ_STATUS_SET.has(value)) {
    throw new Error(`${subject} carries status "${value}", which is not an RFQ status`);
  }
  return value as RfqStatus;
}

function toRfqLine(item: RfqItem): RfqLine {
  return { productSlug: item.productSlug, kg: Number(item.kg) };
}

/**
 * `Rfq` → `RfqSummary`, for `GET /rfqs`'s row shape. Reads nothing beyond the RFQ's own scalar
 * columns, so — unlike `toRfqDetail` — it never throws on an unloaded relation, because it never
 * loads one.
 */
export function toRfqSummary(rfq: Rfq): RfqSummary {
  return {
    id: rfq.rfqNumber,
    kind: KIND[rfq.kind],
    status: toRfqStatus(rfq.status, `RFQ ${rfq.rfqNumber}`),
    businessName: rfq.businessName,
    createdAt: rfq.createdAt.toISOString(),
  };
}

/**
 * `Rfq` → `RfqDetail`, for `GET /rfqs/:rfqNumber` and for `RfqsService.create`'s own return value
 * once Task 10's controller maps it. The **only** place an `Rfq` becomes this wire shape.
 *
 * **Throws on an unloaded `items` or `gifting` relation, the same guard `order.mapper.ts`'s
 * `toAccountOrder` carries and for the identical reason.** TypeORM types both as always-present —
 * `items: RfqItem[]`, `gifting: RfqGiftingDetail | null` — while leaving them `undefined` when the
 * relation was never selected. A caller that skipped the re-read after `save()` and mapped the
 * raw result straight through would typecheck perfectly and answer `lines: []` on a bulk enquiry
 * that named three products — the exact failure `CheckoutService.place` shipped once already,
 * where an order's `events` went from `undefined` to `timeline: []` for the same reason.
 *
 * `assignedSalespersonId`, `expectedValuePaise` and the `notesList` relation are never read here —
 * see `RfqDetail`'s own docblock for why that omission is load-bearing rather than incidental.
 */
export function toRfqDetail(rfq: Rfq): RfqDetail {
  // Widened deliberately: the declared type says this is always an array, and an unloaded
  // relation is the case it is wrong about.
  const items: RfqItem[] | undefined = rfq.items;
  if (items === undefined) {
    throw new Error(`RFQ ${rfq.rfqNumber} cannot be mapped without its items loaded`);
  }

  const summary = toRfqSummary(rfq);
  // Every caller of this function loads `gifting` alongside `items` in the same `relations`
  // clause — there is no code path that loads one and not the other — so `items` being present
  // is this function's whole evidence that the read was a real one, and `gifting` is trusted at
  // whatever value TypeORM set it to: `null` for a bulk enquiry, the row for a gifting one.
  const gifting = rfq.gifting;

  return {
    ...summary,
    contactPerson: rfq.contactPerson,
    mobile: rfq.mobile,
    email: rfq.email,
    ...(rfq.gstin ? { gstin: rfq.gstin } : {}),
    businessType: rfq.businessType,
    pincode: rfq.pincode,
    ...(rfq.packaging ? { packaging: rfq.packaging } : {}),
    ...(rfq.frequency ? { frequency: rfq.frequency } : {}),
    ...(rfq.notes ? { notes: rfq.notes } : {}),
    lines: items.map(toRfqLine),
    ...(gifting ? { gifting: toWireGiftingDetail(gifting) } : {}),
  };
}

/**
 * Exported as of plan 9.3 so `admin-rfq.mapper.ts` can reuse it. `budgetPerBoxPaise` is the only
 * money on this shape, and one place converting it is the difference between the operator and the
 * prospect reading the same figure. Nothing else about the mapping differs between the two
 * surfaces: brief §24's five questions are the prospect's own answers, and the admin sees them
 * unchanged.
 */
export function toWireGiftingDetail(gifting: NonNullable<Rfq['gifting']>): WireRfqGiftingDetail {
  return {
    occasion: gifting.occasion,
    giftBoxSlug: gifting.giftBoxSlug,
    boxes: gifting.boxes,
    budgetPerBox: toRupees(gifting.budgetPerBoxPaise),
    brandingRequired: gifting.brandingRequired,
    deliveryDate: gifting.deliveryDate,
    message: gifting.message,
  };
}
