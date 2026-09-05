import { z } from "zod";
import { GSTIN_REGEX, PHONE_REGEX, PINCODE_REGEX } from "@/features/checkout/schema";

/**
 * Brief §14's business types and §17's packaging and frequency options now live in
 * `@/contract`, so the backend's RFQ DTO validates against exactly the strings these
 * selects submit. Re-exported here because the RFQ form and the bulk landing page already
 * import them from this module.
 */
export { BUSINESS_TYPES, ORDER_FREQUENCIES, PACKAGING_OPTIONS } from "@/contract";

export const rfqLineSchema = z.object({
  productSlug: z.string().min(1, "Choose a product"),
  kg: z.number().min(1, "Enter a quantity of at least 1 kg"),
});

/**
 * The phone, pincode and GSTIN rules are imported from the checkout schema rather than
 * restated — one definition, so a correction lands everywhere at once.
 */
export const rfqSchema = z.object({
  businessName: z.string().min(2, "Enter your business name"),
  contactPerson: z.string().min(2, "Enter a contact person"),
  mobile: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
  email: z.string().email("Enter a valid email address"),
  // Optional at RFQ stage, but validated the moment anything is typed.
  gstin: z
    .string()
    .refine((v) => v === "" || GSTIN_REGEX.test(v), "Enter a valid 15-character GSTIN")
    .optional(),
  businessType: z.string().min(1, "Select your business type"),
  pincode: z.string().regex(PINCODE_REGEX, "Enter a valid 6-digit pincode"),
  lines: z.array(rfqLineSchema).min(1, "Add at least one product"),
  packaging: z.string().min(1, "Select a packaging preference"),
  frequency: z.string().min(1, "Select how often you expect to order"),
  notes: z.string().optional(),
});

export type RfqFormValues = z.infer<typeof rfqSchema>;
