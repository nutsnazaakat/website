import type {
  AdminOrder,
  AdminOrderSummary,
  OrderChannel,
  OrderStatus,
  Paginated,
} from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The orders seam — `GET /admin/orders`, its detail, and the three writes.
 *
 * Every path here is addressed by the **order number** (`NN-2026-000123`), never a uuid.
 * `AdminOrder.id` and `AdminOrderSummary.id` are both the order number, which the contract states
 * and the controller relies on: there is no `ParseUUIDPipe` on `:orderNumber` precisely because a
 * uuid pipe would reject every real reference.
 */

/**
 * What `GET /admin/orders` accepts, and nothing else.
 *
 * The backend's `ValidationPipe` runs with `forbidNonWhitelisted` globally, so an undeclared
 * parameter is a **400**, not an ignored filter. In particular there is deliberately **no
 * free-text search**: `AdminOrderQueryDto`'s own docblock says so, and sending `?q=` fails the
 * request rather than returning everything.
 *
 * `from` and `to` are `@IsISO8601()`, which accepts both a bare `YYYY-MM-DD` and a full instant,
 * and the service treats them differently on purpose:
 *
 * - a **date-only** bound is resolved in the business timezone — `from=2026-08-27` is midnight IST
 *   on the 27th, and `to=2026-08-27` is strictly before midnight IST on the 28th, so a single day
 *   selected at both ends is that whole day inclusive;
 * - a **full instant** is used exactly as sent.
 *
 * This app sends date-only bounds, always. That is the point of plan 9.4: one definition of "what
 * day is it", server-side, shared with the dashboard's buckets. Computing an instant here would
 * quietly reintroduce the browser's timezone as a second answer.
 */
export interface OrderListQuery {
  status?: OrderStatus;
  channel?: OrderChannel;
  /** `YYYY-MM-DD`, inclusive, resolved in the business timezone. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive, resolved in the business timezone. */
  to?: string;
  page?: number;
  limit?: number;
}

/** `AdminOrderQueryDto`'s `@Min(1) @Max(60)`, and the service's `DEFAULT_LIMIT`. */
export const ORDERS_PAGE_SIZE = 24;
export const ORDERS_MAX_PAGE_SIZE = 60;

export function fetchOrders(
  query: OrderListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminOrderSummary>> {
  return http.get<Paginated<AdminOrderSummary>>(
    `/admin/orders${toQueryString({ ...query })}`,
    signal,
  );
}

export function fetchOrder(orderNumber: string, signal?: AbortSignal): Promise<AdminOrder> {
  return http.get<AdminOrder>(`/admin/orders/${encodeURIComponent(orderNumber)}`, signal);
}

/**
 * `POST /admin/orders/:orderNumber/status` — a validated transition plus a timeline event.
 *
 * `restock` is required **if and only if** `status` is `refunded` (`@ValidateIf` on the DTO);
 * sending it otherwise is a 400 under `forbidNonWhitelisted`'s sibling `whitelist`, and omitting it
 * on a refund is a 400 too. An illegal transition answers 422 `ILLEGAL_STATUS_TRANSITION` carrying
 * `allowed` — see `errors.ts`, which is what turns that into something an operator can act on.
 *
 * Answers **200**, not 201, and the body is the whole re-read `AdminOrder`: fresh timeline, fresh
 * payment state. Every admin write on this controller does the same, which is what lets the detail
 * screen replace its cache from the mutation result rather than refetching.
 */
export interface ChangeStatusInput {
  status: OrderStatus;
  note?: string;
  restock?: boolean;
}

export function changeOrderStatus(
  orderNumber: string,
  input: ChangeStatusInput,
): Promise<AdminOrder> {
  return http.post<AdminOrder>(
    `/admin/orders/${encodeURIComponent(orderNumber)}/status`,
    // Sent explicitly rather than spread, so an extra field on the caller's object can never reach
    // a `forbidNonWhitelisted` endpoint and turn a status change into a 400.
    {
      status: input.status,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.restock === undefined ? {} : { restock: input.restock }),
    },
  );
}

/**
 * `POST /admin/orders/:orderNumber/payment/collect` — COD collected.
 *
 * **Idempotent server-side, and the second call writes nothing at all** — not a second `payments`
 * row, not an audit row, and a different `reference` on the retry is ignored rather than applied.
 * The response is the same `AdminOrder` either way, carrying the *first* call's
 * `paymentCollectedAt` and `paymentReference`.
 *
 * So the UI must not pretend a second click did something. The screen hides the control once
 * `paymentStatus` is `collected`, and the mutation's success toast reports what the server came
 * back with rather than what was typed.
 *
 * There is deliberately **no amount**: the server uses the `payments.amountPaise` recorded when the
 * order was placed, so an operator cannot collect a figure that disagrees with the invoice.
 */
export function collectPayment(orderNumber: string, reference?: string): Promise<AdminOrder> {
  return http.post<AdminOrder>(
    `/admin/orders/${encodeURIComponent(orderNumber)}/payment/collect`,
    reference === undefined || reference === "" ? {} : { reference },
  );
}

/**
 * `POST /admin/orders/:orderNumber/shipment` — records a dispatch.
 *
 * **It also transitions the order to `shipped`**, in the same transaction, and the transition is
 * attempted *first*. So an order that cannot legally reach `shipped` answers the same 422
 * `ILLEGAL_STATUS_TRANSITION` with `allowed`, and no shipment row is written. The consequence
 * stated in the DTO's own docblock is that this route cannot record a **second** dispatch or attach
 * a late AWB, because `shipped -> shipped` is refused and there is no `PATCH /admin/shipments/:id`.
 * The screen says so rather than offering a control that can only fail.
 *
 * `status` and `shippedAt` are not accepted: the server sets `dispatched` and stamps the time.
 */
export interface CreateShipmentInput {
  courier: string;
  trackingNumber?: string;
}

export function createShipment(
  orderNumber: string,
  input: CreateShipmentInput,
): Promise<AdminOrder> {
  return http.post<AdminOrder>(`/admin/orders/${encodeURIComponent(orderNumber)}/shipment`, {
    courier: input.courier,
    ...(input.trackingNumber === undefined || input.trackingNumber === ""
      ? {}
      : { trackingNumber: input.trackingNumber }),
  });
}
