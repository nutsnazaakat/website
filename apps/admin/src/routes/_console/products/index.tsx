import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AdminProduct } from "@/contract";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { fetchCategories } from "@/features/categories/api/categories";
import { errorMessage } from "@/features/orders/api/errors";
import { fetchProducts, PRODUCTS_PAGE_SIZE } from "@/features/products/api/products";
import { count, dateTime, inr } from "@/lib/format";

/**
 * `/products` — brief §30's catalogue, **unpublished products included**.
 *
 * That inclusion is the whole point of `GET /admin/products` rather than `GET /catalog/products`:
 * the storefront query pins `product.isPublished = true`, and an admin list built on it would hide
 * every draft from the only screen that can publish one. The **Status** column and the tri-state
 * filter are how the operator tells the two apart.
 *
 * Filters live in the URL, so a filtered view is a link. `validateSearch` narrows every value,
 * because they arrive from the address bar and `AdminProductQueryDto` is validated with
 * `forbidNonWhitelisted` — an unrecognised parameter is a 400 the operator cannot interpret, not an
 * ignored filter.
 */

interface ProductsSearch {
  q?: string;
  category?: string;
  /** Tri-state. **Absent means both**, which is what an admin catalogue is for. */
  published?: boolean;
  page?: number;
}

/**
 * `?published=` as three states rather than two.
 *
 * TanStack parses `?published=true` to a boolean and `?published=` to the empty string, and a
 * hand-edited value can be anything at all — so both spellings are accepted and everything else is
 * dropped rather than forwarded. `@Transform` on the DTO reads the strings `"true"`/`"false"`, which
 * is what `toQueryString` will send; `@Type(() => Boolean)` was measured to turn `"false"` into
 * `true` and the DTO records why it is not used.
 */
function parsePublished(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export const Route = createFileRoute("/_console/products/")({
  validateSearch: (search: Record<string, unknown>): ProductsSearch => {
    const q = search["q"];
    const category = search["category"];
    const published = parsePublished(search["published"]);
    const page = Number(search["page"]);

    return {
      ...(typeof q === "string" && q.trim() !== "" ? { q: q.slice(0, 200) } : {}),
      ...(typeof category === "string" && category !== "" ? { category } : {}),
      ...(published === undefined ? {} : { published }),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: ProductsScreen,
});

/** The lowest and highest pack price on a product, or `null` when it has no packs at all. */
function priceRange(product: AdminProduct): { low: number; high: number } | null {
  if (product.variants.length === 0) return null;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const variant of product.variants) {
    if (variant.price < low) low = variant.price;
    if (variant.price > high) high = variant.price;
  }
  return { low, high };
}

function ProductsScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;

  const products = useQuery({
    queryKey: ["products", search],
    queryFn: ({ signal }) => fetchProducts({ ...search, page, limit: PRODUCTS_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  /**
   * The category filter's options. Twelve rows, cached for the session — `GET /admin/categories` is
   * a bare array with no pagination, so this is one request rather than a per-row lookup.
   */
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => fetchCategories(signal),
  });

  /** Any filter change resets to page 1: page 4 of a different filter is rarely where anyone meant to be. */
  function setFilter(patch: Partial<ProductsSearch>) {
    void navigate({
      search: (previous: ProductsSearch): ProductsSearch => {
        const next: ProductsSearch = { ...previous, ...patch };
        delete next.page;
        // An empty string from a cleared control must become *absent*, not `q=`: `toQueryString`
        // would send the empty value and `@MaxLength` would not save it from being a filter that
        // matches everything by accident.
        if (next.q === undefined || next.q === "") delete next.q;
        if (next.category === undefined || next.category === "") delete next.category;
        if (next.published === undefined) delete next.published;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: ProductsSearch): ProductsSearch => {
        const updated: ProductsSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const isFiltered =
    search.q !== undefined || search.category !== undefined || search.published !== undefined;
  const total = products.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PRODUCTS_PAGE_SIZE));

  return (
    <Page
      title="Products"
      description={
        products.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "product" : "products"}, drafts included`
      }
      actions={
        /*
          A `<Button>` that navigates rather than a `<Link>` wearing button styling. `Button` has
          no `asChild` (there is no `@radix-ui/react-slot` here) and a `<Button>` nested inside a
          `<Link>` is interactive content inside interactive content — invalid markup a screen
          reader announces twice. Exporting `buttonVariants` to style the link instead was tried
          and reverted: it turns `button.tsx` into a file that exports both a component and a
          non-constant, which is the one lint warning this repo has and does not want a second of.
        */
        <Button onClick={() => void navigate({ to: "/products/new" })}>New product</Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Name or slug" htmlFor="filter-q" className="w-56">
            <Input
              // Remounted when the URL's `q` changes, because this input is *uncontrolled* — it
              // holds what was typed rather than what is filtering. Without the key, "Clear
              // filters" would empty the query string and leave the old text sitting in the box,
              // which reads as a filter that failed to clear.
              key={search.q ?? ""}
              id="filter-q"
              maxLength={200}
              placeholder="almond"
              defaultValue={search.q ?? ""}
              // On blur and on Enter rather than on every keystroke: a request per character
              // against a 120/min limit is how an operator rate-limits themselves mid-search.
              onBlur={(event) => setFilter({ q: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ q: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Category" htmlFor="filter-category" className="w-48">
            <Select
              id="filter-category"
              value={search.category ?? ""}
              onChange={(event) => setFilter({ category: event.target.value })}
            >
              <option value="">All categories</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.slug}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Status" htmlFor="filter-published" className="w-40">
            <Select
              id="filter-published"
              value={search.published === undefined ? "" : search.published ? "true" : "false"}
              onChange={(event) => setFilter({ published: parsePublished(event.target.value) })}
            >
              <option value="">Live and drafts</option>
              <option value="true">Published only</option>
              <option value="false">Drafts only</option>
            </Select>
          </Field>

          {isFiltered && (
            <Button
              variant="ghost"
              onClick={() => void navigate({ search: {} })}
              className="mb-0.5"
            >
              Clear filters
            </Button>
          )}
        </Panel>

        <Panel>
          {products.isPending ? (
            <Loading label="Loading products" />
          ) : products.isError ? (
            <Notice
              tone="error"
              title="Products could not be loaded."
              body={errorMessage(products.error)}
              action={
                <Button variant="outline" onClick={() => void products.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : products.data.items.length === 0 ? (
            <Notice
              title={isFiltered ? "No products match these filters." : "The catalogue is empty."}
              body={
                isFiltered
                  ? "Clear the filters to see everything, drafts included."
                  : "Create a product, add its packs, then publish it."
              }
              action={
                isFiltered ? (
                  <Button variant="outline" onClick={() => void navigate({ search: {} })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableWrap>
              <Table caption="Products, drafts included">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Category</Th>
                    <Th numeric>Packs</Th>
                    <Th numeric>Price</Th>
                    <Th>Stock</Th>
                    <Th>Status</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {products.data.items.map((product) => {
                    const range = priceRange(product);
                    const active = product.variants.filter((variant) => variant.isActive).length;
                    return (
                      <Tr key={product.id}>
                        <Td>
                          <Link
                            to="/products/$id"
                            params={{ id: product.id }}
                            className="text-primary font-medium hover:underline"
                          >
                            {product.name}
                          </Link>
                          <span className="text-muted-foreground block max-w-64 truncate text-[11px]">
                            {product.slug}
                          </span>
                        </Td>
                        <Td className="text-muted-foreground">{product.category}</Td>
                        <Td numeric>
                          {count(active)}
                          {active === product.variants.length
                            ? ""
                            : ` of ${count(product.variants.length)}`}
                        </Td>
                        <Td numeric>
                          {range === null ? (
                            <span className="text-muted-foreground">No packs</span>
                          ) : range.low === range.high ? (
                            inr(range.low)
                          ) : (
                            `${inr(range.low)} – ${inr(range.high)}`
                          )}
                        </Td>
                        <Td>
                          {/*
                            `soldOut` is derived server-side over the *active* variants only, so it
                            means the same thing here as on the storefront. Nothing recomputes it.
                          */}
                          {product.soldOut ? (
                            <span className="text-destructive text-[11px] font-medium">
                              Sold out
                            </span>
                          ) : (
                            <span className="text-leaf text-[11px] font-medium">In stock</span>
                          )}
                        </Td>
                        <Td>
                          <span
                            className={
                              product.isPublished
                                ? "bg-leaf/15 text-leaf rounded px-1.5 py-0.5 text-[11px] font-medium"
                                : "bg-gold/25 text-gold-foreground dark:text-gold rounded px-1.5 py-0.5 text-[11px] font-medium"
                            }
                          >
                            {product.isPublished ? "Published" : "Draft"}
                          </span>
                        </Td>
                        <Td className="text-muted-foreground tnum whitespace-nowrap">
                          {dateTime(product.updatedAt)}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {products.data !== undefined && products.data.items.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-muted-foreground tnum text-[11px]">
                Page {count(page)} of {count(lastPage)} · {count(total)} in total
              </p>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}
