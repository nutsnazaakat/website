import type { SavedAddress } from './order';

/**
 * `GET`/`PUT /business/me`'s shape — brief §19's fuller profile, on top of what registration
 * already collected (`CompanyProfile`, in `auth.ts`).
 *
 * `billingAddress`/`shippingAddress` are the resolved rows the business's own two address
 * references point at, never bare ids — `businesses.billing_address_id` and
 * `.shipping_address_id` are references into the same book `GET /account/addresses` already
 * serves, and a client editing this page needs the row to render, not a second round trip to
 * fetch it. `null` for a reference that was never set, or that pointed at an address the
 * customer has since deleted — see `BusinessesService`'s docblock for why a soft-deleted
 * reference reads back as absent rather than as the deleted row.
 *
 * `mobile` is `''` for a business that registered but has never filled in this page —
 * `Business.mobile`'s own docblock is explicit that the column is `NOT NULL` deliberately, so
 * this type carries the empty string honestly rather than a placeholder invented for it.
 *
 * **Deliberately excludes** `segment` and `assignedSalespersonId` — both are commercial/sales
 * decisions about this customer, not something they set or need to see. See
 * `business.mapper.ts`'s docblock for why `segment` in particular must never reach this wire
 * shape.
 */
export interface BusinessProfile {
  companyName: string;
  contactPerson: string;
  mobile: string;
  gstin?: string;
  businessType: string;
  billingAddress: SavedAddress | null;
  shippingAddress: SavedAddress | null;
}

/**
 * `PUT /business/me`'s body — a full replace, not a patch, matching the form it comes from:
 * `business/profile.tsx` always submits every field, so an omitted field here is not "leave
 * unchanged" the way a PATCH would read it.
 *
 * `billingAddressId`/`shippingAddressId` are ids from the caller's own address book, or `null`
 * to clear the reference — never an inline address. `UpdateBusinessDto`'s docblock has the full
 * reasoning: the address book already exists, one-default-per-user enforced, soft-deleted, and
 * writing a second pair of addresses through this endpoint would duplicate every one of those
 * rules and be the copy that drifts.
 */
export interface UpdateBusinessRequest {
  companyName: string;
  contactPerson: string;
  mobile: string;
  gstin?: string;
  businessType: string;
  billingAddressId: string | null;
  shippingAddressId: string | null;
}

/**
 * `GET /business/stats`'s shape — the dashboard's server-computed figures.
 *
 * `openRfqs` counts every enquiry not yet in one of `RFQ_STATUSES`' three closed states
 * (`approved`, `rejected`, `converted`) — brief §34's pipeline has four *open* states
 * (`new`, `contacted`, `quote-sent`, `negotiation`), not the one `'new'` the old client-side
 * `filter` counted before Task 7 gave the vocabulary its real seven values.
 *
 * `bulkSpend` is rupees, per spec §8's money boundary — the server converts from
 * `orders.totalPaise`, and the client no longer sums anything itself.
 */
export interface BusinessStats {
  openRfqs: number;
  bulkSpend: number;
  bulkOrders: number;
}
