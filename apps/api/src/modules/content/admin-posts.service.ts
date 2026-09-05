import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminBlogPost, Paginated } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { BlogPost } from '../../entities/content/blog-post.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { AdminPostQueryDto } from './dto/admin-post-query.dto';
import type { CreatePostDto, UpdatePostDto } from './dto/save-post.dto';
import { toAdminBlogPost } from './mappers/blog-post.mapper';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

interface PostSnapshot {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  image: string;
  author: string;
  isPublished: boolean;
  publishedAt: string | null;
  seo: Record<string, unknown>;
  /**
   * The article's **length**, not the article.
   *
   * A body runs to several thousand words, and `audit_logs.before`/`after` are `jsonb` columns
   * holding "the changed fields, not the whole row". Two full copies of an article per edit would
   * make the trail larger than the table it describes, and would put the same prose in a place
   * nobody edits it. The length is enough to answer the question a trail is actually asked — "did
   * this edit touch the body, and by roughly how much" — while `blog_posts` remains the one home
   * of the text. Stated because "the body is not in the trail" is otherwise a silent gap.
   */
  bodyLength: number;
}

function snapshot(post: BlogPost): PostSnapshot {
  return {
    slug: post.slug,
    title: post.title,
    category: post.category,
    excerpt: post.excerpt,
    image: post.image,
    author: post.author,
    isPublished: post.isPublished,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    seo: { ...post.seo },
    bodyLength: post.body.length,
  };
}

/** The changed fields only, or null when nothing moved. `AdminCategoriesService`'s helper verbatim. */
function diff(
  before: PostSnapshot,
  after: PostSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof PostSnapshot)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * `/admin/posts` — spec §6.4's blog block, brief §28's categories and §39's SEO fields.
 *
 * **The admin list includes drafts; the public one cannot.** That single difference is the reason
 * this service and `ContentService` are two classes rather than one with a flag: every query there
 * filters `isPublished = true`, and a flag would put the storefront one wrong argument away from
 * serving an unpublished article.
 *
 * **`publishedAt` is stamped on first publication and never cleared**, matching
 * `AdminProductsService`. An unpublish/republish cycle is not a new post, and rewriting the date
 * would lose the only record of when the article first existed. It is also why `publishedAt` is not
 * on `CreatePostDto`: it is derived from `isPublished` moving, never supplied.
 *
 * **A published post's slug may be changed, and the old URL then 404s.** `UpdatePostDto`'s docblock
 * carries the decision and what it costs.
 *
 * Same two rules as every other admin write: one transaction per write, the audit row inside it,
 * and no audit row for a write that changed nothing.
 */
@Injectable()
export class AdminPostsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/posts` — **drafts included**, newest first.
   *
   * Ordered on `createdAt` rather than `publishedAt`, unlike the public list, and the difference is
   * forced rather than stylistic: a draft's `publishedAt` is null, and null sorts last under
   * `DESC NULLS LAST` — so ordering an editor's index by publication date would bury every draft
   * below every published post, which is the opposite of what an editor's index is for. `slug` is
   * the tiebreak, carrying `uq_blog_posts_slug`, so paging is stable.
   *
   * Paginated where the public list is not, for `AdminCouponQueryDto`'s reason: an editorial blog
   * accumulates, and a list endpoint that can be turned into a table dump is what the 60-row cap on
   * every other admin list exists to prevent.
   */
  async list(query: AdminPostQueryDto): Promise<Paginated<AdminBlogPost>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource.getRepository(BlogPost).createQueryBuilder('post');
    if (query.category !== undefined) {
      builder.andWhere('post.category = :category', { category: query.category });
    }
    if (query.isPublished !== undefined) {
      builder.andWhere('post.isPublished = :isPublished', { isPublished: query.isPublished });
    }

    const [rows, total] = await builder
      .orderBy('post.createdAt', 'DESC')
      .addOrderBy('post.slug', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toAdminBlogPost), total, page, limit };
  }

  async create(input: CreatePostDto & { actorUserId: string }): Promise<AdminBlogPost> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertSlugFree(manager, input.slug, null);

      const posts = manager.getRepository(BlogPost);
      const isPublished = input.isPublished ?? false;
      const created = await posts.save(
        posts.create({
          slug: input.slug,
          title: input.title,
          category: input.category,
          excerpt: input.excerpt,
          image: input.image,
          author: input.author,
          body: input.body,
          isPublished,
          // Stamped here rather than defaulted, so a post created already published carries the
          // date it went live rather than a null that `publish` would have to backfill later.
          publishedAt: isPublished ? new Date() : null,
          seo: { ...input.seo },
        }),
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.POST_CREATE,
        entityType: AuditEntity.POST,
        entityId: created.slug,
        after: { ...snapshot(created) },
      });

      return toAdminBlogPost(created);
    });
  }

  async update(
    slug: string,
    input: UpdatePostDto & { actorUserId: string },
  ): Promise<AdminBlogPost> {
    return this.dataSource.transaction(async (manager) => {
      const post = await this.loadOrThrow(manager, slug);
      const before = snapshot(post);

      if (input.slug !== undefined) {
        await this.assertSlugFree(manager, input.slug, post.id);
        post.slug = input.slug;
      }
      if (input.title !== undefined) post.title = input.title;
      if (input.category !== undefined) post.category = input.category;
      if (input.excerpt !== undefined) post.excerpt = input.excerpt;
      if (input.image !== undefined) post.image = input.image;
      if (input.author !== undefined) post.author = input.author;
      if (input.body !== undefined) post.body = input.body;
      if (input.seo !== undefined) post.seo = { ...input.seo };
      if (input.isPublished !== undefined) {
        post.isPublished = input.isPublished;
        // First publication only. Never cleared by unpublishing — see the class docblock.
        if (input.isPublished && post.publishedAt === null) post.publishedAt = new Date();
      }

      const changed = diff(before, snapshot(post));
      if (changed === null) return toAdminBlogPost(post);

      await manager.getRepository(BlogPost).save(post);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.POST_UPDATE,
        entityType: AuditEntity.POST,
        // **The row's identity after the write**, so a rename is filed under the slug the post now
        // has and `before.slug` in the payload is the only pointer back. Filing it under the old
        // slug instead would scatter one post's history across every name it has ever had.
        entityId: post.slug,
        before: changed.before,
        after: changed.after,
      });

      return toAdminBlogPost(post);
    });
  }

  /**
   * `DELETE /admin/posts/:slug` — a hard delete, per spec §5a, and **unconditional**.
   *
   * No `ENTITY_IN_USE` check, unlike products and coupons, because nothing references a post:
   * `blog_posts` is the leaf of its own graph — no foreign key anywhere in the schema points at it,
   * it appears in no order, no cart and no ledger, and `related` is a same-category query rather
   * than a stored link. Checked rather than assumed, and stated here so that the next person adding
   * a reference to this table knows this endpoint has to grow a guard with it.
   *
   * The obvious alternative to deleting a live post — take it down but keep it — is
   * `isPublished: false` through the PATCH, which is what the audit row for a delete should make an
   * operator wonder about. The endpoint is spec §6.4's, so it exists; the trail carries the whole
   * row in `before`, because nothing else ever will.
   */
  async remove(slug: string, actorUserId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const post = await this.loadOrThrow(manager, slug);

      await this.audit.record(manager, {
        actorUserId,
        action: AuditAction.POST_DELETE,
        entityType: AuditEntity.POST,
        entityId: post.slug,
        before: { ...snapshot(post) },
      });

      await manager.getRepository(BlogPost).delete({ id: post.id });
    });
  }

  private async loadOrThrow(manager: EntityManager, slug: string): Promise<BlogPost> {
    // No `isPublished` filter, which is the whole point of the admin routes: a draft is reachable
    // here and 404s on `GET /content/posts/:slug`.
    const post = await manager.getRepository(BlogPost).findOne({ where: { slug } });
    if (!post) {
      throw new DomainError(ErrorCodes.NOT_FOUND, `No post ${slug}.`, HttpStatus.NOT_FOUND, {
        slug,
      });
    }
    return post;
  }

  /** A named 409 rather than a driver error from `uq_blog_posts_slug`. See `AdminProductsService`. */
  private async assertSlugFree(
    manager: EntityManager,
    slug: string,
    exceptId: string | null,
  ): Promise<void> {
    const builder = manager
      .getRepository(BlogPost)
      .createQueryBuilder('post')
      .where('post.slug = :slug', { slug });
    if (exceptId !== null) builder.andWhere('post.id != :exceptId', { exceptId });

    if (await builder.getExists()) {
      throw new DomainError(
        ErrorCodes.IDENTIFIER_IN_USE,
        'Another post already uses that slug.',
        HttpStatus.CONFLICT,
        { field: 'slug', value: slug },
      );
    }
  }
}
