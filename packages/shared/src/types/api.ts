/**
 * The transport envelope. Spec §3.1 departure 2: CUG returns `{ success, data }` from most
 * controllers but bare DTOs from auth, and Gateway returns raw payloads. This service emits
 * one shape from a global interceptor, so a client never has to guess.
 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Emitted by `GlobalExceptionFilter`.
 *
 * `stack` must never be populated when `NODE_ENV=production`. That guarantee is enforced by
 * the filter, not by this type — an optional field is a hint, not a control. Client code must
 * never render `stack` on a user-reachable surface, in any environment.
 */
export interface ApiError {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string;
  /** Stable machine-readable code, e.g. `OUT_OF_STOCK`. Absent for unclassified errors. */
  code?: string;
  errorId: string;
  requestId: string;
  /**
   * Machine-readable context for the error, when there is any.
   *
   * `Record<string, unknown>` rather than `Record<string, string[]>` because two different
   * shapes legitimately flow through here and the narrower type was a lie the filter had to
   * cast past:
   *
   * - **Validation failures** populate it as field path to messages, e.g.
   *   `{ "shipping.pincode": ["Enter a valid 6-digit pincode"] }`. Nested DTO paths are dotted.
   *   class-validator emits a tree, so the backend flattens it in `ValidationPipe`'s
   *   `exceptionFactory`.
   * - **Domain errors** populate whatever the code needs, e.g. `OUT_OF_STOCK` carrying
   *   `{ available: 3, requested: 10 }` so the UI can say how many are left.
   *
   * Branch on `code` to know which you are holding.
   */
  details?: Record<string, unknown>;
  stack?: string;
}

/**
 * The literal shape of every response body. Narrow on `success` before reading `data`.
 *
 * Declared so a client types the envelope once instead of rewriting the union at each call
 * site — or, worse, typing only `.data` and trusting the shape came back correctly.
 */
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/**
 * An explicit opt-in for a handler that wants to set `message` on the envelope.
 *
 * The interceptor previously inferred this from shape alone — `'data' in value` plus a string
 * `message`. That is unsafe in this domain: `SupportTicket` has a `message` column, so a genuine
 * DTO could be silently unwrapped, and a passed-through upstream `{ success, data }` payload
 * would hit the double-wrap guard and be emitted unenveloped. `__envelope` is a key no domain
 * object will ever carry, so the check becomes unambiguous.
 *
 * Build one with `withMessage`; never hand-write the marker.
 */
export interface Enveloped<T> {
  readonly __envelope: true;
  data: T;
  message?: string;
}

export function withMessage<T>(data: T, message: string): Enveloped<T> {
  return { __envelope: true, data, message };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}
