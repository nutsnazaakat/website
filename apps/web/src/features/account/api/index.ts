import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";
import type { AccountOrder, OrderFilters, SavedAddress } from "../types";

/**
 * The account area's reads, over the real API.
 *
 * **The receipt is gone, and so is everything it made up.** `fromReceipt` reconstructed an order out
 * of the `nn.order.${id}` sessionStorage record that checkout wrote, because in Phase 1 there was
 * nowhere else for a just-placed order to live. It had to guess five things, and every one of them is
 * now answered by a row:
 *
 * | It invented | The endpoint answers |
 * | --- | --- |
 * | `gst = Math.round(subtotal * 0.05)` | `orders.gst_paise`, computed per line at placement |
 * | `shipping = amount − subtotal − gst` — *"the residue is what shipping cost"* | `orders.shipping_paise`, from the destination's own row |
 * | `discount: 0`, always | `orders.discount_paise` |
 * | `status: "confirmed"`, always | `orders.status` |
 * | a two-event timeline whose `confirmed` step read **"Payment received."** | `order_events`, oldest first, on a COD order nobody has paid for yet |
 *
 * The last one is the one worth keeping in mind, because it is the shape of the whole class: the
 * reconstruction was not merely approximate, it was *confidently wrong* — a paid-for note on an unpaid
 * order, and a `confirmed` status on an order the server had only just accepted as `pending`.
 *
 * **`listOrders` takes no email, and cannot.** It used to accept `MockOrderFilters = OrderFilters & {
 * email?: string }` and filter a client-side array by it. `OrderFilters` has no email field on
 * purpose (spec §13): the server scopes history by `user_id` from the session, and a client able to
 * name the account it is reading is the IDOR hole. All four call sites dropped the argument —
 * `routes/account/index.tsx`, `routes/account/orders/index.tsx`, `routes/business/orders.tsx` and
 * `routes/business/index.tsx`.
 *
 * **Disagreement 6 disappears here rather than being fixed.** The receipt's local `OrderItem` had no
 * `slug`, so `LineName` in `account/orders/$id.tsx` — which links to the product exactly when one is
 * present — rendered a just-placed order's lines as plain text while a seeded order's linked.
 * `order_items.product_slug` is a non-null snapshot column, so every order the server answers with
 * links.
 *
 * **The address book is real too now, and the last of the mock's rules moved to the server.** The
 * in-memory `book` this module kept, its `commit` helper and the four functions that used it are
 * gone. `commit`'s one rule worth keeping — *exactly one default, and never zero while the book has
 * entries* — is now half enforced by `uq_addresses_one_default_per_user`, which stops **two**
 * defaults, and half by `AddressesService`, which is what stops **zero**: promoting the first address
 * saved, and promoting a survivor when the default is deleted or unticked.
 *
 * **No address function takes an email any more.** All five endpoints are session-scoped, so an
 * `email` argument was at best dead and at worst a suggestion that a client picks whose address book
 * it reads — the same IDOR shape spec §13 rules out for orders, and the reason `OrderFilters` cannot
 * carry one either. Dropped from `useAddresses`, from `accountKeys.addresses` and from both call
 * sites.
 *
 * **And no client-minted ids.** `routes/account/addresses.tsx` used to fabricate
 * `` `adr-${Date.now().toString(36)}` `` for a new address, which collides for two saved in the same
 * millisecond and is not a uuid at all — so it now reaches `ParseUUIDPipe` as a 400 rather than a
 * `uuid` column as a 500. `addresses.id` is `BaseEntity`'s generated uuid, and a create simply does
 * not send one: `forbidNonWhitelisted` makes an id in the body a 400 rather than a value quietly
 * ignored.
 */

/**
 * Everything about an address except the id, which the server allocates.
 *
 * Structurally what `AddressForm`'s `savedAddressSchema` infers, so the form's values are the request
 * body with nothing in between. Named rather than inlined because it is the body of two verbs — a
 * create and a patch — and the form sends the whole object on both.
 */
export type SavedAddressInput = Omit<SavedAddress, "id">;

export const accountApi = {
  /**
   * `GET /account/orders` — the signed-in customer's own orders, newest first.
   *
   * Spread into `toQueryString` rather than passed as-is so an added `OrderFilters` member is carried
   * without a second edit, and so `channel: undefined` is dropped rather than serialised: `?channel=undefined`
   * fails `OrderQueryDto`'s `@IsIn` and turns "no filter" into a 400.
   *
   * No `email`, no `userId`, no pagination. The session decides whose history this is, and
   * `OrderQueryDto` accepts nothing else — `forbidNonWhitelisted` makes a stray parameter a 400
   * rather than a filter that is quietly ignored.
   */
  listOrders: (filters: OrderFilters = {}): Promise<AccountOrder[]> =>
    http.get(`/account/orders${toQueryString({ ...filters })}`),

  /**
   * `GET /account/orders/:orderNumber` — one of the caller's orders, by the number on their
   * confirmation.
   *
   * **The order *number*, never the uuid.** `AccountOrder.id` is `NN-{year}-{6 digits}` and the route
   * parameter is the same value, which is what lets `/account/orders/$id` be linked from a
   * confirmation email or read down a phone line.
   *
   * **Rejects for an order the caller cannot see, rather than resolving to `null`.** The mock answered
   * `null` because it was searching an array; the endpoint answers 404, and `catalogApi.getProduct`
   * already established which of the two this codebase does with a miss — `product.$slug.tsx` reads
   * `isError || !product`, and `account/orders/$id.tsx`'s `if (!order)` covers a rejection and an
   * absent answer identically. Mapping the 404 back to `null` would add a branch **no test in this
   * suite can distinguish**: with `data` `undefined` either way, the not-found screen is byte-identical.
   *
   * The 404 covers both "no such order" and "not yours", and the server cannot tell them apart by
   * design — order numbers are sequential, so a 403 for someone else's would make the endpoint an
   * existence oracle. Spec §13.
   */
  getOrder: (orderNumber: string): Promise<AccountOrder> =>
    http.get(`/account/orders/${encodeURIComponent(orderNumber)}`),

  /**
   * `POST /account/orders/:orderNumber/cancel` — the customer cancelling their own order.
   *
   * **No body, and there is nothing that could go in one.** The target status is `'cancelled'`,
   * hardcoded on the server: `RETAIL_TRANSITIONS` also allows `delivered -> refunded`, so a route
   * that accepted a status from its client would be a self-service refund wearing the name *cancel*.
   * The order comes from the path and the actor from the session cookie.
   *
   * `http.post` echoes `nn_csrf` into `X-CSRF-Token` for every unsafe method, which matters more here
   * than on a read: a cancellation is terminal — `nextStatuses(channel, 'cancelled')` is `[]` — so
   * the request a forged cross-site form would make is one that destroys an order rather than one
   * that discloses it.
   *
   * **Answers the order as it now stands, so the page re-renders from the server's answer rather than
   * from a guess about it.** The two refusals a caller has to expect are a **404** for an order that
   * is not theirs (never a 403 — order numbers are sequential, so an existence oracle is a
   * disclosure) and a **422 `ILLEGAL_STATUS_TRANSITION`** for an order too far along to cancel,
   * carrying `details.allowed` — `nextStatuses(channel, from)` — which is what lets a client say what
   * *is* possible. Both arrive as an `ApiRequestError`, and neither is mapped to `null`: a
   * cancellation that quietly did nothing is the one outcome a customer must never be shown.
   */
  cancelOrder: (orderNumber: string): Promise<AccountOrder> =>
    http.post(`/account/orders/${encodeURIComponent(orderNumber)}/cancel`),

  /**
   * `GET /account/addresses` — the caller's own addresses, **default first**.
   *
   * No email and no id. The session decides whose book this is, exactly as it decides whose orders
   * `listOrders` answers with.
   *
   * The ordering is the server's (`isDefault DESC, createdAt ASC, id ASC`) and the page depends on
   * it: `/account/addresses` tells the customer *"the default one is offered first"*.
   */
  listAddresses: (): Promise<SavedAddress[]> => http.get("/account/addresses"),

  /**
   * `POST /account/addresses` — save a new address.
   *
   * **Answers the whole book, not the address created**, and every mutation below does the same. One
   * address's `isDefault` is a function of the others: saving a default demotes the previous one, and
   * a book's *first* address is promoted whether or not the form asked for it. A response carrying
   * only the new row would leave the client's copy of a different row stale — two *Default* badges on
   * screen, or none — which is why `useAddressMutations` can write the result straight into the cache
   * instead of refetching.
   */
  addAddress: (address: SavedAddressInput): Promise<SavedAddress[]> =>
    http.post("/account/addresses", address),

  /**
   * `PATCH /account/addresses/:id` — edit one.
   *
   * A patch, so a caller may send one field; the form sends all of them, which is also accepted. The
   * id is in the path and **never in the body**: two identifiers for one row is an obvious place for
   * them to disagree, and the server answers 400 for a body that carries one.
   *
   * Rejects with `ApiRequestError` for an address that is not the caller's — a **404**, the same
   * answer an id nobody owns gets, because the server cannot tell the two apart by design.
   */
  updateAddress: (id: string, address: SavedAddressInput): Promise<SavedAddress[]> =>
    http.patch(`/account/addresses/${encodeURIComponent(id)}`, address),

  /**
   * `DELETE /account/addresses/:id` — a **soft** delete, and the reason is restorability rather than
   * order history: an order holds an `addressSnapshot`, so deleting an address cannot rewrite where a
   * past order went. Answers 200 with the remaining book, because deleting the default promotes
   * another address and the page has a badge to move.
   */
  removeAddress: (id: string): Promise<SavedAddress[]> =>
    http.delete(`/account/addresses/${encodeURIComponent(id)}`),

  /**
   * `POST /account/addresses/:id/default` — move the default.
   *
   * **200 and not 201**: nothing is created, a flag moves between two existing rows. No body either —
   * the address is named by the path and the account by the session cookie. Idempotent, so a
   * double-clicked *Make default* is not a constraint violation.
   */
  setDefaultAddress: (id: string): Promise<SavedAddress[]> =>
    http.post(`/account/addresses/${encodeURIComponent(id)}/default`),
};
