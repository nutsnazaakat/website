import { useState, type FormEvent } from "react";
import type { AdminCategory } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Notice, Panel, PanelHeader } from "@/components/ui/panel";
import type { CategoryInput } from "@/features/categories/api/categories";

/**
 * Brief §7's category, created and edited by one component.
 *
 * **`isPublished` is a field here and is deliberately not one on the product form.** Spec §6.4
 * gives products a `publish`/`unpublish` endpoint pair and gives categories none, so this checkbox
 * is a category's only route to being published — and `POST /admin/categories/:id/publish` would be
 * inventing surface the spec does not list. The asymmetry is the spec's, not this screen's.
 *
 * There is **no delete control**, on this form or anywhere on the screen, because there is no
 * delete route: §6.4 lists `GET`, `POST` and `PATCH` for this resource and nothing else.
 * `products.category_id` is `ON DELETE RESTRICT`, so a category holding products could not be
 * deleted even if the route existed, and unpublishing is what "take it off the storefront" means.
 */

/** `CreateCategoryDto`'s `SLUG_PATTERN`. Same rule as a product slug, and for the same reason. */
const SLUG_PATTERN = "[a-z0-9]+(-[a-z0-9]+)*";

interface Draft {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
  sortOrder: string;
  isPublished: boolean;
  seoTitle: string;
  seoDescription: string;
  seoOgImage: string;
}

function draftFrom(category: AdminCategory | undefined): Draft {
  if (category === undefined) {
    return {
      slug: "",
      name: "",
      image: "",
      blurb: "",
      description: "",
      sortOrder: "0",
      isPublished: true,
      seoTitle: "",
      seoDescription: "",
      seoOgImage: "",
    };
  }
  return {
    slug: category.slug,
    name: category.name,
    image: category.image,
    blurb: category.blurb,
    description: category.description,
    sortOrder: String(category.sortOrder),
    isPublished: category.isPublished,
    seoTitle: category.seo.title,
    seoDescription: category.seo.description,
    seoOgImage: category.seo.ogImage,
  };
}

export function CategoryForm({
  category,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  category?: AdminCategory;
  pending: boolean;
  error?: string | undefined;
  onSubmit: (input: CategoryInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(category));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      slug: draft.slug.trim(),
      name: draft.name.trim(),
      image: draft.image.trim(),
      blurb: draft.blurb.trim(),
      description: draft.description.trim(),
      sortOrder: Number(draft.sortOrder),
      isPublished: draft.isPublished,
      seo: {
        title: draft.seoTitle.trim(),
        description: draft.seoDescription.trim(),
        ogImage: draft.seoOgImage.trim(),
      },
    });
  }

  const idPrefix = category === undefined ? "new-category" : `category-${category.id}`;

  return (
    <Panel>
      <PanelHeader
        title={category === undefined ? "New category" : `Editing ${category.name}`}
        hint={category === undefined ? "Brief §7" : category.slug}
        action={
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        }
      />
      <form className="flex flex-col gap-3 px-3 py-3" onSubmit={submit}>
        {error !== undefined && (
          <Notice tone="error" title="That could not be saved." body={error} />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor={`${idPrefix}-name`}>
            <Input
              id={`${idPrefix}-name`}
              required
              minLength={2}
              maxLength={120}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label="Slug" htmlFor={`${idPrefix}-slug`}>
            <Input
              id={`${idPrefix}-slug`}
              required
              maxLength={80}
              pattern={SLUG_PATTERN}
              title="Lowercase letters, digits and single hyphens"
              value={draft.slug}
              onChange={(event) => set("slug", event.target.value)}
            />
          </Field>
          <Field label="Tile image URL" htmlFor={`${idPrefix}-image`} className="sm:col-span-2">
            <Input
              id={`${idPrefix}-image`}
              required
              maxLength={500}
              value={draft.image}
              onChange={(event) => set("image", event.target.value)}
            />
          </Field>
          <Field label="Blurb" htmlFor={`${idPrefix}-blurb`} className="sm:col-span-2">
            <Input
              id={`${idPrefix}-blurb`}
              required
              minLength={2}
              maxLength={300}
              placeholder="The short line under the tile"
              value={draft.blurb}
              onChange={(event) => set("blurb", event.target.value)}
            />
          </Field>
          <Field label="Description" htmlFor={`${idPrefix}-description`} className="sm:col-span-2">
            <Textarea
              id={`${idPrefix}-description`}
              required
              minLength={2}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
          <Field label="Display order" htmlFor={`${idPrefix}-sort`}>
            <Input
              id={`${idPrefix}-sort`}
              type="number"
              min={0}
              max={10_000}
              step={1}
              value={draft.sortOrder}
              onChange={(event) => set("sortOrder", event.target.value)}
            />
          </Field>
          <Field label="On the storefront" htmlFor={`${idPrefix}-published`}>
            <Select
              id={`${idPrefix}-published`}
              value={draft.isPublished ? "true" : "false"}
              onChange={(event) => set("isPublished", event.target.value === "true")}
            >
              <option value="true">Published — the tile is shown</option>
              <option value="false">Unpublished — the tile is hidden</option>
            </Select>
          </Field>
          <Field label="SEO title" htmlFor={`${idPrefix}-seo-title`}>
            <Input
              id={`${idPrefix}-seo-title`}
              maxLength={200}
              value={draft.seoTitle}
              onChange={(event) => set("seoTitle", event.target.value)}
            />
          </Field>
          <Field label="SEO image" htmlFor={`${idPrefix}-seo-og`}>
            <Input
              id={`${idPrefix}-seo-og`}
              maxLength={500}
              value={draft.seoOgImage}
              onChange={(event) => set("seoOgImage", event.target.value)}
            />
          </Field>
          <Field
            label="SEO description"
            htmlFor={`${idPrefix}-seo-description`}
            className="sm:col-span-2"
          >
            <Textarea
              id={`${idPrefix}-seo-description`}
              maxLength={400}
              value={draft.seoDescription}
              onChange={(event) => set("seoDescription", event.target.value)}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : category === undefined ? "Create category" : "Save category"}
          </Button>
          <p className="text-muted-foreground text-[11px]">
            {/*
              Said on the form as well as on the screen, because this is the control that does it:
              an operator reaching for "Unpublished" to withdraw a range needs to know here, not
              after the fact, that the products stay on sale.
            */}
            Unpublishing hides the tile. The products inside it stay on the storefront.
          </p>
        </div>
      </form>
    </Panel>
  );
}
