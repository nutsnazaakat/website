import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { settings } from "@/config/settings";
import { useAuth } from "@/features/auth/AuthProvider";
import { useProducts, WHOLE_CATALOGUE } from "@/features/catalog/hooks/useCatalog";
import type { Channel } from "@/features/catalog/types";
import { cartApi } from "./api";
import { cartTotals, lineTotal } from "./cart-math";
import type { CartLine, CartTotals } from "./types";

/** What an empty basket costs, before the server has said anything. */
const EMPTY_TOTALS: CartTotals = {
  subtotal: 0,
  gst: 0,
  shipping: 0,
  total: 0,
  hasQuoteLines: false,
  hasUnpriceableLines: false,
};

interface CartCtx {
  lines: CartLine[];
  mode: Channel;
  setMode: (m: Channel) => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  /**
   * Every mutator is asynchronous now — the basket lives on the server, and a server cart cannot be
   * written synchronously. The shape of the context is otherwise preserved so consumers change as
   * little as possible; a call site that does not care about the outcome marks the discard with
   * `void` so the intent is explicit rather than accidental, and reads `error` to surface a failure.
   */
  addRetail: (slug: string, size: string, grams: number, qty?: number) => Promise<void>;
  addBulk: (slug: string, kg: number) => Promise<void>;
  switchLineToBulk: (id: string) => Promise<void>;
  setQty: (id: string, qty: number) => Promise<void>;
  /** Re-prices a bulk line at a new kilogram quantity, keeping its place in the basket. */
  setKg: (id: string, kg: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  count: number;
  totals: CartTotals;
  lineTotalFor: (line: CartLine) => number | null;
  /** True until the first `GET /cart` has answered. */
  isLoading: boolean;
  /**
   * The last failed read or write, in the server's own words, or null.
   *
   * Cleared at the start of every mutation, so a rejected add followed by a successful one does not
   * leave a stale complaint on the page.
   */
  error: string | null;
  /** A manual retry, for a page that wants to offer one after a failed write. */
  reload: () => Promise<void>;
}

const Ctx = createContext<CartCtx | null>(null);

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_MESSAGE;

/** Folds a repeat add into the existing line rather than leaving two rows with one id. */
const upsert = (prev: CartLine[], line: CartLine): CartLine[] => {
  const found = prev.find((l) => l.id === line.id);
  return found
    ? prev.map((l) => (l.id === line.id ? { ...l, qty: l.qty + line.qty } : l))
    : [...prev, line];
};

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [lines, setLines] = useState<CartLine[]>([]);
  const [totals, setTotals] = useState<CartTotals>(EMPTY_TOTALS);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Channel>("retail");
  const [open, setOpen] = useState(false);

  /**
   * The catalogue, for the optimistic window **only** — see `totals` below.
   *
   * The provider no longer fetches this itself. `useProducts({ limit: WHOLE_CATALOGUE })` is the
   * same query key the cart drawer, the cart page, the checkout summary and the bulk cart already
   * use, so react-query serves all five from one cached request; the provider's own
   * `catalogApi.listProducts()` and its local `products` state were a fifth, uncoordinated copy
   * with their own error handling — outside react-query, so nothing could dedupe it.
   *
   * Measured on the add-to-cart → cart page journey with the app's own `staleTime`: **two**
   * whole-catalogue requests before this change, **one** after.
   *
   * It cannot be removed outright. `CartLine` deliberately carries no name, price or image, and
   * `lineTotalFor` is on this context, so the provider needs product data to answer it — a claim
   * worth measuring before believing: with no catalogue every `lineTotalFor` returns 0 and every
   * basket row renders ₹0.
   */
  const { data: catalogue } = useProducts({ limit: WHOLE_CATALOGUE });
  const products = catalogue?.items;
  const find = useCallback((slug: string) => products?.find((p) => p.slug === slug), [products]);

  /**
   * The authoritative basket, mirrored into refs.
   *
   * `write` has to read the current basket, compute the next one, send it, and — if the server
   * refuses — put the old one back. Reading it out of `useState`'s updater cannot do that: the
   * updater runs during the re-render, not at the call, so the values would not be in hand when the
   * request is issued. A ref is also what keeps `reload` out of the render loop, which matters
   * because it sits in an effect's dependency list.
   */
  const linesRef = useRef<CartLine[]>([]);
  const totalsRef = useRef<CartTotals>(EMPTY_TOTALS);

  /**
   * Monotonic request counter, so a reply that has been overtaken is discarded.
   *
   * Without it two overlapping requests are applied in whatever order they happen to settle. The
   * case that found it: `/order-success/$id` used to call `clear()` in a mount effect, so the
   * emptying `PUT` and the mount `GET` were genuinely in flight together, and a `GET` landing second
   * repopulated the basket that had just been cleared — after which the next add-to-cart wrote those
   * lines back. Last-issued wins, which is the right rule for a whole-basket replace.
   *
   * That particular pair is gone: the server now empties the cart inside the placement transaction,
   * so `CheckoutForm` calls `reload()` on success rather than writing an empty basket. The counter
   * stays, and still earns its place — a `reload()` from placement and the effect's own `GET` on a
   * sign-in landing in the wrong order would show a basket the account no longer has.
   */
  const generation = useRef(0);

  const commit = useCallback((next: CartLine[], nextTotals: CartTotals) => {
    linesRef.current = next;
    totalsRef.current = nextTotals;
    setLines(next);
    setTotals(nextTotals);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setIsLoading(true);
    try {
      const state = await cartApi.get();
      if (generation.current !== token) return;
      commit(state.lines, state.totals);
      setError(null);
    } catch (failure) {
      if (generation.current !== token) return;
      /**
       * `GET /cart` is a public route, so a 401 is impossible here and any failure is a real one.
       * Swallowing it would show the customer an empty basket with no explanation.
       */
      setError(messageOf(failure));
    } finally {
      if (generation.current === token) setIsLoading(false);
    }
  }, [commit]);

  /**
   * One mutation: compute the next basket locally, show it at once, then replace it with whatever
   * the server says the basket now is.
   *
   * `cartTotals` is used for the optimistic window and **nowhere else inside this provider**.
   * The server's figures are authoritative — it computes per-line GST in paise while this
   * accumulates float rupees, so the two can differ by a rupee — and every reply overwrites the
   * guess. Do not delete `cart-math.ts` as dead code, and do not start trusting it.
   *
   * **One screen outside this provider still calls it directly: `business/bulk-cart.tsx`.** No
   * endpoint totals a subset of the basket — `POST /cart/validate` prices retail and bulk lines
   * together — so that screen re-runs this same client-side maths over the bulk slice alone and
   * labels the result *indicative* on screen, for the identical reason this comment states. That
   * label is the whole of what keeps it honest; it is not a second exception to relax.
   *
   * On rejection both halves go back, and the totals go back to the server's **last authoritative
   * figure** rather than to a recomputation of the previous basket, or a rollback would quietly
   * substitute the client's arithmetic for the server's.
   */
  const write = useCallback(
    async (compute: (prev: CartLine[]) => CartLine[]): Promise<void> => {
      const previousLines = linesRef.current;
      const previousTotals = totalsRef.current;
      const next = compute(previousLines);
      const token = ++generation.current;

      setError(null);
      commit(next, cartTotals(next, find, settings.freeShippingThreshold));

      try {
        const state = await cartApi.replace(next);
        if (generation.current !== token) return;
        commit(state.lines, state.totals);
      } catch (failure) {
        if (generation.current !== token) return;
        commit(previousLines, previousTotals);
        setError(messageOf(failure));
      }
    },
    [commit, find],
  );

  useEffect(() => {
    /**
     * Reload whenever the signed-in identity changes, in either direction.
     *
     * On **sign-in** the server has already folded any guest basket into the account during
     * `POST /auth/login`, so the client only has to pick up the result — which is why nothing here
     * calls `/cart/merge`. Doing the merge server-side means a customer whose browser closes straight
     * after signing in still keeps their basket.
     *
     * On **sign-out** this matters just as much and is easy to miss: the account's cart is no longer
     * reachable, and the customer reverts to a fresh guest cart. Without this the browser would keep
     * displaying the signed-out user's basket, and the next add-to-cart would write it into a guest
     * cart that never had those lines.
     *
     * Watching the id rather than hooking the login call is what makes both directions fall out of
     * one effect instead of needing two call sites to remember. Watching `userId` — a **string** —
     * rather than the `user` object is load-bearing too: `AuthProvider` seeds `user` from the
     * localStorage snapshot synchronously, then `GET /auth/me` may set a different object with the
     * same id, which on the object is a changed dependency and refetches for nothing.
     *
     * This effect runs on mount as well, so it is the **single** load path. A `void cartApi.get()`
     * beside it would mean two `GET /cart` calls on every page load, one of them winning a race
     * nothing defines. `reload` is `useCallback`-memoised with a stable dependency list for the same
     * reason it is in this list: an unmemoised one gets a new identity on every render, re-fires the
     * effect, sets state, re-renders — an unbounded loop of `GET /cart` for as long as the page is
     * open.
     */
    void reload();
  }, [userId, reload]);

  const value = useMemo<CartCtx>(
    () => ({
      lines,
      mode,
      setMode,
      open,
      setOpen,
      addRetail: async (slug, size, grams, qty = 1) => {
        setOpen(true);
        await write((prev) =>
          upsert(prev, { id: `r:${slug}:${size}`, slug, mode: "retail", size, grams, qty }),
        );
      },
      addBulk: async (slug, kg) => {
        setOpen(true);
        await write((prev) =>
          upsert(prev, { id: `b:${slug}:${kg}`, slug, mode: "bulk", kg, qty: 1 }),
        );
      },
      switchLineToBulk: (id) =>
        write((prev) =>
          prev.flatMap((l) => {
            if (l.id !== id || l.mode !== "retail") return [l];
            const kg = Math.round(((l.grams ?? 0) * l.qty) / 1000);
            return [{ id: `b:${l.slug}:${kg}`, slug: l.slug, mode: "bulk" as const, kg, qty: 1 }];
          }),
        ),
      setQty: (id, qty) =>
        write((prev) =>
          qty <= 0
            ? prev.filter((l) => l.id !== id)
            : prev.map((l) => (l.id === id ? { ...l, qty } : l)),
        ),
      // A bulk line's id encodes its kilograms, so changing the quantity rewrites the id.
      // Editing onto a quantity already in the basket folds the two rows together rather
      // than leaving two lines that claim the same id.
      setKg: (id, kg) =>
        write((prev) => {
          const line = prev.find((l) => l.id === id);
          if (!line || line.mode !== "bulk") return prev;
          const next = Math.max(1, Math.round(kg));
          const nextId = `b:${line.slug}:${next}`;
          if (nextId === id) return prev;
          return prev.some((l) => l.id === nextId)
            ? prev.flatMap((l) => {
                if (l.id === id) return [];
                return l.id === nextId ? [{ ...l, qty: l.qty + line.qty }] : [l];
              })
            : prev.map((l) => (l.id === id ? { ...l, id: nextId, kg: next } : l));
        }),
      remove: (id) => write((prev) => prev.filter((l) => l.id !== id)),
      clear: () => write(() => []),
      count: lines.reduce((a, l) => a + l.qty, 0),
      totals,
      lineTotalFor: (line: CartLine) => lineTotal(line, find),
      isLoading,
      error,
      reload,
    }),
    [lines, mode, open, find, totals, isLoading, error, write, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCart must be used inside CartProvider");
  return c;
}
