import type { AdminInventoryRow, AdminInventoryTransaction, Paginated } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The stock seam — brief §32's screen, spec §6.4's four inventory routes.
 *
 * **Addressed by `variantId`, not by variant id-as-`:id`.** The route parameter is spelled
 * `:variantId` in the controller and in the spec, because an `inventory` row is 1:1 with a variant
 * and has no id of its own that anyone would quote.
 *
 * **Nothing on this endpoint is money.** `onHand`, `reserved`, `available` and `lowStockThreshold`
 * are all counts of packs, and the backend's own mapper notes that spec §8's paise boundary does
 * not apply to this resource at all. So there is nothing here that a stray `/100` could damage —
 * but equally nothing to convert.
 */

/**
 * `?status=` — **`low` includes `out`**, and that containment is why the backend made it one enum
 * rather than two booleans.
 *
 * Spec §12's rule is `available <= lowStockThreshold`, and a threshold is never negative, so a
 * variant at zero satisfies it too. `?low=true&out=false` is a question with no useful answer, and
 * offering it would invite a client to ask it. Omitting the parameter is every stock position there
 * is.
 */
export type StockStatusFilter = "low" | "out";

export interface InventoryListQuery {
  /** SKU or product name, case-insensitive substring. Not `size` — every 1 kg pack would match. */
  q?: string;
  status?: StockStatusFilter;
  page?: number;
  limit?: number;
}

/** `InventoryQueryDto`'s `@Min(1) @Max(60)`, and `InventoryService`'s `DEFAULT_LIMIT`. */
export const INVENTORY_PAGE_SIZE = 24;
export const INVENTORY_MAX_PAGE_SIZE = 60;

/**
 * `GET /admin/inventory` — **ordered by `available` ascending**, so the most urgent row is the first
 * row and an operator who scans the top of page 1 has seen the worst of it.
 *
 * Inactive variants are listed, deliberately: stock does not stop existing because a pack was
 * withdrawn from sale, and a screen claiming to show all of it must not quietly hide some. It also
 * keeps `?status=low`'s `total` equal to the dashboard's Low Stock card, which the backend asserts
 * in its integration suite and which would be false if either side filtered.
 */
export function fetchInventory(
  query: InventoryListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminInventoryRow>> {
  return http.get<Paginated<AdminInventoryRow>>(
    `/admin/inventory${toQueryString({ ...query })}`,
    signal,
  );
}

/**
 * `GET /admin/inventory/:variantId/transactions` — **the audit trail for stock, and the only one.**
 *
 * `GET /admin/audit-logs` deliberately carries no stock movements: the ledger is append-only,
 * `SUM(delta) = onHand` per variant is a tested invariant, and duplicating the rows into a second
 * table would create two records of one fact that can disagree. So the two screens answer different
 * questions — the audit log says who changed a price, a threshold or a listing; this says where the
 * stock went — and the inventory screen says which is which rather than leaving an operator to
 * discover it by finding nothing.
 *
 * Pagination only: no `q`, no type filter. Filtering an audit trail by *type* is how an operator
 * misses the row that explains the discrepancy they were chasing, and the DTO says so.
 */
export function fetchStockLedger(
  variantId: string,
  query: { page?: number; limit?: number },
  signal?: AbortSignal,
): Promise<Paginated<AdminInventoryTransaction>> {
  return http.get<Paginated<AdminInventoryTransaction>>(
    `/admin/inventory/${encodeURIComponent(variantId)}/transactions${toQueryString({ ...query })}`,
    signal,
  );
}

/**
 * `PATCH /admin/inventory/:variantId` — a signed delta and a reason, in one transaction with the
 * ledger row.
 *
 * **The reason is required and is free text**, not a fixed list: brief §32 wants the history to say
 * *why*, and a reason an admin actually writes beats a dropdown whose first option gets picked.
 * `@MinLength(4)`, `@MaxLength(200)`.
 *
 * **A zero delta is refused**, at the DTO (`@NotEquals(0)`, 400) and again in the service (422).
 * `0.4` is truncated to zero *before* the check, deliberately: an earlier version let it through and
 * wrote an `ADJUSTMENT` row asserting a movement of zero into an append-only trail.
 *
 * A delta that would take `onHand` below `reserved` is **409 `OUT_OF_STOCK`**, and a variant that
 * does not exist is a 404 — separated on purpose, because "would oversell reserved units" and "no
 * such variant" send an operator to look at entirely different things.
 *
 * The answer is `{ onHand, balanceAfter }` and nothing else — **not** the whole `AdminInventoryRow`,
 * unlike the threshold route below. The caller refetches rather than patching a row from a partial.
 */
export function adjustStock(
  variantId: string,
  input: { delta: number; reason: string },
): Promise<{ onHand: number; balanceAfter: number }> {
  return http.patch<{ onHand: number; balanceAfter: number }>(
    `/admin/inventory/${encodeURIComponent(variantId)}`,
    { delta: input.delta, reason: input.reason },
  );
}

/**
 * `PATCH /admin/inventory/:variantId/threshold` — **the only way to change a threshold after the
 * variant was created**, which is why the product screen renders no input for it.
 *
 * A separate route from the adjustment rather than a field on it, because it moves no stock: it
 * **writes no ledger row** and queues no `stock.low` notification. It *does* write an audit row, and
 * it bumps `inventory.updatedAt` through `@UpdateDateColumn` — which is why `AdminInventoryRow`'s
 * own docblock warns that `updatedAt` is "when this row last changed", not "when stock last moved".
 *
 * `lowStockThreshold` is **required**, unlike every other admin PATCH where an omitted field means
 * "leave unchanged": there is one field, so an empty body is not a partial update but a request that
 * cannot mean anything. **`0` is legal** and means "warn me only when it is actually gone" — spec
 * §12's rule is `<=`, so a zero threshold makes `low` exactly `outOfStock` rather than disabling it.
 *
 * Answers the whole re-read `AdminInventoryRow`, selected by the same statement the list uses, so
 * `low` cannot mean one thing in the table and another in the reply to the write that changed it.
 */
export function setStockThreshold(
  variantId: string,
  lowStockThreshold: number,
): Promise<AdminInventoryRow> {
  return http.patch<AdminInventoryRow>(
    `/admin/inventory/${encodeURIComponent(variantId)}/threshold`,
    { lowStockThreshold },
  );
}
