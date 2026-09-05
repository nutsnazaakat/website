/**
 * Re-export shim — the definitions moved to `shared/src/types/cart.ts` so the server can produce
 * them.
 *
 * Kept as a module rather than deleted because these are the import paths the cart's own components
 * already use, and because the shim is the thing that removes the drift: `CartTotals` was declared
 * twice, here and in `shared/`, and the two had to be kept in step by hand.
 */
export type {
  CartLine,
  CartTotals,
  CartValidationLine,
  CartValidationResult,
} from "@/contract";
