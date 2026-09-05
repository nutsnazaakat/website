import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { ReviewStatus } from '../enums';
import { Product } from '../catalog/product.entity';
import { User } from '../identity/user.entity';

/**
 * Brief §27. Held behind admin moderation; public endpoints return APPROVED only.
 *
 * `productId` is nullable and `SET NULL` on delete, while `productSlug` is a copy. So a
 * product deleted in admin leaves this row — the rating, the body, the image, and the whole
 * moderation trail (`moderatedByUserId`, `moderatedAt`, `rejectionReason`) — completely
 * unchanged, the same way `OrderItem` and `RfqItem` protect the record of what a customer
 * actually bought or asked about.
 */
@Entity('reviews')
export class Review extends BaseEntity {
  @Index('idx_reviews_product')
  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'uuid', nullable: true, name: 'product_id' })
  productId: string | null;

  /** Kept alongside the id so a deleted product still identifies what was reviewed. */
  @Index('idx_reviews_product_slug')
  @Column({ type: 'varchar', length: 120 })
  productSlug: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'varchar', length: 120 })
  author: string;

  /** Whole stars 1–5, enforced by a check constraint in the migration. */
  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string | null;

  /**
   * Set by the server only, after finding a DELIVERED order for this user containing this
   * product. Spec §13 — a client-supplied value here would make the badge meaningless.
   */
  @Column({ type: 'boolean', default: false })
  verifiedPurchase: boolean;

  @Index('idx_reviews_status')
  @Column({ type: 'enum', enum: ReviewStatus, default: ReviewStatus.PENDING })
  status: ReviewStatus;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'moderated_by_user_id' })
  moderatedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'moderated_by_user_id' })
  moderatedByUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  moderatedAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  rejectionReason: string | null;
}
