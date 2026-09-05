import type { AuthUser } from "@/contract";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-context";

/**
 * What a non-admin sees, instead of a blank screen or a redirect loop.
 *
 * They may hold a **perfectly valid session** — a customer who signed in with real credentials.
 * Nothing is wrong with their account; it simply is not an admin account, so `RolesGuard` will 403
 * every `/admin/*` call this console makes. Three things follow, and each is a decision:
 *
 * 1. **They are not signed out.** A 403 means *this account cannot*, not *your session expired*.
 *    Clearing their session would be a lie, and would produce a loop: sign in, succeed, be sent
 *    back to sign in.
 * 2. **They are told which account they are on.** "Not authorised" without a name leaves someone
 *    who has two accounts with no idea which one they used, and this is the single most likely way
 *    to arrive here.
 * 3. **Signing out is offered, not performed.** It is the actual next step — sign in as the admin
 *    account — so it is a button, and it revokes the session server-side rather than just
 *    forgetting it locally.
 *
 * There is deliberately no link to the storefront: this app does not know where it is, and the
 * storefront's own guards already route an admin the other way.
 */
export function RefusedScreen({ user }: { user: AuthUser }) {
  const { signOut } = useAuth();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
          Nuts &amp; Nazaakat — Admin
        </p>
        <h1 className="text-xl">This account cannot use the admin console.</h1>
      </div>

      <div className="border-border bg-card rounded-md border p-3 text-[13px]">
        <p>
          You are signed in as <strong>{user.name}</strong>{" "}
          <span className="text-muted-foreground">({user.email})</span>, which is a{" "}
          <strong>{user.role === "b2b" ? "business" : "retail customer"}</strong> account.
        </p>
        <p className="text-muted-foreground mt-2">
          Your session is valid — nothing is wrong with it. The console is restricted to
          administrator accounts, and the server will refuse every request this app makes on your
          behalf.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void signOut()}>Sign out and use another account</Button>
      </div>
    </main>
  );
}
