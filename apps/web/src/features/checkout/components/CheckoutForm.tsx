import { Form } from "@/components/ui/form";
import { useCheckoutForm } from "../hooks/useCheckoutForm";
import { BusinessDetailsSection } from "./sections/BusinessDetailsSection";
import { ContactSection } from "./sections/ContactSection";
import { CouponSection } from "./sections/CouponSection";
import { DeliveryAddressSection } from "./sections/DeliveryAddressSection";
import { OrderSummary } from "./sections/OrderSummary";
import { PaymentSection } from "./sections/PaymentSection";
import { ShippingSection } from "./sections/ShippingSection";

/**
 * The checkout screen, as a composition root.
 *
 * **Why this file could be split at all.** A React component's JSX children have no ordering
 * constraint between them: each section below reads from the same `useCheckoutForm` closure and
 * writes to the same `react-hook-form` store, and moving one into its own file changes nothing about
 * when it runs, because nothing about it *ran in sequence* to begin with. React re-renders the whole
 * tree from one state, so the source order here is layout order and nothing more — the `aside` even
 * says so out loud, sitting between the business and coupon blocks in the markup and in column two
 * on screen. That is the opposite of the backend's `CheckoutService.place`, which is deliberately
 * still one 257-line sequence: there, every statement depends on the row the previous one locked,
 * and lifting a block out would be lifting it out of the transaction that makes it correct.
 *
 * **The step numbers are the one thing that reads as a whole here, so they stay here.** They
 * renumber on `isB2b` — a business basket inserts "Business Details" as 3 and pushes coupon,
 * shipping and payment to 4, 5, 6 — which is only checkable if the whole ladder is visible in one
 * place. Each section takes `step` as a prop rather than deciding its own.
 */
export function CheckoutForm() {
  const {
    form,
    isB2b,
    billingSame,
    offered,
    takingOrders,
    delivery,
    serviceable,
    coupon,
    couponCode,
    couponApplied,
    couponRefused,
    discount,
    items,
    totals,
    shipping,
    payable,
    placement,
    submitting,
  } = useCheckoutForm();

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          placement.mutate(values);
        })}
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start"
      >
        <ContactSection form={form} step={1} />

        <DeliveryAddressSection form={form} step={2} />

        {isB2b && <BusinessDetailsSection form={form} billingSame={billingSame} step={3} />}

        <OrderSummary
          items={items}
          totals={totals}
          discount={discount}
          couponApplied={couponApplied}
          shipping={shipping}
          payable={payable}
          placement={placement}
          submitting={submitting}
          takingOrders={takingOrders}
        />

        <CouponSection
          form={form}
          coupon={coupon}
          couponCode={couponCode}
          couponApplied={couponApplied}
          couponRefused={couponRefused}
          step={isB2b ? 4 : 3}
        />

        <ShippingSection
          delivery={delivery}
          serviceable={serviceable}
          shipping={shipping}
          step={isB2b ? 5 : 4}
        />

        <PaymentSection
          form={form}
          offered={offered}
          takingOrders={takingOrders}
          step={isB2b ? 6 : 5}
        />
      </form>
    </Form>
  );
}
