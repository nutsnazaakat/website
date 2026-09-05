import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ShopPage } from "@/features/catalog/components/ShopPage";

/**
 * Spec §5.3 — every filter lives in the URL so a filtered shop view can be shared,
 * bookmarked and walked back through with the browser's back button.
 */
const searchSchema = z.object({
  category: z.string().optional(),
  q: z.string().optional(),
  sort: z
    .enum(["featured", "best-selling", "price-asc", "price-desc", "newest", "rating"])
    .optional(),
  origin: z.string().optional(),
  grade: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  bestsellerOnly: z.boolean().optional(),
  inStockOnly: z.boolean().optional(),
  /**
   * Focuses the shop's own search field on arrival. The mobile tab bar used to set this;
   * it now opens the instant-search dialog instead (brief §22), so the flag survives only
   * for deep links that want the field focused.
   */
  focus: z.boolean().optional(),
  /**
   * The page of results, absent for the first one — so the shareable link to an unpaged shop is
   * exactly what it was before pagination existed, and `resetFilters` needs no special case.
   */
  page: z.number().int().min(1).optional(),
});

export type ShopSearch = z.infer<typeof searchSchema>;

export const Route = createFileRoute("/shop")({
  validateSearch: searchSchema,
  component: ShopPage,
});
