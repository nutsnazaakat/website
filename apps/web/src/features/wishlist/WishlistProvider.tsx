import { useQueryClient } from "@tanstack/react-query";
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
import { useAuth } from "@/features/auth/AuthProvider";
import { wishlistApi } from "./api";
import { wishlistKeys } from "./hooks/useWishlist";

/** Nothing saved. Shared so an empty state is one object rather than a new `Set` per render. */
const EMPTY: ReadonlySet<string> = new Set();

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_MESSAGE;

interface WishlistCtx {
  /**
   * Slugs, for the O(1) check every card makes.
   *
   * A `Set` rather than a list derived from the saved products on every render: every `ProductCard`
   * on a 24-product shop page calls `has()`, and a linear scan of an array per card per render is
   * the kind of thing that is invisible at 27 products and embarrassing at 500.
   *
   * `ReadonlySet` rather than `Set`, because handing consumers a mutable one makes
   * `wishlist.slugs.add("x")` compile: it would mutate provider state in place, render nothing, and
   * then be silently overwritten by the next server reply.
   */
  slugs: ReadonlySet<string>;
  /** True until the first `GET /wishlist/slugs` has answered. */
  isLoading: boolean;
  /**
   * The last failed read or write, in the server's own words, or null.
   *
   * Not on the plan's context shape, and added for the reason `CartProvider` carries one: a rejected
   * save rolls the heart back, and a heart that quietly un-fills is indistinguishable from a
   * mis-click. The page renders this; the card does not, because `toggle` is called as
   * `void toggle(slug)` and a rejecting promise there is an unhandled rejection.
   */
  error: string | null;
  has: (slug: string) => boolean;
  toggle: (slug: string) => Promise<void>;
  reload: () => Promise<void>;
  count: number;
}

const Ctx = createContext<WishlistCtx | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();

  const [slugs, setSlugs] = useState<ReadonlySet<string>>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The authoritative set, mirrored into a ref.
   *
   * `toggle` has to read the current set, compute the next one, send it, and put the old one back if
   * the server refuses. `useState`'s updater cannot do that: it runs during the re-render, not at the
   * call, so neither set would be in hand when the request goes out. The ref is also what keeps
   * `reload` out of the render loop, which matters because it sits in an effect's dependency list.
   */
  const slugsRef = useRef<ReadonlySet<string>>(EMPTY);

  /**
   * Monotonic request counter, so a reply that has been overtaken is discarded.
   *
   * Shared between the read and the write on purpose: both produce a whole set, so last-issued wins
   * is the right rule. Without it, signing in mid-toggle applies the two replies in whatever order
   * they settle, and the guest's set can land on top of the account's.
   */
  const generation = useRef(0);

  const commit = useCallback((next: ReadonlySet<string>) => {
    slugsRef.current = next;
    setSlugs(next);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setIsLoading(true);
    try {
      const { slugs: saved } = await wishlistApi.slugs();
      if (generation.current !== token) return;
      commit(new Set(saved));
      setError(null);
    } catch (failure) {
      if (generation.current !== token) return;
      // `GET /wishlist/slugs` is `@Public()`, so a 401 is impossible and any failure is a real one.
      // Swallowing it would show a customer with a full list a page of empty hearts.
      setError(messageOf(failure));
    } finally {
      if (generation.current === token) setIsLoading(false);
    }
  }, [commit]);

  /**
   * Optimistic: flip the slug locally at once, then replace the whole set with the reply. The server
   * is authoritative, exactly as the cart replaces its totals — and it has to be, because two tabs
   * can save different things and only the server knows the union.
   *
   * The heart responds to the click, not to the round trip. On rejection the previous set goes back.
   */
  const toggle = useCallback(
    async (slug: string): Promise<void> => {
      const previous = slugsRef.current;
      const saving = !previous.has(slug);
      const optimistic = new Set(previous);
      if (saving) optimistic.add(slug);
      else optimistic.delete(slug);

      const token = ++generation.current;
      setError(null);
      commit(optimistic);
      // A click during the first load supersedes it, and this counter is what tells that load to
      // discard its reply — so its `finally` will not clear the flag, and without this line the
      // page would spin for ever having already shown the answer.
      setIsLoading(false);

      try {
        const { slugs: saved } = saving
          ? await wishlistApi.add(slug)
          : await wishlistApi.remove(slug);
        if (generation.current !== token) return;
        commit(new Set(saved));
        // The saved *products* are a separate, cached query. Without this a product saved on the
        // shop page is missing from `/wishlist` for the app-wide 60s `staleTime`.
        void queryClient.invalidateQueries({ queryKey: wishlistKeys.products() });
      } catch (failure) {
        if (generation.current !== token) return;
        commit(previous);
        setError(messageOf(failure));
      }
    },
    [commit, queryClient],
  );

  useEffect(() => {
    /**
     * Reload whenever the signed-in identity changes, in either direction — `CartProvider`'s effect,
     * for the same reasons.
     *
     * On **sign-in** the server has already folded the guest's saved rows into the account during
     * `POST /auth/login`, so the client only picks up the result; nothing here calls a merge
     * endpoint. On **sign-out** it matters just as much and is the half that is easy to forget: the
     * account's saved list is no longer reachable, and leaving it on screen would show the next
     * person at that browser what the previous one had saved.
     *
     * Watching `userId` — a **string** — rather than the `user` object is load-bearing:
     * `AuthProvider` seeds `user` from the localStorage snapshot synchronously and then `GET
     * /auth/me` may set a different object with the same id, which on the object is a changed
     * dependency and refetches for nothing.
     *
     * This effect runs on mount too, so it is the **single** load path. `reload` is memoised with a
     * stable dependency list for the same reason it is in this list: an unmemoised one gets a new
     * identity every render, re-fires the effect, sets state, re-renders — an unbounded loop of
     * requests for as long as the page is open.
     */
    void reload();
  }, [userId, reload]);

  const value = useMemo<WishlistCtx>(
    () => ({
      slugs,
      isLoading,
      error,
      has: (slug: string) => slugs.has(slug),
      toggle,
      reload,
      count: slugs.size,
    }),
    [slugs, isLoading, error, toggle, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWishlist() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWishlist must be used inside WishlistProvider");
  return c;
}
