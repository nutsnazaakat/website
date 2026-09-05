import type { AdminAuditLogEntry, Paginated } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The admin trail — `GET /admin/audit-logs`. Spec §5's *"every destructive admin action writes an
 * audit-log row"*, read back.
 *
 * Read-only, and there is deliberately no write path: `AuditLogService.record` is the one writer and
 * it takes the caller's open transaction, so a row and the change it describes commit together.
 *
 * **Three absences that are decisions, not gaps.** Each one is a case where an empty result would
 * otherwise read as a broken trail:
 *
 * - **Stock movements are not here.** Plan 9.2 decided the `inventory_transactions` ledger *is* the
 *   audit trail for stock — append-only, carrying the delta, the reason, the resulting balance and
 *   the acting admin — so no `AuditAction` member exists for one. An operator asking who wrote off
 *   40 kg of cashews wants `GET /admin/inventory/:variantId/transactions`. What *is* here is
 *   `inventory.update`, a change to a **threshold**, which moves no stock.
 * - **Customers' own actions are not here.** Placing an order, writing a review, cancelling — this
 *   table is about what admins did. An order's own history is its timeline.
 * - **`ip` and `userAgent` are not on the wire at all**, rather than published as columns that are
 *   always null: they exist for a request-scoped interceptor nobody built.
 *
 * `action` and `entity` are plain strings on the wire and **not unions**, deliberately: the
 * backend's vocabularies gain a member with every admin write path that ships, and pinning them
 * would make this app fail to compile against a server that had merely grown one. So the filters
 * below are free text with suggestions, never a closed dropdown.
 */

export interface AuditLogQuery {
  actorUserId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  /** `YYYY-MM-DD`, resolved in the **business timezone** — the same rule as the order list. */
  from?: string;
  /** `YYYY-MM-DD`, resolved in the business timezone. */
  to?: string;
  page?: number;
  limit?: number;
}

/** `AuditLogQueryDto`'s `@Min(1) @Max(60)`. */
export const AUDIT_PAGE_SIZE = 24;

export function fetchAuditLogs(
  query: AuditLogQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminAuditLogEntry>> {
  return http.get<Paginated<AdminAuditLogEntry>>(
    `/admin/audit-logs${toQueryString({ ...query })}`,
    signal,
  );
}

/**
 * The entity kinds that exist today, offered as suggestions rather than as the only valid answers.
 *
 * A `<datalist>` rather than a `<select>`, because the server's `AuditEntity` grows and a closed
 * list here would make a newly-added kind unfilterable until this file was edited. Wrong
 * suggestions cost an empty page; a closed list costs a feature.
 */
export const KNOWN_ENTITIES: readonly string[] = [
  "product",
  "variant",
  "category",
  "order",
  "inventory",
  "pricing-tier",
  "rfq",
  "coupon",
  "post",
  "review",
  "support-ticket",
  "setting",
];
