import { useQuery } from "@tanstack/react-query";
import { catalogApi } from "../api";
import type { ProductFilters } from "../types";

export const catalogKeys = {
  all: ["catalog"] as const,
  products: (f: ProductFilters) => [...catalogKeys.all, "products", f] as const,
  product: (slug: string) => [...catalogKeys.all, "product", slug] as const,
  facets: () => [...catalogKeys.all, "facets"] as const,
  categories: () => [...catalogKeys.all, "categories"] as const,
  category: (slug: string) => [...catalogKeys.all, "category", slug] as const,
  bestsellers: (n: number) => [...catalogKeys.all, "bestsellers", n] as const,
  related: (slug: string) => [...catalogKeys.all, "related", slug] as const,
  combos: () => [...catalogKeys.all, "combos"] as const,
};

/**
 * A page wide enough to hold the whole catalogue, and the listing DTO's `@Max(60)` ceiling.
 *
 * Several screens want a slug-to-product lookup rather than a listing — the cart drawer, the checkout
 * summary, the bulk cart, the three RFQ screens. They used to call `useProducts()` and get
 * everything, because nothing paginated. Against the server's default page of 24 they would name 24
 * of the 27 products and silently fall back to the raw slug for the rest, which reads as a missing
 * product rather than a missing page.
 *
 * It is a stopgap, not the design: the right answer is for the server to price and name a basket,
 * which is what the cart endpoints do in Milestone 4. Asking for 61 products is a 400, so this
 * cannot be widened — a catalogue past 60 has to move to that lookup instead.
 */
export const WHOLE_CATALOGUE = 60;

export const useProducts = (filters: ProductFilters = {}) =>
  useQuery({
    queryKey: catalogKeys.products(filters),
    queryFn: () => catalogApi.listProducts(filters),
  });

/**
 * Filter options for the shop sidebar.
 *
 * Replaces the second, unfiltered `useProducts()` that `ShopPage` and `bulk.$category` each fired to
 * derive origins, grades and price bounds from the whole catalogue. That worked only while lists were
 * unpaginated; against a paginated list it would have described one page and been quietly wrong.
 *
 * `staleTime` is generous because facets change when the catalogue changes, not per keystroke.
 */
export const useProductFacets = () =>
  useQuery({
    queryKey: catalogKeys.facets(),
    queryFn: () => catalogApi.facets(),
    staleTime: 5 * 60 * 1000,
  });

export const useProduct = (slug: string) =>
  useQuery({ queryKey: catalogKeys.product(slug), queryFn: () => catalogApi.getProduct(slug) });

export const useCategories = () =>
  useQuery({ queryKey: catalogKeys.categories(), queryFn: catalogApi.listCategories });

export const useCategory = (slug: string) =>
  useQuery({ queryKey: catalogKeys.category(slug), queryFn: () => catalogApi.getCategory(slug) });

export const useBestsellers = (limit = 8) =>
  useQuery({
    queryKey: catalogKeys.bestsellers(limit),
    queryFn: () => catalogApi.listBestsellers(limit),
  });

export const useRelated = (slug: string) =>
  useQuery({ queryKey: catalogKeys.related(slug), queryFn: () => catalogApi.listRelated(slug) });

export const useCombos = () =>
  useQuery({ queryKey: catalogKeys.combos(), queryFn: catalogApi.listCombos });
