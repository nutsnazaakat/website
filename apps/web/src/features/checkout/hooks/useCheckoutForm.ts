import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Banknote, CreditCard } from "lucide-react";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { PINCODE_REGEX, type PaymentMethod } from "@/contract";
import { settings } from "@/config/settings";
import { accountKeys } from "@/features/account/hooks/useAccount";
import { useCart } from "@/features/cart/CartProvider";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { checkoutApi } from "../api";
import { b2bCheckoutSchema, b2cCheckoutSchema, type CheckoutFormValues } from "../schema";

const emptyAddress = {
  fullName: "",
  phone: "",
  email: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  pincode: "",
};

const payments: { value: PaymentMethod; icon: typeof Banknote; label: string; hint: string }[] = [
  {
    value: "online",
    icon: CreditCard,
    label: "Pay Online",
    hint: "UPI, cards and netbanking",
  },
  {
    value: "cod",
    icon: Banknote,
    label: "Cash on Delivery",
    hint: "Pay the courier when it arrives",
  },
];

/**
 * Everything `/checkout` needs to know before it can render a field, in one hook.
 *
 * The split from `CheckoutForm` is a move, not a rewrite: the body below is the component's own
 * prologue verbatim, in its original order, because that order is the hook order React depends on.
 * What is *returned* is the closure the JSX used to read from lexical scope, so a section that used
 * to reach for `serviceable` now receives it — and `CheckoutFormState` below makes the reaching
 * type-checked.
 *
 * `form` is returned and passed down as a prop rather than published through `FormProvider`.
 * `useFormContext` would type every `name` as a loose string: `"shipping.pincode"` misspelled is a
 * field that silently never registers, which is a blank input and a validation error the customer
 * cannot clear. Handing the typed `UseFormReturn` down keeps that a compile error.
 */
export function useCheckoutForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { lines, totals, lineTotalFor, reload: reloadCart } = useCart();
  // Names the cart lines, so it needs the catalogue rather than a page of it.
  const { data: catalogue } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];

  /**
   * Which methods checkout may offer, read from the config rather than from the server.
   *
   * A `Record<PaymentMethod, boolean>` so a method added to `shared` cannot quietly go unoffered.
   * Both flags mirror a `settings` row — `codEnabled: true`, `onlinePaymentEnabled: false` — and
   * Task 9's server refuses `"online"` with `422 PAYMENT_METHOD_UNAVAILABLE`. Offering a card the
   * server will refuse shows the customer a door that was never open, which is the whole reason the
   * gate exists; the 422 is still the enforcement and this is only merchandising.
   */
  const enabled: Record<PaymentMethod, boolean> = {
    cod: settings.codEnabled,
    online: settings.onlinePaymentEnabled,
  };
  const offered = payments.filter((method) => enabled[method.value]);
  const takingOrders = offered.length > 0;

  // Bulk or quote-only lines put this order on the business track, which needs
  // GSTIN and company details before it can be invoiced.
  //
  // `hasQuoteLines`, never `hasUnpriceableLines`: the latter is also true for a sold-out pack, and
  // demanding a GST number from a retail customer because one bag ran out is a dead end.
  const isB2b = lines.some((l) => l.mode === "bulk") || totals.hasQuoteLines;

  // The form always holds the superset shape; the active schema decides what is
  // required, so toggling between B2C and B2B never remounts the fields.
  const form = useForm<CheckoutFormValues, unknown, CheckoutFormValues>({
    resolver: isB2b
      ? zodResolver<CheckoutFormValues, unknown, CheckoutFormValues>(b2bCheckoutSchema)
      : zodResolver<CheckoutFormValues, unknown, CheckoutFormValues>(b2cCheckoutSchema),
    defaultValues: {
      shipping: { ...emptyAddress },
      couponCode: "",
      /**
       * `cod`, not `online` — disagreement 2, settled.
       *
       * The old default was harmless only because `onSubmit` threw the choice away; now that the
       * field is sent, `"online"` is a `422 PAYMENT_METHOD_UNAVAILABLE` on the happy path. The
       * fallback to whichever method *is* offered exists so the form can never submit a method whose
       * card the settings hid — with both off nothing is submittable at all, which is the branch
       * `takingOrders` renders.
       */
      paymentMethod: settings.codEnabled ? "cod" : "online",
      companyName: "",
      gstin: "",
      poNumber: "",
      billingSameAsShipping: true,
      specialInstructions: "",
    },
  });

  const billingSame = form.watch("billingSameAsShipping") !== false;

  /**
   * Serviceability for the address being typed, which is where the ETA and the delivery charge now
   * come from.
   *
   * Disagreement 3 condemned four competing ETAs and gave this screen's own — a flat
   * `addDays(new Date(), 4)` with no reference to the customer's pincode — no owner. It agreed with
   * the seed by coincidence, because every seeded prefix carries `etaDays: 4`; that column is
   * per-destination and admin-editable, which is the entire argument for its authority, so the first
   * admin to lengthen a remote prefix's ETA would have made this page promise a date the very next
   * screen contradicted.
   *
   * A `useQuery` keyed on the pincode rather than an effect: react-query then dedupes the request
   * across keystrokes, and re-typing a pincode already asked about is answered from the cache
   * instead of the network. `enabled` on `PINCODE_REGEX` keeps a half-typed pincode from asking the
   * server about a value its DTO would answer 400 for.
   */
  const pincode = form.watch("shipping.pincode");
  const delivery = useQuery({
    queryKey: ["checkout", "pincode", pincode],
    queryFn: () => checkoutApi.checkPincode(pincode),
    enabled: PINCODE_REGEX.test(pincode),
  });
  const serviceable = delivery.data?.serviceable === true ? delivery.data : null;

  const coupon = useMutation({ mutationFn: checkoutApi.previewCoupon });
  const couponCode = form.watch("couponCode") ?? "";
  const couponApplied = coupon.data?.eligible === true ? coupon.data : null;
  const couponRefused = coupon.data?.eligible === false ? coupon.data : null;
  const discount = couponApplied?.discount ?? 0;

  /**
   * One `Idempotency-Key` per attempt, minted lazily and cleared only after a placement succeeds.
   *
   * A key generated inside the submit handler would give every click a fresh one and defeat
   * `IdempotencyInterceptor` completely — the double-clicked Place Order it exists to collapse would
   * arrive as two unrelated requests and place two orders. A key held for the component's whole life
   * is the opposite failure: after a successful order the customer's *next* order would replay the
   * first one's response. So it lives as long as one attempt does, retries included.
   */
  const attemptKey = useRef<string | null>(null);
  const keyForAttempt = (): string => (attemptKey.current ??= crypto.randomUUID());

  /**
   * The basket as this page's own summary list renders it.
   *
   * Declared here rather than imported: it used to be `OrderItem` on the checkout API, part of the
   * `sessionStorage` receipt's shape, and the receipt is gone — the confirmation screen reads the
   * placed order from the server now. Nothing outside this component needs it, and exporting it
   * again would invite a second definition of a line to drift from `OrderLine` in `shared`.
   */
  const items: { name: string; detail: string; qty: number; total: number | null }[] = lines.map(
    (line) => ({
      name: products.find((p) => p.slug === line.slug)?.name ?? line.slug,
      detail: line.mode === "bulk" ? `${line.kg} kg` : (line.size ?? ""),
      qty: line.qty,
      total: lineTotalFor(line),
    }),
  );

  /**
   * The delivery charge, mirroring `CheckoutService.shippingFor` rather than restating it.
   *
   * The server's rule is *"free shipping still wins; otherwise bill the pincode row"* — so the
   * threshold decision comes from the cart's own figure, which `GET /cart` already computed, and the
   * amount comes from the destination. Printing the pincode's charge unconditionally would overcharge
   * every basket over `freeShippingThreshold`, which is exactly the misuse `PincodeCheckResponse`'s
   * docblock warns about. Until a pincode is known the cart's flat figure stands in.
   */
  const shipping = totals.shipping === 0 ? 0 : (serviceable?.shipping ?? totals.shipping);
  const payable = totals.subtotal - discount + totals.gst + shipping;

  const placement = useMutation({
    mutationFn: (values: CheckoutFormValues) => checkoutApi.placeOrder(values, keyForAttempt()),
    onSuccess: async (order) => {
      // Cleared here and nowhere else: this attempt is over, so the next order needs its own key.
      attemptKey.current = null;

      /**
       * Seeded before navigating, and not as an optimisation. It is also now the **only** copy: the
       * `nn.order.${id}` sessionStorage receipt this used to write beside it is deleted, along with
       * the two readers that needed it.
       *
       * `/checkout` and `/order-success/$id` have no route guard — `requireCustomer` is used by
       * `routes/account/route.tsx` and nowhere else — so a **guest** placing an order is the
       * ordinary retail path. Their order is written with `userId: null` while
       * `GET /account/orders/:orderNumber` is session-scoped, so fetching their own confirmation
       * would be a 401, and nothing on the order identifies them: there is no guest-token column on
       * `orders`. The placement response *is* the order — `PlaceOrderResult = AccountOrder` — so
       * writing it under the key the confirmation reads costs nothing and is the only thing that
       * makes a guest's confirmation possible.
       *
       * `accountKeys.order(id)` rather than a hand-written array at either end: two literals that
       * drift by one element are a silent cache miss, which for a guest is a 401 on their own order.
       */
      queryClient.setQueryData(accountKeys.order(order.id), order);

      await navigate({ to: "/order-success/$id", params: { id: order.id } });

      /**
       * The basket is re-read, never re-emptied. `CheckoutService.place` deletes the cart's items
       * inside the placement transaction (`checkout.service.ts:321`), so a client `PUT /cart` with
       * an empty array would be a second opinion about a basket the server has already settled —
       * and a write, unlike a read, can lose a line added in another tab. A `GET` picks up what the
       * server did, which is what keeps the header count honest.
       *
       * **After the navigation, not before.** The emptied basket would otherwise reach this screen
       * first, and `/checkout` renders "Your cart is waiting for something delicious." for an empty
       * one — so the customer would watch their order turn into an empty-cart page on the way to
       * their confirmation.
       */
      void reloadCart();
    },
  });

  const submitting = placement.isPending;

  return {
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
  };
}

/**
 * What the sections may be handed, derived from the hook rather than restated.
 *
 * `ReturnType` so the two cannot drift: a section's props are a `Pick` of this, so dropping a field
 * from the hook is a compile error at every section that reads it instead of a runtime `undefined`.
 */
export type CheckoutFormState = ReturnType<typeof useCheckoutForm>;
