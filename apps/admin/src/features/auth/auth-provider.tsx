import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthUser, Credentials } from "@/contract";
import { login, logout, me } from "@/features/auth/api/auth";
import { AuthContext, type AuthContextValue, type AuthStatus } from "@/features/auth/auth-context";
import { ApiRequestError } from "@/lib/http";

/**
 * Holds the session.
 *
 * **It hydrates from `GET /auth/me`, never from storage.** The access and refresh tokens are
 * httpOnly cookies, so the session is not JS-readable and a local copy would be a cache nobody can
 * invalidate — an operator whose admin rights were revoked would keep seeing the console until they
 * happened to reload. `http.ts` has already attempted a refresh before any 401 reaches here, so a
 * 401 at this point means the session is genuinely gone.
 *
 * **A 403 must never sign anybody out.** That distinction is the whole of task 2 and it is easy to
 * get backwards, because both are "the server said no". A 401 means *your session expired*; a 403
 * means *this account cannot*. A customer holding a perfectly valid `b2c` session who signs in here
 * will 403 every admin call, and clearing their session in response would be both a lie and a
 * silent loop: they would be sent to sign in, succeed, and be sent back. So nothing in this file
 * reacts to a 403 at all — `RefusedScreen` explains it instead.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    void me(controller.signal)
      .then((account) => {
        if (!live) return;
        setUser(account);
        setStatus("authenticated");
      })
      .catch((error: unknown) => {
        if (!live) return;
        // An abort is the effect being torn down (StrictMode's double-mount, or a fast unmount),
        // not an answer about the session. Reporting it as "anonymous" would flash the sign-in
        // screen at a signed-in operator on every mount in development.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setUser(null);
        setStatus("anonymous");
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  const signIn = useCallback(async (credentials: Credentials): Promise<AuthUser> => {
    const session = await login(credentials);
    setUser(session.user);
    setStatus("authenticated");
    // Returned as well as stored so the sign-in form can decide what to say about *this* account
    // without waiting for a re-render — a non-admin is refused with an explanation rather than
    // navigated somewhere that will 403.
    return session.user;
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await logout();
    } catch (error: unknown) {
      // The local session is cleared whatever happened, but the two failures are not the same and
      // only one of them is fine to swallow.
      //
      // A 401 here has already been through `http.ts`'s refresh-and-retry — that is exactly why
      // `/auth/logout` is *not* in `NEVER_REFRESH` — so reaching this point means the session was
      // unrecoverable and there was nothing left to revoke.
      //
      // Anything else (a network failure, a 5xx) means the session row may still be live with a
      // 30-day refresh cookie behind it. Clearing the UI regardless is still right — leaving
      // somebody staring at a console they asked to leave is worse — but it is not silent.
      if (!(error instanceof ApiRequestError) || error.status !== 401) {
        console.error("Sign-out did not reach the server; the session may still be active.", error);
      }
    } finally {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      role: user?.role ?? null,
      isAdmin: user?.role === "admin",
      signIn,
      signOut,
    }),
    [status, user, signIn, signOut],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
