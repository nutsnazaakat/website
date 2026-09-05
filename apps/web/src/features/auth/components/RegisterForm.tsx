import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { BUSINESS_TYPES } from "@/features/rfq/schema";
import { useAuth } from "../AuthProvider";
import { registerSchema, type RegisterValues } from "../schema";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function RegisterForm({ redirectTo }: { redirectTo?: string }) {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<RegisterValues, unknown, RegisterValues>({
    resolver: zodResolver<RegisterValues, unknown, RegisterValues>(registerSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      password: "",
      isBusiness: false,
      companyName: "",
      businessType: "",
      gstin: "",
    },
  });

  // Spec §46: this one checkbox is how a single account gains bulk access.
  const isBusiness = form.watch("isBusiness");

  const onSubmit = async (values: RegisterValues) => {
    setError(null);
    try {
      const user = await register({
        name: values.name,
        email: values.email,
        phone: values.phone,
        password: values.password,
        isBusiness: values.isBusiness,
        ...(values.isBusiness
          ? {
              company: {
                companyName: values.companyName ?? "",
                contactPerson: values.name,
                businessType: values.businessType ?? "",
                ...(values.gstin ? { gstin: values.gstin } : {}),
              },
            }
          : {}),
      });
      toast.success(user.role === "b2b" ? "Account created with bulk access" : "Account created");
      await navigate({ to: redirectTo ?? "/account" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create your account. Try again.");
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full name</FormLabel>
              <FormControl>
                <Input autoComplete="name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" {...field} />
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
                <Input inputMode="numeric" maxLength={10} autoComplete="tel" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isBusiness"
          render={({ field }) => (
            <FormItem className="border-border flex items-start gap-3 rounded-2xl border p-4">
              <FormControl>
                <Checkbox
                  checked={field.value === true}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
              </FormControl>
              <div>
                <FormLabel className="!mt-0">I&apos;m buying for a business</FormLabel>
                <FormDescription>
                  Unlocks bulk pricing, quote requests and GST invoices on this same account.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        {isBusiness && (
          <div className="border-border grid gap-4 rounded-2xl border p-4">
            <FormField
              control={form.control}
              name="companyName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Company name</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="businessType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business type</FormLabel>
                  <FormControl>
                    <select className={SELECT_CLASS} {...field} value={field.value ?? ""}>
                      <option value="">Select a business type</option>
                      {BUSINESS_TYPES.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="gstin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>GSTIN (optional)</FormLabel>
                  <FormControl>
                    <Input
                      maxLength={15}
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                    />
                  </FormControl>
                  <FormDescription>Add it later if you are not registered yet.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-destructive text-sm font-medium">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Creating account…
            </>
          ) : (
            "Create Account"
          )}
        </Button>
      </form>
    </Form>
  );
}
