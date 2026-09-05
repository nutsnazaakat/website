import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountApi, type SavedAddressInput } from "../api";
import type { AccountOrder, OrderFilters, SavedAddress } from "../types";

/**
 * The account area's query keys.
 *
 * `orders` is keyed on `OrderFilters` and nothing else now. It used to be keyed on
 * `MockOrderFilters` — `OrderFilters & { email?: string }` — which put the account's address in the
 * cache key because the mock filtered by it client-side; the server scopes the read from the session,
 * so the email was never a dimension of the answer, only of the key. Two pages asking for the same
 * filters now share one cache entry rather than one per signed-in address.
 *
 * **`order(id)` keeps its name and its shape.** `CheckoutForm` writes the placement response into
 * `accountKeys.order(order.id)` before navigating, because `/checkout` and `/order-success/$id` have
 * no route guard: a guest's order is written with `userId: null` and both account reads are
 * session-scoped, so a guest could never fetch their own confirmation. Task 23 reads that entry.
 * Renaming this key would turn a guest's confirmation into a 401 with nothing on screen to say so.
 */
export const accountKeys = {
  all: ["account"] as const,
  /**
   * The prefix every `orders(filters)` entry shares.
   *
   * Exists so a cancellation can invalidate *all* of them in one call. `orders(f)` puts the filter
   * object in the key, so `/account/orders`, `/account`, `/business/orders` and `/business` each hold
   * their own entry — four caches of a list the cancelled order is still in. Invalidating one and
   * leaving three is worse than invalidating none, because the customer then sees the order cancelled
   * on the page they cancelled it from and live everywhere else.
   */
  ordersRoot: () => [...accountKeys.all, "orders"] as const,
  orders: (f: OrderFilters) => [...accountKeys.ordersRoot(), f] as const,
  order: (id: string) => [...accountKeys.all, "order", id] as const,
  /**
   * **No email in the key, because there is none in the request.** It used to be
   * `["account", "addresses", email]`, because the mock filtered a client-side book by it; five
   * session-scoped endpoints replaced that, so the address was never a dimension of the answer — only
   * of the key. `useOrders` lost its email for the same reason one task earlier.
   */
  addresses: () => [...accountKeys.all, "addresses"] as const,
};

export const useOrders = (filters: OrderFilters = {}) =>
  useQuery({
    queryKey: accountKeys.orders(filters),
    queryFn: () => accountApi.listOrders(filters),
  });

/**
 * `orderNumber`, not the uuid — `NN-{year}-{6 digits}` is the route parameter and the wire key.
 *
 * **`enabled` is a parameter because one of the two readers must be able to not ask.**
 * `/order-success/$id` renders the order `CheckoutForm` seeded into this very key, and for a guest —
 * the ordinary retail path, since neither `/checkout` nor that route is guarded — the request this
 * hook would make can only ever be a 401: their order carries `userId: null` and the endpoint is
 * session-scoped. It also spares the signed-in customer a refetch of an order the server handed them
 * a moment ago, `staleTime` being 0. `/account/orders/$id` passes nothing and asks unconditionally.
 *
 * The key and the query function stay here rather than being rebuilt at the second call site: a
 * hand-written key array that drifts by one element is a silent cache miss, which on the
 * confirmation screen is a 401 on the customer's own order.
 */
export const useOrder = (orderNumber: string, options: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: accountKeys.order(orderNumber),
    queryFn: () => accountApi.getOrder(orderNumber),
    enabled: options.enabled ?? true,
  });

/**
 * `POST /account/orders/:orderNumber/cancel`.
 *
 * The response **is** the order as it now stands, so it is written straight into the detail entry
 * rather than triggering a refetch: the server has just told us the committed state, and a refetch
 * would ask it the same question again with a window in between where the page still shows `pending`.
 *
 * The lists are invalidated rather than patched, because there are up to four of them under different
 * filters and the cancelled order's position in each depends on that filter. `refetchType: "all"` is
 * deliberate: the account overview and the business dashboard are usually unmounted when a customer
 * cancels from the detail page, and react-query's default `"active"` would leave those entries stale
 * until they happen to be remounted — at which point they render an order the customer cancelled
 * minutes ago as still live.
 */
export function useCancelOrder(orderNumber: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: () => accountApi.cancelOrder(orderNumber),
    onSuccess: (order: AccountOrder) => {
      qc.setQueryData(accountKeys.order(order.id), order);
      void qc.invalidateQueries({ queryKey: accountKeys.ordersRoot(), refetchType: "all" });
    },
  });
}

/**
 * `GET /account/addresses` — the signed-in customer's own book, default first.
 *
 * **No argument, and no `enabled` guard either.** The hook used to take an email and sit disabled
 * while it was `""`, which was the only thing stopping a request for an anonymous visitor's book.
 * That guard is gone because the request is now session-scoped and `/account` is behind
 * `requireCustomer` in the layout's `beforeLoad` — a guard that runs before any component mounts — so
 * the query cannot fire without a session. Keeping `enabled` would mean keeping the email, which is
 * the argument spec §13 rules out.
 */
export const useAddresses = () =>
  useQuery({
    queryKey: accountKeys.addresses(),
    queryFn: () => accountApi.listAddresses(),
  });

/**
 * A save, which is a create or an edit depending on whether the form was opened on an existing
 * address.
 *
 * `id: null` for a new one — deliberately explicit rather than an optional property, because the two
 * verbs are different requests and "no id" is the decision that picks between them. The page used to
 * paper over that difference by fabricating an id (`adr-${Date.now().toString(36)}`) so that every
 * save could be an upsert against a client-side array; there is a server now, and it allocates the
 * uuid.
 */
export interface SaveAddress {
  id: string | null;
  values: SavedAddressInput;
}

/**
 * All three address mutations answer the **whole book**, so they share one cache update.
 *
 * `setQueryData` rather than an invalidation, and the endpoints are shaped to make that safe: one
 * address's `isDefault` is a function of the others, so the server sends back every row rather than
 * the one that changed. A response carrying only the changed address would leave this cache holding a
 * stale copy of a *different* one — two *Default* badges, or none — and no refetch would be triggered
 * to correct it.
 */
export function useAddressMutations() {
  const qc = useQueryClient();
  const onSuccess = (list: SavedAddress[]) => qc.setQueryData(accountKeys.addresses(), list);

  return {
    save: useMutation({
      mutationFn: ({ id, values }: SaveAddress) =>
        id === null ? accountApi.addAddress(values) : accountApi.updateAddress(id, values),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => accountApi.removeAddress(id),
      onSuccess,
    }),
    setDefault: useMutation({
      mutationFn: (id: string) => accountApi.setDefaultAddress(id),
      onSuccess,
    }),
  };
}
