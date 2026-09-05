import { z } from "zod";
import {
  GSTIN_REGEX,
  INDIAN_STATES,
  PHONE_REGEX,
  PINCODE_REGEX,
  type PaymentMethod,
} from "@/contract";

/**
 * The identifier formats and the state list now live in `@/contract` so the backend's
 * class-validator DTOs apply exactly these rules. Re-exported here because the RFQ, gifting
 * and business-profile schemas already import them from this module.
 */
export { GSTIN_REGEX, INDIAN_STATES, PHONE_REGEX, PINCODE_REGEX };

export const addressSchema = z.object({
  fullName: z.string().min(2, "Enter your full name"),
  phone: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
  email: z.string().email("Enter a valid email address"),
  line1: z.string().min(4, "Enter your address"),
  line2: z.string().optional(),
  city: z.string().min(2, "Enter your city"),
  state: z.string().min(2, "Select your state"),
  pincode: z.string().regex(PINCODE_REGEX, "Enter a valid 6-digit pincode"),
});

/**
 * Every method the form knows how to render, pinned to the wire's own union.
 *
 * `satisfies readonly PaymentMethod[]` is the whole point: `paymentMethod` is now **sent**, and
 * `PlaceOrderDto` types it as `PaymentMethod` while validating `@IsIn(['cod'])`. A value this schema
 * accepted that `shared` did not would be a 400 the form could not explain, and a member added to
 * `PaymentMethod` that never reached this tuple would be a method checkout silently refused to offer.
 *
 * It is **not** narrowed to `['cod']` even though that is all the server currently accepts. Which
 * methods are on offer is a settings question — `settings.onlinePaymentEnabled`, seeded `false` — and
 * `CheckoutForm` gates the cards on it, so enabling online payment later is a settings change rather
 * than a schema change. Narrowing here would put the answer in two places and make one of them a
 * deployment.
 */
export const PAYMENT_METHODS = ["cod", "online"] as const satisfies readonly PaymentMethod[];

export const b2cCheckoutSchema = z.object({
  shipping: addressSchema,
  couponCode: z.string().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
});

export const b2bCheckoutSchema = b2cCheckoutSchema.extend({
  companyName: z.string().min(2, "Enter your company name"),
  gstin: z.string().regex(GSTIN_REGEX, "Enter a valid 15-character GSTIN"),
  poNumber: z.string().optional(),
  billingSameAsShipping: z.boolean(),
  billing: addressSchema.optional(),
  specialInstructions: z.string().optional(),
});

export type Address = z.infer<typeof addressSchema>;
export type B2cCheckout = z.infer<typeof b2cCheckoutSchema>;
export type B2bCheckout = z.infer<typeof b2bCheckoutSchema>;

/**
 * The shape react-hook-form holds. It is the B2B superset with the B2B-only fields
 * optional, so switching between the two schemas never remounts the form or loses
 * what the customer already typed. Which schema is active decides what is required.
 */
export type CheckoutFormValues = B2cCheckout & Partial<Omit<B2bCheckout, keyof B2cCheckout>>;
