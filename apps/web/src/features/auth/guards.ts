import { redirect } from "@tanstack/react-router";
import { redirectToAdminApp } from "./admin-redirect";
import { readSnapshot } from "./storage";
import type { User } from "./types";

/**
 * Route guards for `beforeLoad`.
 *
 * They read the localStorage snapshot rather than `AuthProvider`, because `beforeLoad` runs before
 * the component tree — and therefore before any React context — is available on that navigation.
 *
 * The snapshot is display state, not a credential, so these guards are **not** the access control:
 * they only decide which screen to paint. A visitor who forges a snapshot reaches `/account` and
 * then watches every request on it answer 401, because authorisation happens server-side against
 * an httpOnly cookie no script can read. The converse also follows: a visitor holding valid
 * cookies whose localStorage was cleared is bounced to sign-in even though the API would have
 * served them, which is the price of guarding synchronously.
 */

/** Anonymous visitors go to the sign-in form, which sends them back here afterwards. */
export function requireAuth(href: string): User {
  const user = readSnapshot();
  if (!user) throw redirect({ to: "/login", search: { redirect: href } });
  return user;
}

/**
 * `/account/*` belongs to customers, and an administrator is not one.
 *
 * `requireAuth` above answers "is someone signed in", not "who" — which is not enough here.
 * An admin reaching `/account` was shown "Track orders, manage addresses and keep your details
 * current": the customer dashboard, which is exactly what the separate admin console exists to
 * replace. Routing them away at sign-in closes only the path through the sign-in form; this closes
 * direct navigation and the case where they arrive holding a snapshot from an earlier session.
 *
 * `redirectToAdminApp()` is a **full page navigation** when this environment knows where the console
 * is, because it is a different application in its own repository. When it does not, the storefront
 * home is the honest fallback: there is no screen in this app that could explain, and bouncing them
 * to `/login` would assert they are signed out, which is false. Either way the customer area is not
 * rendered — hence the unconditional `throw`.
 */
export function requireCustomer(href: string): User {
  const user = requireAuth(href);
  if (user.role === "admin") {
    redirectToAdminApp();
    throw redirect({ to: "/" });
  }
  return user;
}

/**
 * Spec §7 guards `/business/*` on `role === "b2b"`.
 *
 * The redirect target must sit *outside* the `business/` layout or a rejected visitor
 * bounces straight back into the thing that rejected them. Anonymous visitors get the
 * sign-in form; a signed-in retail customer gets `/account`, which explains what bulk
 * access needs and offers to turn it on — one account covers both channels, so the
 * answer is an upgrade rather than a second registration.
 */
export function requireBusiness(href: string): User {
  const user = requireAuth(href);
  if (user.role !== "b2b") throw redirect({ to: "/account", search: { upgrade: "business" } });
  return user;
}
