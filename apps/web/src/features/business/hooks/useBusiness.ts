import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateBusinessRequest } from "@/contract";
import { businessApi } from "../api";

export const businessKeys = {
  all: ["business"] as const,
  profile: () => [...businessKeys.all, "profile"] as const,
  stats: () => [...businessKeys.all, "stats"] as const,
  orders: () => [...businessKeys.all, "orders"] as const,
};

/** `GET /business/me`. `/business/profile` is behind the same guard `/business/*` already has,
 * so there is no anonymous case to enable-gate against, unlike `useOrder`'s guest confirmation. */
export const useBusinessProfile = () =>
  useQuery({ queryKey: businessKeys.profile(), queryFn: businessApi.getProfile });

/**
 * `PUT /business/me`.
 *
 * The response is written straight into the profile's cache entry rather than triggering a
 * refetch — the server has just told us the committed state, and `AddressesController`'s own
 * reasoning applies here too: showing the customer what was actually saved is what lets the two
 * address selects re-render from the same resolved rows a fresh `GET` would answer with.
 *
 * No `onError` here — the account profile page's own `ContactDetails` puts the try/catch and the
 * toast in the component, not the hook, so a failed save can reset nothing and leave the
 * customer's input exactly as they left it. This mutation matches that shape rather than
 * inventing a second one.
 */
export function useUpdateBusinessProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBusinessRequest) => businessApi.updateProfile(input),
    onSuccess: (profile) => {
      qc.setQueryData(businessKeys.profile(), profile);
    },
  });
}

/**
 * `GET /business/stats` — the dashboard's three server-computed figures. Task 19 deletes the
 * dashboard's own `reduce` over order totals and `filter(status === 'new')` over RFQs; this is
 * what it reads instead.
 */
export const useBusinessStats = () =>
  useQuery({ queryKey: businessKeys.stats(), queryFn: businessApi.getStats });

/**
 * `GET /business/orders` — the caller's own bulk orders, newest first. Deep-equal to
 * `useOrders({ channel: "bulk" })` on the wire (`BusinessesController.listOrders`'s own
 * docblock); a separate query key rather than sharing `accountKeys.orders({channel:"bulk"})` so
 * this feature's cache does not reach into another feature's key space for one it happens to
 * answer identically today.
 */
export const useBusinessOrders = () =>
  useQuery({ queryKey: businessKeys.orders(), queryFn: businessApi.listOrders });
