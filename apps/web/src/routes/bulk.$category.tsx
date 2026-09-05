import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { EmptyState } from "@/components/common/EmptyState";
import { Pager } from "@/components/common/Pager";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { settings } from "@/config/settings";
import { BULK_ROW_GRID, BulkProductCard } from "@/features/bulk/components/BulkProductCard";
import { ShopFilters, type ShopFilterValue } from "@/features/catalog/components/ShopFilters";
import { useCategories, useProductFacets, useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { cn } from "@/lib/utils";

/**
 * Every facet lives in the URL, the same contract the retail shop uses, so a filtered
 * bulk view can be pasted into a purchase email and reopened exactly as it was.
 */
const searchSchema = z.object({
  q: z.string().optional(),
  origin: z.string().optional(),
  grade: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  bestsellerOnly: z.boolean().optional(),
  inStockOnly: z.boolean().optional(),
  /** Hides anything whose minimum order quantity exceeds what the buyer can commit to. */
  maxMoq: z.number().optional(),
  sort: z.enum(["featured", "price-asc", "price-desc", "rating", "best-selling"]).optional(),
  /** Absent for the first page, so the link a buyer pastes into an email is the one they were on. */
  page: z.number().int().min(1).optional(),
});

export const Route = createFileRoute("/bulk/$category")({
  validateSearch: searchSchema,
  component: BulkCatalog,
});

type BulkSearch = z.infer<typeof searchSchema>;
type BulkSort = NonNullable<BulkSearch["sort"]>;

const MOQ_CHOICES = [5, 10, 25, 50];

const sortOptions: { value: BulkSort; label: string }[] = [
  { value: "featured", label: "Featured" },
  { value: "price-asc", label: "Rate: Low to High" },
  { value: "price-desc", label: "Rate: High to Low" },
  { value: "best-selling", label: "Most Ordered" },
  { value: "rating", label: "Highest Rated" },
];

const columns = ["Product", "Grade", "MOQ", "Quantity", "Price / kg", "Actions"];

function BulkCatalog() {
  const { category } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [qInput, setQInput] = useState(search.q ?? "");

  /**
   * Any facet change returns to the first page — the same trap the retail shop has. `page` sits in
   * the same search object as the filters, so a bare `{ ...prev, ...patch }` carries it through every
   * change and narrowing the list from page two shows an empty table.
   */
  const setFilter = (patch: Partial<BulkSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true });

  /** Paging keeps every facet and changes only the page. */
  const setPage = (page: number) =>
    navigate({
      search: (prev) => ({ ...prev, page: page === 1 ? undefined : page }),
      replace: true,
    });

  const { data: categories } = useCategories();
  const { data: products, isLoading } = useProducts({
    category,
    q: search.q,
    origin: search.origin,
    grade: search.grade,
    minPrice: search.minPrice,
    maxPrice: search.maxPrice,
    bestsellerOnly: search.bestsellerOnly,
    inStockOnly: search.inStockOnly,
    // MOQ is a server-side filter now. Applied here it filtered whichever page had been fetched,
    // so both the rows and the count described page one rather than the category.
    maxMoq: search.maxMoq,
    sort: search.sort,
    page: search.page,
  });
  // Facets come from their own whole-catalogue endpoint, so narrowing one never empties the others.
  // This used to be a second, unfiltered `useProducts()`, which under pagination would have offered
  // the origins of the first 24 products as though they were the catalogue's.
  const { data: facets } = useProductFacets();
  const origins = facets?.origins ?? [];
  const grades = facets?.grades ?? [];
  const priceCeiling =
    !facets || facets.maxPrice === 0 ? 5000 : Math.ceil(facets.maxPrice / 500) * 500;

  const rows = products?.items ?? [];
  const total = products?.total ?? 0;

  /**
   * A real `href` per page, built by the router. `PaginationLink` renders a bare `<a>`, and an
   * anchor without one is not keyboard reachable.
   */
  const hrefForPage = (page: number) =>
    router.buildLocation({
      to: "/bulk/$category",
      params: { category },
      search: { ...search, page: page === 1 ? undefined : page },
    }).href;

  const activeCategory = categories?.find((c) => c.slug === category);
  const heading = activeCategory ? `Bulk ${activeCategory.name}` : "Bulk dry fruits";

  useSeo({
    title: `${heading} — Per-kg Wholesale Pricing | ${settings.brandName}`,
    description: `Per-kg slab pricing for ${activeCategory?.name.toLowerCase() ?? "every category we stock"}. Set your quantity to see the rate that applies, add to your bulk cart or request a written quote.`,
  });

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
      maxMoq: undefined,
    });

  const activeFilterCount =
    Object.values(filterValue).filter((v) => v !== undefined).length +
    (search.maxMoq === undefined ? 0 : 1);

  const filters = (
    <div className="space-y-7">
      <ShopFilters
        origins={origins}
        grades={grades}
        priceCeiling={priceCeiling}
        value={filterValue}
        onChange={setFilter}
        onReset={resetFilters}
      />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Minimum order quantity</legend>
        <div className="flex flex-wrap gap-2">
          {MOQ_CHOICES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setFilter({ maxMoq: search.maxMoq === m ? undefined : m })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                search.maxMoq === m
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/50",
              )}
            >
              Up to {m} kg
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );

  return (
    <div className="container-page py-10">
      <nav className="text-muted-foreground text-xs">
        <Link to="/bulk-orders" className="hover:text-foreground">
          Bulk Orders
        </Link>{" "}
        / <span className="text-foreground">{activeCategory?.name ?? "All categories"}</span>
      </nav>

      <h1 className="font-display mt-4 text-4xl">{heading}</h1>
      <p className="text-muted-foreground mt-3 max-w-2xl text-sm">
        Set the quantity you need and the applicable slab rate resolves as you type. Rates are
        exclusive of GST. Quantities above the published slabs go through a written quotation.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Input
          value={qInput}
          onChange={(e) => {
            setQInput(e.target.value);
            setFilter({ q: e.target.value.trim() === "" ? undefined : e.target.value });
          }}
          placeholder="Search W320 kaju, mamra badam…"
          aria-label="Search bulk products"
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
            <div className="mt-6">{filters}</div>
          </SheetContent>
        </Sheet>

        <select
          value={search.sort ?? "featured"}
          onChange={(e) =>
            setFilter({ sort: sortOptions.find((s) => s.value === e.target.value)?.value })
          }
          aria-label="Sort bulk products"
          className="border-input bg-background h-10 rounded-md border px-3 text-sm"
        >
          {sortOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* The envelope's `total`, not the row count: the table shows one page of it. */}
        <span className="text-muted-foreground ml-auto text-sm">{total} products</span>
      </div>

      <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
        {[{ slug: "all", name: "All" }, ...(categories ?? [])].map((c) => (
          <Link
            key={c.slug}
            to="/bulk/$category"
            params={{ category: c.slug }}
            // Switching category keeps the facets the buyer already set — but not the page, or a
            // buyer on page two lands on page two of a category that has one.
            search={{ ...search, page: undefined }}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm whitespace-nowrap transition-colors",
              category === c.slug
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50",
            )}
          >
            {c.name}
          </Link>
        ))}
      </div>

      <div className="mt-8 gap-10 md:grid md:grid-cols-[220px_1fr]">
        <aside className="hidden md:block">
          <div className="sticky top-24">{filters}</div>
        </aside>

        <div className="min-w-0">
          {isLoading ? (
            <ProductGridSkeleton count={4} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No bulk lines match these filters."
              body="Try widening the rate range, clearing the MOQ limit or asking us directly."
              action={
                <div className="flex flex-wrap justify-center gap-3">
                  <Button variant="outline" onClick={resetFilters}>
                    Clear filters
                  </Button>
                  <Button asChild>
                    <Link to="/business/rfqs/new">Request a Quote</Link>
                  </Button>
                </div>
              }
            />
          ) : (
            <>
              <div className="border-border overflow-hidden rounded-2xl border">
                <div
                  className={cn(
                    "border-border bg-sand text-muted-foreground hidden border-b px-4 py-3 text-xs font-semibold tracking-wide uppercase",
                    BULK_ROW_GRID,
                  )}
                >
                  {columns.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <ul>
                  {rows.map((p) => (
                    <BulkProductCard key={p.slug} product={p} />
                  ))}
                </ul>
              </div>

              <Pager
                page={products?.page ?? 1}
                total={total}
                limit={products?.limit ?? 24}
                hrefForPage={hrefForPage}
                onPageChange={setPage}
              />
            </>
          )}
        </div>
      </div>

      <p className="text-muted-foreground mt-14 text-sm">
        Need a rate we have not published, custom packing or a standing monthly supply?{" "}
        <Link to="/business/rfqs/new" className="font-medium underline underline-offset-4">
          Raise a quote request
        </Link>
        .
      </p>
    </div>
  );
}
