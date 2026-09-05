import type { CreateContactMessageRequest, SupportTicketSummary } from "@/contract";
import { http } from "@/lib/http";
import type { ContactFormValues } from "../schema";

/**
 * The contact form's real backend. `toCreateContactMessageRequest` strips the optionals a
 * `defaultValues` object initialises to `""` — `rfqApi`'s `toCreateRfqRequest` states the
 * identical reason: `@IsOptional()` in class-validator skips its sibling validators only for
 * `undefined`/`null`, so an empty string is a *present* value that would 400 on `phone` for
 * every message that left it untouched.
 */
const omitEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

function toCreateContactMessageRequest(values: ContactFormValues): CreateContactMessageRequest {
  const phone = omitEmpty(values.phone);
  const orderNumber = omitEmpty(values.orderNumber);
  return {
    name: values.name,
    email: values.email,
    ...(phone === undefined ? {} : { phone }),
    topic: values.topic,
    ...(orderNumber === undefined ? {} : { orderNumber }),
    message: values.message,
  };
}

export const contactApi = {
  /** `POST /contact` — public: a visitor needs no account to ask a question. */
  submit: (values: ContactFormValues): Promise<SupportTicketSummary> =>
    http.post<SupportTicketSummary>("/contact", toCreateContactMessageRequest(values)),
};
