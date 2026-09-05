import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { fetchCategories } from "@/features/categories/api/categories";
import { errorMessage } from "@/features/orders/api/errors";
import { createProduct, type ProductInput } from "@/features/products/api/products";
import { ProductForm } from "@/features/products/product-form";

/**
 * `/products/new`.
 *
 * A **static sibling of `$id`, and it wins the match** — TanStack ranks a literal segment above a
 * dynamic one, so `/products/new` never reaches `$id` and is never sent to the API as a product
 * uuid. Both live in `routes/_console/products/` with `index.tsx`, and there is deliberately no
 * `products.tsx` beside that directory: a sibling file becomes the layout route, and without an
 * `<Outlet />` every child here would resolve successfully and paint nothing.
 *
 * The screen cannot render until the categories are loaded, because `categoryId` is required and
 * is a uuid nobody types. That is a real dependency rather than a convenience: a form submitted
 * with an empty category is a 400.
 */
export const Route = createFileRoute("/_console/products/new")({
  component: NewProductScreen,
});

function NewProductScreen() {
  const navigate = useNavigate();
  const client = useQueryClient();

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => fetchCategories(signal),
  });

  const create = useMutation({
    mutationFn: (input: ProductInput) => createProduct(input),
    onSuccess: (product) => {
      void client.invalidateQueries({ queryKey: ["products"] });
      client.setQueryData(["product", product.id], product);
      toast.success(`${product.name} created as a draft.`);
      // Straight to the detail, because the product is not sellable yet: it has no packs, and
      // publishing a product with no active variant puts a permanently sold-out listing on the
      // storefront.
      void navigate({ to: "/products/$id", params: { id: product.id } });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  return (
    <Page
      title="New product"
      description="Created as a draft. Add its packs, then publish."
      actions={
        <Link
          to="/products"
          className="text-muted-foreground inline-flex items-center gap-1 text-[12px] hover:underline"
        >
          <ArrowLeft className="size-3.5" />
          Products
        </Link>
      }
    >
      {categories.isPending ? (
        <Loading label="Loading categories" />
      ) : categories.isError ? (
        <Panel>
          <Notice
            tone="error"
            title="Categories could not be loaded."
            body={`${errorMessage(categories.error)} A product needs a category, so the form cannot be filled in until this succeeds.`}
          />
        </Panel>
      ) : categories.data.length === 0 ? (
        <Panel>
          <Notice
            title="There are no categories yet."
            body="Every product belongs to one, so create a category first."
            action={
              <Link to="/categories" className="text-primary text-[12px] hover:underline">
                Go to categories
              </Link>
            }
          />
        </Panel>
      ) : (
        <ProductForm
          categories={categories.data}
          submitLabel="Create product"
          pending={create.isPending}
          error={create.isError ? errorMessage(create.error) : undefined}
          onSubmit={(input) => create.mutate(input)}
        />
      )}
    </Page>
  );
}
