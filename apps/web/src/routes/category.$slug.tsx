import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useCategories, useCategory, useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/category/$slug")({ component: CategoryPage });

function CategoryPage() {
  const { slug } = Route.useParams();
  const { data: category } = useCategory(slug);
  const { data: products, isLoading } = useProducts({ category: slug });
  const { data: categories } = useCategories();

  useSeo({
    title: `${category?.name ?? "Category"} — Buy Online | Nuts & Nazaakat`,
    description: category?.description ?? "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "/" },
        { "@type": "ListItem", position: 2, name: "Shop", item: "/shop" },
        { "@type": "ListItem", position: 3, name: category?.name ?? slug },
      ],
    },
  });

  return (
    <div className="container-page py-9 pb-[72px]">
      <nav className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
        <Link to="/">Home</Link>
        {" / "}
        <Link to="/shop">Shop</Link>
        {" / "}
        <span className="text-foreground">{category?.name ?? slug}</span>
      </nav>

      <div className="border-border mt-5 border-b pb-6">
        <h1 className="page-h1">{category?.name ?? slug}</h1>
        {category && (
          <p className="text-body mt-3 max-w-[560px] text-[15px]">
            {category.blurb}. Retail packs from 100 g, or per-kg bulk pricing above that.
          </p>
        )}
      </div>

      <div className="mt-8 grid items-start gap-9 max-md:grid-cols-1 md:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="md:sticky md:top-24">
          <p className="border-foreground mb-3 border-b-[1.5px] pb-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
            Category
          </p>
          <ul>
            <li>
              <Link
                to="/shop"
                className="flex w-full items-center justify-between py-2 text-[13px]"
              >
                All products
              </Link>
            </li>
            {(categories ?? []).map((c) => (
              <li key={c.slug}>
                <Link
                  to="/category/$slug"
                  params={{ slug: c.slug }}
                  className={cn(
                    "flex w-full items-center justify-between py-2 text-[13px]",
                    c.slug === slug && "text-gold font-bold",
                  )}
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-border bg-sand mt-6 border p-[18px]">
            <p className="text-[13px] font-bold">Need more than a kilo?</p>
            <p className="text-muted-foreground mt-1.5 text-[12px] leading-[1.5]">
              Per-kg slab pricing starts at 1 kg with GST invoicing.
            </p>
            <Link to="/bulk-orders" className="section-link mt-3 inline-block hover:text-foreground">
              Bulk pricing
            </Link>
          </div>
        </aside>

        <div>
          {isLoading ? (
            <ProductGridSkeleton />
          ) : products && products.total > 0 ? (
            <div className="grid gap-[18px] [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
              {products.items.map((p) => (
                <ProductCard key={p.slug} product={p} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="Nothing here yet."
              body="This category has no products in stock right now."
              action={
                <Button asChild>
                  <Link to="/shop">Browse all products</Link>
                </Button>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
