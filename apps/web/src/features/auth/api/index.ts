import type { AuthUser, Credentials, RegisterInput } from "@/contract";
import { ApiRequestError, http } from "@/lib/http";

/**
 * A rejected sign-in or a duplicate registration, with copy fit to show the customer.
 *
 * `code` is the backend's stable machine-readable code where there is one. There deliberately is
 * none on a 429, so nothing here may treat a missing code as "unclassified" — the throttled case
 * is identified by status, not code, inside `lib/http`.
 */
export class AuthError extends Error {
  /** Declared and assigned, not a parameter property: `erasableSyntaxOnly` rejects those. */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/**
 * What `/auth/login`, `/auth/register` and `/auth/refresh` return.
 *
 * The tokens are never in here — they arrive as httpOnly cookies. `csrfToken` is only an echo of
 * the readable `nn_csrf` cookie, which `lib/http` reads from `document.cookie` on every
 * state-changing request, so this module has nothing to do with it.
 */
interface AuthResponse {
  user: AuthUser;
  csrfToken: string;
}

/**
 * The editable half of a profile, derived from `AuthUser` rather than restated.
 *
 * `Pick` and not a fresh interface, so the two fields cannot drift from the type the answer comes
 * back as — the same reason `SavedAddressInput` is `Omit<SavedAddress, "id">`. It also documents the
 * exclusions structurally: `email`, `role` and `company` are members of `AuthUser` that are
 * deliberately not picked.
 */
export type ProfileUpdate = Pick<AuthUser, "name" | "phone">;

function toAuthError(error: unknown): never {
  if (error instanceof ApiRequestError) throw new AuthError(error.message, error.code);
  throw error;
}

export const authApi = {
  login: async (credentials: Credentials): Promise<AuthUser> => {
    try {
      const { user } = await http.post<AuthResponse>("/auth/login", credentials);
      return user;
    } catch (error) {
      return toAuthError(error);
    }
  },

  register: async (input: RegisterInput): Promise<AuthUser> => {
    try {
      const { user } = await http.post<AuthResponse>("/auth/register", input);
      return user;
    } catch (error) {
      return toAuthError(error);
    }
  },

  logout: async (): Promise<void> => {
    await http.post<null>("/auth/logout");
  },

  /**
   * Hydrates the session on load. Returns null rather than throwing on 401, because "not
   * signed in" is an ordinary state on every public page, not an error.
   *
   * Anything other than a 401 still throws. A 500 or a network failure means "unknown", and
   * reporting that as "signed out" would silently sign a customer out of a working session.
   */
  me: async (): Promise<AuthUser | null> => {
    try {
      return await http.get<AuthUser>("/auth/me");
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return null;
      throw error;
    }
  },

  /** Spec §46 — one account serves both channels, so bulk access is a switch, not a second login. */
  upgradeToBusiness: async (): Promise<AuthUser> => {
    try {
      return await http.post<AuthUser>("/auth/upgrade-to-business");
    } catch (error) {
      return toAuthError(error);
    }
  },

  /**
   * `PATCH /account/profile` — the customer's own name and mobile number.
   *
   * **Here, beside `me()`, even though the URL is under `/account`.** The answer *is* the session
   * user, and `AuthProvider` holds the only client-side copy of one: a seam in
   * `features/account/api` would need the provider to import the account feature to write the
   * snapshot, or a second holder of `AuthUser` that the header and the route guards do not read. One
   * holder, one write. Grep `account/profile` and this is the only hit in `src/`.
   *
   * **`name` and `phone`, and nothing else, because that is all the server accepts.** `email` is the
   * login identifier and changing it is an account-recovery flow with verification; `role` is
   * `POST /auth/upgrade-to-business` above; `isActive` is an admin action. All three are absent from
   * `UpdateProfileDto`, and `forbidNonWhitelisted` answers **400** for a body that carries one rather
   * than ignoring it — so a client that added a field would be told, not quietly disappointed.
   *
   * Answers the whole profile, which is what makes the snapshot write safe: the response is the
   * committed row rather than an echo of the request, so a value the server trimmed or normalised
   * arrives back in the shape it was stored in.
   */
  updateProfile: async (values: ProfileUpdate): Promise<AuthUser> => {
    try {
      return await http.patch<AuthUser>("/account/profile", values);
    } catch (error) {
      return toAuthError(error);
    }
  },
};
