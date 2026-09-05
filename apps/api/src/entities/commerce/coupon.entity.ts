import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { CouponChannel, CouponScope, CouponType } from '../enums';
import { Category } from '../catalog/category.entity';

/** Brief §36. */
@Entity('coupons')
export class Coupon extends BaseEntity {
  /** Stored uppercase so lookup is exact and `save10` matches `SAVE10`. */
  @Index('uq_coupons_code', { unique: true })
  @Column({ type: 'varchar', length: 40 })
  code: string;

  @Column({ type: 'enum', enum: CouponType })
  type: CouponType;

  /**
   * Exactly one of `percentValue` / `flatValuePaise` is populated, according to `type`. Split
   * from a single polymorphic `value` column so a paise amount always goes through
   * `@PaiseColumn` like every other money field — a `CHECK` constraint enforcing "exactly one
   * populated" belongs in the migration, not here.
   */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  percentValue: string | null;

  @PaiseColumn({ nullable: true })
  flatValuePaise: bigint | null;

  @PaiseColumn({ nullable: true })
  minOrderValuePaise: bigint | null;

  /** Caps a percentage discount. Brief §36. */
  @PaiseColumn({ nullable: true })
  maxDiscountPaise: bigint | null;

  @Column({ type: 'enum', enum: CouponScope, default: CouponScope.ALL })
  appliesTo: CouponScope;

  /**
   * `SET NULL`, not `CASCADE`, unlike the structurally similar `Product.category`
   * (`RESTRICT`): deleting a category should not delete a coupon. Losing the link widens the
   * coupon's scope back to `ALL` rather than destroying it; application validation is
   * expected to catch any scope mismatch this creates.
   */
  @ManyToOne(() => Category, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ type: 'uuid', nullable: true, name: 'category_id' })
  categoryId: string | null;

  @Column({ type: 'enum', enum: CouponChannel, default: CouponChannel.ALL })
  channel: CouponChannel;

  @Column({ type: 'boolean', default: false })
  firstOrderOnly: boolean;

  @Column({ type: 'int', nullable: true })
  usageLimit: number | null;

  @Column({ type: 'int', nullable: true })
  usageLimitPerUser: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
