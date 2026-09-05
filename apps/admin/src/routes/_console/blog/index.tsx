import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminBlogPost, BlogCategory } from "@/contract";
import { BLOG_CATEGORIES } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { ToneBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  deletePost,
  fetchPosts,
  parseBlogCategory,
  POSTS_PAGE_SIZE,
  updatePost,
} from "@/features/blog/api/posts";
import { PostForm } from "@/features/blog/post-form";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateOnly } from "@/lib/format";

/**
 * `/blog` — brief §28's categories, §39's SEO fields, drafts included.
 *
 * **The admin list shows unpublished posts; the public one does not.** That difference is the whole
 * reason there are two shapes on the wire: `BlogPostSummary.publishedAt` is non-null because an
 * unpublished post never reaches the public list, and `AdminBlogPost.publishedAt` is nullable
 * because a draft has never gone live.
 *
 * **The editor is inline rather than a `/blog/$slug` route**, because there is no
 * `GET /admin/posts/:slug` to deep-link to — the public route only serves published posts, so a
 * detail screen could not open a draft. `?edit=<slug>` resolves against the rows this page already
 * has and says so when it cannot.
 */

interface BlogSearch {
  category?: BlogCategory;
  isPublished?: boolean;
  edit?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/blog/")({
  validateSearch: (search: Record<string, unknown>): BlogSearch => {
    const category = parseBlogCategory(search["category"]);
    const raw = search["isPublished"];
    const isPublished =
      raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    const edit = search["edit"];
    const page = Number(search["page"]);

    return {
      ...(category === undefined ? {} : { category }),
      ...(isPublished === undefined ? {} : { isPublished }),
      ...(typeof edit === "string" && edit.trim() !== "" ? { edit: edit.trim() } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: BlogScreen,
});

function BlogScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;
  const [creating, setCreating] = useState(false);

  const posts = useQuery({
    queryKey: ["posts", { category: search.category, isPublished: search.isPublished, page }],
    queryFn: ({ signal }) =>
      fetchPosts(
        {
          ...(search.category === undefined ? {} : { category: search.category }),
          ...(search.isPublished === undefined ? {} : { isPublished: search.isPublished }),
          page,
          limit: POSTS_PAGE_SIZE,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  function setSearchParams(patch: Partial<BlogSearch>, resetPage = true) {
    void navigate({
      search: (previous: BlogSearch): BlogSearch => {
        const next: BlogSearch = { ...previous, ...patch };
        if (resetPage) delete next.page;
        if (next.category === undefined) delete next.category;
        if (next.isPublished === undefined) delete next.isPublished;
        if (next.edit === undefined || next.edit === "") delete next.edit;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: BlogSearch): BlogSearch => {
        const updated: BlogSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const rows = posts.data?.items ?? [];
  const editing =
    search.edit === undefined ? null : (rows.find((row) => row.slug === search.edit) ?? null);
  const editMissing = search.edit !== undefined && editing === null && posts.data !== undefined;
  const total = posts.data?.total ?? 0;

  return (
    <Page
      title="Blog"
      description={
        posts.data === undefined ? "Loading…" : `${count(total)} ${total === 1 ? "post" : "posts"}`
      }
      actions={
        <Button
          onClick={() => {
            setCreating(true);
            setSearchParams({ edit: undefined }, false);
          }}
        >
          New post
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {creating && <PostForm post={null} onDone={() => setCreating(false)} />}

        {editing !== null && (
          <PostForm
            key={editing.slug}
            post={editing}
            onDone={() => setSearchParams({ edit: undefined }, false)}
          />
        )}

        {editMissing && (
          <Panel>
            <Notice
              title={`${String(search.edit)} is not on this page.`}
              body="There is no endpoint that reads a single post as an admin — the public one only serves published ones — so the editor works from the rows already loaded. Clear the filters, or page to the post you want."
              action={
                <Button
                  variant="outline"
                  onClick={() => setSearchParams({ edit: undefined }, false)}
                >
                  Close the editor
                </Button>
              }
            />
          </Panel>
        )}

        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Category" htmlFor="filter-category" className="w-56">
            <Select
              id="filter-category"
              value={search.category ?? ""}
              onChange={(event) =>
                setSearchParams({ category: parseBlogCategory(event.target.value) })
              }
            >
              <option value="">All categories</option>
              {BLOG_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Visibility" htmlFor="filter-published" className="w-44">
            <Select
              id="filter-published"
              value={search.isPublished === undefined ? "" : String(search.isPublished)}
              onChange={(event) =>
                setSearchParams({
                  isPublished:
                    event.target.value === "true"
                      ? true
                      : event.target.value === "false"
                        ? false
                        : undefined,
                })
              }
            >
              <option value="">Drafts and published</option>
              <option value="true">Published only</option>
              <option value="false">Drafts only</option>
            </Select>
          </Field>

          <p className="text-muted-foreground mb-1.5 ml-auto max-w-md text-right text-[11px]">
            Drafts appear here and nowhere else — the public list filters them out.
          </p>
        </Panel>

        <Panel>
          {posts.isPending ? (
            <Loading label="Loading posts" />
          ) : posts.isError ? (
            <Notice
              tone="error"
              title="Posts could not be loaded."
              body={errorMessage(posts.error)}
              action={
                <Button variant="outline" onClick={() => void posts.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title="No posts."
              body="Brief §28's categories are Dry Fruit Guides, Buying Guides, Recipes, Storage Tips, B2B and Nutrition Education."
            />
          ) : (
            <TableWrap>
              <Table caption="Blog posts, newest first">
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Category</Th>
                    <Th>Author</Th>
                    <Th>Status</Th>
                    <Th>Published</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((post) => (
                    <PostRow
                      key={post.slug}
                      post={post}
                      onEdit={() => {
                        setCreating(false);
                        setSearchParams({ edit: post.slug }, false);
                      }}
                    />
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {posts.data !== undefined && rows.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={POSTS_PAGE_SIZE}
              onPage={goToPage}
              unit="post"
            />
          )}
        </Panel>
      </div>
    </Page>
  );
}

function PostRow({ post, onEdit }: { post: AdminBlogPost; onEdit: () => void }) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: () => updatePost(post.slug, { isPublished: !post.isPublished }),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ["posts"] });
      toast.success(saved.isPublished ? "Published." : "Taken down. The post is kept as a draft.");
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => deletePost(post.slug),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["posts"] });
      setConfirming(false);
      toast.success(`“${post.title}” deleted.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <Tr>
      <Td>
        <span className="block max-w-72 truncate font-medium">{post.title}</span>
        <span className="text-muted-foreground tnum block max-w-72 truncate text-[11px]">
          /{post.slug}
        </span>
      </Td>
      <Td>{post.category}</Td>
      <Td className="text-muted-foreground">{post.author}</Td>
      <Td>
        <ToneBadge
          tone={post.isPublished ? "done" : "attention"}
          title={
            post.isPublished
              ? "Live on the public blog."
              : "Visible here only. The public list filters drafts out."
          }
        >
          {post.isPublished ? "Published" : "Draft"}
        </ToneBadge>
      </Td>
      <Td className="text-muted-foreground tnum whitespace-nowrap">
        {post.publishedAt === null ? "Never" : dateOnly(post.publishedAt)}
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {post.isPublished ? "Take down" : "Publish"}
          </Button>
          {confirming ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Deleting…" : "Delete for good"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}
        </div>
        {confirming && (
          <p className="text-muted-foreground mt-1 max-w-64 text-[11px]">
            Nothing references a post, so this really does delete it — there is no refusal to catch
            and no way back. <em>Take down</em> keeps it as a draft.
          </p>
        )}
      </Td>
    </Tr>
  );
}
