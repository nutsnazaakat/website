import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthUser, Credentials, RegisterInput, Role } from "@/contract";
import { authApi, type ProfileUpdate } from "./api";
import { clearSnapshot, readSnapshot, writeSnapshot } from "./storage";

interface AuthCtx {
  user: AuthUser | null;
  /** Null when signed out, so a caller can distinguish "anonymous" from "retail". */
  role: Role | null;
  isAuthenticated: boolean;
  /**
   * True until `GET /auth/me` has answered.
   *
   * For **components**, not for route guards — a `beforeLoad` guard runs before the component tree
   * exists and cannot read this context at all, which is the whole reason `guards.ts` reads the
   * localStorage snapshot instead.
   *
   * What it is genuinely for: a component that renders auth state must not flash the signed-out
   * version while `me()` is still in flight. The snapshot makes first paint right in the common
   * case, but a visitor holding valid cookies whose localStorage was cleared has no snapshot, and
   * without this the header would show "Sign in" and then flip to their name.
   */
  isLoading: boolean;
  login: (credentials: Credentials) => Promise<AuthUser>;
  register: (input: RegisterInput) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /**
   * Spec §46 — one account serves both retail and bulk, so an existing retail customer turns on
   * bulk buying rather than opening a second account. The company details are captured afterwards
   * on `/business/profile`.
   *
   * Async, and callers must await it before navigating into `/business/*`: the guard there reads
   * the snapshot, which is only written once the server has confirmed the new role.
   */
  upgradeToBusiness: () => Promise<void>;
  /**
   * `PATCH /account/profile` — the customer editing their own name and mobile number.
   *
   * On the auth context rather than in a `features/account` hook because the answer **is** this
   * context's `user`: the endpoint returns the whole `AuthUser`, and there is exactly one client-side
   * copy of that — this state plus the localStorage snapshot the route guards read. A mutation that
   * lived elsewhere would either leave the header showing the old name until the next `GET /auth/me`,
   * or need a second writer of the snapshot.
   *
   * Async and awaited by its caller for the same reason `upgradeToBusiness` is: nothing may report
   * success before the server has confirmed it. The rejection is left to propagate so the form can
   * render the server's message.
   */
  updateProfile: (values: ProfileUpdate) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  /**
   * Seeded from the localStorage snapshot so the first paint and the route guards in
   * `beforeLoad` agree, then corrected by the server.
   *
   * The snapshot is **display state, not a credential**. The real session is an httpOnly
   * cookie that JavaScript cannot read. Tampering with the snapshot changes what the UI
   * optimistically renders and nothing else: every API call is authorised server-side.
   */
  const [user, setUser] = useState<AuthUser | null>(() => readSnapshot());
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void authApi
      .me()
      .then((serverUser) => {
        if (cancelled) return;
        setUser(serverUser);
        if (serverUser) writeSnapshot(serverUser);
        else clearSnapshot();
      })
      .catch(() => {
        /**
         * Reached only for a failure that is *not* a 401 — `me()` already turns "not signed in"
         * into `null`. So this is a 500 or a dead network, which means "unknown", not "signed
         * out": the snapshot is deliberately left alone so an offline reload keeps rendering the
         * account it last saw rather than throwing the customer out of a session that is probably
         * still live. Every request is still authorised server-side, so nothing is granted by
         * keeping it.
         *
         * A `catch` is required, not tidiness. Without it a network failure here is an unhandled
         * promise rejection, which is a console error in the browser and a failing run in vitest.
         */
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: AuthUser) => {
    writeSnapshot(next);
    setUser(next);
    return next;
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      role: user?.role ?? null,
      isAuthenticated: user !== null,
      isLoading,
      login: async (credentials) => persist(await authApi.login(credentials)),
      register: async (input) => persist(await authApi.register(input)),
      logout: async () => {
        /**
         * Clear locally even if the request fails, because the user asked to sign out and a UI
         * that refuses is worse than one that is optimistic.
         *
         * But be honest about what a failure leaves behind: the server-side session row is still
         * live and the refresh cookie is valid for **30 days**, so this is a local sign-out only.
         * "The access cookie expires within 15 minutes regardless" is true and irrelevant — the
         * refresh cookie is what keeps the session alive. The refresh-and-retry in `lib/http` is
         * what makes this call actually succeed after an idle spell; this branch is the
         * genuine-network-failure case, and it does not revoke anything.
         *
         * The rejection is re-raised rather than swallowed so the caller can say so.
         */
        try {
          await authApi.logout();
        } finally {
          clearSnapshot();
          setUser(null);
        }
      },
      upgradeToBusiness: async () => {
        persist(await authApi.upgradeToBusiness());
      },
      updateProfile: async (values) => {
        // `persist`, not `setUser`: the snapshot is what `beforeLoad` guards read and what makes the
        // next first paint right, so a name changed only in React state would revert on reload.
        persist(await authApi.updateProfile(values));
      },
    }),
    [user, isLoading, persist],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be used inside AuthProvider");
  return c;
}
