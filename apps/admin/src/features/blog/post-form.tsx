import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminBlogPost, BlogCategory } from "@/contract";
import { BLOG_CATEGORIES } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { createPost, updatePost, type PostInput } from "@/features/blog/api/posts";
import { errorMessage } from "@/features/orders/api/errors";

/**
 * The post editor — brief §28's categories and §39's SEO fields.
 *
 * **The slug warning is the reason this form has a confirmation step at all.** Changing the slug of
 * a *published* post changes its public URL, and there is no redirect table anywhere in this
 * system: the old address stops resolving and starts answering 404 — for every link already shared,
 * every search result already indexed, and every page that links to it. That is not recoverable by
 * changing the slug back either, because the index has by then followed the new one.
 *
 * So the save is interrupted once, with the two URLs printed side by side. Not a `window.confirm`:
 * it has to *show* the old address next to the new one, and a browser dialog cannot. Once
 * acknowledged it saves, because the operator may well have a good reason — a typo in a slug
 * published an hour ago is worth fixing.
 *
 * A draft's slug changes freely and silently. Nothing has ever linked to it.
 */

interface FormState {
  slug: string;
  title: string;
  category: BlogCategory;
  excerpt: string;
  image: string;
  author: string;
  body: string;
  isPublished: boolean;
  seoTitle: string;
  seoDescription: string;
  seoOgImage: string;
}

/**
 * The category a new post starts in.
 *
 * Spelled out rather than `BLOG_CATEGORIES[0]`, for two reasons: `noUncheckedIndexedAccess` makes
 * the index access `BlogCategory | undefined`, and a literal annotated with the union stops
 * compiling if that category is ever renamed — which an index would not.
 */
const FIRST_CATEGORY: BlogCategory = "Dry Fruit Guides";

function blankForm(): FormState {
  return {
    slug: "",
    title: "",
    category: FIRST_CATEGORY,
    excerpt: "",
    image: "",
    author: "Nuts & Nazaakat",
    body: "",
    isPublished: false,
    seoTitle: "",
    seoDescription: "",
    seoOgImage: "",
  };
}

function formFrom(post: AdminBlogPost): FormState {
  return {
    slug: post.slug,
    title: post.title,
    // The wire carries `category` as a plain string; the tuple is the authority on which are real.
    category: BLOG_CATEGORIES.find((candidate) => candidate === post.category) ?? FIRST_CATEGORY,
    excerpt: post.excerpt,
    image: post.image,
    author: post.author,
    body: post.body,
    isPublished: post.isPublished,
    seoTitle: post.seo.title,
    seoDescription: post.seo.description,
    seoOgImage: post.seo.ogImage,
  };
}

export function PostForm({
  post,
  onDone,
}: {
  /** `null` creates. Anything else edits that post. */
  post: AdminBlogPost | null;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState<FormState>(post === null ? blankForm() : formFrom(post));
  const [slugWarned, setSlugWarned] = useState(false);

  const mutation = useMutation({
    mutationFn: (input: PostInput) =>
      post === null ? createPost(input) : updatePost(post.slug, input),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ["posts"] });
      toast.success(post === null ? `“${saved.title}” created.` : `“${saved.title}” saved.`);
      onDone();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  /** A live post whose address is about to change. A draft's slug is nobody's link. */
  const slugChangingOnLivePost =
    post !== null && post.isPublished && form.slug.trim() !== post.slug;

  /** One place the payload is built, so the warning's "save anyway" cannot drift from the form's own save. */
  function payload(): PostInput {
    return {
      slug: form.slug.trim(),
      title: form.title.trim(),
      category: form.category,
      excerpt: form.excerpt.trim(),
      image: form.image.trim(),
      author: form.author.trim(),
      body: form.body,
      isPublished: form.isPublished,
      seo: {
        title: form.seoTitle.trim(),
        description: form.seoDescription.trim(),
        ogImage: form.seoOgImage.trim(),
      },
    };
  }

  function submit() {
    if (slugChangingOnLivePost && !slugWarned) {
      setSlugWarned(true);
      return;
    }
    mutation.mutate(payload());
  }

  return (
    <Panel>
      <PanelHeader
        title={post === null ? "New post" : `Edit “${post.title}”`}
        hint={post === null ? "Brief §28" : post.isPublished ? "Published" : "Draft"}
        action={
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        }
      />

      {slugChangingOnLivePost && slugWarned && (
        <div className="border-border border-b">
          <Notice
            tone="error"
            title="This changes a live URL, and the old one will 404."
            body={`/blog/${post.slug} stops resolving the moment this saves, and /blog/${form.slug.trim()} takes over. There is no redirect table in this system, so every link already shared and every search result already indexed will break. Change the slug back if that is not what you meant.`}
            action={
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(payload())}
                >
                  {mutation.isPending ? "Saving…" : "Save anyway, and break the old URL"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    set("slug", post.slug);
                    setSlugWarned(false);
                  }}
                >
                  Keep {post.slug}
                </Button>
              </div>
            }
          />
        </div>
      )}

      <form
        className="flex flex-col gap-3 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" htmlFor="post-title">
            <Input
              id="post-title"
              required
              maxLength={250}
              value={form.title}
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>

          <Field label="Slug" htmlFor="post-slug">
            <Input
              id="post-slug"
              required
              maxLength={160}
              placeholder="how-to-store-dry-fruits-at-home"
              value={form.slug}
              onChange={(event) => {
                set("slug", event.target.value);
                setSlugWarned(false);
              }}
            />
          </Field>

          <Field label="Category" htmlFor="post-category">
            <Select
              id="post-category"
              value={form.category}
              onChange={(event) => {
                const next = BLOG_CATEGORIES.find((candidate) => candidate === event.target.value);
                if (next !== undefined) set("category", next);
              }}
            >
              {BLOG_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Author" htmlFor="post-author">
            <Input
              id="post-author"
              required
              maxLength={120}
              value={form.author}
              onChange={(event) => set("author", event.target.value)}
            />
          </Field>

          <Field label="Hero image URL" htmlFor="post-image" className="sm:col-span-2">
            <Input
              id="post-image"
              required
              maxLength={500}
              value={form.image}
              onChange={(event) => set("image", event.target.value)}
            />
          </Field>
        </div>

        <Field label="Excerpt" htmlFor="post-excerpt">
          <Textarea
            id="post-excerpt"
            required
            maxLength={400}
            rows={2}
            value={form.excerpt}
            onChange={(event) => set("excerpt", event.target.value)}
          />
        </Field>

        <Field label="Body" htmlFor="post-body">
          <Textarea
            id="post-body"
            required
            rows={14}
            value={form.body}
            onChange={(event) => set("body", event.target.value)}
          />
        </Field>

        <fieldset className="border-border flex flex-col gap-3 rounded border px-3 py-2">
          <legend className="text-muted-foreground px-1 text-[11px] font-medium tracking-wide uppercase">
            SEO — brief §39
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SEO title" htmlFor="post-seo-title">
              <Input
                id="post-seo-title"
                maxLength={200}
                value={form.seoTitle}
                onChange={(event) => set("seoTitle", event.target.value)}
              />
            </Field>
            <Field label="OG image URL" htmlFor="post-seo-og">
              <Input
                id="post-seo-og"
                maxLength={500}
                value={form.seoOgImage}
                onChange={(event) => set("seoOgImage", event.target.value)}
              />
            </Field>
          </div>
          <Field label="Meta description" htmlFor="post-seo-description">
            <Textarea
              id="post-seo-description"
              maxLength={320}
              rows={2}
              value={form.seoDescription}
              onChange={(event) => set("seoDescription", event.target.value)}
            />
          </Field>
          <p className="text-muted-foreground text-[11px]">
            Blank is a real answer — the storefront falls back to the title and excerpt rather than
            rendering an empty tag.
          </p>
        </fieldset>

        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={form.isPublished}
            onChange={(event) => set("isPublished", event.target.checked)}
          />
          Published — visible on the public blog
        </label>

        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? "Saving…"
              : slugChangingOnLivePost && !slugWarned
                ? "Save…"
                : post === null
                  ? "Create post"
                  : "Save changes"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>

        <p className="text-muted-foreground text-[11px]">
          The publication date is stamped the first time a post goes live and is never cleared by
          unpublishing — so a post taken down and put back keeps its original date rather than
          jumping to the top of the blog.
        </p>
      </form>
    </Panel>
  );
}
