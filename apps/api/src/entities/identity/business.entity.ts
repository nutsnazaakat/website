import { Column, Entity, Index, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { CustomerSegment } from '../enums';
import { Address } from './address.entity';
import { User } from './user.entity';

/** Brief §19. One-to-one with a `BUSINESS` user — brief §46 forbids a separate B2B account. */
@Entity('businesses')
export class Business extends BaseEntity {
  @OneToOne(() => User, (user) => user.business, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id', unique: true })
  userId: string;

  @Column({ type: 'varchar', length: 160 })
  companyName: string;

  @Column({ type: 'varchar', length: 120 })
  contactPerson: string;

  @Column({ type: 'varchar', length: 15 })
  mobile: string;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60 })
  businessType: string;

  /**
   * Brief §31. The price band this business buys at — the middle rung of
   * `PricingResolver`'s "business-specific → segment → default" (Task 2).
   *
   * Admin-set, not derived from `businessType`: see `CUSTOMER_SEGMENTS`'s docblock in
   * `@nutwala/shared` for why a self-declared registration field must never choose a price band.
   * `DEFAULT` for every business until Milestone 9's `PATCH /admin/businesses/:id` exists, which
   * is what makes this migration change nobody's prices.
   */
  @Column({ type: 'enum', enum: CustomerSegment, default: CustomerSegment.DEFAULT })
  segment: CustomerSegment;

  /**
   * Both address relations were bare `uuid` columns with no foreign key until this task —
   * verified against the live schema, the only FKs on `businesses` were `user_id` and
   * `assigned_salesperson_id`. `SET NULL` rather than `RESTRICT`: `addresses` is the customer's
   * own book to prune, soft-deleted or not, and a business record must never be the thing that
   * blocks removing one — the opposite call from `coupon_redemptions.order_id`, and for the
   * opposite reason.
   *
   * `addresses.deletedAt` is not filtered here — a relation only says what the row currently
   * points at. Every reader that resolves this into a deliverable address (`GET /business/me`,
   * Task 15) must filter `deletedAt IS NULL` itself.
   */
  @ManyToOne(() => Address, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'billing_address_id' })
  billingAddress: Address | null;

  @Column({ type: 'uuid', nullable: true, name: 'billing_address_id' })
  billingAddressId: string | null;

  @ManyToOne(() => Address, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'shipping_address_id' })
  shippingAddress: Address | null;

  @Column({ type: 'uuid', nullable: true, name: 'shipping_address_id' })
  shippingAddressId: string | null;

  /**
   * Brief §34/§35. An admin user, not a separate staff table. Indexed for the planned
   * salesperson "my businesses" view — the only FK in this schema that previously lacked one.
   */
  @Index('idx_businesses_assigned_salesperson')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_salesperson_id' })
  assignedSalesperson: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_salesperson_id' })
  assignedSalespersonId: string | null;
}
