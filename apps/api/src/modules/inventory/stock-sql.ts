// backend/src/modules/inventory/stock-sql.ts

/**
 * The stock predicates, in SQL, written once.
 *
 * Every one of these is a *derivation* — `available`, "low", "out" — and spec §10.1 states the rule
 * this file exists to obey: "one exported derivation helper, called by every mapper, never
 * recomputed inline", because "a second assembly site that reimplements the rule slightly
 * differently compiles cleanly and ships a stale flag". `variantSoldOut` in `@nutwala/shared` is
 * that helper for TypeScript. Nothing was that helper for SQL, and there are now three statements
 * that need the same predicates: the dashboard's low-stock card (spec §12), `GET /admin/inventory`'s
 * `low` flag, and `GET /admin/inventory`'s `?status=low` filter. Spelled out three times, the first
 * edit to any one of them makes the card disagree with the list it links to.
 *
 * **Every fragment assumes the `inventory` table is aliased `i`.** Not parameterised on the alias:
 * a `lowStock('inv')` helper would be a template with one caller shape, and the string it produced
 * would be no more checkable than these. All three call sites alias it `i` and a mismatch is an
 * immediate Postgres error naming the missing alias, not a silent wrong answer.
 */

/** `onHand - reserved`, per spec §10.1. Parenthesised because callers compare it. */
export const SQL_AVAILABLE = '(i."onHand" - i.reserved)';

/**
 * **Spec §12's low-stock rule: `available <= lowStockThreshold`, inclusive.**
 *
 * This deliberately disagrees with `checkLowStock` in this same directory, which fires the
 * `stock.low` notification on a strict `<` — "landing exactly *on* the threshold is not low". So a
 * variant sitting at exactly its threshold counts towards the dashboard card and appears under
 * `?status=low`, while having queued no notification.
 *
 * The disagreement is a card-versus-event distinction, not a bug, and both plan 9.1 and plan 9.2
 * put it on the record with tests at both ends so that neither side gets "fixed" to match the other:
 *
 * - the **card** answers a standing question — what needs attention right now? An operator who set
 *   a threshold of 10 means "tell me when I'm down to ten", so the tenth pack belongs on the
 *   reorder list;
 * - the **event** is a one-off crossing, and its dedupe property depends on being strict: with
 *   `<=`, a write that landed exactly on the threshold and a write that took it one lower would
 *   both satisfy "crossed", so the same variant could notify twice for one slide downwards.
 */
export const SQL_LOW_STOCK = `${SQL_AVAILABLE} <= i."lowStockThreshold"`;

/**
 * `available <= 0` — the same rule, and the same reasoning, as `variantSoldOut` in
 * `@nutwala/shared`, which this fragment exists to mirror in the one place TypeScript cannot reach:
 * a `WHERE` clause.
 *
 * `<= 0` rather than `= 0` for `variantSoldOut`'s stated reason. `ck_inventory_non_negative` keeps
 * `onHand >= reserved` for every row, so the expression cannot be negative today; if it ever were,
 * the safe direction is closed — a false "sold out" costs a sale, a false "in stock" oversells.
 *
 * The row flag itself is **not** computed with this fragment: it comes from `variantSoldOut`
 * applied to the selected `available`, so the wire value has exactly one implementation across the
 * whole codebase. This fragment is only the filter, and
 * `test/integration/admin-inventory.integration.spec.ts` asserts the two agree on every row of
 * every page — which is what makes "they mirror each other" a build failure rather than a comment.
 */
export const SQL_OUT_OF_STOCK = `${SQL_AVAILABLE} <= 0`;
