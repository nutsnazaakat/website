import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common/EmptyState";
import { Pager } from "@/components/common/Pager";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useSeo } from "@/hooks/useSeo";
import { cn } from "@/lib/utils";
import type { ShopSearch } from "@/routes/shop";
import { useCategories, useProductFacets, useProducts } from "../hooks/useCatalog";
import type { ProductFilters, ProductSort } from "../types";
import { ProductCard } from "./ProductCard";
import { ShopFilters, type ShopFilterValue } from "./ShopFilters";

const route = getRouteApi("/shop");

const sortOptions: { value: ProductSort; label: string }[] = [
  { value: "featured", label: "Featured" },
  { value: "best-selling", label: "Best Selling" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "newest", label: "Newest First" },
  { value: "rating", label: "Highest Rated" },
];

/** The sidebar's slider needs a round number above the dearest product, and a floor for an empty shop. */
const FALLBACK_CEILING = 5000;

export function ShopPage() {
  useSeo({
    title: "Shop Dry Fruits Online — Almonds, Cashews, Makhana | Nuts & Nazaakat",
    description:
      "Browse premium dry fruits in 100g, 250g, 500g and 1kg packs. Filter by category, grade, origin and price. Fresh packing, pan-India delivery.",
  });

  const search = route.useSearch();
  const navigate = route.useNavigate();
  const router = useRouter();

  /**
   * Any filter change returns to the first page.
   *
   * `page` lives in the same search object as the filters, so a plain `{ ...prev, ...patch }` would
   * carry it through every filter change: pick a category while on page 3 of the unfiltered shop,
   * land on page 3 of a one-page result, and see an empty grid. From the customer's side their
   * filter deleted the catalogue.
   *
   * `page: undefined` rather than `1`, so the first page has no `?page=` in the URL and the
   * shareable link for an unpaged shop is what it always was — which is also why `resetFilters`
   * needs no special case.
   */
  const setFilter = (patch: Partial<ShopSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true });

  /** Paging keeps every filter and changes only the page. */
  const setPage = (page: number) =>
    navigate({
      search: (prev) => ({ ...prev, page: page === 1 ? undefined : page }),
      replace: true,
    });

  /**
   * Built field by field rather than spread from `search`, and that is load-bearing.
   *
   * The two shapes are not the same: `focus` is a UI flag that focuses the search box on arrival and
   * means nothing to the server, and the listing DTO validates with `forbidNonWhitelisted`, so
   * `?focus=true` arriving at the API is a **400**, not an ignored parameter — measured against the
   * running service. TypeScript does not catch it either, because `search` is a variable rather than
   * an object literal and excess properties pass structurally.
   */
  const filters: ProductFilters = {
    category: search.category,
    q: search.q,
    sort: search.sort,
    origin: search.origin,
    grade: search.grade,
    minPrice: search.minPrice,
    maxPrice: search.maxPrice,
    bestsellerOnly: search.bestsellerOnly,
    inStockOnly: search.inStockOnly,
    page: search.page,
  };

  const { data: products, isLoading } = useProducts(filters);
  const { data: categories } = useCategories();

  /**
   * Facet options come from their own endpoint, computed over the whole published catalogue.
   *
   * This used to be a second, unfiltered `useProducts()` — one more full-catalogue fetch on every
   * shop page load, and once lists paginate it would have described the first 24 products and called
   * that the shop's origin list.
   */
  const { data: facets } = useProductFacets();
  const origins = facets?.origins ?? [];
  const grades = facets?.grades ?? [];
  const priceCeiling =
    !facets || facets.maxPrice === 0 ? FALLBACK_CEILING : Math.ceil(facets.maxPrice / 500) * 500;

  const items = products?.items ?? [];
  const total = products?.total ?? 0;

  // The search box keeps its own state and pushes to the URL 300ms after typing stops,
  // so a five-letter query does not leave five entries in the history stack.
  const urlQ = search.q ?? "";
  const [qInput, setQInput] = useState(urlQ);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQInput(urlQ);
  }, [urlQ]);

  useEffect(() => {
    if (qInput === urlQ) return;
    const t = setTimeout(() => setFilter({ q: qInput.trim() === "" ? undefined : qInput }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, urlQ]);

  useEffect(() => {
    if (search.focus) inputRef.current?.focus();
  }, [search.focus]);

  const filterValue: ShopFilterValue = {
    origin: search.origin,
    grade: search.grade,
    minPrice: search.minPrice,
    maxPrice: search.maxPrice,
    bestsellerOnly: search.bestsellerOnly,
    inStockOnly: search.inStockOnly,
  };

  const resetFilters = () =>
    setFilter({
      origin: undefined,
      grade: undefined,
      minPrice: undefined,
      maxPrice: undefined,
      bestsellerOnly: undefined,
      inStockOnly: undefined,
    });

  const activeCategory = search.category ?? "all";
  const activeFilterCount = Object.values(filterValue).filter((v) => v !== undefined).length;

  /**
   * A real `href` for each page link, built by the router rather than by hand.
   *
   * `PaginationLink` renders a bare `<a>`, and an anchor with no `href` is not keyboard reachable.
   * `buildLocation` produces the same URL a `<Link>` would, so the control is focusable, middle
   * clickable and shareable, while the click handler keeps the navigation client-side.
   */
  const hrefForPage = (page: number) =>
    router.buildLocation({
      to: "/shop",
      search: { ...search, page: page === 1 ? undefined : page },
    }).href;

  const filterPanel = (
    <ShopFilters
      origins={origins}
      grades={grades}
      priceCeiling={priceCeiling}
      value={filterValue}
      onChange={setFilter}
      onReset={resetFilters}
    />
  );

  return (
    <div className="container-page py-10">
      <h1 className="font-display text-4xl">Shop dry fruits</h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-sm">
        Graded kernels, honest pricing and pack sizes that match how you actually eat. Buying more
        than 5kg? Switch to bulk for per-kg pricing.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Input
          ref={inputRef}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search almonds, premium kaju, 1kg badam…"
          aria-label="Search products"
          className="max-w-xs"
        />

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="md:hidden">
              <SlidersHorizontal className="mr-2 size-4" />
              Filters
              {activeFilterCount > 0 && ` (${activeFilterCount})`}
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80 overflow-y-auto p-6">
            <SheetHeader className="sr-only">
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="mt-6">{filterPanel}</div>
          </SheetContent>
        </Sheet>

        <Select
          value={search.sort ?? "featured"}
          onValueChange={(v) => setFilter({ sort: v as ProductSort })}
        >
          <SelectTrigger className="w-52" aria-label="Sort products">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* The envelope's `total`, not the page length: the page holds 24 and the shop has 27. */}
        <span className="text-muted-foreground ml-auto text-sm">{total} products</span>
      </div>

      <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
        {[{ slug: "all", name: "All" }, ...(categories ?? [])].map((c) => (
          <button
            key={c.slug}
            onClick={() => setFilter({ category: c.slug === "all" ? undefined : c.slug })}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm whitespace-nowrap transition-colors",
              activeCategory === c.slug
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50",
            )}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="mt-8 gap-10 md:grid md:grid-cols-[220px_1fr]">
        <aside className="hidden md:block">
          <div className="sticky top-24">{filterPanel}</div>
        </aside>

        <div>
          {isLoading ? (
            <ProductGridSkeleton />
          ) : items.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
                {items.map((p) => (
                  <ProductCard key={p.slug} product={p} />
                ))}
              </div>

              <Pager
                page={products?.page ?? 1}
                total={total}
                limit={products?.limit ?? 24}
                hrefForPage={hrefForPage}
                onPageChange={setPage}
              />
            </>
          ) : search.q ? (
            <EmptyState
              title={`No matches for “${search.q}”.`}
              body="Try a broader term like “almonds” or “makhana”."
            />
          ) : (
            <EmptyState
              title="Nothing matches these filters."
              body="Try widening the price range or clearing a filter."
              action={
                <Button variant="outline" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          )}
        </div>
      </div>

      <p className="text-muted-foreground mt-14 text-sm">
        Buying for a shop, bakery or café?{" "}
        <Link to="/bulk-orders" className="font-medium underline underline-offset-4">
          See bulk per-kg pricing
        </Link>
        .
      </p>
    </div>
  );
}
