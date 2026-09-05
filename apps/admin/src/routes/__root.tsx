import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster } from "sonner";

/**
 * The application root.
 *
 * **`<Outlet />` is not optional and its absence is silent.** A layout route that forgets it
 * renders its own markup, resolves the child route successfully, and shows a blank page — no error,
 * no warning, and a test asserting "the route loaded" passes against nothing. The backend repo hit
 * that three times. Every layout in this app therefore renders one, and
 * `src/routes/routes.test.tsx` asserts on content *inside* each route rather than on the fact that
 * it resolved.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <>
      <Outlet />
      {/*
        Bottom-right, and `richColors` off. An operator's eye lives on the table; a toast at the
        top would sit over the filter bar they are typing into.
      */}
      <Toaster position="bottom-right" closeButton />
    </>
  );
}
