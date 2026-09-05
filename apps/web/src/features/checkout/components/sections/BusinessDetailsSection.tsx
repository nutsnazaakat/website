import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { INDIAN_STATES } from "../../schema";
import { Section } from "./Section";
import { SELECT_CLASS } from "./shared";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";

/**
 * Rendered only when the basket is on the business track. The `isB2b` test stays in the composition
 * root beside the step numbers it also decides, so the whole ladder reads in one place.
 */
export function BusinessDetailsSection({
  form,
  billingSame,
  step,
}: Pick<CheckoutFormState, "form" | "billingSame"> & { step: number }) {
  return (
    <Section title="Business Details" step={step} className="lg:col-start-1">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="companyName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Company name</FormLabel>
              <FormControl>
                <Input autoComplete="organization" {...field} value={field.value ?? ""} />
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
              <FormLabel>GSTIN</FormLabel>
              <FormControl>
                <Input
                  maxLength={15}
                  placeholder="15-character GSTIN"
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                />
              </FormControl>
              <FormDescription>Needed for an input-credit invoice.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="poNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>PO number (optional)</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="billingSameAsShipping"
          render={({ field }) => (
            <FormItem className="flex items-center gap-3 sm:pt-8">
              <FormControl>
                <Checkbox
                  checked={field.value !== false}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
              </FormControl>
              <FormLabel className="!mt-0">Billing address is the same</FormLabel>
            </FormItem>
          )}
        />

        {!billingSame && (
          // Every field addressSchema requires has to be reachable here, or a
          // half-filled billing address would fail validation with no way to fix it.
          <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="billing.fullName"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Billing name</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Billing phone</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      maxLength={10}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Billing email</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.line1"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Billing address</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.line2"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Billing landmark (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Billing city</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="billing.state"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Billing state</FormLabel>
                  <FormControl>
                    <select className={SELECT_CLASS} {...field} value={field.value ?? ""}>
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
              name="billing.pincode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Billing pincode</FormLabel>
                  <FormControl>
                    <Input maxLength={6} inputMode="numeric" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        )}

        <FormField
          control={form.control}
          name="specialInstructions"
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Special instructions (optional)</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Packing, labelling or delivery-window notes"
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </Section>
  );
}
