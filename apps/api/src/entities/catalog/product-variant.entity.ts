import { Column, Entity, Index, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { VariantChannel } from '../enums';
import type { Inventory } from './inventory.entity';
import { Product } from './product.entity';

/** Brief §11. Eight sizes from 100g to 50kg, each with its own SKU, price and stock. */
@Entity('product_variants')
export class ProductVariant extends BaseEntity {
  @Index('idx_product_variants_product')
  @ManyToOne(() => Product, (product) => product.variants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  @Index('uq_product_variants_sku', { unique: true })
  @Column({ type: 'varchar', length: 60 })
  sku: string;

  @Column({ type: 'varchar', length: 20 })
  size: string;

  /** Canonical unit for per-100g and per-kg comparison. Brief §47. */
  @Column({ type: 'int' })
  grams: number;

  @Column({ type: 'enum', enum: VariantChannel })
  channel: VariantChannel;

  /** GST-exclusive. See `shared/src/money.ts`'s `gstOn`, which adds tax on top of this. */
  @PaiseColumn()
  pricePaise: bigint;

  /**
   * By law a consumer-facing *inclusive* figure, unlike `pricePaise` (GST-exclusive) — the
   * two are not directly comparable. Worth surfacing here rather than letting checkout
   * implementation rediscover it.
   */
  @PaiseColumn()
  mrpPaise: bigint;

  @Column({ type: 'int', default: 1 })
  moq: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToOne('Inventory', 'variant')
  inventory: Inventory | null;
}
