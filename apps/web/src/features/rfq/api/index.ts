import type {
  CreateGiftingRfqRequest,
  CreateRfqRequest,
  RfqDetail,
  RfqSummary,
} from "@/contract";
import type { GiftingFormValues } from "@/features/gifting/schema";
import { http } from "@/lib/http";
import type { RfqFormValues } from "../schema";

/**
 * The RFQ area's reads and writes, over the real API.
 *
 * **The mock and its client-minted number are gone.** `create` used to spread the form's own
 * `RfqDraft`, mint `RFQ-{year}-{6 digits}` from a module-scoped counter continuing
 * `mocks/rfqs.ts`'s three seeded rows, and unshift the result into that same array. `nextRfqNumber`
 * (`backend/src/modules/rfqs/rfq-number.ts`) now draws from `rfq_number_seq`, the sequence live
 * traffic draws from too, so the number in a confirmation screen is the one the sales desk's queue
 * actually holds rather than a figure that happened to look right in a demo.
 *
 * **Two request builders, not one shared draft.** `toCreateRfqRequest` and
 * `toCreateGiftingRfqRequest` take the two forms' own values types and strip the optionals a
 * `defaultValues` object initialises to `""` — `checkoutApi`'s `toPlaceOrderRequest` draws the
 * identical line for the identical reason: `@IsOptional()` in class-validator skips its sibling
 * validators only for `undefined`/`null`, so `gstin: ""` is a *present* value that fails
 * `@Matches(GSTIN_REGEX)` rather than being treated as absent. Sending either form object as-is
 * would 400 on `gstin` (and, for the bulk form, `notes`) on every enquiry that left them untouched.
 *
 * `get` throws on a missing or someone-else's RFQ number — `RfqsService.findOne` cannot tell the
 * two apart on purpose, and neither can this — the same shape `accountApi.getOrder` answers with
 * for the identical reason.
 */
const omitEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

function toCreateRfqRequest(values: RfqFormValues): CreateRfqRequest {
  const gstin = omitEmpty(values.gstin);
  const notes = omitEmpty(values.notes);
  return {
    businessName: values.businessName,
    contactPerson: values.contactPerson,
    mobile: values.mobile,
    email: values.email,
    ...(gstin === undefined ? {} : { gstin }),
    businessType: values.businessType,
    pincode: values.pincode,
    lines: values.lines,
    packaging: values.packaging,
    frequency: values.frequency,
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * `companyName`, not `businessName` — the gifting form's own word for the field, matching
 * `CreateGiftingRfqDto`'s. `RfqsController` is what maps it onto `businessName` for `create`; this
 * function's job stops at sending the field under the name the endpoint actually validates.
 */
function toCreateGiftingRfqRequest(values: GiftingFormValues): CreateGiftingRfqRequest {
  const gstin = omitEmpty(values.gstin);
  const message = omitEmpty(values.message);
  return {
    companyName: values.companyName,
    contactPerson: values.contactPerson,
    mobile: values.mobile,
    email: values.email,
    ...(gstin === undefined ? {} : { gstin }),
    businessType: values.businessType,
    pincode: values.pincode,
    occasion: values.occasion,
    giftBoxSlug: values.giftBoxSlug,
    boxes: values.boxes,
    budgetPerBox: values.budgetPerBox,
    brandingRequired: values.brandingRequired,
    deliveryDate: values.deliveryDate,
    ...(message === undefined ? {} : { message }),
  };
}

export const rfqApi = {
  /** `GET /rfqs` — the signed-in caller's own enquiries, newest first, both kinds in one list. */
  list: (): Promise<RfqSummary[]> => http.get<RfqSummary[]>("/rfqs"),

  /** `GET /rfqs/:rfqNumber` — one of the caller's enquiries, with its lines or gifting detail. */
  get: (rfqNumber: string): Promise<RfqDetail> => http.get<RfqDetail>(`/rfqs/${rfqNumber}`),

  /** `POST /rfqs` — a bulk quote request. Public: a prospect needs no account to raise one. */
  create: (values: RfqFormValues): Promise<RfqDetail> =>
    http.post<RfqDetail>("/rfqs", toCreateRfqRequest(values)),

  /** `POST /rfqs/gifting` — a corporate gifting enquiry. Public, for the same reason. */
  createGifting: (values: GiftingFormValues): Promise<RfqDetail> =>
    http.post<RfqDetail>("/rfqs/gifting", toCreateGiftingRfqRequest(values)),
};
