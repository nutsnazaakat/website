import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { settings } from "@/config/settings";

/** The centred card both auth screens sit in. Sand background, single column, no chrome. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="bg-sand">
      <div className="container-page flex min-h-[72vh] items-center justify-center py-12 sm:py-16">
        <div className="w-full max-w-md">
          <p className="text-muted-foreground text-center text-xs font-semibold tracking-[0.2em] uppercase">
            {settings.brandName}
          </p>

          <div className="border-border bg-background mt-4 rounded-3xl border p-6 sm:p-8">
            <h1 className="font-display text-3xl">{title}</h1>
            <p className="text-muted-foreground mt-2 text-sm">{subtitle}</p>
            {children}
          </div>

          <p className="text-muted-foreground mt-5 text-center text-sm">{footer}</p>
        </div>
      </div>
    </div>
  );
}

/** Shared link row under the card. */
export function AuthSwitch({
  prompt,
  to,
  label,
  redirectTo,
}: {
  prompt: string;
  to: "/login" | "/register";
  label: string;
  redirectTo?: string;
}) {
  return (
    <>
      {prompt}{" "}
      <Link
        to={to}
        search={{ redirect: redirectTo }}
        className="text-foreground font-semibold underline underline-offset-4"
      >
        {label}
      </Link>
    </>
  );
}
