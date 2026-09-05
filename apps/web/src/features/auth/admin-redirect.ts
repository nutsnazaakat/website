import type { Role } from "@/contract";

/**
 * Where the admin console lives. Configured rather than hardcoded, because it differs per
 * environment and this app must not assume it is deployed beside anything.
 *
 * Unset in development, which is the common case while only the customer app is running: an admin
 * then stays put and sees the notice below rather than being bounced to a dead URL.
 *
 * Annotated `: string | undefined` deliberately, for the reason `lib/http.ts` spells out:
 * `ImportMetaEnv` carries an `[key: string]: any` index signature, so without the annotation the
 * `any` would spread into every caller of `redirectToAdminApp`.
 */
const ADMIN_APP_URL: string | undefined = import.meta.env.VITE_ADMIN_APP_URL;

export const isAdmin = (role: Role | null | undefined): boolean => role === "admin";

/**
 * The admin console is a separate app in its own repo, so this is a **full page navigation**, not a
 * router `navigate()`. Using the router would look like it worked and then render nothing, because
 * this app has no `/admin` route and — per `no-admin-routes.test.ts` — never will.
 */
export function redirectToAdminApp(): boolean {
  if (!ADMIN_APP_URL) return false;
  window.location.assign(ADMIN_APP_URL);
  return true;
}
