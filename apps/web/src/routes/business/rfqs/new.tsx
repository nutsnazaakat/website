import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useSiteSettings } from "@/config/useSiteSettings";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import { useCreateRfq } from "@/features/rfq/hooks/useRfqs";
import {
  BUSINESS_TYPES,
  ORDER_FREQUENCIES,
  PACKAGING_OPTIONS,
  rfqSchema,
  type RfqFormValues,
} from "@/features/rfq/schema";
import type { Rfq, RfqLine } from "@/features/rfq/types";
import { useSeo } from "@/hooks/useSeo";

/**
 * Prefill carried in from a product page, the bulk catalogue or the bulk cart.
 * `product` + `kg` describe a single line; `items` carries several as `slug:kg`
 * pairs, which is what the bulk cart sends when it hands over a whole basket.
 */
const searchSchema = z.object({
  product: z.string().optional(),
  kg: z.number().optional(),
  items: z.string().optional(),
});

export const Route = createFileRoute("/business/rfqs/new")({
  validateSearch: searchSchema,
  component: NewRfq,
});

/** Matches the native state select in the checkout form. */
const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function prefillLines(search: z.infer<typeof searchSchema>): RfqLine[] {
  if (search.items) {
    const parsed = search.items
      .split(",")
      .map((pair) => {
        const [slug, kg] = pair.split(":");
        return { productSlug: slug ?? "", kg: Number(kg) > 0 ? Number(kg) : 1 };
      })
      .filter((l) => l.productSlug !== "");
    if (parsed.length > 0) return parsed;
  }
  if (search.product) return [{ productSlug: search.product, kg: search.kg ?? 1 }];
  return [{ productSlug: "", kg: 1 }];
}

function NewRfq() {
  const settings = useSiteSettings();
  const search = Route.useSearch();
  // Every product has to be pickable from the form, so it needs the catalogue, not a page of it.
  const { data: catalogue } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items ?? [];
  const createRfq = useCreateRfq();
  const [created, setCreated] = useState<Rfq | null>(null);

  useSeo({
    title: `Request a Bulk Quote | ${settings.brandName}`,
    description:
      "Tell us the products, quantities and packing you need. We reply with a written quotation against a numbered request you can track.",
  });

  const form = useForm<RfqFormValues, unknown, RfqFormValues>({
    resolver: zodResolver<RfqFormValues, unknown, RfqFormValues>(rfqSchema),
    defaultValues: {
      businessName: "",
      contactPerson: "",
      mobile: "",
      email: "",
      gstin: "",
      businessType: "",
      pincode: "",
      lines: prefillLines(search),
      packaging: PACKAGING_OPTIONS[4],
      frequency: ORDER_FREQUENCIES[0],
      notes: "",
    },
  });

  const lines = useFieldArray({ control: form.control, name: "lines" });
  const submitting = form.formState.isSubmitting;

  const onSubmit = async (values: RfqFormValues) => {
    setCreated(await createRfq.mutateAsync(values));
  };

  if (created) {
    return (
      <div className="border-border bg-card shadow-soft mx-auto max-w-xl rounded-3xl border p-8 text-center">
        <CheckCircle2 className="text-leaf mx-auto size-10" />
        <h1 className="font-display mt-4 text-4xl">Quote Request Submitted</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          Our B2B desk replies with pricing, samples and dispatch timelines within one working day.
          Quote this number in any follow-up.
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
          <Button asChild variant="outline">
            <Link to="/business/rfqs">All quote requests</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl">Request a Quote</h1>
      <p className="text-muted-foreground mt-3 text-sm">
        Tell us what you need and how often. Every request gets a number you can track from this
        dashboard.
      </p>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="mt-8 space-y-8">
          <section className="border-border rounded-2xl border p-5 sm:p-6">
            <h2 className="font-display text-2xl">Your business</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="businessName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Business name</FormLabel>
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
                    <FormLabel>Email</FormLabel>
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
                    <FormDescription>Add it later if you are not registered yet.</FormDescription>
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
                        <option value="">Select a business type</option>
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
                      <Input
                        inputMode="numeric"
                        maxLength={6}
                        autoComplete="postal-code"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <section className="border-border rounded-2xl border p-5 sm:p-6">
            <h2 className="font-display text-2xl">What you need</h2>
            <div className="mt-5 space-y-4">
              {lines.fields.map((row, i) => (
                <div key={row.id} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
                  <FormField
                    control={form.control}
                    name={`lines.${i}.productSlug`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Product</FormLabel>
                        <FormControl>
                          <select className={SELECT_CLASS} {...field}>
                            <option value="">Select a product</option>
                            {products.map((p) => (
                              <option key={p.slug} value={p.slug}>
                                {p.name}
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
                    name={`lines.${i}.kg`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Quantity (kg)</FormLabel>
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
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove product line ${i + 1}`}
                      disabled={lines.fields.length === 1}
                      onClick={() => lines.remove(i)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => lines.append({ productSlug: "", kg: 1 })}
              >
                <Plus className="mr-1 size-4" /> Add another product
              </Button>
            </div>

            <Separator className="my-6" />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="packaging"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Packaging preference</FormLabel>
                    <FormControl>
                      <select className={SELECT_CLASS} {...field}>
                        {PACKAGING_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
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
                name="frequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected frequency</FormLabel>
                    <FormControl>
                      <select className={SELECT_CLASS} {...field}>
                        {ORDER_FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {f}
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
                name="notes"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Additional requirements (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder="Grade preferences, labelling, delivery windows, payment terms"
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" /> Submitting…
                </>
              ) : (
                "Request Bulk Quote"
              )}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/business/rfqs">Cancel</Link>
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
