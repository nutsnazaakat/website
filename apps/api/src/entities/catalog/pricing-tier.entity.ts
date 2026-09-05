import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { CustomerSegment } from '../enums';
import { Business } from '../identity/business.entity';
import { Product } from './product.entity';

/**
 * Brief §16 and §31. Quantity-slab pricing per product, optionally narrowed to a segment or
 * to one business.
 *
 * Resolution order, implemented in Plan 3: a tier for this exact `businessId` wins, then one
 * for the buyer's segment, then `DEFAULT`. That ordering is why all three live in one table
 * rather than three.
 */
@Entity('pricing_tiers')
export class PricingTier extends BaseEntity {
  @Index('idx_pricing_tiers_product')
  @ManyToOne(() => Product, (product) => product.pricingTiers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  @Column({ type: 'numeric', precision: 8, scale: 2 })
  minKg: string;

  /** Null is the open-ended top slab, e.g. "50kg+". */
  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  maxKg: string | null;

  /** Null means this slab requires a quote and routes to the RFQ flow. Brief §47. */
  @PaiseColumn({ nullable: true })
  pricePerKgPaise: bigint | null;

  @Column({ type: 'enum', enum: CustomerSegment, default: CustomerSegment.DEFAULT })
  segment: CustomerSegment;

  /** Brief §31 customer-specific pricing. */
  @ManyToOne(() => Business, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'business_id' })
  business: Business | null;

  @Column({ type: 'uuid', nullable: true, name: 'business_id' })
  businessId: string | null;
}
