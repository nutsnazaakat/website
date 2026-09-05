import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRouter, RouterProvider, type RouterHistory } from "@tanstack/react-router";
import { AuthProvider } from "@/features/auth/auth-provider";
import { routeTree } from "@/routeTree.gen";

/**
 * The router and the providers around it, built as a function rather than a module-level singleton.
 *
 * That is what makes the route tests real: `src/routes/routes.test.tsx` mounts **this** router with
 * a fresh `QueryClient` per case and asserts on content *inside* each route. A shared instance
 * would carry one case's cache and history into the next, and the tests would start passing for
 * reasons unrelated to the routes.
 */
export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    /**
     * Not `"intent"`. Prefetching on hover would fire an admin query for every row the cursor
     * crosses on the way to the one the operator wants — twenty-four orders, twenty-four requests,
     * against a 120/min limit.
     */
    defaultPreload: false,
    /**
     * **Drops any search parameter no route's `validateSearch` returned. Not the default.**
     *
     * `search.strict` is `false` out of the box, which means a route's `validateSearch` can only
     * *add* to the raw query string, never remove from it. Measured, not assumed: with the default,
     * `/orders?status=nonsense&bogus=1` left `/_console/orders/`'s match search carrying both keys
     * even though its validator returned neither — and `fetchOrders` then sent `status=nonsense` to
     * an endpoint whose global `ValidationPipe` runs with `forbidNonWhitelisted`, turning a
     * hand-edited address bar into a 400 an operator cannot interpret.
     *
     * With it on, each route declares the parameters it has and nothing else survives. Pinned by
     * `src/routes/routes.test.tsx`.
     */
    search: { strict: true },
    defaultNotFoundComponent: NotFound,
    // Omitted in the browser, where the router creates its own from `window.history`. The route
    // tests pass a `createMemoryHistory({ initialEntries: [path] })` so a case can start on
    // `/orders/NN-2026-005107` without a redirect standing in for the navigation.
    ...(history === undefined ? {} : { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-lg font-semibold">No such screen.</h1>
      <p className="text-muted-foreground text-[12px]">
        Fifteen of the console's eighteen screens are not built yet — the sidebar marks them.
      </p>
      <a href="/" className="text-primary text-[12px] hover:underline">
        Back to the dashboard
      </a>
    </main>
  );
}

/**
 * `AuthProvider` sits **inside** `QueryClientProvider` and **outside** `RouterProvider`.
 *
 * Inside the query client because it is a provider like any other and may one day want it; outside
 * the router because `_console`'s guard calls `useAuth` during render, and a provider mounted by a
 * route could not be read by the route that mounts it.
 */
export function AppProviders({
  router,
  queryClient,
}: {
  router: AppRouter;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
