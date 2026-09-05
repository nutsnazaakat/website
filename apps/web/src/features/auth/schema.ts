import { z } from "zod";
import { GSTIN_REGEX, PHONE_REGEX } from "@/features/checkout/schema";

export const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});

/**
 * Company fields are optional in the shape and conditionally required in the refinement,
 * so ticking "I'm buying for a business" reveals them without remounting the form or
 * discarding what has already been typed.
 */
export const registerSchema = z
  .object({
    name: z.string().min(2, "Enter your full name"),
    email: z.string().email("Enter a valid email address"),
    phone: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
    // 8, matching `RegisterDto`'s `@MinLength(8)` and `PasswordService.MIN_LENGTH`. At 6 the
    // client accepted passwords the API rejects, turning an inline field error into a 400.
    password: z.string().min(8, "Use at least 8 characters"),
    isBusiness: z.boolean(),
    companyName: z.string().optional(),
    businessType: z.string().optional(),
    gstin: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.isBusiness) return;
    if ((v.companyName ?? "").trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["companyName"],
        message: "Enter your company name",
      });
    }
    if (!v.businessType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessType"],
        message: "Select your business type",
      });
    }
    // GSTIN stays optional — a business may register before it is GST-registered.
    if (v.gstin && !GSTIN_REGEX.test(v.gstin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gstin"],
        message: "Enter a valid 15-character GSTIN",
      });
    }
  });

export type LoginValues = z.infer<typeof loginSchema>;
export type RegisterValues = z.infer<typeof registerSchema>;
