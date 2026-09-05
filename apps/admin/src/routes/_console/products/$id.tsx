import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminProduct } from "@/contract";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { fetchCategories } from "@/features/categories/api/categories";
import { errorMessage } from "@/features/orders/api/errors";
import {
  deleteProduct,
  fetchProduct,
  publishProduct,
  unpublishProduct,
  updateProduct,
  type ProductInput,
} from "@/features/products/api/products";
import { entityInUse, type DeleteRefusal } from "@/features/products/api/refusals";
import { ProductForm } from "@/features/products/product-form";
import { VariantEditor } from "@/features/products/variant-editor";
import { count, dateTime } from "@/lib/format";

/**
 * `/products/$id` — one product, its packs, and the four writes on it.
 *
 * **The parameter is `$id` and it is a uuid**, unlike `/orders/$orderNumber`. Every handler on
 * `AdminProductsController` carries a `ParseUUIDPipe`, so a slug in this position is a 400 rather
 * than a 404 — the two detail screens name their parameters differently because they really are
 * two different keys.
 *
 * This file sits in `routes/_console/products/` alongside `index.tsx` and `new.tsx`, with **no
 * `products.tsx` beside the directory**. That is the trap the backend repo hit three times: a
 * sibling file becomes the layout route, and without an `<Outlet />` the child resolves
 * successfully and renders nothing at all — no error, no warning.
 */
export const Route = createFileRoute("/_console/products/$id")({
  component: ProductDetailScreen,
});

function ProductDetailScreen() {
  const { id } = Route.useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<DeleteRefusal | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const product = useQuery({
    queryKey: ["product", id],
    queryFn: ({ signal }) => fetchProduct(id, signal),
  });

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => fetchCategories(signal),
  });

  /**
   * Every write on this resource answers with the whole re-read product, so each one replaces the
   * detail cache from its own result rather than refetching. The list's rows and the dashboard's
   * cards may both have moved, and this screen does not know which cached filter combination this
   * product belongs to — so those are invalidated rather than patched.
   */
  function apply(updated: AdminProduct) {
    client.setQueryData(["product", id], updated);
    void client.invalidateQueries({ queryKey: ["products"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  }

  const save = useMutation({
    mutationFn: (input: ProductInput) => updateProduct(id, input),
    onSuccess: (updated) => {
      apply(updated);
      toast.success("Product saved.");
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const publish = useMutation({
    mutationFn: (next: boolean) => (next ? publishProduct(id) : unpublishProduct(id)),
    onSuccess: (updated) => {
      apply(updated);
      toast.success(
        updated.isPublished
          ? "Published. It is on the storefront now."
          : "Withdrawn from the storefront. Carts holding it keep the line, and checkout blocks on it.",
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteProduct(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["products"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      client.removeQueries({ queryKey: ["product", id] });
      toast.success("Product deleted.");
      void navigate({ to: "/products" });
    },
    onError: (error: unknown) => {
      const refused = entityInUse(error);
      if (refused !== null) {
        // The normal case, not a failure. Spec §5a: a referenced row is refused with a named 409
        // so the operator gets an instruction rather than an opaque 500 carrying a constraint name.
        setRefusal(refused);
        setConfirmingDelete(false);
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  if (product.isPending) {
    return (
      <Page title="Product">
        <Loading label="Loading the product" />
      </Page>
    );
  }

  if (product.isError) {
    return (
      <Page title="Product">
        <Panel>
          <Notice
            tone="error"
            title="This product could not be loaded."
            body={errorMessage(product.error)}
            action={
              <Link to="/products" className="text-primary text-[12px] hover:underline">
                Back to products
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const data = product.data;
  const hasActiveVariant = data.variants.some((variant) => variant.isActive);

  return (
    <Page
      title={data.name}
      description={`${data.slug} · updated ${dateTime(data.updatedAt)}`}
      actions={
        <>
          <span
            className={
              data.isPublished
                ? "bg-leaf/15 text-leaf rounded px-1.5 py-0.5 text-[11px] font-medium"
                : "bg-gold/25 text-gold-foreground dark:text-gold rounded px-1.5 py-0.5 text-[11px] font-medium"
            }
          >
            {data.isPublished ? "Published" : "Draft"}
          </span>
          <Link
            to="/products"
            className="text-muted-foreground inline-flex items-center gap-1 text-[12px] hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            Products
          </Link>
        </>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {categories.data === undefined ? (
            <Panel>
              <Loading label="Loading categories" />
            </Panel>
          ) : (
            <ProductForm
              // Keyed on the product, so a navigation between two products rebuilds the draft
              // rather than leaving the previous product's typing in the fields.
              key={data.id}
              categories={categories.data}
              product={data}
              submitLabel="Save changes"
              pending={save.isPending}
              error={save.isError ? errorMessage(save.error) : undefined}
              onSubmit={(input) => save.mutate(input)}
            />
          )}

          <VariantEditor product={data} />
        </div>

        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Storefront" hint={data.isPublished ? "Live" : "Not listed"} />
            <div className="flex flex-col gap-3 px-3 py-3">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                <dt className="text-muted-foreground">First published</dt>
                <dd className="tnum">
                  {/*
                    Stamped on the *first* publish only and never cleared, so an unpublish and
                    republish keeps the record of when the listing first existed.
                  */}
                  {data.publishedAt === null ? "Never" : dateTime(data.publishedAt)}
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="tnum">{dateTime(data.createdAt)}</dd>
                <dt className="text-muted-foreground">Rating</dt>
                <dd className="tnum">
                  {data.reviewCount === 0
                    ? "No reviews"
                    : `${String(data.rating)} from ${count(data.reviewCount)}`}
                </dd>
              </dl>

              {!data.isPublished && !hasActiveVariant && (
                <p className="text-muted-foreground text-[11px]">
                  This product has no pack on sale. Publishing it would put a permanently sold-out
                  listing on the storefront.
                </p>
              )}

              <Button
                variant={data.isPublished ? "outline" : "default"}
                disabled={publish.isPending}
                onClick={() => publish.mutate(!data.isPublished)}
              >
                {publish.isPending
                  ? "Saving…"
                  : data.isPublished
                    ? "Unpublish"
                    : "Publish to the storefront"}
              </Button>
              <p className="text-muted-foreground text-[11px]">
                Unpublishing writes nothing to the carts holding this product: the line stays, it
                becomes unpriceable, and checkout is blocked until it returns. Deleting empties
                them.
              </p>
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="Delete" hint="Permanent" />
            <div className="flex flex-col gap-3 px-3 py-3">
              {refusal !== null ? (
                <Notice
                  tone="error"
                  title="This product cannot be deleted."
                  body={
                    refusal.message +
                    (refusal.orderItems !== undefined
                      ? ` ${count(refusal.orderItems)} order lines reference it.`
                      : refusal.inventoryTransactions !== undefined
                        ? ` ${count(refusal.inventoryTransactions)} stock movements reference it.`
                        : "")
                  }
                  action={
                    data.isPublished ? (
                      <Button
                        variant="outline"
                        disabled={publish.isPending}
                        onClick={() => publish.mutate(false)}
                      >
                        Unpublish instead
                      </Button>
                    ) : (
                      <span className="text-muted-foreground text-[11px]">
                        It is already unpublished, so it is off the storefront already.
                      </span>
                    )
                  }
                />
              ) : confirmingDelete ? (
                <>
                  <p className="text-[12px]">
                    Deleting removes the product, its packs, its images, its pricing tiers and its
                    stock rows — and empties every cart and wishlist holding it. Invoices survive:
                    order lines keep their own snapshot of the name and price.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate()}
                    >
                      {remove.isPending ? "Deleting…" : "Delete permanently"}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                      Keep it
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-muted-foreground text-[11px]">
                    A product that has ever been ordered or stocked cannot be deleted — its history
                    is append-only. Unpublishing is the withdrawal that always works.
                  </p>
                  <Button variant="outline" onClick={() => setConfirmingDelete(true)}>
                    Delete this product
                  </Button>
                </>
              )}
            </div>
          </Panel>

          <Button variant="ghost" onClick={() => void product.refetch()}>
            Reload this product
          </Button>
        </div>
      </div>
    </Page>
  );
}
