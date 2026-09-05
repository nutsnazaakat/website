import { zodResolver } from "@hookform/resolvers/zod";
import { Clock3, Loader2, Star } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCreateReview } from "../hooks/useReviews";
import { reviewSchema, type ReviewFormValues } from "../schema";

/**
 * Brief §27. Star rating, written review and an optional image.
 *
 * A submitted review is queued for moderation rather than published, so the success
 * state says so explicitly. Showing the review back to its author as though it were live
 * would be a lie the moment an admin rejects it.
 */
export function ReviewForm({ productSlug }: { productSlug: string }) {
  const createReview = useCreateReview();
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<ReviewFormValues, unknown, ReviewFormValues>({
    resolver: zodResolver<ReviewFormValues, unknown, ReviewFormValues>(reviewSchema),
    defaultValues: { author: "", rating: 0, body: "", imageUrl: "" },
  });

  const rating = form.watch("rating");
  const submitting = form.formState.isSubmitting;

  const onSubmit = async (values: ReviewFormValues) => {
    await createReview.mutateAsync({
      productSlug,
      author: values.author,
      rating: values.rating,
      body: values.body,
      ...(values.imageUrl ? { imageUrl: values.imageUrl } : {}),
    });
    form.reset();
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div
        role="status"
        className="border-border bg-sand shadow-soft rounded-2xl border p-6 text-sm"
      >
        <p className="font-display flex items-center gap-2 text-xl">
          <Clock3 className="text-leaf size-5" aria-hidden="true" />
          Thanks — your review is awaiting approval
        </p>
        <p className="text-muted-foreground mt-2">
          Every review is read by our team before it goes live, so it will not appear on this page
          straight away. We publish or decline within two working days.
        </p>
        <Button variant="outline" className="mt-4" onClick={() => setSubmitted(false)}>
          Write another review
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        aria-label="Write a review"
        className="border-border bg-card shadow-soft rounded-2xl border p-6"
      >
        <h3 className="font-display text-2xl">Write a review</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Reviews are moderated before they appear.
        </p>

        <div className="mt-5 space-y-5">
          <FormField
            control={form.control}
            name="rating"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your rating</FormLabel>
                <FormControl>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        aria-label={`Rate ${star} out of 5`}
                        aria-pressed={rating === star}
                        onClick={() => field.onChange(star)}
                        className="focus-visible:ring-ring rounded-md p-0.5 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <Star
                          className={cn(
                            "size-7 transition-colors",
                            star <= rating ? "fill-gold text-gold" : "text-border",
                          )}
                        />
                      </button>
                    ))}
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="author"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" placeholder="Shown with your review" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Your review</FormLabel>
                <FormControl>
                  <Textarea
                    rows={4}
                    placeholder="Taste, texture, packaging, how it arrived — whatever would have helped you decide."
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="imageUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Photo URL (optional)</FormLabel>
                <FormControl>
                  <Input
                    inputMode="url"
                    placeholder="https://placehold.co/800x800"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>
                  Paste a link for now — direct photo upload arrives with the customer account
                  release.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" /> Submitting…
              </>
            ) : (
              "Submit Review"
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
