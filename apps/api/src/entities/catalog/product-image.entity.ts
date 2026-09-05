import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from './product.entity';

@Entity('product_images')
export class ProductImage extends BaseEntity {
  @Index('idx_product_images_product')
  @ManyToOne(() => Product, (product) => product.images, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;

  /** A URL. Brief §1 forbids generated images, so these are placeholders or remote assets. */
  @Column({ type: 'varchar', length: 500 })
  url: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  alt: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;
}
