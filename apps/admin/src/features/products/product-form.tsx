import { useState, type FormEvent } from "react";
import type { AdminCategory, AdminProduct, Badge } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Notice, Panel, PanelHeader } from "@/components/ui/panel";
import type { ProductInput } from "@/features/products/api/products";

/**
 * Brief §30's product form, used unchanged by `/products/new` and `/products/$id`.
 *
 * One component rather than two, because a create form and an edit form that drift apart is how a
 * field ends up settable only on one of them. The only difference between the two callers is the
 * initial values and the button's wording.
 *
 * **Brief §30 lists "SKU" among the product fields and there is no input for it here.** That is
 * settled rather than skipped: spec §5b records the user's confirmation that SKU stays
 * variant-level only — there is no `products.sku` column, `uq_product_variants_sku` is where the
 * uniqueness lives, and `OrderItem` and the stock ledger both address a variant. §30's own next
 * sentence ("Variants: weight, SKU, price, MRP…") puts it there too. The variant editor on the
 * detail screen is what answers it.
 *
 * **`isPublished` is not a field either.** A product is always created unpublished and moves
 * through `POST /admin/products/:id/publish`, which is what keeps a `product.publish` audit row
 * behind every live listing. Rendering a checkbox that the PATCH would reject under
 * `forbidNonWhitelisted` would be offering a control that can only fail.
 */

/** `CreateProductDto`'s `SLUG_PATTERN`, the same rule the category form applies. A slug is a URL. */
const SLUG_PATTERN = "[a-z0-9]+(-[a-z0-9]+)*";

const BADGES: readonly Badge[] = ["BESTSELLER", "NEW", "PREMIUM"];

/**
 * The form's own state: every field a string, because that is what an `<input>` holds.
 *
 * Numbers are parsed at submit rather than stored as numbers, so a half-typed `1.` does not
 * round-trip through `NaN` and blank the field under the operator's cursor.
 */
interface Draft {
  name: string;
  slug: string;
  categoryId: string;
  subtitle: string;
  description: string;
  origin: string;
  grade: string;
  processing: string;
  shelfLife: string;
  storage: string;
  ingredients: string;
  hsn: string;
  gstRate: string;
  moqKg: string;
  quoteOnly: boolean;
  badge: string;
  seoTitle: string;
  seoDescription: string;
  seoOgImage: string;
}

function draftFrom(product: AdminProduct | undefined, fallbackCategoryId: string): Draft {
  if (product === undefined) {
    return {
      name: "",
      slug: "",
      categoryId: fallbackCategoryId,
      subtitle: "",
      description: "",
      origin: "",
      grade: "",
      processing: "",
      shelfLife: "",
      storage: "",
      ingredients: "",
      hsn: "",
      gstRate: "5",
      moqKg: "",
      quoteOnly: false,
      badge: "",
      seoTitle: "",
      seoDescription: "",
      seoOgImage: "",
    };
  }
  return {
    name: product.name,
    slug: product.slug,
    categoryId: product.categoryId,
    subtitle: product.subtitle,
    description: product.description,
    origin: product.origin,
    grade: product.grade,
    processing: product.processing,
    shelfLife: product.shelfLife,
    storage: product.storage,
    ingredients: product.ingredients,
    hsn: product.hsn,
    gstRate: String(product.gstRate),
    moqKg: String(product.moqKg),
    quoteOnly: product.quoteOnly === true,
    badge: product.badge ?? "",
    seoTitle: product.seo.title,
    seoDescription: product.seo.description,
    seoOgImage: product.seo.ogImage,
  };
}

/** A `ReadonlySet<string>` rather than a cast on `BADGES`, matching `statuses.ts`: the annotation
 * does the widening that an assertion would otherwise have to claim. */
const BADGE_LOOKUP: ReadonlySet<string> = new Set<string>(BADGES);

function isBadge(value: string): value is Badge {
  return BADGE_LOOKUP.has(value);
}

export function ProductForm({
  categories,
  product,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  categories: readonly AdminCategory[];
  product?: AdminProduct;
  submitLabel: string;
  pending: boolean;
  error?: string | undefined;
  onSubmit: (input: ProductInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(product, categories[0]?.id ?? ""));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      categoryId: draft.categoryId,
      subtitle: draft.subtitle.trim(),
      description: draft.description.trim(),
      origin: draft.origin.trim(),
      grade: draft.grade.trim(),
      processing: draft.processing.trim(),
      shelfLife: draft.shelfLife.trim(),
      storage: draft.storage.trim(),
      ingredients: draft.ingredients.trim(),
      hsn: draft.hsn.trim(),
      gstRate: Number(draft.gstRate),
      // Omitted rather than sent as 0: the column has its own default and an empty box means
      // "leave it to the server", not "this product has no bulk minimum".
      ...(draft.moqKg.trim() === "" ? {} : { moqKg: Number(draft.moqKg) }),
      quoteOnly: draft.quoteOnly,
      ...(isBadge(draft.badge) ? { badge: draft.badge } : {}),
      seo: {
        title: draft.seoTitle.trim(),
        description: draft.seoDescription.trim(),
        ogImage: draft.seoOgImage.trim(),
      },
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {error !== undefined && (
        <Panel>
          <Notice tone="error" title="That could not be saved." body={error} />
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Identity" hint="Brief §30" />
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="product-name">
            <Input
              id="product-name"
              required
              minLength={2}
              maxLength={200}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label="Slug" htmlFor="product-slug">
            <Input
              id="product-slug"
              required
              maxLength={120}
              // The server's own rule, applied here so a bad slug is caught before a round trip.
              // It is still the server's decision: this is a convenience, not the check.
              pattern={SLUG_PATTERN}
              title="Lowercase letters, digits and single hyphens"
              value={draft.slug}
              onChange={(event) => set("slug", event.target.value)}
            />
          </Field>
          <Field label="Category" htmlFor="product-category">
            <Select
              id="product-category"
              required
              value={draft.categoryId}
              onChange={(event) => set("categoryId", event.target.value)}
            >
              <option value="">Choose a category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.isPublished ? "" : " (unpublished)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Badge (optional)" htmlFor="product-badge">
            <Select
              id="product-badge"
              value={draft.badge}
              onChange={(event) => set("badge", event.target.value)}
            >
              <option value="">No badge</option>
              {BADGES.map((badge) => (
                <option key={badge} value={badge}>
                  {badge}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subtitle" htmlFor="product-subtitle" className="sm:col-span-2">
            <Input
              id="product-subtitle"
              required
              minLength={2}
              maxLength={300}
              value={draft.subtitle}
              onChange={(event) => set("subtitle", event.target.value)}
            />
          </Field>
          <Field label="Description" htmlFor="product-description" className="sm:col-span-2">
            <Textarea
              id="product-description"
              required
              minLength={2}
              rows={4}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Provenance and handling" />
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
          <Field label="Origin" htmlFor="product-origin">
            <Input
              id="product-origin"
              required
              minLength={2}
              maxLength={120}
              value={draft.origin}
              onChange={(event) => set("origin", event.target.value)}
            />
          </Field>
          <Field label="Grade" htmlFor="product-grade">
            <Input
              id="product-grade"
              required
              maxLength={80}
              value={draft.grade}
              onChange={(event) => set("grade", event.target.value)}
            />
          </Field>
          <Field label="Processing" htmlFor="product-processing">
            <Input
              id="product-processing"
              required
              minLength={2}
              maxLength={200}
              value={draft.processing}
              onChange={(event) => set("processing", event.target.value)}
            />
          </Field>
          <Field label="Shelf life" htmlFor="product-shelf-life">
            <Input
              id="product-shelf-life"
              required
              minLength={2}
              maxLength={120}
              value={draft.shelfLife}
              onChange={(event) => set("shelfLife", event.target.value)}
            />
          </Field>
          <Field label="Storage" htmlFor="product-storage" className="sm:col-span-2">
            <Input
              id="product-storage"
              required
              minLength={2}
              maxLength={300}
              value={draft.storage}
              onChange={(event) => set("storage", event.target.value)}
            />
          </Field>
          <Field label="Ingredients" htmlFor="product-ingredients" className="sm:col-span-2">
            <Input
              id="product-ingredients"
              required
              minLength={2}
              maxLength={300}
              value={draft.ingredients}
              onChange={(event) => set("ingredients", event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Tax and bulk" hint="Snapshotted onto every invoice" />
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-3">
          <Field label="HSN code" htmlFor="product-hsn">
            <Input
              id="product-hsn"
              required
              minLength={4}
              maxLength={12}
              value={draft.hsn}
              onChange={(event) => set("hsn", event.target.value)}
            />
          </Field>
          <Field label="GST rate (%)" htmlFor="product-gst">
            <Input
              id="product-gst"
              required
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={draft.gstRate}
              onChange={(event) => set("gstRate", event.target.value)}
            />
          </Field>
          <Field label="Bulk minimum (kg)" htmlFor="product-moq-kg">
            <Input
              id="product-moq-kg"
              type="number"
              min={0}
              step={0.01}
              placeholder="Leave blank for the default"
              value={draft.moqKg}
              onChange={(event) => set("moqKg", event.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-[12px] sm:col-span-3">
            <input
              type="checkbox"
              checked={draft.quoteOnly}
              onChange={(event) => set("quoteOnly", event.target.checked)}
            />
            Quote required — brief §47. Checked before any pricing tier, so it wins over a priced
            slab and routes every bulk enquiry to the RFQ form.
          </label>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="SEO" hint="Brief §39" />
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
          <Field label="Title" htmlFor="product-seo-title">
            <Input
              id="product-seo-title"
              maxLength={200}
              value={draft.seoTitle}
              onChange={(event) => set("seoTitle", event.target.value)}
            />
          </Field>
          <Field label="Open Graph image" htmlFor="product-seo-og">
            <Input
              id="product-seo-og"
              maxLength={500}
              value={draft.seoOgImage}
              onChange={(event) => set("seoOgImage", event.target.value)}
            />
          </Field>
          <Field
            label="Meta description"
            htmlFor="product-seo-description"
            className="sm:col-span-2"
          >
            <Textarea
              id="product-seo-description"
              maxLength={400}
              value={draft.seoDescription}
              onChange={(event) => set("seoDescription", event.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        {product === undefined && (
          <p className="text-muted-foreground text-[11px]">
            A new product is always created unpublished, and has no packs until you add one.
          </p>
        )}
      </div>
    </form>
  );
}
