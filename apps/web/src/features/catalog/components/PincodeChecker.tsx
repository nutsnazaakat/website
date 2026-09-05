import { useMutation } from "@tanstack/react-query";
import { MapPin, Truck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settings } from "@/config/settings";
import { checkoutApi } from "@/features/checkout/api";
import { inr } from "@/lib/format";

/** Flat rate below the free-shipping threshold, mirroring cart-math. */
const SHIPPING_FLAT = 79;

interface PincodeCheckerProps {
  /** Value of the currently selected pack, used to preview the shipping charge. */
  orderValue: number;
}

export function PincodeChecker({ orderValue }: PincodeCheckerProps) {
  const [pincode, setPincode] = useState("");
  const { mutate, data, isPending, reset } = useMutation({
    mutationFn: checkoutApi.checkPincode,
  });

  const valid = /^\d{6}$/.test(pincode);
  const freeShipping = orderValue >= settings.freeShippingThreshold;

  return (
    <div className="border-border mt-6 rounded-2xl border p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <MapPin className="text-leaf size-4" />
        Check delivery
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) mutate(pincode);
        }}
      >
        <Input
          value={pincode}
          inputMode="numeric"
          maxLength={6}
          placeholder="Enter 6-digit pincode"
          aria-label="Delivery pincode"
          className="max-w-48"
          onChange={(e) => {
            setPincode(e.target.value.replace(/\D/g, "").slice(0, 6));
            reset();
          }}
        />
        <Button type="submit" variant="outline" disabled={!valid || isPending}>
          {isPending ? "Checking…" : "Check"}
        </Button>
      </form>

      {data &&
        (data.serviceable ? (
          <div className="mt-3 space-y-1 text-sm">
            <p className="text-leaf flex items-center gap-2 font-medium">
              <Truck className="size-4" />
              Delivers to {data.pincode} in {data.etaDays} working days.
            </p>
            <p className="text-muted-foreground">
              {freeShipping
                ? "Free shipping on this order."
                : `Shipping ${inr(SHIPPING_FLAT)} — free above ${inr(settings.freeShippingThreshold)}.`}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground mt-3 text-sm">We don&apos;t deliver here yet.</p>
        ))}
    </div>
  );
}
