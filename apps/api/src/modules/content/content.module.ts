import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogPost } from '../../entities/content/blog-post.entity';
import { AdminModule } from '../admin/admin.module';
import { AdminPostsController } from './admin-posts.controller';
import { AdminPostsService } from './admin-posts.service';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

/**
 * The blog, both halves — spec §6.1's public `/content/posts` routes and §6.4's `/admin/posts`.
 *
 * **The public half was specced in Milestone 2 and never built.** `blog_posts` has been seeded with
 * eight posts since Milestone 3 and no controller anywhere in the service read them;
 * `ContentService`'s docblock records how that surfaced. So this module ships both at once, which
 * is also the only way the plan's own requirement — that a draft appear in the admin list and not
 * in the public one — could be asserted at all.
 *
 * `BlogPost` is registered because `ContentService` injects its repository. `AdminPostsService`
 * needs no entry of its own: it injects the `DataSource` and reaches the repository through one
 * transaction's `EntityManager`, as `AdminCategoriesService` does.
 *
 * `AdminModule` is imported for `AuditLogService`.
 *
 * `Review` is deliberately **not** here even though `reviews` is the other table under
 * `entities/content/`. A review belongs to a product and is served under
 * `catalog/products/:slug/reviews` by `ReviewsModule`; grouping the two by their folder would put
 * two unrelated surfaces behind one module boundary because of where their entity files happen to
 * sit.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BlogPost]), AdminModule],
  controllers: [ContentController, AdminPostsController],
  providers: [ContentService, AdminPostsService],
})
export class ContentModule {}
