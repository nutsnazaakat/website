import type { RfqStatus } from "@/contract";
import { isRfqStatus } from "@/features/rfqs/api/rfqs";
import { ApiRequestError } from "@/lib/http";

/**
 * Reading what the server said about a refused enquiry move.
 *
 * The shape is `features/orders/api/errors.ts`'s exactly, because the backend deliberately made it
 * the same shape: `RfqStatusService.transition` throws the identical `ILLEGAL_STATUS_TRANSITION`
 * code at two different statuses, and each means something different.
 *
 * - **422** — the move is not in `RFQ_TRANSITIONS`. `details` carries
 *   `{ rfqNumber, from, to, allowed }`, and `allowed` is the real set of next statuses. This is the
 *   case worth rendering: the server has already worked out the operator's real choices, so "that
 *   failed" throws away the answer.
 * - **409** — another operator moved the enquiry first. `details` carries `{ rfqNumber, from, to }`
 *   and **no `allowed`**, because the enquiry is no longer in the state the caller reasoned about.
 *   Reload, do not re-offer buttons derived from a stale read.
 *
 * `errorMessage` is not re-declared here. It lives in the orders module because that is where plan
 * 9.6a put it, and it is entirely generic — 429 carries no code, 403 must not read as "signed
 * out", everything else passes the server's own sentence through. A second copy would be the drift
 * this project keeps warning about; the honest tidy-up is to move that one function to `src/lib/`,
 * which is a rename plan 9.6b deliberately does not make while another plan is editing the same
 * files.
 */

const CODE = "ILLEGAL_STATUS_TRANSITION";

/**
 * The `allowed` array off a 422, narrowed to real statuses, or `null` when this is not that error.
 *
 * An **empty array is a real answer** — `rejected` and `converted` are terminal — and is returned
 * as `[]` so the caller can distinguish "nowhere to go" from "not this error".
 */
export function allowedRfqTransitionsFrom(error: unknown): RfqStatus[] | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code !== CODE || error.status !== 422) return null;

  const allowed = error.details?.["allowed"];
  if (!Array.isArray(allowed)) return null;

  return allowed.filter(isRfqStatus);
}

/**
 * Whether this refusal is the "somebody else moved it" 409 rather than the "that move is illegal"
 * 422. The detail screen answers it by reloading, because nothing it can offer is trustworthy until
 * it has re-read the enquiry.
 */
export function isConcurrentRfqModification(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === CODE && error.status === 409;
}
