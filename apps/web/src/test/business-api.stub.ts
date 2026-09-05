import {
  BUSINESS_TYPES,
  GSTIN_REGEX,
  PHONE_REGEX,
  type AccountOrder,
  type AuthUser,
  type BusinessProfile,
  type BusinessStats,
  type UpdateBusinessRequest,
} from "@/contract";
import { bulkOrdersFor, liveAddressesFor } from "./account-api.stub";
import { openRfqCountFor } from "./rfq-api.stub";

/**
 * `GET`/`PUT /business/me`, `GET /business/stats` and `GET /business/orders` — the seventh
 * handler, Task 18's `/me` pair and Task 19's two reads.
 *
 * Delegated to from `installAuthStub` alongside the other six, for the reason all of them
 * exist: there is a single `globalThis.fetch`. Without this file the business-profile route
 * fails with *"api stub received an unexpected request: GET /api/v1/business/me"*.
 *
 * **The address ids are cross-checked against `account-api.stub.ts`'s live book**, via
 * `liveAddressesFor`, not the static `addressBook` fixture — a test that adds or deletes an
 * address through the real address routes and then saves the business profile must see that
 * change, the same way the real `BusinessesService.update` reads the database rather than a
 * cached copy of it.
 *
 * No CSRF check, matching the catalogue/cart/wishlist/checkout/rfq stubs — `installAuthStub`
 * holds no cookie for a session-less caller, and this route is reachable only by a signed-in
 * `BUSINESS` account regardless.
 */
const PREFIX = "/business/me";

let profiles: Record<string, BusinessProfile> = {};
let updateBodies: UpdateBusinessRequest[] = [];
let updateFailure: string | undefined;
let statsReadEmails: string[] = [];

export function resetBusinessStub(): void {
  profiles = {};
  updateBodies = [];
  updateFailure = undefined;
  statsReadEmails = [];
}

/**
 * Every caller `GET /business/stats` has answered, in order.
 *
 * Load-bearing for exactly one assertion nothing rendered can make: that the dashboard's spend
 * figure came from *this* endpoint rather than a `reduce` over orders the page fetched for a
 * different reason. On the seeded fixture the two would render the identical ₹77,348 — every
 * seeded bulk order total is a whole number of rupees, so a client-side sum and a server-side
 * one agree to the paise — so a rendered-string assertion alone cannot tell a real read from a
 * reintroduced client computation that happens to land on the same figure.
 */
export function statsReads(): string[] {
  return statsReadEmails;
}

/**
 * `b2b@demo.in`'s seeded profile — the same fields `users.seed.ts`'s `BUSINESS_FIXTURE` gives
 * the real business, both address references pointing at the seeded `Warehouse` row.
 *
 * Resolved through `liveAddressesFor` rather than baked in as a literal id: `mocks/addresses.ts`
 * gives the row the human id `"adr-b2b-warehouse"`, but `account-api.stub.ts`'s `seededBook`
 * hashes every mock id through `uuidFor` before it ever reaches the wire — the same
 * transformation `seedAddressId` (what a test actually calls to get "the id of the seeded
 * Warehouse address") reads back. A literal copy of the mock's id would answer with a value no
 * response from either stub ever actually carries.
 */
function seededProfileFor(email: string): BusinessProfile | undefined {
  if (email.toLowerCase() !== "b2b@demo.in") return undefined;
  const warehouse =
    liveAddressesFor(email).find((address) => address.label === "Warehouse") ?? null;
  return {
    companyName: "Anand Sweets & Namkeen",
    contactPerson: "Rakesh Anand",
    mobile: "9845012345",
    gstin: "29ABCDE1234F1Z5",
    businessType: "Sweet shop",
    billingAddress: warehouse,
    shippingAddress: warehouse,
  };
}

/**
 * Overrides one account's profile directly — the arrangement `routes.smoke.test.tsx` needs to
 * put a business in the third address state (a non-empty book, but neither reference set)
 * without first driving a real `PUT` through the UI to get there.
 */
export function seedBusinessProfile(email: string, profile: BusinessProfile): void {
  profiles[email.toLowerCase()] = profile;
}

/** Makes the next `PUT /business/me` fail with `message`, as a 400 the form must surface. */
export function failBusinessUpdate(message: string): void {
  updateFailure = message;
}

/** Every `PUT /business/me` body the client has sent, in order — the analogue of
 * `addressWrites()`: the only way to prove `billingAddressId: ""` was converted to `null`
 * before it left the form, rather than only that a plausible profile came back afterwards. */
export function businessUpdateRequests(): UpdateBusinessRequest[] {
  return updateBodies;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });

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
    timestamp: "2026-08-23T00:00:00.000Z",
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
    timestamp: "2026-08-23T00:00:00.000Z",
    path,
    method,
    message: "Validation failed",
    code: "VALIDATION_FAILED",
    details,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

const unauthenticated = (path: string, method: string): Response =>
  failure(401, "Unauthorized", path, method);

function profileFor(session: AuthUser): BusinessProfile {
  const key = session.email.toLowerCase();
  const existing = profiles[key];
  if (existing) return existing;
  const seeded = seededProfileFor(key);
  if (seeded) return seeded;
  const company = session.company;
  return {
    companyName: company?.companyName ?? "",
    contactPerson: company?.contactPerson ?? "",
    mobile: "",
    ...(company?.gstin ? { gstin: company.gstin } : {}),
    businessType: company?.businessType ?? "",
    billingAddress: null,
    shippingAddress: null,
  };
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

const UPDATE_FIELDS = new Set([
  "companyName",
  "contactPerson",
  "mobile",
  "gstin",
  "businessType",
  "billingAddressId",
  "shippingAddressId",
]);

/** `UpdateBusinessDto`, decorator for decorator — see `update-business.dto.ts`. */
function updateErrors(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;
  const details: Record<string, string[]> = {};

  for (const key of Object.keys(dto)) {
    if (!UPDATE_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  bounded(details, "companyName", dto.companyName, 2, 160);
  bounded(details, "contactPerson", dto.contactPerson, 2, 120);
  if (typeof dto.mobile !== "string" || !PHONE_REGEX.test(dto.mobile)) {
    details.mobile = ["Enter a valid 10-digit Indian mobile number"];
  }
  if (dto.gstin !== undefined && (typeof dto.gstin !== "string" || !GSTIN_REGEX.test(dto.gstin))) {
    details.gstin = ["Enter a valid 15-character GSTIN"];
  }
  if (typeof dto.businessType !== "string" || !BUSINESS_TYPES.includes(dto.businessType as never)) {
    details.businessType = [
      `businessType must be one of the following values: ${BUSINESS_TYPES.join(", ")}`,
    ];
  }

  return details;
}

function handleMe(
  method: string,
  init: RequestInit | undefined,
  session: AuthUser,
  where: { path: string; method: string },
): Response {
  if (method === "GET") return ok<BusinessProfile>(profileFor(session));

  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const details = updateErrors(raw);
  if (Object.keys(details).length > 0) return validationFailed(details, where.path, where.method);
  if (updateFailure !== undefined) {
    return failure(400, updateFailure, where.path, where.method, "VALIDATION_FAILED");
  }
  const dto = raw as UpdateBusinessRequest;
  updateBodies.push(dto);

  const book = liveAddressesFor(session.email);
  const resolve = (id: string | null): BusinessProfile["billingAddress"] => {
    if (id === null) return null;
    const found = book.find((address) => address.id === id);
    return found ?? null;
  };

  const updated: BusinessProfile = {
    companyName: dto.companyName,
    contactPerson: dto.contactPerson,
    mobile: dto.mobile,
    ...(dto.gstin ? { gstin: dto.gstin } : {}),
    businessType: dto.businessType,
    billingAddress: resolve(dto.billingAddressId),
    shippingAddress: resolve(dto.shippingAddressId),
  };
  profiles[session.email.toLowerCase()] = updated;
  return ok<BusinessProfile>(updated);
}

/**
 * `GET /business/stats` — the same three figures `business-stats.service.ts` computes, read off
 * the identical stores `account-api.stub.ts`'s `bulkOrdersFor` and `rfq-api.stub.ts`'s
 * `openRfqCountFor` already own, rather than a third copy of either.
 */
function handleStats(session: AuthUser): Response {
  statsReadEmails.push(session.email);
  const orders = bulkOrdersFor(session.email);
  return ok<BusinessStats>({
    openRfqs: openRfqCountFor(session.email),
    bulkSpend: orders.reduce((sum, order) => sum + order.total, 0),
    bulkOrders: orders.length,
  });
}

/** `GET /business/orders` — deep-equal to `GET /account/orders?channel=bulk`, because both read
 * `bulkOrdersFor`. */
function handleOrders(session: AuthUser): Response {
  return ok<AccountOrder[]>(bulkOrdersFor(session.email));
}

/** Answers a `GET`/`PUT /business/me`, `GET /business/stats` or `GET /business/orders` request,
 * or `undefined` for any other URL. */
export function handleBusinessRequest(
  url: string,
  method: string,
  init: RequestInit | undefined,
  session: AuthUser | null,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  const where = { path: url, method };

  if (path === PREFIX) {
    if (!session) return unauthenticated(where.path, where.method);
    return handleMe(method, init, session, where);
  }
  if (method === "GET" && path === "/business/stats") {
    if (!session) return unauthenticated(where.path, where.method);
    return handleStats(session);
  }
  if (method === "GET" && path === "/business/orders") {
    if (!session) return unauthenticated(where.path, where.method);
    return handleOrders(session);
  }

  return undefined;
}
