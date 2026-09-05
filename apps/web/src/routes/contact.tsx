import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { SupportTicketSummary } from "@/contract";
import { ContactDetails } from "@/components/common/ContactDetails";
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
import { settings } from "@/config/settings";
import { useSubmitContactMessage } from "@/features/contact/hooks/useContact";
import { CONTACT_TOPICS, contactSchema, type ContactFormValues } from "@/features/contact/schema";
import { useSeo } from "@/hooks/useSeo";
import { ApiRequestError } from "@/lib/http";

export const Route = createFileRoute("/contact")({ component: Contact });

/** Matches the native selects in the checkout, RFQ and gifting forms. */
const SELECT_CLASS =
  "flex h-10 w-full border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function Contact() {
  const submitMessage = useSubmitContactMessage();
  const [created, setCreated] = useState<SupportTicketSummary | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useSeo({
    title: `Contact Us | ${settings.brandName}`,
    description:
      "Questions about an order, shipping, a return, bulk pricing or corporate gifting — send us a message and we reply within one working day.",
  });

  const form = useForm<ContactFormValues, unknown, ContactFormValues>({
    resolver: zodResolver<ContactFormValues, unknown, ContactFormValues>(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      topic: CONTACT_TOPICS[0],
      orderNumber: "",
      message: "",
    },
  });

  const submitting = form.formState.isSubmitting;

  /**
   * `handleSubmit` swallows anything `onSubmit` throws, so an un-caught rejection here leaves the
   * form sitting there with no message — which is the one outcome a real visitor is most likely to
   * meet, because `POST /contact` is throttled at five per hour per IP.
   *
   * The 429 is detected by `status`, not by `code`: `ThrottlerException` is not a `DomainError`, so
   * a throttled response carries no machine-readable code at all. `ApiRequestError`'s own docblock
   * in `lib/http.ts` states this and is the reason the branch is written this way.
   */
  const onSubmit = async (values: ContactFormValues) => {
    setSubmitError(null);
    try {
      const ticket = await submitMessage.mutateAsync(values);
      form.reset();
      setCreated(ticket);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 429) {
        setSubmitError(
          "You have sent us several messages already. Please give it an hour, or call us if it is urgent.",
        );
        return;
      }
      setSubmitError(
        "We could not send that just now. Please try again in a moment — your message is still in the form.",
      );
    }
  };

  return (
    <div className="container-page py-14 pb-[72px]">
      <div className="max-w-[620px]">
        <p className="kicker mb-5">Contact</p>
        <h1 className="page-h1">Talk to us</h1>
        <p className="text-body mt-4 text-[16px]">
          Order questions, delivery chasers, wholesale enquiries and gifting briefs all land in the
          same place. We reply within one working day.
        </p>
      </div>

      <div className="mt-10 grid gap-9 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
        <div>
          {created ? (
            <div role="status" className="border-border bg-card border p-8">
              <CheckCircle2 className="text-gold size-10" aria-hidden="true" />
              <h2 className="font-display mt-4 text-3xl">Message received</h2>
              <p className="text-muted-foreground mt-3 text-sm">
                Thanks — we have it. We reply to every message within one working day, to the email
                address you gave us.
              </p>
              <p className="text-muted-foreground mt-2 text-sm">
                Quote it if you follow up:{" "}
                <span className="font-semibold">{created.ticketNumber}</span>
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => setCreated(null)}>
                  Send another message
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/faq">Browse the FAQs</Link>
                </Button>
              </div>
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                aria-label="Contact form"
                className="border-border bg-card border p-6 sm:p-[clamp(24px,3vw,36px)]"
              >
                <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
                  Send a message
                </p>
                <h2 className="sr-only">Send a message</h2>

                {submitError && (
                  <p
                    role="alert"
                    className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex gap-2 border px-4 py-3 text-sm"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {submitError}
                  </p>
                )}

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Your name</FormLabel>
                        <FormControl>
                          <Input autoComplete="name" {...field} />
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
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mobile number (optional)</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="numeric"
                            maxLength={10}
                            autoComplete="tel-national"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="topic"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>What is this about?</FormLabel>
                        <FormControl>
                          <select className={SELECT_CLASS} {...field}>
                            {CONTACT_TOPICS.map((t) => (
                              <option key={t} value={t}>
                                {t}
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
                    name="orderNumber"
                    render={({ field }) => (
                      <FormItem className="sm:col-span-2">
                        <FormLabel>Order number (optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="NN-2026-000000"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormDescription>
                          Including it saves a round trip if this is about an order.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="message"
                    render={({ field }) => (
                      <FormItem className="sm:col-span-2">
                        <FormLabel>Message</FormLabel>
                        <FormControl>
                          <Textarea rows={5} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Button type="submit" size="lg" className="mt-6" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send Message"
                  )}
                </Button>
              </form>
            </Form>
          )}
        </div>

        <aside className="space-y-4">
          {[
            {
              title: "Retail orders",
              body: "Pack sizes, delivery, an order already placed — include the order ID if you have one.",
            },
            {
              title: "Bulk & wholesale",
              body: "Slab rates, samples and GST invoicing. For a numbered quote, use the bulk request form.",
            },
            {
              title: "Gifting",
              body: "Box counts, branding and dates. The gifting page files a trackable request.",
            },
          ].map((card) => (
            <div key={card.title} className="border-border bg-card border p-5">
              <p className="text-[13px] font-bold">{card.title}</p>
              <p className="text-body mt-1.5 text-[13px] leading-[1.6]">{card.body}</p>
            </div>
          ))}

          <ContactDetails />

          <div className="border-border bg-sand border p-6">
            <p className="font-display text-xl">Faster routes</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link to="/account/orders" className="underline underline-offset-4">
                  Track an order
                </Link>{" "}
                <span className="text-muted-foreground">— status without asking us</span>
              </li>
              <li>
                <Link to="/business/rfqs/new" className="underline underline-offset-4">
                  Request bulk pricing
                </Link>{" "}
                <span className="text-muted-foreground">— numbered and trackable</span>
              </li>
              <li>
                <Link to="/gifting" className="underline underline-offset-4">
                  Corporate gifting brief
                </Link>{" "}
                <span className="text-muted-foreground">— boxes, branding, dates</span>
              </li>
              <li>
                <Link to="/faq" className="underline underline-offset-4">
                  FAQs
                </Link>{" "}
                <span className="text-muted-foreground">— ordering, shipping, returns</span>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
