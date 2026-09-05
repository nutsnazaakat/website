import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { CartProvider } from "@/features/cart/CartProvider";
import { WishlistProvider } from "@/features/wishlist/WishlistProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/*
         * `WishlistProvider` goes **inside** `AuthProvider` and inside the query client, because it
         * calls `useAuth()` for its reload-on-identity-change effect and `useQueryClient()` to
         * invalidate the saved-products query — either one is a crash on first paint if it is moved
         * above them, and `main.tsx` is the only consumer of this file, so nothing else would notice.
         *
         * Its position relative to `CartProvider` is free: neither reads the other's context, so
         * this nesting is JSX, not a dependency. `AppProviders.test.tsx` pins the two constraints
         * that are real.
         */}
        <CartProvider>
          <WishlistProvider>{children}</WishlistProvider>
        </CartProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
