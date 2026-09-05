import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from '../catalog/product.entity';
import { Rfq } from './rfq.entity';

@Entity('rfq_items')
export class RfqItem extends BaseEntity {
  @Index('idx_rfq_items_rfq')
  @ManyToOne(() => Rfq, (rfq) => rfq.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @ManyToOne(() => Product, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'product_id' })
  product: Product | null;

  @Column({ type: 'uuid', nullable: true, name: 'product_id' })
  productId: string | null;

  /** Kept alongside the id so an unpublished product still shows on a historic RFQ. */
  @Column({ type: 'varchar', length: 120 })
  productSlug: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  kg: string;
}
