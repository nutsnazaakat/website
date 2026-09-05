import type { RfqStatus } from "@/contract";

/**
 * Brief §17/§34. The sales desk's pipeline, not a client-side guess — `@/contract` is the
 * union the backend's `ck_rfqs_status` constraint actually enforces, so an eighth status is a
 * compile error at both ends rather than a badge that silently renders nothing.
 *
 * Imported above rather than only re-exported: `Rfq` below needs the type in this module's own
 * scope, and `export type { RfqStatus } from "..."` alone does not bring a re-exported name into
 * scope for local use.
 */
export { RFQ_STATUSES } from "@/contract";
export type { RfqStatus };

/**
 * The wire shapes, straight from `@/contract` — `RfqsController`'s own contract, not a
 * client-side guess at it. `RfqDraft` and `GiftingDetails`, this module's two locally-declared
 * interfaces before Task 14, are gone: both described the mock's `create` input, and the real
 * `POST /rfqs` and `POST /rfqs/gifting` take `CreateRfqRequest` and `CreateGiftingRfqRequest`
 * respectively — different shapes for different endpoints, not one draft that covered both.
 *
 * `Rfq` survives as an alias of `RfqDetail`, so every screen that held the created enquiry under
 * that name — `business/rfqs/new.tsx`, `CorporateGiftingForm.tsx` — needed no second edit here.
 */
export type {
  RfqKind,
  RfqLine,
  RfqGiftingDetail,
  RfqSummary,
  RfqDetail,
  RfqDetail as Rfq,
  CreateRfqRequest,
  CreateGiftingRfqRequest,
} from "@/contract";
