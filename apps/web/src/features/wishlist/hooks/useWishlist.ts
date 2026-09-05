import { useQuery } from "@tanstack/react-query";
import { wishlistApi } from "../api";

export const wishlistKeys = {
  all: ["wishlist"] as const,
  products: () => [...wishlistKeys.all, "products"] as const,
};

/**
 * The saved products themselves — `GET /wishlist`, which prices and names them.
 *
 * A react-query hook rather than provider state, for the same reason the cart page reads the
 * catalogue this way: exactly one screen wants it, and `WishlistProvider` is mounted on every screen.
 * Putting the products on the context would mean either fetching them on every page load to serve
 * one page, or holding a field that is empty everywhere else and lying about it.
 *
 * `WishlistProvider.toggle` invalidates this key on every successful write, so a product saved from
 * the shop page is present when the customer reaches `/wishlist` — `staleTime` is 60s app-wide, which
 * is long enough for a cached list to be missing what the customer just saved.
 */
export const useSavedProducts = () =>
  useQuery({ queryKey: wishlistKeys.products(), queryFn: wishlistApi.list });
