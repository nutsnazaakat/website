/**
 * The three Indian identifier formats the site validates.
 *
 * Moved out of `frontend/src/features/checkout/schema.ts` so the backend's class-validator
 * DTOs and the frontend's zod schemas apply one definition. A second copy would drift the
 * moment one of them is corrected.
 */

/** 10 digits, starting 6–9, as issued for Indian mobile numbers. */
export const PHONE_REGEX = /^[6-9]\d{9}$/;

/** 6-digit Indian postal code. */
export const PINCODE_REGEX = /^\d{6}$/;

/** 15-character GSTIN: 2-digit state, 5-letter PAN prefix, 4 digits, letter, digit, Z, checksum. */
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/;

/**
 * `NN-{year}-{at least 6 digits}` — the order reference a customer quotes to support.
 *
 * Anchored, and the digit run is `{6,}` rather than `{6}`: the millionth order legitimately carries
 * seven, and a pattern that refused it would make the format claim expire silently rather than the
 * number. `orders.orderNumber` is `varchar(20)`, which has room for eleven.
 *
 * Here rather than in the backend for the reason this file exists at all. It was declared in
 * `backend/src/modules/orders/order-number.ts`, where the frontend cannot reach it, so
 * `routes.smoke.test.tsx` hand-wrote `/^Order ID: NN-\d{4}-\d{6}$/` — **`{6}`**, contradicting the
 * decision above, and failing at order 1,000,000 where the server deliberately succeeds. One
 * definition, both ends.
 */
export const ORDER_NUMBER_PATTERN = /^NN-\d{4}-\d{6,}$/;

/**
 * `RFQ-{year}-{at least 6 digits}` — the same shape as `ORDER_NUMBER_PATTERN`, and for the
 * identical reason: `rfqs.rfqNumber` is `varchar(20)`, with room for the digit run to grow past
 * six, and `{6}` would make the pattern reject the millionth RFQ where the server succeeds.
 *
 * Declared here rather than in `backend/src/modules/rfqs/rfq-number.ts` so the frontend can
 * import the one definition instead of hand-writing a second regex that drifts to `{6}` —
 * `ORDER_NUMBER_PATTERN`'s own docblock records exactly that mistake happening once already.
 */
export const RFQ_NUMBER_PATTERN = /^RFQ-\d{4}-\d{6,}$/;

/**
 * `ST-{year}-{at least 6 digits}` — a support ticket's reference, the same shape as
 * `ORDER_NUMBER_PATTERN`/`RFQ_NUMBER_PATTERN` and for the identical reason: declared here so the
 * frontend's contact-form stub and the backend's `ticket-number.ts` import the one definition
 * instead of a second regex that drifts to `{6}`.
 */
export const TICKET_NUMBER_PATTERN = /^ST-\d{4}-\d{6,}$/;
