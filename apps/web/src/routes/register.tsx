import { createFileRoute } from "@tanstack/react-router";
import { useSiteSettings } from "@/config/useSiteSettings";
import { AuthCard, AuthSwitch } from "@/features/auth/components/AuthCard";
import { RegisterForm } from "@/features/auth/components/RegisterForm";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: RegisterPage,
});

function RegisterPage() {
  const settings = useSiteSettings();
  const { redirect } = Route.useSearch();

  useSeo({
    title: `Create an Account | ${settings.brandName}`,
    description:
      "One account for home deliveries and business bulk orders — tick the business box to unlock bulk pricing.",
    noindex: true,
  });

  return (
    <AuthCard
      title="Create your account"
      subtitle="One account covers home deliveries and business bulk orders."
      footer={
        <AuthSwitch
          prompt="Already registered?"
          to="/login"
          label="Sign in"
          redirectTo={redirect}
        />
      }
    >
      <RegisterForm redirectTo={redirect} />
    </AuthCard>
  );
}
