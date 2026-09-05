import type { CartLine, CartTotals, CartValidationResult } from "@/contract";
import { http } from "@/lib/http";

export interface CartState {
  lines: CartLine[];
  totals: CartTotals;
}

/**
 * `CartLine` narrowed to the server's `CartLineDto`. Written out field by field rather than by
 * deleting keys, so a field added to the wire response cannot silently start being posted back.
 *
 * **Not optional plumbing — without it every cart write returns 400.** `CartLine` is what the server
 * *sends*; `CartLineDto` is what it *accepts*, and it is deliberately narrower: `id` and `grams` are
 * absent from it, and `app.module.ts` configures the pipe with `whitelist` **and**
 * `forbidNonWhitelisted`, so those two are not stripped — they are refused. Measured against the
 * running service, a raw `CartLine` posted to `/cart/validate` answers
 *
 * ```json
 * {"details":{"lines.0.id":["property id should not exist"],
 *             "lines.0.grams":["property grams should not exist"]}}
 * ```
 *
 * `tsc` cannot catch it: `lines` is a variable, so excess-property checking does not apply.
 *
 * Dropping `id` is right semantically too. `replace` deletes and re-inserts the rows, so the server
 * composes the line id itself from `slug` + `size`/`kg` — the same `r:${slug}:${size}` and
 * `b:${slug}:${kg}` scheme this client builds — and a client-supplied one would be meaningless.
 */
const toRequestLine = (line: CartLine) => ({
  slug: line.slug,
  mode: line.mode,
  qty: line.qty,
  ...(line.size !== undefined ? { size: line.size } : {}),
  ...(line.kg !== undefined ? { kg: line.kg } : {}),
});

/**
 * The cart over the real API.
 *
 * `replace` sends the whole basket rather than a delta. The server's state is then a function of one
 * request instead of a sequence, so a dropped request cannot leave the two disagreeing about a
 * quantity — and there is no ordering between concurrent mutations to get wrong.
 *
 * There is no `merge` here on purpose: the server folds a guest basket in during sign-in, so the
 * client only refetches. See `CartProvider`.
 */
export const cartApi = {
  get: (): Promise<CartState> => http.get("/cart"),
  replace: (lines: CartLine[]): Promise<CartState> =>
    http.put("/cart", { lines: lines.map(toRequestLine) }),
  validate: (lines?: CartLine[]): Promise<CartValidationResult> =>
    http.post("/cart/validate", lines ? { lines: lines.map(toRequestLine) } : {}),
};
