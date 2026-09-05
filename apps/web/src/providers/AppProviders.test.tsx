import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCart } from "@/features/cart/CartProvider";
import { useWishlist } from "@/features/wishlist/WishlistProvider";
import { installAuthStub } from "@/test/auth-api.stub";
import { AppProviders } from "./AppProviders";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function Probe() {
  const { count, isLoading } = useCart();
  const wishlist = useWishlist();
  return (
    <>
      <span data-testid="cart">{`${String(count)}:${String(isLoading)}`}</span>
      <span data-testid="wishlist">
        {`${String(wishlist.count)}:${String(wishlist.isLoading)}`}
      </span>
    </>
  );
}

/**
 * The production provider composition, rendered.
 *
 * This is the only test that mounts `AppProviders` itself, and it exists because the file was pinned
 * by nothing. `main.tsx` is the sole consumer, so a wrong order still typechecks, still builds and
 * still passes every other suite — the route tests build their own tree — and fails at runtime with
 * a white screen.
 *
 * That stopped being hypothetical in Task 24. `CartProvider` acquired two dependencies on providers
 * *outside* it: `useAuth()`, for the reload-on-identity-change effect, which throws
 * "useAuth must be used inside AuthProvider"; and a react-query read of the catalogue for the
 * optimistic total, which throws "No QueryClient set". Moving `CartProvider` above either one is now
 * a crash on first paint, and nothing else would have caught it.
 *
 * `WishlistProvider` joined with exactly the same two dependencies — `useAuth()` for its own identity
 * effect and `useQueryClient()` to invalidate the saved-products query — so it is pinned here too.
 * Its position relative to `CartProvider` is deliberately *not* pinned: neither reads the other, so
 * asserting an order between them would only forbid a harmless edit.
 */
describe("AppProviders", () => {
  it("puts the cart and wishlist inside both the query client and the auth provider", async () => {
    restoreFetch = installAuthStub();

    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    );

    // `isLoading` false is the proof each provider's own mount request completed through the tree,
    // rather than the context merely existing.
    await waitFor(() => expect(screen.getByTestId("cart")).toHaveTextContent("0:false"));
    await waitFor(() => expect(screen.getByTestId("wishlist")).toHaveTextContent("0:false"));
  });
});
