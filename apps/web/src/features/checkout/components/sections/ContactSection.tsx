import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";
import { Section } from "./Section";

export function ContactSection({ form, step }: Pick<CheckoutFormState, "form"> & { step: number }) {
  return (
    <Section title="Contact" step={step} className="lg:col-start-1">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="shipping.email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="shipping.phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Mobile number</FormLabel>
              <FormControl>
                <Input
                  inputMode="numeric"
                  maxLength={10}
                  autoComplete="tel-national"
                  placeholder="10-digit mobile"
                  {...field}
                />
              </FormControl>
              <FormDescription>For delivery updates only.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </Section>
  );
}
