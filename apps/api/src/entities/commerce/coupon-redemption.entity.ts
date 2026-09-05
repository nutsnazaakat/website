import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Coupon } from './coupon.entity';
import { User } from '../identity/user.entity';

/**
 * One row per successful redemption.
 *
 * `Unique(couponId, orderId)` is the backstop against a retried checkout double-counting a
 * use. Per-user limits are counted inside the order transaction after taking
 * `SELECT ... FOR UPDATE` on the coupon row (spec §10.2), because counting then inserting is
 * otherwise a read-then-write race two concurrent checkouts can both win.
 */
@Entity('coupon_redemptions')
@Unique('uq_coupon_redemptions_coupon_order', ['couponId', 'orderId'])
export class CouponRedemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * `RESTRICT`, not `CASCADE`: `DELETE /admin/coupons/:id` is a real endpoint, and deleting a
   * used coupon must not wipe its redemption history. `Coupon.isActive` is already the
   * soft-disable path for a coupon that should stop working.
   *
   * No index here beyond the `(couponId, orderId)` unique constraint below — a dedicated
   * single-column index would duplicate that constraint's leading column, which Postgres can
   * already use for coupon-only lookups.
   */
  @ManyToOne(() => Coupon, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'coupon_id' })
  coupon: Coupon;

  @Column({ type: 'uuid', name: 'coupon_id' })
  couponId: string;

  /**
   * `SET NULL`, not `CASCADE`: deleting a user must not erase their redemptions, or a
   * coupon's usage count against `usageLimit`/`usageLimitPerUser` would under-count and the
   * coupon could be redeemed past its intended cap. The redemption row surviving with the
   * link cleared is also what a data-erasure request needs. Same pattern as
   * `InventoryTransaction.actorUser` and `OrderEvent.actorUser`.
   */
  @Index('idx_coupon_redemptions_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @PaiseColumn()
  discountPaise: bigint;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
