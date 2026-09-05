import { toRupees } from '@nutwala/shared';
import type { AdminRfq, AdminRfqNote, AdminRfqSummary, RfqLine } from '@nutwala/shared';
import type { RfqItem } from '../../../entities/b2b/rfq-item.entity';
import type { RfqNote } from '../../../entities/b2b/rfq-note.entity';
import type { Rfq } from '../../../entities/b2b/rfq.entity';
import type { User } from '../../../entities/identity/user.entity';
import { toAdminSalesperson } from '../../business/mappers/admin-business.mapper';
import { toRfqSummary, toWireGiftingDetail } from './rfq.mapper';

/** What the admin shapes need beyond the `Rfq` row itself: the admin named as
 * `assigned_salesperson_id`, resolved by the service so a page costs one read rather than one per
 * row. */
export interface AdminRfqContext {
  salesperson: User | null;
}

function toRfqLine(item: RfqItem): RfqLine {
  return { productSlug: item.productSlug, kg: Number(item.kg) };
}

/**
 * `Rfq` → `AdminRfqSummary` — **brief §34's columns**: RFQ ID, business, contact, products,
 * quantity, expected value, status, assigned salesperson.
 *
 * **Delegates to `toRfqSummary` for the five fields it shares with the customer's own row shape**,
 * exactly as `toAdminOrder` delegates to `toAccountOrder`. That is where `rfqs.status` — a plain
 * `varchar(20)`, not a Postgres enum — is checked against `RFQ_STATUSES` before being cast, and a
 * second cast here would be the copy that stops checking.
 *
 * **Throws on an unloaded `items` relation**, the same guard `toRfqDetail` and `toAccountOrder`
 * both carry. TypeORM types `items` as always-present while leaving it `undefined` when the
 * relation was never selected, so a caller that forgot `relations: { items: true }` would typecheck
 * perfectly and answer `lines: []`, `totalKg: 0` for an enquiry that named three products —
 * silently turning brief §34's "products, quantity" columns into blanks.
 *
 * `totalKg` is summed here rather than left to the client so the quantity column is one number
 * computed in one place. `kg` is `numeric(10,2)`, which `pg` hands back as a string, so `Number()`
 * is doing real work — `'25.00' + '10.00'` would concatenate.
 */
export function toAdminRfqSummary(rfq: Rfq, context: AdminRfqContext): AdminRfqSummary {
  // Widened deliberately: the declared type says this is always an array, and an unloaded relation
  // is the case it is wrong about.
  const items: RfqItem[] | undefined = rfq.items;
  if (items === undefined) {
    throw new Error(`RFQ ${rfq.rfqNumber} cannot be mapped without its items loaded`);
  }

  const lines = items.map(toRfqLine);

  return {
    ...toRfqSummary(rfq),
    contactPerson: rfq.contactPerson,
    mobile: rfq.mobile,
    email: rfq.email,
    lines,
    totalKg: lines.reduce((sum, line) => sum + line.kg, 0),
    expectedValue: rfq.expectedValuePaise === null ? null : toRupees(rfq.expectedValuePaise),
    assignedSalesperson:
      context.salesperson === null ? null : toAdminSalesperson(context.salesperson),
  };
}

/**
 * One `rfq_notes` row — brief §34's internal notes.
 *
 * `authorUser` must be loaded: `authorName` is the whole reason the relation is joined, since a
 * note signed with a uuid is unreadable. `author_user_id` is `ON DELETE RESTRICT`, so unlike the
 * stock ledger's actor it can never be null — an admin who has written a note cannot be deleted,
 * which is a deliberate choice the schema already made.
 */
export function toAdminRfqNote(note: RfqNote): AdminRfqNote {
  const author: User | undefined = note.authorUser;
  if (author === undefined) {
    throw new Error(`RFQ note ${note.id} cannot be mapped without its author loaded`);
  }

  return {
    id: note.id,
    body: note.body,
    authorUserId: note.authorUserId,
    authorName: author.name,
    createdAt: note.createdAt.toISOString(),
  };
}

/**
 * `Rfq` → `AdminRfq`, for `GET /admin/rfqs/:rfqNumber`.
 *
 * **`notes` and `internalNotes` are different things and this is where the difference is kept.**
 * `notes` is `rfqs.notes` — free text the *prospect* typed into brief §17's "additional
 * requirements" box, which `RfqDetail.notes` already shows them back. `internalNotes` is the
 * `rfq_notes` relation — brief §34's sales notes, whose entity says in as many words: *"Never
 * exposed on a customer-facing endpoint."* Nothing merges them, and
 * `POST /admin/rfqs/:rfqNumber/notes` writes only the second.
 *
 * `gifting` is `null` for a bulk enquiry and the row for a gifting one, through the same
 * `toWireGiftingDetail` the customer's own detail uses — one place converts `budgetPerBoxPaise`.
 *
 * `notesList` is required rather than tolerated when absent: a detail route that quietly answered
 * `internalNotes: []` for an enquiry with a note history is a screen an operator would trust.
 */
export function toAdminRfq(rfq: Rfq, context: AdminRfqContext): AdminRfq {
  const notes: RfqNote[] | undefined = rfq.notesList;
  if (notes === undefined) {
    throw new Error(`RFQ ${rfq.rfqNumber} cannot be mapped without its note history loaded`);
  }

  return {
    ...toAdminRfqSummary(rfq, context),
    userId: rfq.userId,
    gstin: rfq.gstin,
    businessType: rfq.businessType,
    pincode: rfq.pincode,
    packaging: rfq.packaging,
    frequency: rfq.frequency,
    notes: rfq.notes,
    // Truthiness rather than `!== null`, so an unloaded relation reads as absent instead of
    // crashing the mapper — `toRfqDetail` makes the same allowance for the same field.
    gifting: rfq.gifting ? toWireGiftingDetail(rfq.gifting) : null,
    internalNotes: notes.map(toAdminRfqNote),
    updatedAt: rfq.updatedAt.toISOString(),
  };
}
