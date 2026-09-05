import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Search, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { useSearchDialog } from "../SearchProvider";
import { useCategories, useProducts } from "../hooks/useCatalog";

/** Brief §22 lists these five verbatim as the example popular searches. */
const POPULAR_SEARCHES = ["almonds", "premium kaju", "1kg badam", "bulk cashew", "makhana"];

const DEBOUNCE_MS = 200;
const MAX_PRODUCTS = 6;
const MAX_CATEGORIES = 4;

/**
 * Brief §22 — instant search over products, categories and popular searches.
 *
 * Composed from the `command.tsx` primitives inside a plain `Dialog` rather than using
 * `CommandDialog`, because that wrapper has no accessible title and Radix requires one.
 *
 * `shouldFilter` is off: matching happens in the catalogue API seam, which is where it
 * will happen for real in Phase 2. Letting cmdk also filter the results would apply a
 * second, different rule on top of the first.
 */
export function SearchDialog() {
  const { open, setOpen } = useSearchDialog();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // Brief §22 wants results as you type; 200ms is short enough to feel instant and long
  // enough that a typed word is one query rather than six.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Reset between openings so a stale query never greets the next search.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);

  // `limit: 8` because the dialog shows at most a handful: without it every keystroke pulled a
  // full page of 24 products to render eight of them.
  const { data: page } = useProducts(debounced === "" ? { limit: 8 } : { q: debounced, limit: 8 });
  const products = page?.items ?? [];
  const { data: categories = [] } = useCategories();

  const term = debounced.toLowerCase();
  const searching = term !== "";

  const productHits = (
    searching ? products : products.filter((p) => p.badge === "BESTSELLER")
  ).slice(0, MAX_PRODUCTS);

  const categoryHits = (
    searching
      ? categories.filter((c) => `${c.name} ${c.blurb}`.toLowerCase().includes(term))
      : categories
  ).slice(0, MAX_CATEGORIES);

  const noResults = searching && productHits.length === 0 && categoryHits.length === 0;

  const go = (to: () => Promise<void> | void) => {
    setOpen(false);
    void to();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search products and categories</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search the catalogue. Results update as you type.
        </DialogDescription>

        <Command shouldFilter={false} className="rounded-none">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search almonds, kaju, makhana…"
          />

          <CommandList className="max-h-[60vh]">
            {noResults ? (
              <div role="status" className="px-4 py-10 text-center">
                <p className="font-display text-xl">No results for “{debounced}”</p>
                <p className="text-muted-foreground mx-auto mt-2 max-w-xs text-sm">
                  Try a shorter word, or browse the full catalogue — we may list it under a
                  different name.
                </p>
                <button
                  type="button"
                  onClick={() => go(() => navigate({ to: "/shop", search: {} }))}
                  className="mt-4 text-sm underline underline-offset-4"
                >
                  Browse all products
                </button>
              </div>
            ) : (
              <>
                {productHits.length > 0 && (
                  <CommandGroup heading={searching ? "Products" : "Popular products"}>
                    {productHits.map((p) => {
                      const variant = p.variants.find((v) => v.size === "250g") ?? p.variants[0]!;
                      return (
                        <CommandItem
                          key={p.slug}
                          value={p.slug}
                          onSelect={() =>
                            go(() => navigate({ to: "/product/$slug", params: { slug: p.slug } }))
                          }
                          className="cursor-pointer gap-3"
                        >
                          {/* Decorative: the product name sits immediately beside it,
                              so an alt would only duplicate the option's own label. */}
                          <img
                            src={p.images[0]}
                            alt=""
                            width={40}
                            height={40}
                            className="bg-sand size-10 shrink-0 rounded-md object-cover"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {p.grade} · {p.origin}
                            </span>
                          </span>
                          <span className="shrink-0 text-sm font-semibold">
                            {inr(variant.price)}
                            <span className="text-muted-foreground ml-1 font-normal">
                              /{variant.size}
                            </span>
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {categoryHits.length > 0 && (
                  <CommandGroup heading="Categories">
                    {categoryHits.map((c) => (
                      <CommandItem
                        key={c.slug}
                        value={`category-${c.slug}`}
                        onSelect={() =>
                          go(() => navigate({ to: "/category/$slug", params: { slug: c.slug } }))
                        }
                        className="cursor-pointer gap-3"
                      >
                        <Search className="text-muted-foreground size-4" aria-hidden="true" />
                        <span className="flex-1 truncate">{c.name}</span>
                        <span className="text-muted-foreground truncate text-xs">{c.blurb}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {!searching && (
                  <CommandGroup heading="Popular searches">
                    {POPULAR_SEARCHES.map((s) => (
                      <CommandItem
                        key={s}
                        value={`popular-${s}`}
                        onSelect={() => setQuery(s)}
                        className="cursor-pointer gap-3"
                      >
                        <TrendingUp className="text-muted-foreground size-4" aria-hidden="true" />
                        {s}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {searching && (
                  <CommandGroup>
                    <CommandItem
                      value="see-all"
                      onSelect={() => go(() => navigate({ to: "/shop", search: { q: debounced } }))}
                      className="cursor-pointer gap-3"
                    >
                      <ArrowRight className="size-4" aria-hidden="true" />
                      See all results for “{debounced}”
                    </CommandItem>
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
