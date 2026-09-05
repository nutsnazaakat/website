import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../enums';
import { Business } from '../identity/business.entity';
import { User } from '../identity/user.entity';
import type { OrderEvent } from './order-event.entity';
import type { OrderItem } from './order-item.entity';

/** A snapshot of a delivery address as it was at checkout. */
export interface AddressSnapshot {
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

@Entity('orders')
// Composite indexes for the actual query shapes: order history by user, and the admin list
// filtered by status and date. The single-column indexes on each part already exist for other
// access patterns, but neither substitutes for a leading-columns composite index here.
@Index('idx_orders_user_placed_at', ['userId', 'placedAt'])
@Index('idx_orders_status_placed_at', ['status', 'placedAt'])
export class Order extends BaseEntity {
  /** `NN-{year}-{at least 6 digits}`, the reference a customer quotes to support. */
  @Index('uq_orders_order_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  orderNumber: string;

  @Index('idx_orders_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @ManyToOne(() => Business, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'business_id' })
  business: Business | null;

  @Column({ type: 'uuid', nullable: true, name: 'business_id' })
  businessId: string | null;

  @Column({ type: 'enum', enum: OrderChannelEnum })
  channel: OrderChannelEnum;

  /**
   * One of the tuples in `@nutwala/shared`. Varchar with a check constraint rather than a
   * Postgres enum, so brief §33's vocabulary has exactly one definition — see Task 14.
   */
  @Index('idx_orders_status')
  @Column({ type: 'varchar', length: 24 })
  status: string;

  @Column({ type: 'enum', enum: PaymentMethodEnum })
  paymentMethod: PaymentMethodEnum;

  @Column({ type: 'enum', enum: PaymentStatusEnum, default: PaymentStatusEnum.PENDING })
  paymentStatus: PaymentStatusEnum;

  /** GST-exclusive, matching `ProductVariant.pricePaise` and `shared/src/money.ts`'s `gstOn`. */
  @PaiseColumn()
  subtotalPaise: bigint;

  @PaiseColumn({ default: 0 })
  discountPaise: bigint;

  @PaiseColumn()
  gstPaise: bigint;

  @PaiseColumn({ default: 0 })
  shippingPaise: bigint;

  @PaiseColumn()
  totalPaise: bigint;

  @Column({ type: 'varchar', length: 40, nullable: true })
  couponCode: string | null;

  /**
   * The address as it was at checkout, not a foreign key.
   *
   * Spec §5.3: a customer editing or deleting an address must not change where a past order
   * says it was delivered. This is the same reason `OrderItem` snapshots its price.
   */
  @Column({ type: 'jsonb' })
  addressSnapshot: AddressSnapshot;

  @Column({ type: 'jsonb', nullable: true })
  billingSnapshot: AddressSnapshot | null;

  // Brief §20 B2B checkout fields.
  @Column({ type: 'varchar', length: 160, nullable: true })
  companyName: string | null;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  poNumber: string | null;

  @Column({ type: 'text', nullable: true })
  specialInstructions: string | null;

  @Index('idx_orders_placed_at')
  @Column({ type: 'timestamptz' })
  placedAt: Date;

  @Column({ type: 'timestamptz' })
  estimatedDelivery: Date;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  cancelReason: string | null;

  @OneToMany('OrderItem', 'order', { cascade: ['insert'] })
  items: OrderItem[];

  @OneToMany('OrderEvent', 'order', { cascade: ['insert'] })
  events: OrderEvent[];
}
