import { createContext, use } from "react";
import type { AuthUser, Credentials, Role } from "@/contract";

/**
 * How the app learns who is signed in.
 *
 * Split from `AuthProvider` so the provider file exports only a component: oxlint's
 * `react/only-export-components` warns when a module mixes them, and the warning is right — a
 * module exporting both loses fast refresh for the component.
 */

/**
 * What the session is doing, as three states rather than a `user: AuthUser | null` and a boolean.
 *
 * `loading` is the one that matters. With an httpOnly cookie the session is not readable from
 * JavaScript, so on first paint the app genuinely does not know: it has to ask `GET /auth/me`. A
 * route guard that treated "not yet known" as "signed out" would bounce a signed-in operator to
 * the sign-in screen on every reload, which is how this exact design goes wrong.
 */
export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  role: Role | null;
  /**
   * `role === "admin"`, and **UX only**.
   *
   * Spec §7.1 and §5: authorisation is the server's. `RolesGuard` refuses a non-admin regardless of
   * what this app believes, so this flag decides what to *render*, never what is permitted. A
   * tampered client cannot gain anything by flipping it — it would simply see screens whose every
   * request 403s.
   */
  isAdmin: boolean;
  signIn: (credentials: Credentials) => Promise<AuthUser>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = use(AuthContext);
  if (value === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
