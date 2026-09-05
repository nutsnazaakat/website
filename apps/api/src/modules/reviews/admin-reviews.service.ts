import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminReview, Paginated, ReviewStatus } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Review } from '../../entities/content/review.entity';
import { ReviewStatus as ReviewStatusEnum } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { AdminReviewQueryDto } from './dto/admin-review-query.dto';
import type { RejectReviewDto } from './dto/reject-review.dto';
import { toAdminReview } from './mappers/admin-review.mapper';
import { recomputeProductReviewAggregates } from './review-aggregates';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * Wire vocabulary to the database enum, keyed on the wire side so `ReviewStatus` gaining a member
 * is a compile error. `review.mapper.ts` owns the other direction.
 */
const TO_ENTITY_STATUS: Record<ReviewStatus, ReviewStatusEnum> = {
  pending: ReviewStatusEnum.PENDING,
  approved: ReviewStatusEnum.APPROVED,
  rejected: ReviewStatusEnum.REJECTED,
};

/**
 * Brief §27's moderation queue — `GET /admin/reviews`, `POST /admin/reviews/:id/approve` and
 * `.../reject`, spec §6.4.
 *
 * **A second service beside `ReviewsService`, not extra methods on it**, for the reason
 * `AdminOrdersService` gives about `OrdersService`: every read there is scoped to what the public
 * may see — `listForProduct` and `summaryForProduct` both filter `status: APPROVED` — and an
 * unscoped read sitting beside them is one careless reuse away from putting an unmoderated review
 * on a product page. Here the queue is *defined* by reading the rows the storefront must not.
 *
 * **Approve and reject are status transitions, and each one moves the product's rating.** That is
 * the part a status flip alone would miss: `products.ratingAvg` and `reviewCount` are computed from
 * approved rows only, so approving adds a rating to the public average and rejecting a
 * previously-approved review removes one. Both directions run through
 * `recomputeProductReviewAggregates`, in the same transaction, which is why that function was
 * lifted out of `ReviewsService` rather than copied.
 *
 * **A second approve writes nothing at all — not the recompute, and not an audit row.** Plan 9.1's
 * rule that a write which changes nothing leaves no trace, applied here because a trail showing two
 * approvals of one review would read as two moderators disagreeing.
 */
@Injectable()
export class AdminReviewsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/reviews` — **`pending` by default**, because that is the queue an operator opens
   * this page for. `?status=approved` and `?status=rejected` are how you look at the rest.
   *
   * Ordered oldest first, which is the opposite of every other admin list here and deliberate: a
   * moderation queue is worked from the front, and the review that has been waiting longest is the
   * one a customer is most likely to be wondering about. `id` is the tiebreak, because `createdAt`
   * is not unique — `content.seed.ts` writes fourteen rows in one transaction — and an unstable
   * tiebreak over `LIMIT`/`OFFSET` returns one row on two pages and loses another entirely.
   *
   * Rows whose product has since been deleted are listed like any other: `product_id` is
   * `ON DELETE SET NULL` and `productSlug` is a snapshot, so the review still says what it was
   * about. Hiding them would leave a pending review nobody could ever act on.
   */
  async list(query: AdminReviewQueryDto): Promise<Paginated<AdminReview>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource
      .getRepository(Review)
      .createQueryBuilder('review')
      // The default lives here rather than in the DTO, so `?status=` and an omitted parameter are
      // still distinguishable and the queue's definition stays in the service that serves it.
      .where('review.status = :status', { status: TO_ENTITY_STATUS[query.status ?? 'pending'] });

    if (query.productSlug !== undefined) {
      builder.andWhere('review.productSlug = :productSlug', { productSlug: query.productSlug });
    }

    const [rows, total] = await builder
      .orderBy('review.createdAt', 'ASC')
      .addOrderBy('review.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toAdminReview), total, page, limit };
  }

  /**
   * `POST /admin/reviews/:id/approve` — the review becomes visible on the storefront, and its
   * rating starts counting towards the product's average.
   */
  async approve(id: string, actorUserId: string): Promise<AdminReview> {
    return this.moderate(id, {
      actorUserId,
      status: ReviewStatusEnum.APPROVED,
      action: AuditAction.REVIEW_APPROVE,
      rejectionReason: null,
    });
  }

  /**
   * `POST /admin/reviews/:id/reject` — the review stays invisible, and if it had been approved its
   * rating is taken back out of the product's average.
   *
   * The reason is stored on the row and cleared on approve, so a review that is rejected, appealed
   * and then approved does not keep a rejection note that no longer applies.
   */
  async reject(id: string, input: RejectReviewDto & { actorUserId: string }): Promise<AdminReview> {
    return this.moderate(id, {
      actorUserId: input.actorUserId,
      status: ReviewStatusEnum.REJECTED,
      action: AuditAction.REVIEW_REJECT,
      rejectionReason: input.reason?.trim() ?? null,
    });
  }

  /**
   * The one write path, so approve and reject cannot drift on the three things that are easy to get
   * half-right: the no-op check, the aggregate recompute, and the audit row inside the transaction.
   */
  private async moderate(
    id: string,
    input: {
      actorUserId: string;
      status: ReviewStatusEnum;
      action: AuditAction;
      rejectionReason: string | null;
    },
  ): Promise<AdminReview> {
    return this.dataSource.transaction(async (manager) => {
      const review = await this.loadOrThrow(manager, id);

      /**
       * **A second approve writes no row of any kind**, and the reason is stricter than tidiness:
       * `moderatedAt` would otherwise be rewritten to now, losing the only record of when the
       * decision was actually taken. The status *and* the reason are both compared, so re-rejecting
       * with a different note is a real change and is audited.
       */
      const unchanged =
        review.status === input.status && review.rejectionReason === input.rejectionReason;
      if (unchanged) return toAdminReview(review);

      const before = {
        status: review.status,
        rejectionReason: review.rejectionReason,
      };

      review.status = input.status;
      review.rejectionReason = input.rejectionReason;
      review.moderatedByUserId = input.actorUserId;
      review.moderatedAt = new Date();
      await manager.getRepository(Review).save(review);

      /**
       * In the same transaction as the status change, and **skipped when the product is gone**.
       * `productId` is nullable — a moderator can legitimately reject a review whose product was
       * deleted since it was written — and there is then no row to recompute.
       */
      if (review.productId !== null) {
        await recomputeProductReviewAggregates(manager, review.productId);
      }

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: AuditEntity.REVIEW,
        entityId: review.id,
        before,
        after: { status: review.status, rejectionReason: review.rejectionReason },
      });

      return toAdminReview(review);
    });
  }

  private async loadOrThrow(manager: EntityManager, id: string): Promise<Review> {
    const review = await manager.getRepository(Review).findOne({ where: { id } });
    if (!review) {
      throw new DomainError(ErrorCodes.NOT_FOUND, 'No such review.', HttpStatus.NOT_FOUND, {
        reviewId: id,
      });
    }
    return review;
  }
}
