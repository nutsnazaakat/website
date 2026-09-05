import {
  canTransition,
  nextStatuses,
  PHONE_REGEX,
  type AccountOrder,
  type AuthUser,
  type OrderChannel,
  type SavedAddress,
} from "@/contract";
import { addressBook } from "@/mocks/addresses";
import { orders as SEEDED_ORDERS } from "@/mocks/orders";

/**
 * `GET /account/orders` and `GET /account/orders/:orderNumber`, for the route tests.
 *
 * The fifth handler `installAuthStub` delegates to, and it exists for the reason the other four do:
 * there is a single `globalThis.fetch`, so layering a second stub on top would make the tests depend
 * on installation order. Without this file the smoke suite fails with *"api stub received an
 * unexpected request: GET /api/v1/account/orders"* — the dispatcher working as designed, not a bug
 * in the seam that started sending the request.
 *
 * **It takes the session, and that is the whole difference from the mock it replaces.**
 * `accountApi.listOrders` used to accept an `email` and filter a client-side array by it;
 * `OrderFilters` deliberately has no email field, because a client able to name the account it is
 * reading is spec §13's IDOR hole. So ownership is decided here, from the same closure variable the
 * auth stub answers `GET /auth/me` out of, exactly as `@CurrentUser()` decides it on the server.
 * A request with no session is a **401**, not an empty list: an empty array would hide a missing
 * guard behind a plausible answer.
 *
 * **Owner, not email.** `orders.user_id` is what scopes the real read, and an order's
 * `address_snapshot.email` is data on it — a gift consignment carries the recipient's address and the
 * buyer's account. This stub therefore stores an owner alongside each order rather than matching on
 * `order.email`:
 *
 * - the six seeded orders take their owner from `mocks/orders.ts`'s `email`, which is that fixture's
 *   only expression of `user_id` and does agree with it for all six;
 * - an order placed through `POST /checkout/orders` takes its owner from **whoever was signed in when
 *   it was placed**, which is why a *guest's* placement is owned by nobody and answers 404 from both
 *   routes here — the real behaviour, and the reason `CheckoutForm` seeds the placement response into
 *   `accountKeys.order(id)` at all.
 *
 * **`/account/addresses` is modelled too, as of Task 21.** All five routes — the read, the create, the
 * patch, the soft delete and the promotion — because `features/account/api` no longer has a mock to
 * fall back on. What they reproduce is the *contract* rather than the implementation: every write
 * answers the whole book, the book is ordered default-first, exactly one address is the default and
 * never zero while the book has entries, a delete is soft, a label wider than `varchar(40)` is a 400
 * and a non-uuid id is a 400. What they do **not** reproduce is the partial unique index, the
 * clear-then-set ordering it forces or the per-customer lock: those are
 * `addresses.integration.spec.ts`'s to prove against real Postgres, and a second implementation of
 * them here would be a copy free to agree with itself.
 *
 * **`/account/profile` is modelled as of Task 22, and only its `PATCH` is reachable from the browser.**
 * `AuthProvider` hydrates from `GET /auth/me` and holds the only client-side copy of `AuthUser`, so
 * nothing here asks for the profile a second time; the `GET` is answered anyway, out of the same
 * closure variable `/auth/me` uses, because two endpoints returning one row must not be able to
 * disagree in the stub either. What the `PATCH` reproduces is the contract: the two writable fields,
 * a **400** for `email`, `role` or `isActive` rather than a field quietly ignored, the `varchar(120)`
 * bound on `name`, `PHONE_REGEX` on `phone`, a name trimmed before it is measured, and an answer that
 * is the whole profile. A successful edit is written **back into the session**, so a subsequent
 * `GET /auth/me` in the same test agrees with it — without that the stub would let a page look correct
 * while the server's own answer had moved on.
 *
 * **What it does not model.** No pagination, because `OrderQueryDto` has none.
 *
 * **`POST /account/orders/:orderNumber/cancel` is modelled, and its refusals are the point.** The
 * legality of the move is decided by `@/contract`'s `canTransition` — the same function
 * `OrderStatusService` calls on the server and the same one the Cancel button hides itself with — so
 * this stub cannot disagree with either about which orders are cancellable. What it does **not**
 * model is the stock: `putStockBack`, the `CANCELLATION` ledger row and
 * `SUM(delta) = inventory.onHand` are all `orders.integration.spec.ts`'s to prove against a real
 * database, and reproducing them here would be a second implementation that agrees today.
 *
 * No CSRF check either, matching `cart-api.stub.ts` and `checkout-api.stub.ts` for the reason
 * recorded there — the real proof that the header is carried lives in the integration suite, which
 * asserts the 403.
 */

/** `OrderQueryDto`'s `@IsIn(ORDER_CHANNELS)`, which is the decorator that stops a filter widening. */
const ORDER_CHANNELS: readonly string[] = Object.keys({
  retail: true,
  bulk: true,
} satisfies Record<OrderChannel, true>);

interface OwnedOrder {
  /** `orders.user_id`: the account whose history this order is in, or `null` for a guest's. */
  owner: string | null;
  order: AccountOrder;
}

/**
 * `orders.seed.ts`'s six orders, which is what the business dashboard's ₹77,348 is the sum of.
 *
 * Read from `src/mocks/orders.ts` rather than restated, because disagreement 5 was settled by
 * measuring the two against each other: every seeded line total is a whole number of rupees, 5% of a
 * whole rupee is exact to the paise, and `inr()` rounds — so the mock's single aggregate GST and the
 * server's per-line GST render the identical string on all six. Copying the figures here would be a
 * second fixture free to drift from the assertion that reads it.
 */
const SEEDED: readonly OwnedOrder[] = SEEDED_ORDERS.map((order) => ({
  owner: order.email,
  order,
}));

let store: OwnedOrder[] = [...SEEDED];

/** Every `GET /account/orders` query string the client has sent, parsed, in order. */
let listQueries: Record<string, string>[] = [];

/** Every order number the client has asked for by name, in order. */
let reads: string[] = [];

/** Every order number the client has tried to cancel, in order — refused attempts included. */
let cancels: string[] = [];

export function resetAccountStub(): void {
  store = [...SEEDED];
  listQueries = [];
  reads = [];
  cancels = [];
  book = seededBook();
  addressCalls = [];
  addressReadPaths = [];
  profileCalls = [];
}

/**
 * Files an order under the account that placed it — called by `handleCheckoutRequest` on a successful
 * placement, so the two stubs describe one database rather than two.
 *
 * Without this, an order placed in a test could only ever be read back out of the query cache
 * `CheckoutForm` seeds, and a case that opened it from `/account/orders/:orderNumber` would pass with
 * the seam pointed at anything at all — including the deleted `fromReceipt`.
 */
export function recordPlacedOrder(order: AccountOrder, owner: string | null): void {
  store.push({ owner, order });
}

/**
 * The parsed query string of every list read, in order — the analogue of `pincodeChecks()`.
 *
 * Load-bearing because the channel filter is otherwise **unobservable**: the only account with bulk
 * orders in the fixture has nothing but bulk orders, so `?channel=bulk` and no filter at all return
 * the same two rows. A client that stopped sending the parameter would look identical on screen.
 */
export function orderListQueries(): Record<string, string>[] {
  return listQueries;
}

/** The order numbers the client has fetched individually, in order. */
export function orderReads(): string[] {
  return reads;
}

/**
 * The order numbers the client has tried to cancel, in order.
 *
 * Load-bearing for two separate reasons. The obvious one is `lastCartWrite()`'s: a rendered "Cancelled"
 * badge cannot tell a request that was sent from a page that patched its own cache. The second is the
 * confirmation step — an empty list *after* opening the dialog and dismissing it is the only way to
 * see that nothing was sent, and a trigger wired straight to the mutation would look identical on
 * screen right up to the point where the order is gone.
 */
export function orderCancels(): string[] {
  return cancels;
}

/**
 * One owner's bulk orders, newest first — the same filter `handleList` applies for
 * `?channel=bulk`, exposed so `business-api.stub.ts` can answer `GET /business/stats` and
 * `GET /business/orders` from the identical store rather than a second copy of it. Keeping one
 * store is what makes `GET /business/orders` provably deep-equal to
 * `GET /account/orders?channel=bulk` in the stub, the same way the two are on the server.
 */
export function bulkOrdersFor(email: string): AccountOrder[] {
  return store
    .filter((row) => row.owner === email)
    .map((row) => row.order)
    .filter((order) => order.channel === "bulk")
    .sort(newest);
}

/**
 * Files a cancellable order under an account, for the cases that need one.
 *
 * **No mocked order is cancellable and neither is any seeded one** — the six rest in
 * `out-for-delivery`, `shipped`, `cancelled`, `delivered`, `refunded` and `delivered`, while
 * `RETAIL_TRANSITIONS` offers `cancelled` only from `pending`, `confirmed`, `processing` and
 * `packed`. So a case that wants to press the button either places an order through checkout, which
 * lands `pending`, or arranges one here. Both exist: the smoke suite does the former end to end, and
 * this is for the cheaper cases that only need a starting status.
 */
export function seedAccountOrder(order: AccountOrder, owner: string | null): void {
  store = [...store.filter((row) => row.order.id !== order.id), { owner, order }];
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
    timestamp: "2026-08-21T00:00:00.000Z",
    path,
    method,
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/**
 * What `JwtAuthGuard` emits for a route with no `@Public()`: a bare `UnauthorizedException`, so the
 * body carries `message: "Unauthorized"` and **no `code`**. Both account routes are guarded, so this
 * is the answer an anonymous caller gets — never `[]`.
 */
const unauthenticated = (path: string, method: string): Response =>
  failure(401, "Unauthorized", path, method);

/** Newest first, as `placedAt DESC` on `idx_orders_user_placed_at` returns them. */
const newest = (a: AccountOrder, b: AccountOrder): number =>
  new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime();

/**
 * Answers an account request, or returns `undefined` when the URL is not one of them so the caller can
 * offer it to the next handler.
 *
 * `/account/addresses` and `/account/profile` are handled by their own functions, tried first because
 * between them they own four verbs the order routes do not.
 *
 * `applySession` is how a successful `PATCH /account/profile` reaches the session the dispatcher keeps
 * — the same closure variable `GET /auth/me` is answered from. Passed in rather than owned here
 * because there is exactly one `globalThis.fetch` and therefore exactly one session; a copy in this
 * module would be a second one, free to agree with itself while `/auth/me` served the old name.
 */
export function handleAccountRequest(
  url: string,
  method: string,
  session: AuthUser | null,
  applySession: (user: AuthUser) => void,
  init?: RequestInit,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [rawPath, search] = rest.split("?");
  const path = rawPath ?? "";

  const addresses = handleAddressRequest(url, method, path, session, init);
  if (addresses) return addresses;

  const profile = handleProfileRequest(url, method, path, session, applySession, init);
  if (profile) return profile;

  if (method === "POST") {
    const cancel = /^\/account\/orders\/([^/]+)\/cancel$/.exec(path);
    if (cancel) return handleCancel(url, method, decodeURIComponent(cancel[1] ?? ""), session);
    return undefined;
  }

  if (method !== "GET") return undefined;

  if (path === "/account/orders") return handleList(url, method, search, session);

  const detail = /^\/account\/orders\/([^/]+)$/.exec(path);
  if (detail) return handleOne(url, method, decodeURIComponent(detail[1] ?? ""), session);

  return undefined;
}

function handleList(
  url: string,
  method: string,
  search: string | undefined,
  session: AuthUser | null,
): Response {
  const query = Object.fromEntries(new URLSearchParams(search ?? ""));
  listQueries.push(query);

  if (!session) return unauthenticated(url, method);

  /**
   * `forbidNonWhitelisted` on the global `ValidationPipe`, so `?page=2` is a 400 rather than a
   * parameter quietly ignored while page one comes back.
   */
  const unknown = Object.keys(query).filter((key) => key !== "channel");
  if (unknown.length > 0) {
    return failure(
      400,
      "Validation failed",
      url,
      method,
      "VALIDATION_FAILED",
      Object.fromEntries(unknown.map((key) => [key, [`property ${key} should not exist`]])),
    );
  }

  /**
   * `@IsIn`, not `@IsOptional() @IsString()`. An unvalidated channel resolves to `undefined` in the
   * service's `CHANNEL` lookup, and TypeORM **drops** an `undefined` from a `where` — so `?channel=gold`
   * would widen the read to every channel instead of matching none.
   */
  const channel = query.channel;
  if (channel !== undefined && !ORDER_CHANNELS.includes(channel)) {
    return failure(400, "Validation failed", url, method, "VALIDATION_FAILED", {
      channel: [`channel must be one of the following values: ${ORDER_CHANNELS.join(", ")}`],
    });
  }

  const mine = store
    .filter((row) => row.owner === session.email)
    .map((row) => row.order)
    .filter((order) => (channel === undefined ? true : order.channel === channel))
    .sort(newest);

  return ok<AccountOrder[]>(mine);
}

function handleOne(
  url: string,
  method: string,
  orderNumber: string,
  session: AuthUser | null,
): Response {
  reads.push(orderNumber);

  if (!session) return unauthenticated(url, method);

  /**
   * **A miss is a 404 and never a 403**, and the two misses are one branch on purpose: order numbers
   * are sequential and walkable, so an endpoint that answered 403 for "someone else's" and 404 for
   * "no such order" would let a scan enumerate the shop's volume. `ErrorCodes` has no `FORBIDDEN`
   * member at all, which is the registry saying the same thing.
   *
   * `HttpStatus.NOT_FOUND` is explicit on the server because `DomainError` defaults to 422; getting
   * that wrong would send the client's not-found branch a status it does not recognise, so the status
   * is part of the contract this reproduces.
   */
  const found = store.find((row) => row.owner === session.email && row.order.id === orderNumber);
  if (!found) {
    return failure(404, `No order ${orderNumber} in your account.`, url, method, "NOT_FOUND", {
      orderNumber,
    });
  }

  return ok<AccountOrder>(found.order);
}

/**
 * `POST /account/orders/:orderNumber/cancel` — **200, not 201**, because nothing is created and the
 * server passes `@HttpCode(HttpStatus.OK)` for exactly that reason.
 *
 * Three refusals, in the order the server produces them:
 *
 * - **401** with no session, from the global `JwtAuthGuard`. Never a 200 that did nothing.
 * - **404** for an order that is not the caller's — *before* any legality check, and the ordering
 *   matters: a 422 naming `from: "shipped"` would confirm the order exists and disclose its progress
 *   to someone with no claim on it. Letter for letter the read's own 404, because indistinguishable
 *   is the property. `ErrorCodes` has no `FORBIDDEN` member.
 * - **422 `ILLEGAL_STATUS_TRANSITION`** for an order too far along, carrying
 *   `details.allowed` — `nextStatuses(channel, from)` — so a client can say what *is* possible. This
 *   is also what a *second* cancellation gets: `canTransition` refuses a no-op, so `cancelled ->
 *   cancelled` is `allowed: []`.
 *
 * The success path appends one `cancelled` event to the order's own timeline rather than replacing it.
 * `OrderTimeline.tsx` renders the last entry as the current step, so an order whose history ends
 * anywhere other than where the order is shows the customer the wrong step with complete confidence.
 */
function handleCancel(
  url: string,
  method: string,
  orderNumber: string,
  session: AuthUser | null,
): Response {
  cancels.push(orderNumber);

  if (!session) return unauthenticated(url, method);

  const index = store.findIndex(
    (row) => row.owner === session.email && row.order.id === orderNumber,
  );
  const found = store[index];
  if (!found) {
    return failure(404, `No order ${orderNumber} in your account.`, url, method, "NOT_FOUND", {
      orderNumber,
    });
  }

  const { channel, status } = found.order;
  if (!canTransition(channel, status, "cancelled")) {
    return failure(
      422,
      `An order that is "${status}" cannot become "cancelled".`,
      url,
      method,
      "ILLEGAL_STATUS_TRANSITION",
      { orderNumber, from: status, to: "cancelled", allowed: nextStatuses(channel, status) },
    );
  }

  const cancelled: AccountOrder = {
    ...found.order,
    status: "cancelled",
    timeline: [...found.order.timeline, { status: "cancelled", at: new Date().toISOString() }],
  };
  store = store.map((row, at) => (at === index ? { ...row, order: cancelled } : row));

  return ok<AccountOrder>(cancelled);
}

/**
 * `GET`/`POST /account/addresses`, `PATCH`/`DELETE /account/addresses/:id` and
 * `POST /account/addresses/:id/default` — the account address book, Task 21's five routes.
 *
 * **What this models is the contract, not the mechanism.** The server keeps its guarantee with a
 * partial unique index (`WHERE isDefault = true AND deletedAt IS NULL`), a clear-then-set statement
 * pair the index forces, and a `FOR NO KEY UPDATE` lock on the customer's own `users` row so a
 * double-clicked *Add Address* cannot collide. None of that is reproduced here — it is
 * `addresses.integration.spec.ts`'s to prove against real Postgres, and a second implementation would
 * only be free to agree with itself. What *is* reproduced is everything a route test can see:
 *
 * - every write answers the **whole book**, because one address's `isDefault` is a function of the
 *   others and a response carrying only the changed row would leave the page's cache stale;
 * - the book is ordered **default first**, then oldest first — the page says *"the default one is
 *   offered first"*;
 * - **exactly one default, and never zero while the book has entries**: the first address saved is
 *   promoted whatever the form asked for, and deleting or unticking the default promotes the oldest
 *   survivor;
 * - a delete is **soft**, so the row stops appearing and does not come back;
 * - a label wider than `varchar(40)` is a **400** and not a 500, and a non-uuid id is a **400** —
 *   the two SQLSTATE hazards (`22001`, `22P02`) the DTO and `ParseUUIDPipe` close;
 * - a miss is a **404** for both "no such address" and "not yours", indistinguishably.
 *
 * No CSRF check, matching the other four handlers for the reason recorded on the dispatcher: the real
 * proof that `X-CSRF-Token` is carried lives in the integration suite, which asserts the 403.
 */

/** One row of the `addresses` table, as this stub keeps it. */
interface StoredAddress {
  id: string;
  /** `addresses.user_id`, expressed as the account's email — the only identity the stub has. */
  owner: string;
  label: string;
  isDefault: boolean;
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  /** The soft delete. A deleted row stays in the store and out of every answer. */
  deletedAt: string | null;
  /** Insertion order, which is what "the oldest survivor" is measured in. */
  createdAt: number;
}

/** `ParseUUIDPipe`'s own shape, so `adr-b2c-home` is a 400 here exactly as it is on the server. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `addresses.label` is `varchar(40)`, the narrowest column on the table. */
const LABEL_MAX = 40;

/** Every column a client may write. Anything else is `forbidNonWhitelisted`'s 400. */
const ADDRESS_FIELDS = [
  "label",
  "fullName",
  "phone",
  "email",
  "line1",
  "line2",
  "city",
  "state",
  "pincode",
  "isDefault",
] as const;

/** The fields a *create* cannot do without. `line2` and `isDefault` are the two that can be absent. */
const REQUIRED_FIELDS = ADDRESS_FIELDS.filter(
  (field) => field !== "line2" && field !== "isDefault",
);

/**
 * The seeded books from `src/mocks/addresses.ts`, flattened out of its keyed-by-email shape — the same
 * three rows `users.seed.ts` writes, which is what makes the smoke suite's expectations true of both
 * ends. Ids are the mock's own (`adr-b2c-home`) for the seeded rows and uuids for anything created
 * through the API, deliberately: a test that promotes or deletes a seeded address has to send an id
 * the server would accept, and `seedAddress` below is how a case gets one.
 */
function seededBook(): StoredAddress[] {
  let createdAt = 0;
  return Object.entries(addressBook).flatMap(([owner, addresses]) =>
    addresses.map((address) => ({
      id: uuidFor(address.id),
      owner,
      label: address.label,
      isDefault: address.isDefault,
      fullName: address.fullName,
      phone: address.phone,
      email: address.email,
      line1: address.line1,
      line2: address.line2 ?? null,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
      deletedAt: null,
      createdAt: createdAt++,
    })),
  );
}

/**
 * A stable uuid per seeded label, because the real ids are `BaseEntity`'s generated uuids and
 * `ParseUUIDPipe` refuses anything else.
 *
 * The mock's `adr-b2c-home` shape is exactly what the deleted client-side id generator produced, so
 * carrying it into the stub would make every `PATCH`/`DELETE`/`default` case a 400 — and a test suite
 * that could only ever exercise the refusal. Derived from the mock's own id rather than random, so the
 * same address has the same id across a reset.
 */
function uuidFor(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) % 0xffffffff;
  const hex = hash.toString(16).padStart(8, "0").slice(0, 8);
  return `${hex}-0000-4000-8000-${hex}0000`;
}

let book: StoredAddress[] = seededBook();

/** Every address write the client has sent, in order — method, path and body. */
let addressCalls: { method: string; path: string; body: unknown }[] = [];

/** Every address *read* the client has made, with its query string if it sent one. */
let addressReadPaths: string[] = [];

/**
 * The address writes the client has made, in order.
 *
 * Load-bearing for `lastCartWrite()`'s reason: a *Default* badge that moved on screen cannot tell a
 * request that was sent from a page that patched its own cache, and every one of these mutations
 * writes the server's answer straight into the query cache. It is also the only way to see the shape
 * of the request — that a new address carries **no id**, and that an edit carries one in the path
 * rather than in the body.
 */
export function addressWrites(): { method: string; path: string; body: unknown }[] {
  return addressCalls;
}

/**
 * Every `GET /account/addresses` the client has sent, path and query string as it went out.
 *
 * Load-bearing for one assertion nothing on screen can make: that the read carries **no email**. The
 * seam it replaces took one and filtered a client-side book by it, which as a server route is spec
 * §13's IDOR hole, and a client that re-added `?email=` would render an identical page.
 */
export function addressReads(): string[] {
  return addressReadPaths;
}

/**
 * The current live book for one owner, default first — `settle()` itself, exposed so
 * `business-api.stub.ts` can validate a `billingAddressId`/`shippingAddressId` against the same
 * book `GET /account/addresses` would answer with, rather than the static `addressBook` fixture
 * a test may have since added to or deleted from via the real address routes.
 */
export function liveAddressesFor(owner: string): SavedAddress[] {
  return settle(owner);
}

/** The stored id of a seeded address, so a case can promote or delete one by name. */
export function seedAddressId(owner: string, label: string): string {
  const found = book.find((address) => address.owner === owner && address.label === label);
  if (!found) throw new Error(`no seeded address labelled ${label} for ${owner}`);
  return found.id;
}

/** The wire shape: no owner, no tombstone, and `line2` omitted rather than sent as null. */
function toWire(address: StoredAddress): SavedAddress {
  return {
    id: address.id,
    label: address.label,
    isDefault: address.isDefault,
    fullName: address.fullName,
    phone: address.phone,
    email: address.email,
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

const liveFor = (owner: string): StoredAddress[] =>
  book.filter((address) => address.owner === owner && address.deletedAt === null);

/**
 * The invariant the database cannot enforce: a book with entries has **at least** one default.
 *
 * Runs at the end of every write, exactly where `AddressesService.settle` does, and promotes the
 * oldest survivor — which is the rule the deleted mock's `commit` applied to index 0 of an
 * insertion-ordered array.
 */
function settle(owner: string): SavedAddress[] {
  const live = liveFor(owner);
  if (live.length > 0 && !live.some((address) => address.isDefault)) {
    const oldest = [...live].sort((left, right) => left.createdAt - right.createdAt)[0];
    if (oldest) oldest.isDefault = true;
  }

  return [...liveFor(owner)]
    .sort(
      (left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id),
    )
    .map(toWire);
}

/** Clear then set, in that order — the statement pair the partial unique index forces. */
function promote(owner: string, id: string): void {
  for (const address of liveFor(owner)) address.isDefault = false;
  const target = book.find((address) => address.id === id);
  if (target) target.isDefault = true;
}

interface Invalid {
  details: Record<string, string[]>;
}

/**
 * The DTO's refusals, reduced to the three a route test can reach.
 *
 * `CreateAddressDto` inherits eight more rules from `AddressDto` — `PHONE_REGEX`, `PINCODE_REGEX`,
 * every column width — and reproducing all of them here would be a second copy of the contract.
 * `save-address.dto.spec.ts` validates the real class through the production `ValidationPipe` and
 * `addresses.integration.spec.ts` proves it over the wire; what matters *here* is that the form's own
 * unbounded field is bounded, that a client-minted id is refused rather than ignored, and that a
 * create cannot omit a required column.
 */
function invalidBody(body: unknown, requireAll: boolean): Invalid | undefined {
  const details: Record<string, string[]> = {};
  const value = (body ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(ADDRESS_FIELDS as readonly string[]).includes(key)) {
      details[key] = [`property ${key} should not exist`];
    }
  }

  if (requireAll) {
    for (const field of REQUIRED_FIELDS) {
      if (typeof value[field] !== "string" || value[field] === "") {
        details[field] = [`${field} should not be empty`];
      }
    }
  }

  const label = value.label;
  if (typeof label === "string") {
    if (label.length > LABEL_MAX) {
      details.label = [`label must be shorter than or equal to ${String(LABEL_MAX)} characters`];
    } else if (label.length < 2) {
      details.label = ["Name this address, e.g. Home"];
    }
  }

  return Object.keys(details).length > 0 ? { details } : undefined;
}

/** `line2: ''` is a present value the DTO accepts, so the service is what turns it into `null`. */
const normaliseLine2 = (line2: unknown): string | null =>
  typeof line2 === "string" && line2.trim() !== "" ? line2 : null;

function bodyOf(init: RequestInit | undefined): unknown {
  if (init?.body === undefined) return undefined;
  return JSON.parse(String(init.body));
}

const validationFailed = (url: string, method: string, invalid: Invalid): Response =>
  failure(400, "Validation failed", url, method, "VALIDATION_FAILED", invalid.details);

/**
 * `AddressesController.notFound`, letter for letter — one helper, because the edit, the delete and the
 * promotion must be **indistinguishable** on a miss. Two different answers would hand a caller the
 * difference between "no such address" and "someone else's".
 */
const addressNotFound = (url: string, method: string, id: string): Response =>
  failure(404, `No address ${id} in your account.`, url, method, "NOT_FOUND", { id });

/** `ParseUUIDPipe`'s 400, which carries no `code` because `BadRequestException` is not a DomainError. */
const notAUuid = (url: string, method: string): Response =>
  failure(400, "Validation failed (uuid is expected)", url, method);

export function handleAddressRequest(
  url: string,
  method: string,
  path: string,
  session: AuthUser | null,
  init?: RequestInit,
): Response | undefined {
  if (!path.startsWith("/account/addresses")) return undefined;

  const promotion = /^\/account\/addresses\/([^/]+)\/default$/.exec(path);
  const one = /^\/account\/addresses\/([^/]+)$/.exec(path);
  const collection = path === "/account/addresses";

  if (!collection && !one && !promotion) return undefined;
  if (method === "GET" && !collection) return undefined;
  if (method === "GET") addressReadPaths.push(url.startsWith("/api/v1") ? url.slice(7) : url);
  else addressCalls.push({ method, path, body: bodyOf(init) });

  // 401 before anything else, because the global `JwtAuthGuard` runs before the controller. Never an
  // empty book: that would hide a missing guard behind a plausible answer.
  if (!session) return unauthenticated(url, method);
  const owner = session.email;

  if (collection && method === "GET") return ok<SavedAddress[]>(settle(owner));

  if (collection && method === "POST") {
    const body = bodyOf(init);
    const invalid = invalidBody(body, true);
    if (invalid) return validationFailed(url, method, invalid);

    const values = body as Record<string, unknown>;
    const live = liveFor(owner);
    const asDefault = values.isDefault === true || live.length === 0;
    if (asDefault) for (const address of live) address.isDefault = false;

    book.push({
      id: uuidFor(`${owner}:${String(values.label)}:${String(book.length)}`),
      owner,
      label: String(values.label),
      isDefault: asDefault,
      fullName: String(values.fullName),
      phone: String(values.phone),
      email: String(values.email),
      line1: String(values.line1),
      line2: normaliseLine2(values.line2),
      city: String(values.city),
      state: String(values.state),
      pincode: String(values.pincode),
      deletedAt: null,
      createdAt: book.length + 100,
    });

    return json(201, { success: true, data: settle(owner) });
  }

  const id = decodeURIComponent(promotion?.[1] ?? one?.[1] ?? "");
  if (!UUID_V4.test(id)) return notAUuid(url, method);

  const owned = book.find(
    (address) => address.id === id && address.owner === owner && address.deletedAt === null,
  );

  if (promotion && method === "POST") {
    if (!owned) return addressNotFound(url, method, id);
    promote(owner, id);
    // 200, not 201: nothing is created, a flag moves between two existing rows.
    return ok<SavedAddress[]>(settle(owner));
  }

  if (one && method === "PATCH") {
    const body = bodyOf(init);
    const invalid = invalidBody(body, false);
    if (invalid) return validationFailed(url, method, invalid);
    if (!owned) return addressNotFound(url, method, id);

    const values = (body ?? {}) as Record<string, unknown>;
    if (values.isDefault === true) promote(owner, id);
    if (values.isDefault === false) owned.isDefault = false;
    for (const field of ADDRESS_FIELDS) {
      if (field === "isDefault" || values[field] === undefined) continue;
      if (field === "line2") owned.line2 = normaliseLine2(values.line2);
      else owned[field] = String(values[field]);
    }

    return ok<SavedAddress[]>(settle(owner));
  }

  if (one && method === "DELETE") {
    if (!owned) return addressNotFound(url, method, id);
    owned.deletedAt = "2026-08-21T00:00:00.000Z";
    // Cleared on the way out, so a restore cannot produce a second default.
    owned.isDefault = false;
    return ok<SavedAddress[]>(settle(owner));
  }

  return undefined;
}

/**
 * `GET`/`PATCH /account/profile` — Task 22's two routes.
 *
 * **What this models is the contract, and the interesting half is the refusals.** `UpdateProfileDto`
 * declares exactly two properties, so `email`, `role` and `isActive` are refused by
 * `forbidNonWhitelisted` over a field that is simply *not there* — a mechanism with no code to read,
 * which is precisely why a route test should be able to see it. A 400 rather than a silently stripped
 * field matters on its own: a client that believed it had changed an email address and was answered
 * 200 would be wrong at a distance.
 *
 * What it does **not** model is the column widths' real enforcement (`varchar(120)` raising SQLSTATE
 * 22001 in the driver), the case-insensitive `uq_users_email` index, or CSRF — those are
 * `profile.integration.spec.ts`'s to prove against real Postgres, and a second implementation here
 * would only be free to agree with itself.
 *
 * The `GET` exists for symmetry rather than for a consumer: `AuthProvider` hydrates from
 * `GET /auth/me` and holds the only client-side copy of `AuthUser`, so a second read would be a second
 * copy free to disagree with the header. It answers out of the session for that reason — one row, one
 * value, whichever URL asks.
 */

/** `users.name` is `varchar(120)`. `phone` needs no width: `PHONE_REGEX` admits exactly ten digits. */
const NAME_MAX = 120;

/** Every field `UpdateProfileDto` declares. Anything else is `forbidNonWhitelisted`'s 400. */
const PROFILE_FIELDS = ["name", "phone"] as const;

/** Every profile write the client has sent, in order — method, path and body. */
let profileCalls: { method: string; path: string; body: unknown }[] = [];

/**
 * The profile writes the client has made, in order.
 *
 * Load-bearing for `lastCartWrite()`'s reason, and more so here than anywhere else: this form's own
 * `useForm` state is what renders the inputs, so a Save wired to nothing at all would leave the typed
 * name on screen, fire the success toast and look **identical** to a save that reached the server. The
 * recorded call is the only thing that can tell them apart. It is also the only way to see the request
 * *shape* — that `email` is not in the body of a form that renders an email input.
 */
export function profileWrites(): { method: string; path: string; body: unknown }[] {
  return profileCalls;
}

/** `UpdateProfileDto`'s refusals, reduced to the ones a route test can reach. */
function invalidProfile(body: unknown): Invalid | undefined {
  const details: Record<string, string[]> = {};
  const value = (body ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
      details[key] = [`property ${key} should not exist`];
    }
  }

  const name = value.name;
  if (typeof name === "string") {
    // Trimmed before it is measured, exactly as the DTO's `@Transform` does it: `"  "` is a present
    // two-character string, so an untrimmed `@MinLength(2)` accepts it and the row ends up holding
    // either padding or `''` — a blank name on every future order, delivered by a 200.
    const trimmed = name.trim();
    if (trimmed.length > NAME_MAX) {
      details.name = [`name must be shorter than or equal to ${String(NAME_MAX)} characters`];
    } else if (trimmed.length < 2) {
      details.name = ["Enter your full name"];
    }
  } else if (name !== undefined) {
    details.name = ["name must be a string"];
  }

  const phone = value.phone;
  if (phone !== undefined && (typeof phone !== "string" || !PHONE_REGEX.test(phone))) {
    details.phone = ["Enter a valid 10-digit Indian mobile number"];
  }

  return Object.keys(details).length > 0 ? { details } : undefined;
}

export function handleProfileRequest(
  url: string,
  method: string,
  path: string,
  session: AuthUser | null,
  applySession: (user: AuthUser) => void,
  init?: RequestInit,
): Response | undefined {
  if (path !== "/account/profile") return undefined;
  if (method !== "GET" && method !== "PATCH") return undefined;
  if (method === "PATCH") profileCalls.push({ method, path, body: bodyOf(init) });

  // 401 before anything else, because the global `JwtAuthGuard` runs before the controller. Never an
  // empty profile: a profile has no guest equivalent to fall back to.
  if (!session) return unauthenticated(url, method);

  if (method === "GET") return ok<AuthUser>(session);

  const body = bodyOf(init);
  const invalid = invalidProfile(body);
  if (invalid) return validationFailed(url, method, invalid);

  const values = (body ?? {}) as Record<string, unknown>;
  const updated: AuthUser = {
    ...session,
    ...(typeof values.name === "string" ? { name: values.name.trim() } : {}),
    ...(typeof values.phone === "string" ? { phone: values.phone } : {}),
  };

  // Written back into the dispatcher's session, so `GET /auth/me` and this endpoint cannot disagree
  // about a name that has just changed — which is the whole reason the real `PATCH` answers with the
  // committed row rather than 204.
  applySession(updated);

  return ok<AuthUser>(updated);
}
