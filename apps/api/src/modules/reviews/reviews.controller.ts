import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Review, ReviewSummary } from '@nutwala/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

/**
 * Nested under the product it belongs to, so the slug can never be taken from a body.
 *
 * No route here collides with `CatalogController`'s: `products/:slug` matches two segments and
 * `products/:slug/related` matches a different third, so declaration order between the two
 * controllers does not matter here the way it does inside `CatalogController`.
 */
@ApiTags('reviews')
@Controller('catalog/products/:slug/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Approved reviews for a product, newest first' })
  list(@Param('slug') slug: string): Promise<Review[]> {
    return this.reviews.listForProduct(slug);
  }

  @Public()
  @Get('summary')
  @ApiOperation({ summary: 'Rating average and star distribution' })
  summary(@Param('slug') slug: string): Promise<ReviewSummary> {
    return this.reviews.summaryForProduct(slug);
  }

  /**
   * Authenticated: a review needs an author to attribute and, later, a purchase to verify.
   * Rate-limited because it is a public write — five an hour is generous for a person and useless
   * for a script.
   */
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a review, which is held for moderation' })
  create(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReviewDto,
  ): Promise<Review> {
    return this.reviews.create(slug, user.id, dto);
  }
}
