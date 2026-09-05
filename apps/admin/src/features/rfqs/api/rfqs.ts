import type { AdminRfq, AdminRfqSummary, Paginated, RfqKind, RfqStatus } from "@/contract";
import { RFQ_STATUSES } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The quote-request seam — `GET /admin/rfqs`, its detail, and the two writes. Brief §34.
 *
 * Every path is addressed by the **RFQ number** (`RFQ-2026-000123`), never a uuid: `AdminRfq.id`
 * *is* the number, `AdminRfqsController` puts no `ParseUUIDPipe` on `:rfqNumber`, and it is the
 * reference an operator reads down a phone line.
 *
 * **Money is rupees.** `expectedValue` and a gifting enquiry's `budgetPerBox` both arrive
 * converted, and `UpdateRfqDto` takes rupees back — `@IsNumber({ maxDecimalPlaces: 2 })`, up to ten
 * million. Nothing here multiplies or divides by a hundred.
 */

const STATUS_LOOKUP: ReadonlySet<string> = new Set<string>(RFQ_STATUSES);

/** A type predicate rather than a cast: the value comes from the address bar or an error envelope. */
export function isRfqStatus(value: unknown): value is RfqStatus {
  return typeof value === "string" && STATUS_LOOKUP.has(value);
}

export function parseRfqStatus(value: unknown): RfqStatus | undefined {
  return isRfqStatus(value) ? value : undefined;
}

/**
 * `bulk` and `gifting`.
 *
 * Declared here rather than imported because the contract exports `RfqKind` as a type only — there
 * is no `RFQ_KINDS` tuple in `@nutwala/shared`, though `AdminRfqQueryDto` has one of its own. The
 * annotation is what keeps the two in step: adding a third kind to `RfqKind` leaves this array
 * valid but incomplete, while misspelling one stops compiling.
 */
export const RFQ_KINDS: readonly RfqKind[] = ["bulk", "gifting"];

export function parseRfqKind(value: unknown): RfqKind | undefined {
  return value === "bulk" || value === "gifting" ? value : undefined;
}

/**
 * What `GET /admin/rfqs` accepts, and nothing else.
 *
 * `q` matches the RFQ number, the business name and the contact — worth having, because the number
 * is what a prospect quotes on the phone.
 */
export interface RfqListQuery {
  status?: RfqStatus;
  kind?: RfqKind;
  q?: string;
  page?: number;
  limit?: number;
}

/** `AdminRfqQueryDto`'s `@Min(1) @Max(60)`. */
export const RFQS_PAGE_SIZE = 24;

export function fetchRfqs(
  query: RfqListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminRfqSummary>> {
  return http.get<Paginated<AdminRfqSummary>>(`/admin/rfqs${toQueryString({ ...query })}`, signal);
}

export function fetchRfq(rfqNumber: string, signal?: AbortSignal): Promise<AdminRfq> {
  return http.get<AdminRfq>(`/admin/rfqs/${encodeURIComponent(rfqNumber)}`, signal);
}

/**
 * `PATCH /admin/rfqs/:rfqNumber` — brief §34's three editable facts.
 *
 * All three in one transaction, with **the status move attempted first**, so an illegal transition
 * costs no write at all: the salesperson and the expected value are left exactly as they were.
 * An illegal move answers `422 ILLEGAL_STATUS_TRANSITION` carrying `allowed`; a concurrent move
 * answers `409` with the same code and no `allowed`. See `errors.ts`.
 *
 * **`null` is a meaningful value and `undefined` is not.** `UpdateRfqDto` guards both fields with
 * `@ValidateIf((_o, value) => value !== null)`, so sending `null` clears the assignment or the
 * value, while omitting the key leaves it alone. The two must not be collapsed, which is why this
 * signature uses optional-or-null rather than optional alone.
 *
 * Answers **200** with the whole re-read `AdminRfq`, so a caller can replace its cache from the
 * result rather than refetching.
 */
export interface UpdateRfqInput {
  status?: RfqStatus;
  assignedSalespersonId?: string | null;
  expectedValue?: number | null;
}

export function updateRfq(rfqNumber: string, input: UpdateRfqInput): Promise<AdminRfq> {
  // Built key by key rather than spread: `forbidNonWhitelisted` turns a stray property on the
  // caller's object into a 400, and an explicit `undefined` key would serialise away but is not
  // worth relying on.
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body["status"] = input.status;
  if (input.assignedSalespersonId !== undefined) {
    body["assignedSalespersonId"] = input.assignedSalespersonId;
  }
  if (input.expectedValue !== undefined) body["expectedValue"] = input.expectedValue;

  return http.patch<AdminRfq>(`/admin/rfqs/${encodeURIComponent(rfqNumber)}`, body);
}

/**
 * `POST /admin/rfqs/:rfqNumber/notes` — brief §34's internal sales note.
 *
 * **This writes `internalNotes`, never `notes`.** `rfqs.notes` is the prospect's own "additional
 * requirements" from the public form and is rendered back to them on their enquiry page;
 * `rfq_notes` is the private sales trail and no customer-facing endpoint can reach it. There is no
 * admin route that edits the customer-visible field, and that is the correct arrangement — see
 * `AdminRfq`'s own docblock, which names the confusion this comment exists to prevent.
 *
 * Answers **200**, not 201, and returns the whole re-read enquiry with the new note in place.
 */
export function addRfqNote(rfqNumber: string, body: string): Promise<AdminRfq> {
  return http.post<AdminRfq>(`/admin/rfqs/${encodeURIComponent(rfqNumber)}/notes`, { body });
}
