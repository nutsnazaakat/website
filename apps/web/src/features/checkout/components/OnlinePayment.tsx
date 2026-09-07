import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/http";
import { accountKeys } from "@/features/account/hooks/useAccount";
import type { AccountOrder } from "@/features/account/types";

type GatewayResult = { razorpay_payment_id: string; razorpay_signature: string };
type GatewayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  handler: (result: GatewayResult) => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
};
type Gateway = new (options: GatewayOptions) => { open: () => void };
declare global {
  interface Window {
    Razorpay?: Gateway;
  }
}
let loader: Promise<void> | undefined;
function loadGateway() {
  if (window.Razorpay) return Promise.resolve();
  return (loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => fail(), 15000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      loader = undefined;
      reject(new Error("Payment window could not load. Please retry."));
    }
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => {
      clearTimeout(timeout);
      if (window.Razorpay) resolve();
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  }));
}
export function receiptToken(id: string) {
  try {
    return sessionStorage.getItem(`nn.receipt.${id}`) ?? undefined;
  } catch {
    return undefined;
  }
}
export function OnlinePayment({ order }: { order: AccountOrder }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const qc = useQueryClient();
  if (
    order.paymentMethod !== "online" ||
    order.paymentStatus !== "pending" ||
    order.status === "cancelled"
  )
    return null;
  const token = order.checkoutToken ?? receiptToken(order.id);
  async function pay() {
    if (!token) {
      setError(
        "Open the original checkout tab or contact us with your order number to arrange payment.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const headers = { "X-Order-Token": token };
    try {
      await loadGateway();
      const data = await apiRequest<{
        keyId: string;
        gatewayOrderId: string;
        amount: number;
        currency: string;
      }>(`/checkout/orders/${encodeURIComponent(order.id)}/payment`, { method: "POST", headers });
      const Gateway = window.Razorpay!;
      new Gateway({
        key: data.keyId,
        order_id: data.gatewayOrderId,
        amount: data.amount,
        currency: data.currency,
        name: "Nuts & Nazaakat",
        theme: { color: "#171717" },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setError("Payment was not completed. You can retry this order below.");
          },
        },
        handler: async (result) => {
          try {
            const confirmed = await apiRequest<AccountOrder>(
              `/checkout/orders/${encodeURIComponent(order.id)}/payment/verify`,
              {
                method: "POST",
                headers,
                body: {
                  paymentId: result.razorpay_payment_id,
                  signature: result.razorpay_signature,
                },
              },
            );
            qc.setQueryData(accountKeys.order(order.id), confirmed);
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Payment confirmation is delayed. Please refresh before trying again.",
            );
          } finally {
            setBusy(false);
          }
        },
      }).open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to start payment.");
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 rounded-2xl border p-6" aria-label="Online payment">
      <h2 className="font-display text-2xl">Complete your payment</h2>
      <p className="text-muted-foreground my-3 text-sm">
        Your order is reserved. We will begin fulfilment once payment is confirmed.
      </p>
      <Button disabled={busy} onClick={() => void pay()}>
        {busy ? "Waiting for payment…" : "Pay securely"}
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
