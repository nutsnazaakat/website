import { ApiRequestError } from "@/lib/http";

/**
 * Reading a refused delete, rather than reporting that one happened.
 *
 * **`409 ENTITY_IN_USE` is a normal case on this screen, not an error to hide.** Spec §5a settled
 * that admin deletes are hard deletes refused with a named 409 when the row is referenced — not
 * soft deletes — precisely so the operator gets an instruction instead of an opaque 500 carrying a
 * constraint name. The server's `message` is already written for a human ("This product has stock
 * movement history, which is append-only and must outlive it. Unpublish it instead…"), so the work
 * here is reading `details` for the *count*, which is what tells an operator whether they are
 * looking at one stray order or a year of trade.
 *
 * The three shapes, measured from `AdminProductsService.remove` and `AdminVariantsService.remove`:
 *
 * | Refusal | `details` |
 * | --- | --- |
 * | product has been ordered | `{ productId, orderItems }` |
 * | product has ledger history | `{ productId, inventoryTransactions }` |
 * | variant still holds stock | `{ variantId, onHand }` |
 * | variant has been ordered | `{ variantId, orderItems }` |
 * | variant has ledger history | `{ variantId, inventoryTransactions }` |
 *
 * `details` is typed `Record<string, unknown>` in `ApiError` deliberately — its shape depends on
 * `code` — so every field is narrowed rather than asserted, and a server that sent something else
 * degrades to "no counts" rather than rendering `undefined` at the operator.
 */

const CODE = "ENTITY_IN_USE";

/** The reason a delete was refused, in the operator's terms. */
export interface DeleteRefusal {
  /** The server's own sentence. Already actionable; rendered as sent. */
  message: string;
  /** How many order lines reference the row, when that is why. */
  orderItems?: number;
  /** How many append-only stock rows reference it, when that is why. */
  inventoryTransactions?: number;
  /** Packs still on the shelf, for the variant case. */
  onHand?: number;
}

function counted(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The refusal, or `null` when this error is something else entirely — a 404, a 429, a network
 * failure. The caller renders a refusal in place and falls back to `errorMessage` otherwise.
 */
export function entityInUse(error: unknown): DeleteRefusal | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code !== CODE || error.status !== 409) return null;

  const orderItems = counted(error.details, "orderItems");
  const inventoryTransactions = counted(error.details, "inventoryTransactions");
  const onHand = counted(error.details, "onHand");

  return {
    message: error.message,
    ...(orderItems === undefined ? {} : { orderItems }),
    ...(inventoryTransactions === undefined ? {} : { inventoryTransactions }),
    ...(onHand === undefined ? {} : { onHand }),
  };
}
