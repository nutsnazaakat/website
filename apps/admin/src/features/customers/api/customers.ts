import type { AdminCustomer, AdminCustomerSummary, Paginated, Role } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The customers seam — `GET /admin/customers` and `GET /admin/customers/:id`. Brief §35.
 *
 * **Addressed by uuid, unlike orders and RFQs.** `AdminCustomersController` puts a `ParseUUIDPipe`
 * on `:id`, so anything that is not a uuid is a 400 before the service is reached. There is no
 * human-readable customer reference in this system and none is wanted: an email is a login
 * credential, not an identifier to put in a URL.
 *
 * **Money is rupees.** `AdminCustomerSummary.totalSpend` arrives converted — see `lib/format.ts`.
 */

/**
 * The two roles this list can hold.
 *
 * `admin` is deliberately absent, and it is the server's decision rather than this module's:
 * `AdminCustomerQueryDto`'s `role` is `@IsIn(['b2c', 'b2b'])` and `AdminCustomersService` filters
 * `role <> 'ADMIN'` regardless, because an operator account is not a customer and a list that
 * counted them would disagree with the dashboard's `customers` card beside it. Sending
 * `?role=admin` is a 400 under `forbidNonWhitelisted`'s sibling `whitelist`, not an empty page.
 *
 * Typed against the contract's `Role` so it cannot drift into a third spelling.
 */
export const CUSTOMER_ROLES: readonly Extract<Role, "b2c" | "b2b">[] = ["b2c", "b2b"];

export function parseCustomerRole(value: unknown): "b2c" | "b2b" | undefined {
  return value === "b2c" || value === "b2b" ? value : undefined;
}

/**
 * What `GET /admin/customers` accepts, and nothing else.
 *
 * `q` is a real free-text parameter here — `@IsString() @MaxLength(200)` — unlike
 * `GET /admin/orders`, which has none. It matches name, email and phone. Worth stating because the
 * two screens sit next to each other and an operator who learns "no search" on orders would not
 * think to try it here.
 */
export interface CustomerListQuery {
  q?: string;
  role?: "b2c" | "b2b";
  page?: number;
  limit?: number;
}

/** `AdminCustomerQueryDto`'s `@Min(1) @Max(60)`. */
export const CUSTOMERS_PAGE_SIZE = 24;

export function fetchCustomers(
  query: CustomerListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminCustomerSummary>> {
  return http.get<Paginated<AdminCustomerSummary>>(
    `/admin/customers${toQueryString({ ...query })}`,
    signal,
  );
}

export function fetchCustomer(id: string, signal?: AbortSignal): Promise<AdminCustomer> {
  return http.get<AdminCustomer>(`/admin/customers/${encodeURIComponent(id)}`, signal);
}
