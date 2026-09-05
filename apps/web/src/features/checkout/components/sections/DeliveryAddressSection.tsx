import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { INDIAN_STATES } from "../../schema";
import { Section } from "./Section";
import { SELECT_CLASS } from "./shared";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";

export function DeliveryAddressSection({
  form,
  step,
}: Pick<CheckoutFormState, "form"> & { step: number }) {
  return (
    <Section title="Delivery Address" step={step} className="lg:col-start-1">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="shipping.fullName"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
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
          name="shipping.line1"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Input autoComplete="address-line1" placeholder="House, street" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="shipping.line2"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Landmark (optional)</FormLabel>
              <FormControl>
                <Input autoComplete="address-line2" {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="shipping.city"
          render={({ field }) => (
            <FormItem>
              <FormLabel>City</FormLabel>
              <FormControl>
                <Input autoComplete="address-level2" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="shipping.state"
          render={({ field }) => (
            <FormItem>
              <FormLabel>State</FormLabel>
              <FormControl>
                <select autoComplete="address-level1" className={SELECT_CLASS} {...field}>
                  <option value="">Select a state</option>
                  {INDIAN_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
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
          name="shipping.pincode"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pincode</FormLabel>
              <FormControl>
                <Input inputMode="numeric" maxLength={6} autoComplete="postal-code" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </Section>
  );
}
