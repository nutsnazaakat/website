import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BlogPost, BlogPostSummary } from '@nutwala/shared';
import { Public } from '../../common/auth/decorators/public.decorator';
import { ContentService } from './content.service';
import { PostQueryDto } from './dto/post-query.dto';

/**
 * The public blog — spec §6.1's three `/content/posts` routes, brief §28.
 *
 * **Specced and never built until plan 9.4.** `ContentService`'s docblock has the full note; the
 * short version is that `blog_posts` was seeded with eight posts in Milestone 3 and nothing ever
 * exposed them, which only surfaced because this plan required the admin list to be tested against
 * a public one.
 *
 * `@Public()` per handler rather than at the class, matching `CatalogController` and
 * `ReviewsController`: `JwtAuthGuard` is global, and the decorator marks the individual routes an
 * anonymous visitor may reach. No `@Roles()` anywhere here — `admin-routes-guarded` asserts that a
 * customer-facing route carrying `@Roles(UserRole.ADMIN)` is a 403 for every legitimate caller,
 * which reads in production as "the endpoint is broken".
 *
 * **Declaration order is routing order**, and it matters on this controller today rather than
 * hypothetically: `posts` is declared above `posts/:slug`, and `posts/:slug/related` matches a
 * different third segment so it cannot be shadowed. A literal added later — `posts/featured`, say —
 * would have to go **above** `posts/:slug` or Express matches the slug pattern first and answers
 * 404 for a post nobody named. `catalog.controller.ts` carries the same warning and
 * `content.controller.spec.ts` pins the table rather than one route.
 */
@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(private readonly content: ContentService) {}

  @Public()
  @Get('posts')
  @ApiOperation({
    summary: 'Published blog posts, newest first, optionally by category (brief §28)',
  })
  list(@Query() query: PostQueryDto): Promise<BlogPostSummary[]> {
    return this.content.list(query.category);
  }

  /** Declared **below** `posts` and above nothing that would shadow it. See the class docblock. */
  @Public()
  @Get('posts/:slug')
  @ApiOperation({ summary: 'One published post, with its body and SEO block' })
  get(@Param('slug') slug: string): Promise<BlogPost> {
    return this.content.get(slug);
  }

  @Public()
  @Get('posts/:slug/related')
  @ApiOperation({ summary: 'Up to three more posts from the same category' })
  related(@Param('slug') slug: string): Promise<BlogPostSummary[]> {
    return this.content.related(slug);
  }
}
