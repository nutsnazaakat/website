import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import type { AuthUser } from "@/contract";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settings } from "@/config/settings";
import { useAuth } from "@/features/auth/AuthProvider";
import { PHONE_REGEX } from "@/features/checkout/schema";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/account/profile")({ component: AccountProfile });

/**
 * `UpdateProfileDto`'s two rules, in the browser.
 *
 * **The messages are the server's own, word for word**, so a customer reads one sentence per mistake
 * rather than one from zod and a different one from class-validator on the same field. `PHONE_REGEX`
 * is not restated at all — it comes from `@/contract` through `features/checkout/schema`, which
 * is the same constant the DTO's `@Matches` uses.
 *
 * `.trim()` before `.min(2)` matters and is not tidiness: `"  "` is a present two-character string,
 * so an untrimmed `min(2)` accepts it, and the server would then be the only thing standing between
 * that and a blank name on every future order. The DTO trims before validating for the same reason;
 * this is the same rule stated where the customer can see the message immediately.
 *
 * The 120 bound is the `varchar(120)` column. `maxLength` on the input makes it unreachable by typing
 * or pasting; this is what catches a value that got there some other way.
 */
const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Enter your full name")
    .max(120, "name must be shorter than or equal to 120 characters"),
  phone: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
});

type ContactValues = z.infer<typeof contactSchema>;

function AccountProfile() {
  const { user, role, isLoading, upgradeToBusiness } = useAuth();
  const navigate = useNavigate();
  const [enabling, setEnabling] = useState(false);

  useSeo({
    title: `Your Profile | ${settings.brandName}`,
    description: "Your name, contact details and account type.",
    noindex: true,
  });

  const enableBusiness = async () => {
    setEnabling(true);
    try {
      // Awaited, not fired and forgotten: `/business/*` is guarded on the role in the
      // localStorage snapshot, and that is only written once the server has confirmed the
      // upgrade. Navigating first would bounce the customer straight back to /account.
      await upgradeToBusiness();
      toast.success("Business buying enabled");
      await navigate({ to: "/business/profile" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not enable business buying. Try again.",
      );
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-4xl">Your Profile</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        These details appear on your orders and delivery notifications.
      </p>

      {/*
        Mounted only once there is a user, and keyed on their id, so the form's `defaultValues` are
        the real ones on its very first render. `AuthProvider` seeds itself from the localStorage
        snapshot, so this is already true on an ordinary visit; a visitor holding valid cookies whose
        localStorage was cleared has no snapshot, and rendering the form before `GET /auth/me`
        answered would show them two empty boxes and then quietly leave them empty — react-hook-form
        reads `defaultValues` once. The key is what makes a change of account remount rather than keep
        the previous customer's values.
      */}
      {user ? (
        <ContactDetails key={user.id} user={user} />
      ) : (
        <section className="border-border mt-8 rounded-2xl border p-5 sm:p-6">
          <h2 className="font-display text-2xl">Contact details</h2>
          <p className="text-muted-foreground mt-5 text-sm">
            {isLoading ? "Loading your details…" : "We could not load your details just now."}
          </p>
        </section>
      )}

      <section className="border-border mt-8 rounded-2xl border p-5 sm:p-6">
        <h2 className="font-display text-2xl">Account type</h2>

        {role === "b2b" ? (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              This account buys in bulk as well as retail.
            </p>
            <dl className="mt-4 grid gap-y-2 text-sm sm:grid-cols-[160px_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Company</dt>
              <dd>{user?.company?.companyName ?? "Not added yet"}</dd>
              <dt className="text-muted-foreground">Business type</dt>
              <dd>{user?.company?.businessType ?? "Not added yet"}</dd>
              <dt className="text-muted-foreground">GSTIN</dt>
              <dd>{user?.company?.gstin ?? "Not added yet"}</dd>
            </dl>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link to="/business/profile">Edit business profile</Link>
            </Button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              This is a retail account. Bulk pricing, quote requests and GST invoices live on the
              same login — switch them on whenever you need them.
            </p>
            <Button
              className="mt-4"
              disabled={enabling}
              onClick={() => {
                void enableBusiness();
              }}
            >
              {enabling ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" /> Enabling…
                </>
              ) : (
                "Enable business buying"
              )}
            </Button>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The name and mobile number, editable against `PATCH /account/profile`.
 *
 * **Two of the three inputs open here; the email's stays shut, and that is the decision.** All three
 * were `readOnly disabled` while there was no endpoint, and the Phase 1 form before that wrote the
 * edit to localStorage only — so it said "Profile saved" and lost the change on the next
 * `GET /auth/me`. The email is different in kind rather than in readiness: it is the login
 * identifier, `uq_users_email` is a case-insensitive unique index on it, and changing it is an
 * account-recovery flow with verification. `UpdateProfileDto` declares no `email`, so a body carrying
 * one is a **400** — the input being disabled is the explanation, not the enforcement.
 *
 * The save goes through `useAuth().updateProfile`, which writes the server's answer into the session
 * snapshot. That is what keeps the header's greeting, the route guards and this form from disagreeing
 * about a name that has just changed — and it is why the toast fires only after the request resolves.
 */
function ContactDetails({ user }: { user: AuthUser }) {
  const { updateProfile } = useAuth();

  const form = useForm<ContactValues, unknown, ContactValues>({
    resolver: zodResolver<ContactValues, unknown, ContactValues>(contactSchema),
    defaultValues: { name: user.name, phone: user.phone },
  });

  const onSubmit = async (values: ContactValues) => {
    try {
      await updateProfile(values);
      // Reset to what was saved, so the form is no longer "dirty" and a second Save with nothing
      // changed does not look like an unsaved edit.
      form.reset(values);
      toast.success("Profile saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save. Please try again.");
    }
  };

  return (
    <section className="border-border mt-8 rounded-2xl border p-5 sm:p-6">
      <h2 className="font-display text-2xl">Contact details</h2>
      <Form {...form}>
        <form
          onSubmit={(event) => {
            void form.handleSubmit(onSubmit)(event);
          }}
          className="mt-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input maxLength={120} autoComplete="name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mobile number</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      maxLength={10}
                      autoComplete="tel-national"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="account-email">Email</Label>
              <Input id="account-email" value={user.email} readOnly disabled />
              <p className="text-muted-foreground text-sm">
                Your email is your sign-in, so it cannot be changed here.
              </p>
            </div>
          </div>

          <Button type="submit" className="mt-5" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </form>
      </Form>
    </section>
  );
}
