import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useProducts } from "@/features/catalog/hooks/useCatalog";
import { useCreateGiftingRfq } from "@/features/rfq/hooks/useRfqs";
import type { Rfq } from "@/features/rfq/types";
import { inr } from "@/lib/format";
import {
  BUSINESS_TYPES,
  GIFTING_OCCASIONS,
  giftingSchema,
  type GiftingFormValues,
} from "../schema";

/** Matches the native selects in the checkout and RFQ forms. */
const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Brief §24. Number of boxes, budget per box, branding, delivery date and a custom
 * message, submitted through `POST /rfqs/gifting` — its own front door on `RfqsController`, one
 * number sequence and one status vocabulary shared with the bulk enquiry, so a gifting request
 * gets the same numbered, trackable request rather than a second inbox.
 */
export function CorporateGiftingForm() {
  const { data: giftBoxPage } = useProducts({ category: "combos" });
  const giftBoxes = giftBoxPage?.items ?? [];
  const createGiftingRfq = useCreateGiftingRfq();
  const [created, setCreated] = useState<Rfq | null>(null);

  const form = useForm<GiftingFormValues, unknown, GiftingFormValues>({
    resolver: zodResolver<GiftingFormValues, unknown, GiftingFormValues>(giftingSchema),
    defaultValues: {
      companyName: "",
      contactPerson: "",
      mobile: "",
      email: "",
      gstin: "",
      // `BUSINESS_TYPES` already answers the common case; the field stays a real select because
      // a distributor or a caterer sends corporate gifts too.
      businessType: "Corporate gifting",
      pincode: "",
      occasion: GIFTING_OCCASIONS[0],
      giftBoxSlug: "",
      boxes: 25,
      budgetPerBox: 1500,
      brandingRequired: false,
      deliveryDate: "",
      message: "",
    },
  });

  const submitting = form.formState.isSubmitting;
  const boxes = form.watch("boxes");
  const budgetPerBox = form.watch("budgetPerBox");
  const indicativeValue =
    Number.isFinite(boxes) && Number.isFinite(budgetPerBox) ? boxes * budgetPerBox : 0;

  const onSubmit = async (values: GiftingFormValues) => {
    setCreated(await createGiftingRfq.mutateAsync(values));
  };

  if (created) {
    return (
      <div className="border-border bg-card shadow-soft rounded-3xl border p-8 text-center">
        <CheckCircle2 className="text-leaf mx-auto size-10" />
        <h2 className="font-display mt-4 text-3xl">Quote Request Submitted</h2>
        <p className="text-muted-foreground mx-auto mt-3 max-w-md text-sm">
          Our gifting desk replies with box options, branding mockups and a dispatch plan. Quote
          this number in any follow-up.
        </p>
        <p className="bg-sand mt-6 rounded-2xl px-6 py-4 text-2xl font-bold tracking-wide">
          {created.id}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link to="/business/rfqs/$id" params={{ id: created.id }}>
              View this request
            </Link>
          </Button>
          <Button variant="outline" onClick={() => setCreated(null)}>
            Send another enquiry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        aria-label="Corporate gifting enquiry"
        className="border-border bg-card shadow-soft rounded-3xl border p-6 sm:p-8"
      >
        <h2 className="font-display text-3xl">Corporate gifting enquiry</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Tell us the volume, budget and date. We come back with box options and a written quotation
          against a request number you can track.
        </p>

        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="companyName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company name</FormLabel>
                <FormControl>
                  <Input autoComplete="organization" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contactPerson"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact person</FormLabel>
                <FormControl>
                  <Input autoComplete="name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="mobile"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Mobile number</FormLabel>
                <FormControl>
                  <Input
                    inputMode="numeric"
                    maxLength={10}
                    autoComplete="tel-national"
                    placeholder="10-digit mobile"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Work email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="gstin"
            render={({ field }) => (
              <FormItem>
                <FormLabel>GSTIN (optional)</FormLabel>
                <FormControl>
                  <Input
                    maxLength={15}
                    placeholder="15-character GSTIN"
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="businessType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Business type</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field}>
                    {BUSINESS_TYPES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="pincode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Delivery pincode</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" maxLength={6} autoComplete="postal-code" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="occasion"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Occasion</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field}>
                    {GIFTING_OCCASIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="giftBoxSlug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Gift box</FormLabel>
                <FormControl>
                  <select className={SELECT_CLASS} {...field}>
                    <option value="">Select a starting point</option>
                    {giftBoxes.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormDescription>Contents can be swapped on the quotation.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="boxes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Number of boxes</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="budgetPerBox"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Budget per box (₹)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    inputMode="numeric"
                    {...field}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="deliveryDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Delivery date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="brandingRequired"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3 sm:pt-8">
                <FormControl>
                  <Checkbox
                    id="brandingRequired"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                  />
                </FormControl>
                <FormLabel htmlFor="brandingRequired" className="!mt-0 cursor-pointer">
                  Branding required (logo, sleeve or card)
                </FormLabel>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>Custom message (optional)</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="The greeting to print on the card, plus anything else we should know."
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {indicativeValue > 0 && (
          <p className="bg-sand mt-6 rounded-2xl px-4 py-3 text-sm">
            Indicative order value <span className="font-semibold">{inr(indicativeValue)}</span>{" "}
            <span className="text-muted-foreground">
              ({boxes} boxes at your stated budget, before GST and branding)
            </span>
          </p>
        )}

        <Button type="submit" size="lg" className="mt-6" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Submitting…
            </>
          ) : (
            "Request Gifting Quote"
          )}
        </Button>
      </form>
    </Form>
  );
}
