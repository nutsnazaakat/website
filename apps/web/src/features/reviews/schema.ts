import { z } from "zod";

/**
 * Brief §27: rating, written review, optional image. The image is a URL rather than a
 * file because there is no upload endpoint in Phase 1 — the field is shaped so Phase 2
 * can swap the control for a real uploader without changing the submitted payload.
 */
export const reviewSchema = z.object({
  author: z.string().min(2, "Enter the name to show with your review"),
  rating: z
    .number({ invalid_type_error: "Choose a star rating" })
    .int()
    .min(1, "Choose a star rating")
    .max(5),
  body: z.string().min(20, "Write at least 20 characters so the review is useful"),
  imageUrl: z
    .string()
    .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "Enter a valid image URL")
    .optional(),
});

export type ReviewFormValues = z.infer<typeof reviewSchema>;
