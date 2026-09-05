import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Product } from '../catalog/product.entity';
import { ProductVariant } from '../catalog/product-variant.entity';
import { Order } from './order.entity';

/**
 * A purchased line, fully snapshotted.
 *
 * `productId` and `variantId` are nullable and `SET NULL` on delete, while `productSlug`,
 * `name` and `unitPricePaise` are copies. So a product deleted or repriced in admin leaves
 * this row — and the invoice it prints — completely unchanged.
 */
@Entity('order_items')
export class OrderItem extends BaseEntity {
  @Index('idx_order_items_order')
  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'uuid', nullable: true, name: 'product_id' })
  productId: string | null;

  @ManyToOne(() => ProductVariant, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant | null;

  @Column({ type: 'uuid', nullable: true, name: 'variant_id' })
  variantId: string | null;

  @Column({ type: 'varchar', length: 120 })
  productSlug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /**
   * Snapshot of `Product.hsn`. Required on a compliant Indian GST tax invoice, and
   * `productId` is nullable `SET NULL` — once a product is reclassified or deleted there is
   * no other way to regenerate a correct historical invoice for this line. Nullable only
   * because rows created before this column existed cannot be backfilled honestly; the
   * order-creation service always populates it going forward. Do not prune as redundant.
   */
  @Column({ type: 'varchar', length: 12, nullable: true })
  hsn: string | null;

  /** Pack size for a retail line, "25 kg" for a bulk one. Matches the frontend's `detail`. */
  @Column({ type: 'varchar', length: 40 })
  detail: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  size: string | null;

  @Column({ type: 'int', nullable: true })
  grams: number | null;

  @Column({ type: 'numeric', precision: 8, scale: 2, nullable: true })
  kg: string | null;

  @Column({ type: 'int' })
  qty: number;

  /** GST-exclusive, matching `ProductVariant.pricePaise` and `shared/src/money.ts`'s `gstOn`. */
  @PaiseColumn()
  unitPricePaise: bigint;

  /** Null when the line was fulfilled against a negotiated quote. */
  @PaiseColumn({ nullable: true })
  lineTotalPaise: bigint | null;

  @Column({ type: 'numeric', precision: 5, scale: 2 })
  gstRate: string;

  @PaiseColumn({ default: 0 })
  gstAmountPaise: bigint;
}
