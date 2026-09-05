import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
import { isAdmin, redirectToAdminApp } from "../admin-redirect";
import { useAuth } from "../AuthProvider";
import { loginSchema, type LoginValues } from "../schema";

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<LoginValues, unknown, LoginValues>({
    resolver: zodResolver<LoginValues, unknown, LoginValues>(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = async (values: LoginValues) => {
    setError(null);
    try {
      const user = await login(values);
      // An admin has no business in the customer account area. Send them to the console if this
      // environment knows where it is; otherwise leave them on the sign-in page with an explanation,
      // which is more honest than dropping them into a customer dashboard that offers to manage their
      // delivery addresses.
      if (isAdmin(user.role)) {
        if (redirectToAdminApp()) return;
        setError("This is an administrator account. Please sign in through the admin console.");
        return;
      }
      toast.success(`Welcome back, ${user.name.split(" ")[0]}`);
      await navigate({ to: redirectTo ?? "/account" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign you in. Try again.");
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-4">
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
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {error && (
          <p role="alert" className="text-destructive text-sm font-medium">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Signing in…
            </>
          ) : (
            "Sign In"
          )}
        </Button>
      </form>
    </Form>
  );
}
