import { createFileRoute, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Loading } from "@/components/ui/panel";
import { useAuth } from "@/features/auth/auth-context";
import { RefusedScreen } from "@/features/auth/refused-screen";
import { Sidebar } from "@/features/shell/sidebar";

/**
 * The guarded console layout — everything except `/login` renders inside it.
 *
 * A **pathless** layout (`_console`), so the dashboard keeps the path `/` rather than gaining a
 * segment nobody asked for. Its children live in `src/routes/_console/`, which is the directory
 * rule this plan insists on: a path with children gets a directory, never a sibling file. And it
 * renders an `<Outlet />`, without which every child would resolve successfully and paint nothing.
 *
 * **The guard here is UX, not security.** Spec §7.1 and §5: `RolesGuard` refuses a non-admin
 * regardless of what this app believes, so nothing is protected by this component — it exists so
 * that a signed-out operator gets a sign-in form instead of nine cards of error states, and so a
 * non-admin gets an explanation instead of a blank screen.
 */
export const Route = createFileRoute("/_console")({
  component: ConsoleLayout,
});

function ConsoleLayout() {
  const { status, user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const router = useRouter();
  /**
   * Fired at most once.
   *
   * Without the latch this effect is an infinite loop, and the shape of it is worth recording
   * because it is not obvious: this component stays mounted for the frames during which the
   * router transitions to `/login`, so a subscription to `location.href` re-runs the effect with
   * the *new* href, which navigates again with a redirect pointing at the sign-in screen, and so
   * on until React gives up with "Maximum update depth exceeded". Reading the location off
   * `router.state` inside the effect instead of subscribing to it is the other half of the fix —
   * the redirect target must be where the operator was *going*, captured once.
   */
  const redirected = useRef(false);

  useEffect(() => {
    if (status !== "anonymous" || redirected.current) return;
    redirected.current = true;
    void navigate({
      to: "/login",
      // The whole href, query string included, so a link to a filtered order list survives the
      // round trip through sign-in. `replace` so the back button does not walk into the guard
      // again and bounce straight back out.
      search: { redirect: router.state.location.href },
      replace: true,
    });
  }, [status, navigate, router]);

  /**
   * `loading` is a real third state and must not be collapsed into "signed out". The session lives
   * in an httpOnly cookie, so on first paint the app has to ask `GET /auth/me`; treating the answer
   * as absent until it arrives would bounce a signed-in operator to sign-in on every reload.
   */
  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loading label="Checking your session" />
      </div>
    );
  }

  // The redirect above is in flight. Rendering the console for a frame would fire every admin
  // query on the way out, each one a guaranteed 401.
  if (status === "anonymous" || user === null) return null;

  if (!isAdmin) return <RefusedScreen user={user} />;

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
