import type {
  AccountOrder,
  BusinessProfile,
  BusinessStats,
  UpdateBusinessRequest,
} from "@/contract";
import { http } from "@/lib/http";

/**
 * The business area's reads and writes, over the real API.
 *
 * `getProfile`/`updateProfile` are Task 18's. `getStats`/`listOrders` are Task 19's, for the
 * dashboard and the `/business/orders` list — `listOrders` calls `/business/orders` rather than
 * `/account/orders?channel=bulk` directly; the two are deep-equal on the server (`BusinessesController.
 * listOrders`'s own docblock), so this is a naming choice, not a behavioural one, and it is what
 * lets `businessApi` describe everything this area reads without importing `accountApi`.
 */
export const businessApi = {
  /** `GET /business/me` — the caller's own business, with both addresses resolved. */
  getProfile: (): Promise<BusinessProfile> => http.get<BusinessProfile>("/business/me"),

  /** `PUT /business/me` — a full replace of the editable profile fields. */
  updateProfile: (input: UpdateBusinessRequest): Promise<BusinessProfile> =>
    http.put<BusinessProfile>("/business/me", input),

  /** `GET /business/stats` — the dashboard's server-computed figures. */
  getStats: (): Promise<BusinessStats> => http.get<BusinessStats>("/business/stats"),

  /** `GET /business/orders` — the caller's own bulk orders, newest first. */
  listOrders: (): Promise<AccountOrder[]> => http.get<AccountOrder[]>("/business/orders"),
};
