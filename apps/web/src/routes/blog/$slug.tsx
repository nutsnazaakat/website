import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock3 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteSettings } from "@/config/useSiteSettings";
import { Markdown } from "@/features/content/components/Markdown";
import { usePost, useRelatedPosts } from "@/features/content/hooks/useContent";
import { BLOG_CATEGORIES, type BlogCategory } from "@/features/content/types";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/blog/$slug")({ component: BlogPostPage });

/**
 * The post's category as a search param for `/blog`, or no filter when it is not one of the six.
 *
 * `BLOG_CATEGORIES.find` rather than a cast: the wire type is `string`, and this is the boundary
 * where that string either is a known category or is not.
 */
const filterFor = (category: string): { category?: BlogCategory } => {
  const known = BLOG_CATEGORIES.find((c) => c === category);
  return known === undefined ? {} : { category: known };
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

function BlogPostPage() {
  const settings = useSiteSettings();
  const { slug } = Route.useParams();
  const { data: post, isLoading, isError } = usePost(slug);
  const { data: related } = useRelatedPosts(slug);

  useSeo({
    title: post ? `${post.title} | ${settings.brandName}` : `Journal | ${settings.brandName}`,
    description: post?.excerpt ?? "",
    ogImage: post?.image,
    // Brief §39 asks for structured data where appropriate; an editorial page is the
    // clearest case for it.
    jsonLd: post
      ? {
          "@context": "https://schema.org",
          "@type": "Article",
          headline: post.title,
          description: post.excerpt,
          image: post.image,
          datePublished: post.publishedAt,
          dateModified: post.publishedAt,
          articleSection: post.category,
          wordCount: post.body.trim().split(/\s+/).length,
          author: { "@type": "Organization", name: post.author },
          publisher: { "@type": "Organization", name: settings.brandName },
        }
      : undefined,
  });

  if (isLoading) {
    return (
      <div className="container-page py-12">
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="aspect-[16/9] w-full rounded-3xl" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !post) {
    return (
      <div className="container-page py-24 text-center">
        <h1 className="font-display text-3xl">Post not found</h1>
        <p className="text-muted-foreground mt-3 text-sm">
          This article may have been renamed or unpublished.
        </p>
        <Link
          to="/blog"
          search={{}}
          className="mt-6 inline-block text-sm underline underline-offset-4"
        >
          Back to the journal
        </Link>
      </div>
    );
  }

  return (
    <div className="container-page py-10">
      <article className="mx-auto max-w-3xl">
        <nav className="text-muted-foreground text-xs">
          <Link to="/" className="hover:text-foreground">
            Home
          </Link>{" "}
          /{" "}
          <Link to="/blog" search={{}} className="hover:text-foreground">
            Journal
          </Link>{" "}
          /{" "}
          {/*
           * The one place the storefront needs `category` as the union rather than as a string.
           *
           * `/blog` validates its search with `z.enum(BLOG_CATEGORIES)`, while the wire type is
           * `string` — `blog_posts.category` is an unconstrained `varchar(40)`, so the contract
           * declines to narrow it and says why. Matching against the constant here keeps the
           * guarantee where it can actually be checked, and a value outside the list degrades to the
           * unfiltered journal instead of building a link the router would reject.
           */}
          <Link to="/blog" search={filterFor(post.category)} className="hover:text-foreground">
            {post.category}
          </Link>
        </nav>

        <p className="text-leaf mt-6 text-xs font-semibold tracking-[0.14em] uppercase">
          {post.category}
        </p>
        <h1 className="font-display mt-3 text-4xl leading-tight sm:text-5xl">{post.title}</h1>
        <p className="text-muted-foreground mt-4 text-lg">{post.excerpt}</p>

        <div className="text-muted-foreground mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>{post.author}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.publishedAt}>{day(post.publishedAt)}</time>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1.5">
            <Clock3 className="size-4" aria-hidden="true" />
            {post.readingMinutes} min read
          </span>
        </div>

        <img
          src={post.image}
          alt={`Cover image for ${post.title}`}
          width={1200}
          height={675}
          className="bg-sand mt-8 aspect-[16/9] w-full rounded-3xl object-cover"
        />

        <div className="mt-10">
          <Markdown source={post.body} />
        </div>
      </article>

      {related !== undefined && related.length > 0 && (
        <section className="border-border mx-auto mt-16 max-w-5xl border-t pt-10">
          <h2 className="font-display text-3xl">Keep reading</h2>
          <ul aria-label="Related posts" className="mt-6 grid gap-5 md:grid-cols-3">
            {related.map((r) => (
              <li key={r.slug}>
                <Link
                  to="/blog/$slug"
                  params={{ slug: r.slug }}
                  className="border-border bg-card shadow-soft hover:shadow-lift flex h-full flex-col rounded-2xl border p-5 transition-shadow"
                >
                  <p className="text-leaf text-xs font-semibold tracking-[0.14em] uppercase">
                    {r.category}
                  </p>
                  <p className="font-display mt-2 text-xl leading-snug">{r.title}</p>
                  <p className="text-muted-foreground mt-auto pt-4 text-xs">
                    {r.readingMinutes} min read
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
