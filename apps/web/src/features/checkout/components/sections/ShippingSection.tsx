import { addDays, format } from "date-fns";
import { Truck } from "lucide-react";
import { useSiteSettings } from "@/config/useSiteSettings";
import { inr } from "@/lib/format";
import type { CheckoutFormState } from "../../hooks/useCheckoutForm";
import { Section } from "./Section";

export function ShippingSection({
  delivery,
  serviceable,
  shipping,
  step,
}: Pick<CheckoutFormState, "delivery" | "serviceable" | "shipping"> & { step: number }) {
  const settings = useSiteSettings();
  return (
    <Section title="Shipping" step={step} className="lg:col-start-1">
      <div className="border-border flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
        <Truck className="text-leaf size-5" />
        <div>
          <p className="text-sm font-semibold">Standard delivery</p>
          <p className="text-muted-foreground text-xs">
            {serviceable ? (
              <>
                Estimated arrival by{" "}
                {format(addDays(new Date(), serviceable.etaDays), "d MMM yyyy")}
              </>
            ) : delivery.data ? (
              <>We don&apos;t deliver to {delivery.data.pincode} yet.</>
            ) : (
              <>Enter your pincode for a delivery date.</>
            )}
          </p>
        </div>
        <span className="ml-auto text-sm font-semibold">
          {shipping === 0 ? "Free" : inr(shipping)}
        </span>
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        Free above {inr(settings.freeShippingThreshold)}. Dispatched within 24 hours on working
        days.
      </p>
    </Section>
  );
}
