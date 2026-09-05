import {
  BUSINESS_TYPES,
  GIFTING_OCCASIONS,
  GSTIN_REGEX,
  ORDER_FREQUENCIES,
  PACKAGING_OPTIONS,
  PHONE_REGEX,
  PINCODE_REGEX,
  type CreateGiftingRfqRequest,
  type CreateRfqRequest,
  type RfqDetail,
  type RfqLine,
  type RfqSummary,
} from "@/contract";
import type { AuthUser } from "@/contract";

/**
 * The RFQ endpoints — `POST /rfqs`, `POST /rfqs/gifting`, `GET /rfqs`, `GET /rfqs/:rfqNumber` —
 * for the route tests.
 *
 * The sixth handler `installAuthStub` delegates to, for the reason the other five exist: there is
 * a single `globalThis.fetch`, so without this file the smoke suite fails with *"api stub received
 * an unexpected request: GET /api/v1/rfqs"* the moment a test visits `/business/rfqs`.
 *
 * **The number is minted here, not by the client.** `sequence` below mirrors
 * `rfq-number.ts`'s `nextRfqNumber` — `RFQ-{year}-{6 digits}`, `RFQ_NUMBER_PATTERN` — so a test can
 * assert the exact number this stub issued rather than only the pattern's shape, which the old
 * mock's client-minted counter would satisfy just as happily whether or not the request was sent.
 *
 * **Two create routes, two DTOs, two field sets.** `rfqErrors` and `giftingErrors` mirror
 * `CreateRfqDto`/`CreateGiftingRfqDto` decorator for decorator, including the two whitelist checks:
 * `forbidNonWhitelisted` is global on the real server (`app.module.ts`), so an unexpected property
 * on either body is a 400, not a value quietly dropped.
 *
 * **No CSRF check**, matching the catalogue, cart, wishlist and checkout stubs, and for the same
 * reason: `installAuthStub` deliberately holds no cookie for a visitor with no session, and both
 * create routes are reachable by exactly that visitor. The real proof these routes carry the header
 * lives in `rfqs.integration.spec.ts`.
 *
 * **`list`/`get` are session-scoped and answer 401 with none**, matching `JwtAuthGuard` — the same
 * rule `account-api.stub.ts` states for order history, for the identical reason: an empty array
 * would hide a missing guard as indistinguishable from "no RFQs yet".
 */
const PREFIX = "/rfqs";

let store: { owner: string | null; rfq: RfqDetail }[] = [];
let sequence = 0;
let rfqCreateBodies: CreateRfqRequest[] = [];
let giftingCreateBodies: CreateGiftingRfqRequest[] = [];

export function resetRfqStub(): void {
  store = [];
  sequence = 0;
  rfqCreateBodies = [];
  giftingCreateBodies = [];
}

/**
 * Every `POST /rfqs` body the client has sent, in order — the analogue of `placementRequests()`.
 * `toCreateRfqRequest`'s whole job is stripping the optionals a `defaultValues` object initialises
 * to `""`, and no type can see whether it actually did: `http.post` takes its body as `unknown`, so
 * a client that still sent `gstin: ""` would typecheck perfectly. Only the recorded body, or the
 * 400 `rfqErrors` answers for it, can tell.
 */
export function rfqCreateRequests(): CreateRfqRequest[] {
  return rfqCreateBodies;
}

/** Every `POST /rfqs/gifting` body the client has sent, in order. */
export function giftingCreateRequests(): CreateGiftingRfqRequest[] {
  return giftingCreateBodies;
}

/** Seeds one RFQ directly into the store, owned by `owner` (an email) or by nobody (`null`). */
export function seedRfq(rfq: RfqDetail, owner: string | null): void {
  store = [...store.filter((row) => row.rfq.id !== rfq.id), { owner, rfq }];
}

/**
 * `RFQ_STATUSES`' four open states, exactly as `business-stats.service.ts`'s `IS_OPEN` draws
 * them — `new`, `contacted`, `quote-sent`, `negotiation` — so `GET /business/stats`'s stub
 * counts the identical set the real endpoint does, not a client-side guess at it.
 */
const OPEN_STATUSES = new Set(["new", "contacted", "quote-sent", "negotiation"]);

/** One owner's open-RFQ count, for `business-api.stub.ts`'s `GET /business/stats`. */
export function openRfqCountFor(email: string): number {
  return store.filter((row) => row.owner === email && OPEN_STATUSES.has(row.rfq.status)).length;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });
const created = <T>(data: T): Response => json(201, { success: true, data });

function failure(
  status: number,
  message: string,
  path: string,
  method: string,
  code?: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-22T00:00:00.000Z",
    path,
    method,
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

function validationFailed(
  details: Record<string, string[]>,
  path: string,
  method: string,
): Response {
  return json(400, {
    success: false,
    statusCode: 400,
    timestamp: "2026-08-22T00:00:00.000Z",
    path,
    method,
    message: "Validation failed",
    code: "VALIDATION_FAILED",
    details,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/** What `JwtAuthGuard` emits for a route with no `@Public()`: no `code`, message "Unauthorized". */
const unauthenticated = (path: string, method: string): Response =>
  failure(401, "Unauthorized", path, method);

/** `RfqsController.notFound`'s exact copy — this stub echoes the real 404 rather than a generic one. */
function notFound(rfqNumber: string, path: string, method: string): Response {
  return failure(404, `No RFQ ${rfqNumber} in your account.`, path, method, "NOT_FOUND", {
    rfqNumber,
  });
}

const bounded = (
  details: Record<string, string[]>,
  key: string,
  value: unknown,
  min: number,
  max: number,
): void => {
  if (typeof value !== "string") {
    details[key] = [`${key} must be a string`];
  } else if (value.length < min) {
    details[key] = [`${key} must be longer than or equal to ${min} characters`];
  } else if (value.length > max) {
    details[key] = [`${key} must be shorter than or equal to ${max} characters`];
  }
};

const optionalBounded = (
  details: Record<string, string[]>,
  key: string,
  value: unknown,
  max: number,
): void => {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > max) {
    details[key] = [`${key} must be shorter than or equal to ${max} characters`];
  }
};

function contactErrors(dto: Record<string, unknown>): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  if (typeof dto.mobile !== "string" || !PHONE_REGEX.test(dto.mobile)) {
    details.mobile = ["Enter a valid 10-digit Indian mobile number"];
  }
  if (typeof dto.email !== "string" || !dto.email.includes("@")) {
    details.email = ["email must be an email"];
  }
  if (dto.gstin !== undefined && (typeof dto.gstin !== "string" || !GSTIN_REGEX.test(dto.gstin))) {
    details.gstin = ["Enter a valid 15-character GSTIN"];
  }
  if (typeof dto.businessType !== "string" || !BUSINESS_TYPES.includes(dto.businessType as never)) {
    details.businessType = [
      `businessType must be one of the following values: ${BUSINESS_TYPES.join(", ")}`,
    ];
  }
  if (typeof dto.pincode !== "string" || !PINCODE_REGEX.test(dto.pincode)) {
    details.pincode = ["Enter a valid 6-digit pincode"];
  }

  return details;
}

/** `CreateRfqLineDto`'s two fields. */
function lineErrors(index: number, raw: unknown): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null) {
    details[`lines.${index}`] = ["lines must be an object"];
    return details;
  }
  const line = raw as Record<string, unknown>;
  bounded(details, `lines.${index}.productSlug`, line.productSlug, 1, 120);
  if (typeof line.kg !== "number" || line.kg < 1 || line.kg > 100_000) {
    details[`lines.${index}.kg`] = ["kg must not be greater than 100000"];
  }
  return details;
}

const RFQ_FIELDS = new Set([
  "businessName",
  "contactPerson",
  "mobile",
  "email",
  "gstin",
  "businessType",
  "pincode",
  "lines",
  "packaging",
  "frequency",
  "notes",
]);

/** `CreateRfqDto`, decorator for decorator. */
function rfqErrors(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;
  const details: Record<string, string[]> = {};

  for (const key of Object.keys(dto)) {
    if (!RFQ_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  bounded(details, "businessName", dto.businessName, 2, 160);
  bounded(details, "contactPerson", dto.contactPerson, 2, 120);
  Object.assign(details, contactErrors(dto));

  if (!Array.isArray(dto.lines) || dto.lines.length < 1 || dto.lines.length > 20) {
    details.lines = ["lines must contain at least 1 elements"];
  } else {
    dto.lines.forEach((line, i) => Object.assign(details, lineErrors(i, line)));
  }

  if (typeof dto.packaging !== "string" || !PACKAGING_OPTIONS.includes(dto.packaging as never)) {
    details.packaging = [
      `packaging must be one of the following values: ${PACKAGING_OPTIONS.join(", ")}`,
    ];
  }
  if (typeof dto.frequency !== "string" || !ORDER_FREQUENCIES.includes(dto.frequency as never)) {
    details.frequency = [
      `frequency must be one of the following values: ${ORDER_FREQUENCIES.join(", ")}`,
    ];
  }
  optionalBounded(details, "notes", dto.notes, 2000);

  return details;
}

const GIFTING_FIELDS = new Set([
  "companyName",
  "contactPerson",
  "mobile",
  "email",
  "gstin",
  "businessType",
  "pincode",
  "occasion",
  "giftBoxSlug",
  "boxes",
  "budgetPerBox",
  "brandingRequired",
  "deliveryDate",
  "message",
]);

/** `CreateGiftingRfqDto`, decorator for decorator. */
function giftingErrors(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;
  const details: Record<string, string[]> = {};

  for (const key of Object.keys(dto)) {
    if (!GIFTING_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  bounded(details, "companyName", dto.companyName, 2, 160);
  bounded(details, "contactPerson", dto.contactPerson, 2, 120);
  Object.assign(details, contactErrors(dto));

  if (typeof dto.occasion !== "string" || !GIFTING_OCCASIONS.includes(dto.occasion as never)) {
    details.occasion = [
      `occasion must be one of the following values: ${GIFTING_OCCASIONS.join(", ")}`,
    ];
  }
  bounded(details, "giftBoxSlug", dto.giftBoxSlug, 1, 120);
  if (
    typeof dto.boxes !== "number" ||
    !Number.isInteger(dto.boxes) ||
    dto.boxes < 1 ||
    dto.boxes > 100_000
  ) {
    details.boxes = ["boxes must be an integer number"];
  }
  if (
    typeof dto.budgetPerBox !== "number" ||
    dto.budgetPerBox < 1 ||
    dto.budgetPerBox > 1_000_000
  ) {
    details.budgetPerBox = ["budgetPerBox must not be less than 1"];
  }
  if (typeof dto.brandingRequired !== "boolean") {
    details.brandingRequired = ["brandingRequired must be a boolean value"];
  }
  if (typeof dto.deliveryDate !== "string" || Number.isNaN(new Date(dto.deliveryDate).getTime())) {
    details.deliveryDate = ["deliveryDate must be a valid ISO 8601 date string"];
  }
  optionalBounded(details, "message", dto.message, 2000);

  return details;
}

function mintNumber(now: Date): string {
  sequence += 1;
  return `RFQ-${String(now.getFullYear())}-${String(100_000 + sequence)}`;
}

function toSummary(rfq: RfqDetail): RfqSummary {
  return {
    id: rfq.id,
    kind: rfq.kind,
    status: rfq.status,
    businessName: rfq.businessName,
    createdAt: rfq.createdAt,
  };
}

/**
 * Answers an RFQ request, or returns `undefined` when the URL is not one of them so the caller
 * can offer it to the next handler. `session` decides both the owner attributed to a new enquiry
 * (`user?.id ?? null` on the real controller; here, `session?.email ?? null` — the same
 * email-as-owner convention `handleCheckoutRequest` uses) and, for the two read routes, whether
 * there is anyone to scope the read to at all.
 */
export function handleRfqRequest(
  url: string,
  method: string,
  init: RequestInit | undefined,
  session: AuthUser | null,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return undefined;

  const where = { path: url, method };

  if (method === "POST" && path === PREFIX) return handleCreate(where, init, session);
  if (method === "POST" && path === `${PREFIX}/gifting`)
    return handleCreateGifting(where, init, session);
  if (method === "GET" && path === PREFIX) return handleList(where, session);
  if (method === "GET" && path.startsWith(`${PREFIX}/`)) {
    return handleFindOne(where, path.slice(`${PREFIX}/`.length), session);
  }
  return undefined;
}

function handleCreate(
  where: { path: string; method: string },
  init: RequestInit | undefined,
  session: AuthUser | null,
): Response {
  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const details = rfqErrors(raw);
  if (Object.keys(details).length > 0) return validationFailed(details, where.path, where.method);
  const dto = raw as CreateRfqRequest;
  rfqCreateBodies.push(dto);

  const now = new Date();
  const rfq: RfqDetail = {
    id: mintNumber(now),
    kind: "bulk",
    status: "new",
    businessName: dto.businessName,
    createdAt: now.toISOString(),
    contactPerson: dto.contactPerson,
    mobile: dto.mobile,
    email: dto.email,
    ...(dto.gstin === undefined ? {} : { gstin: dto.gstin }),
    businessType: dto.businessType,
    pincode: dto.pincode,
    packaging: dto.packaging,
    frequency: dto.frequency,
    ...(dto.notes === undefined ? {} : { notes: dto.notes }),
    lines: dto.lines as RfqLine[],
  };
  store.push({ owner: session?.email ?? null, rfq });
  return created<RfqDetail>(rfq);
}

function handleCreateGifting(
  where: { path: string; method: string },
  init: RequestInit | undefined,
  session: AuthUser | null,
): Response {
  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const details = giftingErrors(raw);
  if (Object.keys(details).length > 0) return validationFailed(details, where.path, where.method);
  const dto = raw as CreateGiftingRfqRequest;
  giftingCreateBodies.push(dto);

  const now = new Date();
  const rfq: RfqDetail = {
    id: mintNumber(now),
    kind: "gifting",
    status: "new",
    businessName: dto.companyName,
    createdAt: now.toISOString(),
    contactPerson: dto.contactPerson,
    mobile: dto.mobile,
    email: dto.email,
    ...(dto.gstin === undefined ? {} : { gstin: dto.gstin }),
    businessType: dto.businessType,
    pincode: dto.pincode,
    lines: [],
    gifting: {
      occasion: dto.occasion,
      giftBoxSlug: dto.giftBoxSlug,
      boxes: dto.boxes,
      budgetPerBox: dto.budgetPerBox,
      brandingRequired: dto.brandingRequired,
      deliveryDate: dto.deliveryDate,
      message: dto.message ?? "",
    },
  };
  store.push({ owner: session?.email ?? null, rfq });
  return created<RfqDetail>(rfq);
}

function handleList(where: { path: string; method: string }, session: AuthUser | null): Response {
  if (!session) return unauthenticated(where.path, where.method);
  const mine = store
    .filter((row) => row.owner === session.email)
    .map((row) => row.rfq)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return ok<RfqSummary[]>(mine.map(toSummary));
}

function handleFindOne(
  where: { path: string; method: string },
  rfqNumber: string,
  session: AuthUser | null,
): Response {
  if (!session) return unauthenticated(where.path, where.method);
  const row = store.find((r) => r.owner === session.email && r.rfq.id === rfqNumber);
  if (!row) return notFound(rfqNumber, where.path, where.method);
  return ok<RfqDetail>(row.rfq);
}
