import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";
import { Section } from "./Section";

export function PaymentSection({
  form,
  offered,
  takingOrders,
  step,
}: Pick<CheckoutFormState, "form" | "offered" | "takingOrders"> & { step: number }) {
  return (
    <Section title="Payment" step={step} className="lg:col-start-1">
      {takingOrders ? (
        <FormField
          control={form.control}
          name="paymentMethod"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <RadioGroup
                  value={field.value}
                  onValueChange={field.onChange}
                  className="grid gap-3 sm:grid-cols-2"
                >
                  {offered.map((p) => (
                    <label
                      key={p.value}
                      htmlFor={`pay-${p.value}`}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
                        field.value === p.value
                          ? "border-primary bg-accent"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      <RadioGroupItem value={p.value} id={`pay-${p.value}`} />
                      <p.icon className="text-muted-foreground size-5" />
                      <span>
                        <span className="block text-sm font-semibold">{p.label}</span>
                        <span className="text-muted-foreground block text-xs">{p.hint}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : (
        // Both methods off is a real configuration, not a defensive branch: an empty payment
        // section would leave the customer clicking a button that could only 422.
        <p className="text-muted-foreground text-sm">
          We are not taking orders right now. Please try again shortly.
        </p>
      )}
    </Section>
  );
}
