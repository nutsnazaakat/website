import { createFileRoute } from "@tanstack/react-router";
import { settings } from "@/config/settings";
import { AuthCard, AuthSwitch } from "@/features/auth/components/AuthCard";
import { LoginForm } from "@/features/auth/components/LoginForm";
import { useSeo } from "@/hooks/useSeo";

/** `redirect` is where a guard bounced the visitor from, so sign-in can return them. */
export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();

  useSeo({
    title: `Sign In | ${settings.brandName}`,
    description: "Sign in to track orders, manage addresses and buy in bulk.",
    noindex: true,
  });

  return (
    <AuthCard
      title="Sign in"
      subtitle={
        redirect ? `Sign in to continue to ${redirect}` : "One account for retail and bulk buying."
      }
      footer={
        <AuthSwitch
          prompt="New here?"
          to="/register"
          label="Create an account"
          redirectTo={redirect}
        />
      }
    >
      <LoginForm redirectTo={redirect} />
    </AuthCard>
  );
}
