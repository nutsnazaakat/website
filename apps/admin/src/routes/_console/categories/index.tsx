import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { AdminCategory } from "@/contract";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  createCategory,
  fetchCategories,
  updateCategory,
  type CategoryInput,
} from "@/features/categories/api/categories";
import { CategoryForm } from "@/features/categories/category-form";
import { errorMessage } from "@/features/orders/api/errors";
import { count } from "@/lib/format";

/**
 * `/categories` — brief §7's twelve categories, list and edit.
 *
 * **There is no delete control and none should be added.** Spec §6.4 lists `GET`, `POST` and
 * `PATCH` for this resource and nothing else; `products.category_id` is `ON DELETE RESTRICT`, so a
 * category holding products could not be deleted even if the route existed. The screen says so
 * rather than rendering a button that could only 404.
 *
 * **Unpublishing hides the tile, not the products**, and the screen says that out loud in three
 * places. Spec §5b records the user's decision and a backend test pins it: `CatalogService.baseQuery`
 * filters `product.isPublished` and never `category.isPublished`, so it is a navigation decision,
 * not a bulk withdrawal. An operator who unpublishes "Gifting" expecting the range to come off sale
 * and finds every product still buyable through search has been misled by a screen that stayed
 * quiet.
 *
 * `?edit=` carries which row is open, so a half-finished edit survives a reload and a colleague can
 * be sent the link. `new` is the one non-uuid value it takes.
 */

interface CategoriesSearch {
  /** A category id, or the literal `new`. */
  edit?: string;
}

const NEW = "new";

export const Route = createFileRoute("/_console/categories/")({
  validateSearch: (search: Record<string, unknown>): CategoriesSearch => {
    const edit = search["edit"];
    // Narrowed rather than trusted: it comes from the address bar. An id that matches no row falls
    // through to "nothing open" below rather than rendering a form against `undefined`.
    return typeof edit === "string" && edit !== "" ? { edit: edit.slice(0, 80) } : {};
  },
  component: CategoriesScreen,
});

function CategoriesScreen() {
  const { edit } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const client = useQueryClient();

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => fetchCategories(signal),
  });

  function open(target: string | null) {
    void navigate({
      search: (): CategoriesSearch => (target === null ? {} : { edit: target }),
    });
  }

  /**
   * Both writes answer with the whole category, so the cached array is rebuilt from the result
   * rather than refetched. The product screens read this same key for their category picker, which
   * is why it is one key and not two.
   */
  function applied(saved: AdminCategory, created: boolean) {
    client.setQueryData<AdminCategory[]>(["categories"], (previous) => {
      const rows = previous ?? [];
      const next = created
        ? [...rows, saved]
        : rows.map((row) => (row.id === saved.id ? saved : row));
      return [...next].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    });
    // A renamed or unpublished category changes what the product list's Category column reads.
    void client.invalidateQueries({ queryKey: ["products"] });
    open(null);
  }

  const create = useMutation({
    mutationFn: (input: CategoryInput) => createCategory(input),
    onSuccess: (saved) => {
      applied(saved, true);
      toast.success(`${saved.name} created.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const save = useMutation({
    mutationFn: (variables: { id: string; input: CategoryInput }) =>
      updateCategory(variables.id, variables.input),
    onSuccess: (saved) => {
      applied(saved, false);
      toast.success(`${saved.name} saved.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const rows = categories.data ?? [];
  const editing = edit === NEW ? undefined : rows.find((row) => row.id === edit);
  const isCreating = edit === NEW;

  return (
    <Page
      title="Categories"
      description={
        categories.data === undefined
          ? "Loading…"
          : `${count(rows.length)} ${rows.length === 1 ? "category" : "categories"}, unpublished included`
      }
      actions={
        <Button onClick={() => open(isCreating ? null : NEW)}>
          {isCreating ? "Cancel" : "New category"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel>
          <Notice
            title="Unpublishing a category hides its tile, not its products."
            body="The storefront filters products by their own published flag and never by their category's, so a range taken off the menu is still reachable from search, the shop grid and its own URL. To withdraw the goods, unpublish the products."
          />
        </Panel>

        {isCreating && (
          <CategoryForm
            pending={create.isPending}
            error={create.isError ? errorMessage(create.error) : undefined}
            onSubmit={(input) => create.mutate(input)}
            onCancel={() => open(null)}
          />
        )}

        {editing !== undefined && (
          <CategoryForm
            // Keyed on the row, so switching between two categories rebuilds the draft rather than
            // leaving the previous one's typing in the fields.
            key={editing.id}
            category={editing}
            pending={save.isPending}
            error={save.isError ? errorMessage(save.error) : undefined}
            onSubmit={(input) => save.mutate({ id: editing.id, input })}
            onCancel={() => open(null)}
          />
        )}

        <Panel>
          <PanelHeader title="Catalogue navigation" hint="Display order" />
          {categories.isPending ? (
            <Loading label="Loading categories" />
          ) : categories.isError ? (
            <Notice
              tone="error"
              title="Categories could not be loaded."
              body={errorMessage(categories.error)}
              action={
                <Button variant="outline" onClick={() => void categories.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title="There are no categories yet."
              body="Every product belongs to one, so this is the first thing to fill in."
            />
          ) : (
            <TableWrap>
              <Table caption="Categories, in display order">
                <thead>
                  <tr>
                    <Th numeric>Order</Th>
                    <Th>Category</Th>
                    <Th>Blurb</Th>
                    <Th>Storefront</Th>
                    <Th>{""}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((category) => (
                    <Tr key={category.id}>
                      <Td numeric>{count(category.sortOrder)}</Td>
                      <Td>
                        <span className="font-medium">{category.name}</span>
                        <span className="text-muted-foreground block text-[11px]">
                          {category.slug}
                        </span>
                      </Td>
                      <Td className="text-muted-foreground max-w-80 truncate">{category.blurb}</Td>
                      <Td>
                        <span
                          className={
                            category.isPublished
                              ? "bg-leaf/15 text-leaf rounded px-1.5 py-0.5 text-[11px] font-medium"
                              : "bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] font-medium"
                          }
                        >
                          {category.isPublished ? "Tile shown" : "Tile hidden"}
                        </span>
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={
                            edit === category.id
                              ? `Close ${category.name}`
                              : `Edit ${category.name}`
                          }
                          onClick={() => open(edit === category.id ? null : category.id)}
                        >
                          {edit === category.id ? "Close" : "Edit"}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            A category cannot be deleted — there is no such route, and the products that reference
            one are held by a foreign key that refuses it. Hiding the tile is the withdrawal that
            exists.
          </p>
        </Panel>
      </div>
    </Page>
  );
}
