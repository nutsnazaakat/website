import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminBlogPost, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminPostsService } from './admin-posts.service';
import { AdminPostQueryDto } from './dto/admin-post-query.dto';
import { CreatePostDto, UpdatePostDto } from './dto/save-post.dto';

/**
 * `/admin/posts` — spec §6.4, brief §28 and §39.
 *
 * **A second controller beside `ContentController`, never handlers on it.** The public one is
 * `@Public()` per handler and this one is `@Roles(UserRole.ADMIN)` at the class; mixing them would
 * put an admin handler on a controller whose default is anonymous access, and a handler that loses
 * its decorator there is not refused — it is silently opened to the internet.
 *
 * **`:slug`, not `:id`.** §6.4 spells these `:id` and `blog_posts` does have a uuid, but the slug
 * is the post's identity everywhere it matters: it carries `uq_blog_posts_slug`, it is the live URL
 * that `GET /content/posts/:slug` serves, and it is what `audit_logs.entityId` files a post's
 * history under. §6.4 needs the same correction it already carries for
 * `PATCH /admin/inventory/:variantId`. The slug is mutable, unlike a coupon code —
 * `UpdatePostDto`'s docblock has that decision and what the old URL does afterwards.
 *
 * **Declaration order is routing order.** `@Get()` is the collection, and the `:slug` routes below
 * carry a segment it cannot match. A literal added later — `admin/posts/import`, say — must be
 * declared **above** them or the pattern swallows it.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/posts')
export class AdminPostsController {
  constructor(private readonly posts: AdminPostsService) {}

  /** `GET /admin/posts` — **drafts included**, which is the whole difference from the public list. */
  @Get()
  @ApiOperation({ summary: 'Every post, drafts included, newest first (brief §28)' })
  list(@Query() query: AdminPostQueryDto): Promise<Paginated<AdminBlogPost>> {
    return this.posts.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a post. Unpublished unless isPublished is sent' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePostDto,
  ): Promise<AdminBlogPost> {
    // `actorUserId` after the spread — the audit trail's "who" is the signed token's.
    return this.posts.create({ ...dto, actorUserId: user.id });
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a post. An omitted field is left unchanged' })
  update(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePostDto,
  ): Promise<AdminBlogPost> {
    return this.posts.update(slug, { ...dto, actorUserId: user.id });
  }

  /**
   * `DELETE /admin/posts/:slug` — unconditional, because nothing in the schema references a post.
   * `AdminPostsService.remove` records that, and records that a future reference has to add a guard.
   *
   * `@HttpCode(HttpStatus.NO_CONTENT)`, matching `DELETE /admin/products/:id`: there is nothing left
   * to return, and a 200 with an empty envelope would suggest otherwise.
   */
  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a post. Unpublish it instead to take it down but keep it' })
  remove(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.posts.remove(slug, user.id);
  }
}
