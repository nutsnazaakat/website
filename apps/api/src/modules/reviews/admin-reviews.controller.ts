import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminReview, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminReviewsService } from './admin-reviews.service';
import { AdminReviewQueryDto } from './dto/admin-review-query.dto';
import { RejectReviewDto } from './dto/reject-review.dto';

/**
 * Brief §27's moderation queue — spec §6.4's `/admin/reviews` block.
 *
 * **A second controller beside `ReviewsController`, not extra handlers on it.** That one is
 * `@Public()` per handler and nested under `catalog/products/:slug/reviews`; this is
 * `@Roles(UserRole.ADMIN)` at the class and rooted at `admin/reviews`. Mixing them would mean the
 * guard resolving `@Roles()` per handler, and a handler that loses its decorator is not refused —
 * it is silently opened to every authenticated customer.
 *
 * `:id` here, unlike coupons and orders, and for the reason those two are not: a review has no
 * human-readable alternate key. Its uuid is the only handle, `AdminReview.id` carries it, and
 * §6.4 already spells these routes `:id`. `ParseUUIDPipe` therefore belongs on them, where it does
 * not on `:orderNumber` or `:code`.
 *
 * **Declaration order is routing order**, and there is a live constraint here rather than a
 * theoretical one: `@Get()` is the collection and the two `@Post`s carry longer paths, so nothing
 * shadows anything today — but a literal `@Get('pending')` added later would have to sit above any
 * `@Get(':id')` a future task adds. Recorded because a shadowed route 404s while every unit test
 * stays green, which has already happened once on this project.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly reviews: AdminReviewsService) {}

  /** `GET /admin/reviews` — **pending by default**: the queue, not every review ever written. */
  @Get()
  @ApiOperation({ summary: 'The moderation queue. Pending by default, oldest first (brief §27)' })
  list(@Query() query: AdminReviewQueryDto): Promise<Paginated<AdminReview>> {
    return this.reviews.list(query);
  }

  /**
   * `POST /admin/reviews/:id/approve` — the review appears on the product page and its rating joins
   * the product's average.
   *
   * `@HttpCode(HttpStatus.OK)`, because Nest answers a `POST` with 201 by default and nothing is
   * created. The reply is the moderated review, so the console re-renders the committed state
   * instead of guessing what the server did — `AdminOrdersController.setStatus` makes the same
   * choice for the same reason. It matters more on the *second* call, where a 201 would claim
   * something was created when the whole point is that nothing was.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a review, making it visible on the storefront' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminReview> {
    return this.reviews.approve(id, user.id);
  }

  /** `POST /admin/reviews/:id/reject` — the review stays hidden, and stops counting if it had been approved. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a review, with an optional note for the next moderator' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RejectReviewDto,
  ): Promise<AdminReview> {
    // `actorUserId` after the spread: the moderation trail's "who" is the signed token's.
    return this.reviews.reject(id, { ...dto, actorUserId: user.id });
  }
}
