import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { BlogPost, BlogPostSummary } from '@nutwala/shared';
import { In, Not, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { BlogPost as BlogPostEntity } from '../../entities/content/blog-post.entity';
import { toBlogPost, toBlogPostSummary } from './mappers/blog-post.mapper';

/** How many posts `GET /content/posts/:slug/related` carries. Enough for a rail, not a second list. */
const RELATED_LIMIT = 3;

/**
 * The public blog — spec §6.1's `/content/posts` routes, brief §28.
 *
 * **These were specced and never built.** §6.1 lists `GET /content/posts`, `/content/posts/:slug`
 * and `/content/posts/:slug/related`; no `content` controller existed anywhere in the service
 * before plan 9.4, so `blog_posts` had eight seeded rows and no way to read them. Found while
 * building `/admin/posts`, which the plan required to be tested against "the public list" — a list
 * that did not exist. Recorded here because it is the second §6.1 gap this plan turned up, beside
 * `GET /settings`.
 *
 * **Published only, everywhere.** Every query below filters `isPublished`, and that filter is the
 * entire difference between this service and `AdminPostsService`. It is also what makes
 * `BlogPostSummary.publishedAt` a non-null string on the wire while the column is nullable.
 *
 * Unpaginated, matching `GET /catalog/categories` rather than `GET /catalog/products`: brief §28
 * describes an editorial blog with six categories, the seed carries eight posts, and a paginated
 * response would make a "recent posts" rail need to know about page two. Worth revisiting if the
 * blog ever runs to hundreds — the shape to move to is `Paginated<BlogPostSummary>`, which is a
 * wire change and not just a query change.
 */
@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(BlogPostEntity) private readonly posts: Repository<BlogPostEntity>,
  ) {}

  /**
   * `GET /content/posts?category=` — published posts, newest first.
   *
   * `category` is matched exactly against the stored string, which is one of `BLOG_CATEGORIES`. An
   * unknown category answers an empty list rather than a 404: this is a filter, and "no posts in
   * Recipes yet" is a real answer, while a 404 would make an empty section indistinguishable from a
   * broken link.
   *
   * `slug` is the tiebreak on `publishedAt`, because the seed writes all eight posts in one
   * transaction with dates a human chose and nothing stops two sharing one.
   */
  async list(category?: string): Promise<BlogPostSummary[]> {
    const rows = await this.posts.find({
      where: { isPublished: true, ...(category === undefined ? {} : { category }) },
      order: { publishedAt: 'DESC', slug: 'ASC' },
    });
    return rows.map(toBlogPostSummary);
  }

  /** `GET /content/posts/:slug`. An unpublished post is a 404 here, exactly as an unpublished product is. */
  async get(slug: string): Promise<BlogPost> {
    const post = await this.posts.findOne({ where: { slug, isPublished: true } });
    if (!post) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That post may have been renamed or taken down.',
        HttpStatus.NOT_FOUND,
        { slug },
      );
    }
    return toBlogPost(post);
  }

  /**
   * `GET /content/posts/:slug/related` — three more posts: same category first, then the newest
   * from anywhere to fill the rail.
   *
   * The post itself is excluded, and the read that finds its category **404s for an unpublished
   * slug** like the detail route does, rather than answering an empty array: a route that quietly
   * returns nothing for a draft would confirm the draft exists to anyone who guessed its slug,
   * which is the same information leak from the other side. `ReviewsService.create` records the
   * identical reasoning about its own product lookup.
   *
   * Same-category *first* rather than tag-based, because `blog_posts` has no tags and brief §28's
   * six categories are the only relationship the schema carries.
   *
   * **The top-up is deliberate, and it was missing.** This filtered on category alone, which looked
   * right and was measurably wrong the moment a real consumer arrived: four of the eight seeded
   * posts are the only article in their category, so their "Keep reading" rail rendered **nothing**,
   * and a fifth showed a single card where the design has three. The storefront's mock had it right
   * — its docblock asked for "same category first, topped up with the next newest posts so a detail
   * page always has something to offer even when its category holds a single article" — and wiring
   * the storefront to this service would have quietly dropped that. Found by
   * `content.integration.spec.ts`, which had no predecessor: these routes shipped in Milestone 3
   * with no integration coverage and no consumer.
   *
   * Two queries rather than one, because "same category first" is a *ranking*, and expressing it in
   * SQL means either a `CASE` in the `ORDER BY` or a union — both harder to read than asking for the
   * preferred set and then filling the gap. The second query runs only when the first leaves room.
   */
  async related(slug: string): Promise<BlogPostSummary[]> {
    const post = await this.posts.findOne({
      where: { slug, isPublished: true },
      select: { slug: true, category: true },
    });
    if (!post) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That post may have been renamed or taken down.',
        HttpStatus.NOT_FOUND,
        { slug },
      );
    }

    const sameCategory = await this.posts.find({
      where: { isPublished: true, category: post.category, slug: Not(post.slug) },
      order: { publishedAt: 'DESC', slug: 'ASC' },
      take: RELATED_LIMIT,
    });

    const shortfall = RELATED_LIMIT - sameCategory.length;
    if (shortfall <= 0) return sameCategory.map(toBlogPostSummary);

    /*
     * `Not(In([...]))` over the post *and* everything already chosen, rather than `Not(category)`:
     * excluding the category would work today because the first query takes every post in it, but
     * it stops being true the moment a category holds more than `RELATED_LIMIT` posts — the first
     * query would cap at three, and a fourth same-category post would then be eligible here and
     * appear twice. Excluding the actual slugs cannot drift that way.
     */
    const chosen = [post.slug, ...sameCategory.map((row) => row.slug)];
    const topUp = await this.posts.find({
      where: { isPublished: true, slug: Not(In(chosen)) },
      order: { publishedAt: 'DESC', slug: 'ASC' },
      take: shortfall,
    });

    return [...sameCategory, ...topUp].map(toBlogPostSummary);
  }
}
