import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { usePosts } from "@/features/content/hooks/useContent";
import { BLOG_CATEGORIES } from "@/features/content/types";
import { useSeo } from "@/hooks/useSeo";
import { cn } from "@/lib/utils";

/** The filter lives in the URL so a category view can be shared and linked to. */
const searchSchema = z.object({
  category: z.enum(BLOG_CATEGORIES).optional(),
});

export const Route = createFileRoute("/blog/")({
  validateSearch: searchSchema,
  component: BlogIndex,
});

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

function BlogIndex() {
  const { category } = Route.useSearch();
  const { data: posts, isLoading, isError, refetch } = usePosts(category ?? "all");

  useSeo({
    title: category
      ? `${category} — Journal | ${settings.brandName}`
      : `Journal — Dry Fruit Guides, Recipes and Buying Advice | ${settings.brandName}`,
    description:
      "Buying guides, storage advice, recipes and wholesale notes on almonds, cashews, makhana and the rest of the dry fruit aisle.",
  });

  return (
    <div>
      <section className="border-border bg-sand border-b">
        <div className="container-page py-16">
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.2em] uppercase">
            Journal
          </p>
          <h1 className="font-display mt-3 max-w-3xl text-5xl leading-[1.05]">
            What to buy, how to store it, and what the grades actually mean.
          </h1>
          <p className="text-muted-foreground mt-4 max-w-2xl">
            Practical writing for people who buy dry fruit regularly — at home or by the sack.
          </p>
        </div>
      </section>

      <section className="container-page py-12">
        <nav aria-label="Filter by category" className="flex flex-wrap gap-2">
          <Link
            to="/blog"
            search={{}}
            className={cn(
              "rounded-full border px-4 py-1.5 text-sm transition-colors",
              category === undefined
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/50",
            )}
          >
            All
          </Link>
          {BLOG_CATEGORIES.map((c) => (
            <Link
              key={c}
              to="/blog"
              search={{ category: c }}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                category === c
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/50",
              )}
            >
              {c}
            </Link>
          ))}
        </nav>

        <div className="mt-10">
          {/*
           * `isError` is tested **first**, and it has to be.
           *
           * On a failed query react-query leaves `data` undefined and `isLoading` false, so
           * `isLoading || posts === undefined` is still true — the branch below would render the
           * skeleton for ever, and a reader would sit watching six grey cards that never resolve.
           * Unreachable while this page read `@/mocks/posts`, which could not fail; reachable the
           * moment it started reading `GET /content/posts`. Third instance of this exact class in
           * this codebase, after the cart and the checkout.
           */}
          {isError ? (
            <EmptyState
              title="The journal did not load."
              body="Something went wrong on our side, not yours. Try again in a moment."
              action={
                <Button onClick={() => void refetch()} variant="outline">
                  Try again
                </Button>
              }
            />
          ) : isLoading || posts === undefined ? (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-80 w-full rounded-3xl" />
              ))}
            </div>
          ) : posts.length === 0 ? (
            <EmptyState
              title="Nothing filed here yet."
              body="We are still writing for this category. Try another one in the meantime."
            />
          ) : (
            <ul aria-label="Blog posts" className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {posts.map((p) => (
                <li key={p.slug}>
                  <Link
                    to="/blog/$slug"
                    params={{ slug: p.slug }}
                    className="group border-border bg-card shadow-soft hover:shadow-lift flex h-full flex-col overflow-hidden rounded-3xl border transition-shadow"
                  >
                    <img
                      src={p.image}
                      alt={`Cover image for ${p.title}`}
                      loading="lazy"
                      width={800}
                      height={600}
                      className="bg-sand aspect-[4/3] w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                    <div className="flex flex-1 flex-col p-6">
                      <p className="text-leaf text-xs font-semibold tracking-[0.14em] uppercase">
                        {p.category}
                      </p>
                      <h2 className="font-display mt-3 text-2xl leading-snug">{p.title}</h2>
                      <p className="text-muted-foreground mt-2 line-clamp-3 text-sm">{p.excerpt}</p>
                      <p className="text-muted-foreground mt-auto pt-5 text-xs">
                        {day(p.publishedAt)} · {p.readingMinutes} min read
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
