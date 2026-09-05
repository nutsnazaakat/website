import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/EmptyState";
import { ProductGridSkeleton } from "@/components/common/ProductGridSkeleton";
import { Button } from "@/components/ui/button";
import { ProductCard } from "@/features/catalog/components/ProductCard";
import { useCategory, useProducts } from "@/features/catalog/hooks/useCatalog";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/category/$slug")({ component: CategoryPage });

function CategoryPage() {
  const { slug } = Route.useParams();
  const { data: category } = useCategory(slug);
  const { data: products, isLoading } = useProducts({ category: slug });

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
    <div className="container-page py-10">
      <nav className="text-muted-foreground text-xs">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>{" "}
        /{" "}
        <Link to="/shop" className="hover:text-foreground">
          Shop
        </Link>{" "}
        / <span className="text-foreground">{category?.name ?? slug}</span>
      </nav>

      <h1 className="font-display mt-6 text-4xl">{category?.name ?? slug}</h1>
      {category?.description && (
        <p className="text-muted-foreground mt-3 max-w-2xl text-sm">{category.description}</p>
      )}

      {isLoading ? (
        <div className="mt-8">
          <ProductGridSkeleton />
        </div>
      ) : products && products.total > 0 ? (
        <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
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
  );
}
