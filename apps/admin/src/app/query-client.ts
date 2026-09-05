import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/lib/http";

/**
 * The shared query client, and the one place retry policy is decided.
 *
 * The default is three retries with backoff on **every** failure, which is wrong for most of what
 * this app can be told:
 *
 * - **401** is already handled a layer down. `http.ts` refreshes and retries once; if that failed,
 *   the session is genuinely gone and three more attempts only delay the redirect to sign-in.
 * - **403** means *this account cannot* — retrying cannot change the answer, and `RolesGuard` will
 *   say the same thing three more times. It must also never be read as "your session expired":
 *   see `AuthProvider`, which deliberately does not sign the user out on a 403.
 * - **404** is an answer, not an outage.
 * - **422** is a refused write carrying an explanation the operator is about to be shown.
 * - **429** is the one where retrying is actively harmful: it is charged against the same limit
 *   that produced it. Note it carries **no `code`** — `ThrottlerException` is not a `DomainError` —
 *   so it can only be detected as `status === 429`.
 *
 * What is left worth retrying is a network blip or a 5xx, and once is enough to cover a restarting
 * backend without making an operator wait through four failures.
 */
const NEVER_RETRY = new Set([401, 403, 404, 409, 422, 429]);

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && NEVER_RETRY.has(error.status)) return false;
          return failureCount < 1;
        },
        /**
         * Thirty seconds. An operator working an order refreshes by acting on it, not by waiting,
         * and a console that refetched every list on every window focus would make the order table
         * jump under the cursor mid-click.
         */
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // A write is never retried automatically. `POST .../payment/collect` is idempotent and
        // would survive it, but `POST .../status` is not: a retried transition that actually
        // succeeded the first time appends a second timeline event the customer reads as the step
        // happening twice.
        retry: false,
      },
    },
  });
}
