import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { RatingBucket, Review as WireReview, ReviewSummary } from '@nutwala/shared';
import { DataSource, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Product } from '../../entities/catalog/product.entity';
import { Review } from '../../entities/content/review.entity';
import { ReviewStatus as ReviewStatusEnum } from '../../entities/enums';
import { toWireReview } from './mappers/review.mapper';
import { recomputeProductReviewAggregates } from './review-aggregates';
import type { CreateReviewDto } from './dto/create-review.dto';

/** The star values a histogram always shows, highest first. */
const STARS = [5, 4, 3, 2, 1] as const;

/**
 * Exported for its own unit test. Takes the minimum it needs rather than a full entity, so the spec
 * does not have to build one.
 *
 * `average` is rounded to one decimal place, which is what `ReviewList.tsx` renders with
 * `toFixed(1)`. `Product.ratingAvg` — the same mean, recomputed in SQL below — is a
 * `numeric(3,2)` column, so the two figures differ in the second decimal (3.7 here against 3.67
 * there) and agree once rendered. Worth knowing rather than fixing: the column feeds the star
 * rating on a product card, this feeds the histogram header, and both go through `toFixed(1)`.
 */
export function summarise(
  reviews: readonly { rating: number; verifiedPurchase: boolean }[],
): ReviewSummary {
  const total = reviews.length;
  const distribution: RatingBucket[] = STARS.map((stars) => {
    const count = reviews.filter((review) => review.rating === stars).length;
    return { stars, count, percent: total === 0 ? 0 : Math.round((count / total) * 100) };
  });

  return {
    // Guarded, because `0/0` is NaN and JSON turns that into null, which renders as an empty rating
    // rather than "no reviews yet".
    average:
      total === 0
        ? 0
        : Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / total) * 10) / 10,
    total,
    verifiedCount: reviews.filter((review) => review.verifiedPurchase).length,
    distribution,
  };
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * True when the slug names a product an anonymous visitor is allowed to know exists.
   *
   * The same lookup `create` performs, and shared with it for the reason `create`'s docblock
   * already gives: `GET /catalog/products/:slug` 404s for an unpublished slug, so nothing else
   * rooted at that slug may describe it either. `create` filtered; these two reads did not, which
   * left every approved review — author, body, image URL — and a live rating average anonymously
   * readable for a product the catalogue denies. Unpublishing flips `products.isPublished` and
   * touches no `reviews` row, so withdrawing a product from sale withdrew nothing.
   *
   * Found by Milestone 10's security review. `admin-reviews.integration.spec.ts`'s
   * "a withdrawn product publishes nothing" block is the proof, and it asserts the *equality* of
   * the withdrawn and unknown answers rather than merely that the withdrawn one is empty.
   */
  private async isPublished(slug: string): Promise<boolean> {
    const product = await this.products.findOne({
      where: { slug, isPublished: true },
      select: { id: true },
    });
    return product !== null;
  }

  /**
   * Approved reviews of a **published** product. A pending review is invisible to everyone but its
   * moderator, and every review of a withdrawn product is invisible to everyone but the console.
   *
   * An unpublished slug answers `[]` rather than 404, deliberately: an unknown slug has always
   * answered `200 []`, so a 404 here would distinguish "withdrawn" from "never existed" and be the
   * same existence oracle in the opposite direction. Withdrawn, unknown, and published-with-no-
   * reviews all answer identically.
   */
  async listForProduct(slug: string): Promise<WireReview[]> {
    if (!(await this.isPublished(slug))) return [];

    const rows = await this.reviews.find({
      where: { productSlug: slug, status: ReviewStatusEnum.APPROVED },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toWireReview);
  }

  /**
   * The rating average and star histogram, gated exactly as `listForProduct` is.
   *
   * Gating both matters: the summary is the cheaper leak of the two — one request returns a live
   * count and mean for a product the catalogue will not admit to — and `summarise([])` already
   * produces the all-zero shape an unknown slug returns, so the two are indistinguishable without
   * a second code path.
   */
  async summaryForProduct(slug: string): Promise<ReviewSummary> {
    if (!(await this.isPublished(slug))) return summarise([]);

    const rows = await this.reviews.find({
      where: { productSlug: slug, status: ReviewStatusEnum.APPROVED },
      select: { rating: true, verifiedPurchase: true },
    });
    return summarise(rows);
  }

  /**
   * Creates a `PENDING` review and recomputes the product's aggregates.
   *
   * `verifiedPurchase` is **not** taken from the client — it is derived from whether this user has a
   * delivered order containing this product. Trusting a client-supplied flag would let anyone mint a
   * "Verified Purchase" badge, which is the whole value of the badge.
   *
   * Orders do not exist until the next plan, so this resolves to `false` today, with the query
   * written and commented where it belongs rather than left as a client-controlled field to be
   * tightened later.
   *
   * `isPublished` is part of the lookup, which the plan's version omitted. `GET
   * /catalog/products/:slug` 404s for an unpublished slug, so this must too — otherwise the write
   * path confirms the existence of a product the read path denies, which is the same information
   * leak from the other side.
   */
  async create(slug: string, userId: string, dto: CreateReviewDto): Promise<WireReview> {
    const product = await this.products.findOne({
      where: { slug, isPublished: true },
      select: { id: true, slug: true },
    });
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Review);
      const created = await repository.save(
        repository.create({
          productId: product.id,
          productSlug: product.slug,
          userId,
          author: dto.author.trim(),
          rating: dto.rating,
          body: dto.body.trim(),
          imageUrl: dto.imageUrl?.trim() ?? null,
          // Server-derived, never client-supplied. See the doc comment above; becomes a real lookup
          // against delivered orders in the checkout plan.
          verifiedPurchase: false,
          status: ReviewStatusEnum.PENDING,
        }),
      );

      /**
       * In the same transaction as the write, and now through a shared function rather than a
       * private method of this class.
       *
       * Plan 9.4 moved it to `review-aggregates.ts` because moderation is the other half of the
       * lifecycle that moves these columns — approving a review adds its rating to the average and
       * rejecting an approved one removes it — and `AdminReviewsService` must run the identical
       * statement. The reasoning that used to sit here (approved rows only, and why `EntityManager`
       * is spelled out rather than derived from `DataSource['transaction']`) travelled with it.
       */
      await recomputeProductReviewAggregates(manager, product.id);
      return toWireReview(created);
    });
  }
}
