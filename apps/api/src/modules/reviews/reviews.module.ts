import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { Review } from '../../entities/content/review.entity';
import { AdminModule } from '../admin/admin.module';
import { AdminReviewsController } from './admin-reviews.controller';
import { AdminReviewsService } from './admin-reviews.service';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * Public review reads, authenticated creation, and — as of plan 9.4 — brief §27's moderation queue.
 *
 * `Product` is registered because `ReviewsService` resolves the slug from the route to a product id
 * before writing. `AdminReviewsService` needs no `forFeature` entry of its own: it injects the
 * `DataSource` and reaches every repository through one transaction's `EntityManager`, the pattern
 * `AdminCategoriesService` uses.
 *
 * `AdminModule` is imported for `AuditLogService`, which is exported from there precisely because
 * almost none of its callers live in it.
 *
 * **Two controllers, one module, no class mixing scopes.** `admin.module.ts` states the convention:
 * a module that gains admin routes keeps its own second controller rather than moving them there.
 * Both controllers read the same table and the same mapper, which is the point — a moderator and a
 * shopper must be looking at the same review.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Review, Product]), AdminModule],
  controllers: [ReviewsController, AdminReviewsController],
  providers: [ReviewsService, AdminReviewsService],
})
export class ReviewsModule {}
