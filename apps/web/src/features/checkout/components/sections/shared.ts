/**
 * The two non-JSX helpers more than one section needs.
 *
 * Neither is a component, so neither belongs in a `.tsx`, and both are used by two sections apiece —
 * `SELECT_CLASS` by the shipping and billing state pickers, `messageOf` by the coupon refusal line
 * and the placement error. Copying either into both callers is how the same literal came to exist
 * seven times over in `src/` already.
 */

/** A native select keeps the long state list usable on mobile keyboards. */
export const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

export const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : FALLBACK_MESSAGE;
