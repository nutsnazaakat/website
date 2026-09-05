import type { AdminSetting } from "@/contract";
import { ApiRequestError, http } from "@/lib/http";

/**
 * The settings seam — `GET` and `PUT /admin/settings`. Brief §26 and §37.
 *
 * **This is the screen that makes the storefront's contact details fillable.** `settings.seed.ts`
 * seeds `whatsappNumber`, `supportEmail`, `supportPhone`, `gstin`, `fssaiLicence`, `certifications`,
 * `social` and `addressLines` **empty**, deliberately: brief §26 requires certification information
 * to be admin-editable and §37 says in as many words *"do not hardcode a fake number"*. So an empty
 * field here is not a bug and not an oversight — it is the storefront correctly rendering nothing
 * until somebody types the real value.
 *
 * **A `PUT` writes only keys that already exist.** An unknown key is refused `404` naming it,
 * rather than inserted — a typo like `whatsapNumber` would otherwise create a permanent row that
 * looks saved, is returned by `GET /admin/settings`, and is read by nothing. There is no delete
 * route either, so it would never go away. Adding a setting is a seed change alongside the code
 * that reads it.
 *
 * **`isPublic` is reported and not editable**, by design: whether a row reaches `GET /settings` is
 * a property of what the setting *is*, and this table holds a GSTIN.
 */

/**
 * `PUT /admin/settings` — a partial write despite the verb.
 *
 * "Replace" names what happens to each key sent, not to the table: keys not mentioned are left
 * alone. Sending only the keys that changed is therefore both correct and kinder to the audit
 * trail, which records **one row per key that actually changed** — a `PUT` carrying five keys of
 * which two differ writes two rows, and one that changes nothing writes none.
 *
 * A duplicate key in one payload is refused `422` rather than last-write-wins, so callers must not
 * batch two edits of the same key.
 */
export function saveSettings(settings: { key: string; value: unknown }[]): Promise<AdminSetting[]> {
  return http.put<AdminSetting[]>("/admin/settings", { settings });
}

export function fetchSettings(signal?: AbortSignal): Promise<AdminSetting[]> {
  return http.get<AdminSetting[]>("/admin/settings", signal);
}

/**
 * The keys a `PUT` was refused for, or `null` when this is not that refusal.
 *
 * `404 NOT_FOUND` carrying `details.keys`. Rendered rather than reported as "save failed", because
 * the answer — "there is no setting called that" — is the one thing that tells an operator what to
 * do next, and this console is the only thing standing between a typo and a dead row.
 */
export function unknownSettingKeys(error: unknown): string[] | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status !== 404 || error.code !== "NOT_FOUND") return null;

  const keys = error.details?.["keys"];
  if (!Array.isArray(keys)) return null;

  const named = keys.filter((key): key is string => typeof key === "string");
  return named.length === 0 ? null : named;
}

/**
 * What kind of control a row needs, decided from the value the server sent.
 *
 * The column is `jsonb` and `AdminSetting.value` is `unknown` for that reason — it legitimately
 * holds a string, a number, a boolean or an array of strings today. Narrowing at runtime rather
 * than asserting is the only honest way to read it: a row whose shape this screen has not been
 * taught renders read-only rather than being reshaped into something the storefront cannot parse.
 */
export type SettingKind = "text" | "number" | "boolean" | "list" | "unknown";

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function kindOf(value: unknown): SettingKind {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (isStringList(value)) return "list";
  return "unknown";
}
