import type { RfqStatus } from '../constants/taxonomy';

/** Lowercase wire vocabulary for `RfqKind` — the same split `Channel`/`OrderChannel` already draw
 * against their own uppercase Postgres enums. */
export type RfqKind = 'bulk' | 'gifting';

/** One product and a weight — a bulk enquiry's line. Absent entirely on a gifting enquiry, whose
 * quantity lives in `RfqDetail.gifting` instead of a line list. */
export interface RfqLine {
  productSlug: string;
  kg: number;
}

/** Brief §24's five extra questions a corporate gifting enquiry asks. */
export interface RfqGiftingDetail {
  occasion: string;
  giftBoxSlug: string;
  boxes: number;
  /** Rupees, per spec §8's money boundary — the column is `budgetPerBoxPaise`. */
  budgetPerBox: number;
  brandingRequired: boolean;
  /** ISO `yyyy-mm-dd`. */
  deliveryDate: string;
  message: string;
}

/** `GET /rfqs`'s row shape — enough to render a queue, nothing that needs a second request. */
export interface RfqSummary {
  /** `RFQ-{year}-{at least 6 digits}` — the reference, never the uuid. See `RFQ_NUMBER_PATTERN`. */
  id: string;
  kind: RfqKind;
  status: RfqStatus;
  businessName: string;
  createdAt: string;
}

/**
 * `GET /rfqs/:rfqNumber`'s shape. Extends `RfqSummary` rather than repeating its fields, the same
 * relationship `AccountOrder` could have drawn against a list-row type had one existed.
 *
 * `packaging`, `frequency`, `notes` and `gifting` are all optional rather than nullable — a
 * gifting enquiry genuinely has no packaging or frequency (brief §24's box *is* the packaging),
 * and the honest wire answer is an absent key, not a `null` a client has to special-case
 * identically anyway.
 *
 * **Deliberately excludes** `assignedSalespersonId`, `expectedValuePaise` and every `RfqNote` —
 * brief §34's own words for the notes relation are *"Never exposed on a customer-facing
 * endpoint."* Both fields exist on the entity and neither has a database-level guard, so keeping
 * them off this type is the only thing standing between an internal sales note and a customer's
 * browser.
 */
export interface RfqDetail extends RfqSummary {
  contactPerson: string;
  mobile: string;
  email: string;
  gstin?: string;
  businessType: string;
  pincode: string;
  packaging?: string;
  frequency?: string;
  notes?: string;
  /** Empty for a gifting enquiry — its quantity is `gifting`, not a line list. */
  lines: RfqLine[];
  gifting?: RfqGiftingDetail;
}

/**
 * `POST /rfqs`'s body — spec §6.1's bulk quote request.
 *
 * Every field here exists on `CreateRfqDto`; the two are checked against each other by the
 * backend's own compilation, since the controller binds the DTO. `gstin` and `notes` are optional
 * here for the same reason they are on `CreateRfqDto` — a prospect raising a bulk enquiry may not
 * be registered yet and may have nothing to add.
 */
export interface CreateRfqRequest {
  businessName: string;
  contactPerson: string;
  mobile: string;
  email: string;
  gstin?: string;
  businessType: string;
  pincode: string;
  lines: RfqLine[];
  packaging: string;
  frequency: string;
  notes?: string;
}

/**
 * `POST /rfqs/gifting`'s body — brief §24's corporate gifting enquiry.
 *
 * Mirrors `CreateGiftingRfqDto` field for field, including its one deliberate difference from
 * `CreateRfqRequest`: `companyName`, not `businessName` — the gifting form's own word for the
 * field, mapped onto the same column at the controller. `budgetPerBox` is rupees, per spec §8's
 * money boundary; the server is what converts it to `budgetPerBoxPaise`.
 */
export interface CreateGiftingRfqRequest {
  companyName: string;
  contactPerson: string;
  mobile: string;
  email: string;
  gstin?: string;
  businessType: string;
  pincode: string;
  occasion: string;
  giftBoxSlug: string;
  boxes: number;
  budgetPerBox: number;
  brandingRequired: boolean;
  /** ISO `yyyy-mm-dd`. */
  deliveryDate: string;
  message?: string;
}
