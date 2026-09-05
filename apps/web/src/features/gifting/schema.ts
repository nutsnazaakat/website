import { z } from "zod";
import { GSTIN_REGEX, PHONE_REGEX, PINCODE_REGEX } from "@/features/checkout/schema";

/**
 * Brief §24 — the corporate gifting enquiry.
 *
 * The identity rules are imported from the checkout schema for the same reason the RFQ
 * schema imports them: one definition of what a valid Indian mobile, pincode and GSTIN
 * looks like, so a correction lands everywhere at once.
 *
 * The occasion list itself now lives in `@/contract` for the same reason, and is
 * re-exported here because the gifting form already imports it from this module.
 *
 * `businessType` joined the form in Task 14: `CreateGiftingRfqDto` requires it — measured
 * against the live schema, `rfqs.business_type` is `NOT NULL` and the gifting form asked for
 * none of `BUSINESS_TYPES`' twelve strings, unlike the bulk RFQ form, which already carries the
 * field. `BUSINESS_TYPES` already answers the common case with "Corporate gifting" (the form
 * defaults to it), but the question is a real one about a real customer — a distributor or a
 * caterer sends corporate gifts too — so it stays a select, not a hardcoded value.
 */
export { BUSINESS_TYPES, GIFTING_OCCASIONS } from "@/contract";

export const giftingSchema = z.object({
  companyName: z.string().min(2, "Enter your company name"),
  contactPerson: z.string().min(2, "Enter a contact person"),
  mobile: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
  email: z.string().email("Enter a valid email address"),
  gstin: z
    .string()
    .refine((v) => v === "" || GSTIN_REGEX.test(v), "Enter a valid 15-character GSTIN")
    .optional(),
  businessType: z.string().min(1, "Select your business type"),
  pincode: z.string().regex(PINCODE_REGEX, "Enter a valid 6-digit delivery pincode"),
  occasion: z.string().min(1, "Select an occasion"),
  giftBoxSlug: z.string().min(1, "Choose a gift box to base the quote on"),
  boxes: z
    .number({ invalid_type_error: "Enter how many boxes you need" })
    .int("Enter a whole number of boxes")
    .min(1, "Enter at least one box"),
  budgetPerBox: z
    .number({ invalid_type_error: "Enter your budget per box" })
    .min(1, "Enter your budget per box"),
  brandingRequired: z.boolean(),
  // A date in the past cannot be delivered against, so it is a validation error rather
  // than something the sales desk has to catch by hand.
  deliveryDate: z
    .string()
    .min(1, "Choose a delivery date")
    .refine((v) => {
      const chosen = new Date(`${v}T00:00:00`);
      if (Number.isNaN(chosen.getTime())) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return chosen >= today;
    }, "Choose a delivery date that has not already passed"),
  message: z.string().optional(),
});

export type GiftingFormValues = z.infer<typeof giftingSchema>;
