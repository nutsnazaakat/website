import { z } from "zod";
import { PHONE_REGEX } from "@/features/checkout/schema";

/** The contact form's topic list lives in `@/contract`, so the backend's
 * `CreateContactMessageDto` validates against the same strings the select submits. */
export { CONTACT_TOPICS } from "@/contract";

export const contactSchema = z.object({
  name: z.string().min(2, "Enter your name"),
  email: z.string().email("Enter a valid email address"),
  phone: z
    .string()
    .refine((v) => v === "" || PHONE_REGEX.test(v), "Enter a valid 10-digit Indian mobile number")
    .optional(),
  topic: z.string().min(1, "Choose what this is about"),
  orderNumber: z.string().optional(),
  message: z.string().min(10, "Tell us a little more so we can help"),
});

export type ContactFormValues = z.infer<typeof contactSchema>;
