import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSiteSettings } from "@/config/useSiteSettings";
import { checkoutApi } from "@/features/checkout/api";
import { inr } from "@/lib/format";

/** Flat rate below the free-shipping threshold, mirroring cart-math. */
const SHIPPING_FLAT = 79;

interface PincodeCheckerProps {
  /** Value of the currently selected pack, used to preview the shipping charge. */
  orderValue: number;
}

export function PincodeChecker({ orderValue }: PincodeCheckerProps) {
  const settings = useSiteSettings();
  const [pincode, setPincode] = useState("");
  const { mutate, data, isPending, reset } = useMutation({
    mutationFn: checkoutApi.checkPincode,
  });

  const valid = /^\d{6}$/.test(pincode);
  const freeShipping = orderValue >= settings.freeShippingThreshold;

  return (
    <div className="border-border mt-6 border">
      <form
        className="flex"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) mutate(pincode);
        }}
      >
        <label className="text-muted-foreground flex shrink-0 items-center px-3.5 py-3 text-[11px] font-semibold tracking-[0.12em] uppercase">
          Check delivery
        </label>
        <Input
          value={pincode}
          inputMode="numeric"
          maxLength={6}
          placeholder="Enter 6-digit pincode"
          aria-label="Delivery pincode"
          className="h-auto min-w-0 flex-1 border-0 border-l px-3 py-3"
          onChange={(e) => {
            setPincode(e.target.value.replace(/\D/g, "").slice(0, 6));
            reset();
          }}
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={!valid || isPending}
          className="shrink-0"
        >
          {isPending ? "Checking…" : "Check"}
        </Button>
      </form>

      {data &&
        (data.serviceable ? (
          <div className="border-border space-y-1 border-t px-3.5 py-3 text-sm">
            <p className="font-medium">
              Delivers to {data.pincode} in {data.etaDays} working days.
            </p>
            <p className="text-data text-[12px]">
              {freeShipping
                ? "Free shipping on this order."
                : `Shipping ${inr(SHIPPING_FLAT)} — free above ${inr(settings.freeShippingThreshold)}.`}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground border-border border-t px-3.5 py-3 text-sm">
            We don&apos;t deliver here yet.
          </p>
        ))}
    </div>
  );
}
