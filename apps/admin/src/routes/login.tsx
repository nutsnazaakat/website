import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useAuth } from "@/features/auth/auth-context";
import { errorMessage } from "@/features/orders/api/errors";
import { RefusedScreen } from "@/features/auth/refused-screen";

/**
 * Sign-in.
 *
 * **`redirect` is read from the URL and carried through**, so an operator who followed a link to
 * `/orders/NN-2026-005107`, was bounced here, and signed in lands on the order rather than the
 * dashboard. `validateSearch` narrows it rather than trusting it: a `redirect` that is not a
 * same-site absolute path is dropped, because it arrives from the address bar and an open redirect
 * on a sign-in screen is a phishing primitive.
 */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const value = search["redirect"];
    if (typeof value !== "string") return {};
    // Must be an absolute path on this origin. `//evil.example` and `https://evil.example` are both
    // rejected: the browser reads a protocol-relative `//host` as a different site.
    if (!value.startsWith("/") || value.startsWith("//")) return {};
    return { redirect: value };
  },
  component: LoginScreen,
});

function LoginScreen() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const { signIn, status, user, isAdmin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isNavigating = useRouterState({ select: (state) => state.isLoading });

  /**
   * Somebody already signed in, who is not an admin, gets the explanation rather than a form they
   * have already filled in correctly once. This covers both routes to the state: signing in here
   * with customer credentials, and arriving with a pre-existing customer session.
   */
  if (status === "authenticated" && user !== null && !isAdmin) {
    return <RefusedScreen user={user} />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const account = await signIn({ email, password });
      // Navigating a non-admin anywhere in the console would land them on a screen whose every
      // request 403s. The render above catches it on the next pass; not navigating is what makes
      // that possible.
      if (account.role !== "admin") return;
      await navigate({ to: redirect ?? "/" });
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || isNavigating;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-5 px-6">
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-[11px] font-medium tracking-widest uppercase">
          Nuts &amp; Nazaakat
        </p>
        <h1 className="text-xl">Admin console</h1>
        <p className="text-muted-foreground text-[12px]">
          Administrator accounts only. Customer sign-in is on the storefront.
        </p>
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {error !== null && (
          <p role="alert" className="text-destructive text-[12px]">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
