import {
  PHONE_REGEX,
  type CreateContactMessageRequest,
  type SupportTicketSummary,
} from "@/contract";

/**
 * `POST /contact`, for the route tests — the eighth handler `installAuthStub` delegates to.
 * No CSRF modelled, matching the RFQ stub's own note: `installAuthStub` holds no cookie for a
 * visitor with no session, and this route is reachable by exactly that visitor. The real proof
 * this route carries the header lives in `support-tickets.integration.spec.ts`.
 */
const PREFIX = "/contact";

let sequence = 0;
let submittedBodies: CreateContactMessageRequest[] = [];
let failNext: { status: number; message: string } | null = null;

export function resetContactStub(): void {
  sequence = 0;
  submittedBodies = [];
  failNext = null;
}

/** Every `POST /contact` body the client has sent, in order. */
export function contactSubmissions(): CreateContactMessageRequest[] {
  return submittedBodies;
}

/** Arranges the next submission to answer with a server failure instead of succeeding. */
export function failNextContactSubmission(status: number, message: string): void {
  failNext = { status, message };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mintTicketNumber(now: Date): string {
  sequence += 1;
  return `ST-${String(now.getFullYear())}-${String(100_000 + sequence)}`;
}

const CONTACT_FIELDS = new Set(["name", "email", "phone", "topic", "orderNumber", "message"]);

/** `CreateContactMessageDto`, decorator for decorator — `rfq-api.stub.ts`'s own convention. */
function contactErrors(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;
  const details: Record<string, string[]> = {};

  for (const key of Object.keys(dto)) {
    if (!CONTACT_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  if (typeof dto.name !== "string" || dto.name.length < 2 || dto.name.length > 120) {
    details.name = ["name must be longer than or equal to 2 characters"];
  }
  if (typeof dto.email !== "string" || !dto.email.includes("@")) {
    details.email = ["email must be an email"];
  }
  if (dto.phone !== undefined && (typeof dto.phone !== "string" || !PHONE_REGEX.test(dto.phone))) {
    details.phone = ["Enter a valid 10-digit Indian mobile number"];
  }
  if (typeof dto.topic !== "string") {
    details.topic = ["topic must be a string"];
  }
  if (
    dto.orderNumber !== undefined &&
    (typeof dto.orderNumber !== "string" || dto.orderNumber.length > 20)
  ) {
    details.orderNumber = ["orderNumber must be shorter than or equal to 20 characters"];
  }
  if (typeof dto.message !== "string" || dto.message.length < 10 || dto.message.length > 2000) {
    details.message = ["message must be longer than or equal to 10 characters"];
  }

  return details;
}

/** Answers a `POST /contact` request, or `undefined` when the URL is not it, so the caller can
 * offer it to the next handler. */
export function handleContactRequest(
  url: string,
  method: string,
  init: RequestInit | undefined,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (path !== PREFIX || method !== "POST") return undefined;

  const where = { path: url, method };

  if (failNext) {
    const { status, message } = failNext;
    failNext = null;
    return json(status, {
      success: false,
      statusCode: status,
      timestamp: "2026-08-26T00:00:00.000Z",
      path: where.path,
      method: where.method,
      message,
    });
  }

  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const details = contactErrors(raw);
  if (Object.keys(details).length > 0) {
    return json(400, {
      success: false,
      statusCode: 400,
      timestamp: "2026-08-26T00:00:00.000Z",
      path: where.path,
      method: where.method,
      message: "Validation failed",
      code: "VALIDATION_FAILED",
      details,
      errorId: "stub-error-id",
      requestId: "stub-request-id",
    });
  }

  const dto = raw as CreateContactMessageRequest;
  submittedBodies.push(dto);
  const summary: SupportTicketSummary = { ticketNumber: mintTicketNumber(new Date()) };
  return json(201, { success: true, data: summary });
}
