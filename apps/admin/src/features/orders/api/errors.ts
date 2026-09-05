import { B2B_ORDER_STATUSES, B2C_ORDER_STATUSES, type OrderStatus } from "@/contract";
import { ApiRequestError } from "@/lib/http";

/**
 * Reading what the server said about a refused write, rather than reporting that one happened.
 *
 * `ILLEGAL_STATUS_TRANSITION` is emitted at **two** different HTTP statuses and they mean different
 * things, so branching on `code` alone is not enough:
 *
 * - **422** — the move is not in the transition table. `details` carries
 *   `{ orderNumber, from, to, allowed }`, and `allowed` is the real set of next statuses for that
 *   order's channel (empty for a terminal order, which is itself the answer). This is the case
 *   worth rendering: the server has already worked out the operator's real choices.
 * - **409** — another admin moved the order first. `details` carries `{ orderNumber, from, to }`
 *   and **no `allowed`**, because the order is no longer in the state the caller reasoned about.
 *   The honest response is "reload and try again", not a list of buttons derived from a stale read.
 */

const CODE = "ILLEGAL_STATUS_TRANSITION";

const ALL_STATUSES: readonly string[] = [...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES];

function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && ALL_STATUSES.includes(value);
}

/**
 * The `allowed` array off a 422, narrowed to real statuses, or `null` when this is not that error.
 *
 * Every element is checked against the contract's own tuples rather than cast. `details` is typed
 * `Record<string, unknown>` in `ApiError` deliberately — the shape depends on `code` — so narrowing
 * is the only way to read it without an assertion, and a server that ever sent something else would
 * degrade to "no suggestions" rather than rendering a button that cannot work.
 *
 * An **empty array is a real answer**, not an absence: the order is terminal. It is returned as `[]`
 * and the caller distinguishes it from `null`.
 */
export function allowedTransitionsFrom(error: unknown): OrderStatus[] | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code !== CODE || error.status !== 422) return null;

  const allowed = error.details?.["allowed"];
  if (!Array.isArray(allowed)) return null;

  return allowed.filter(isOrderStatus);
}

/**
 * Whether this refusal is the "somebody else moved it" 409 rather than the "that move is illegal"
 * 422. The order screen answers it by reloading, because nothing it can offer is trustworthy until
 * it has re-read the order.
 */
export function isConcurrentModification(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === CODE && error.status === 409;
}

/**
 * A message worth showing an operator.
 *
 * The backend's `message` is already written for a human — `An order that is "shipped" cannot
 * become "pending".` — so this passes it through and only substitutes when there is nothing to
 * pass through. The one case that needs its own words is **429**, which carries no `code` at all
 * (`ThrottlerException` is not a `DomainError`) and whose raw message is
 * `"ThrottlerException: Too Many Requests"`.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status === 403) {
      return "This account is not allowed to do that. Your session is still valid.";
    }
    return error.message;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "Something went wrong. Please try again.";
}
