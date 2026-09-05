import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Category } from './category.entity';
import type { PricingTier } from './pricing-tier.entity';
import type { ProductImage } from './product-image.entity';
import type { ProductVariant } from './product-variant.entity';

@Entity('products')
export class Product extends BaseEntity {
  @Index('uq_products_slug', { unique: true })
  @Column({ type: 'varchar', length: 120 })
  slug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Index('idx_products_category')
  @ManyToOne(() => Category, (category) => category.products, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ type: 'uuid', name: 'category_id' })
  categoryId: string;

  @Column({ type: 'varchar', length: 300 })
  subtitle: string;

  @Column({ type: 'text' })
  description: string;

  /** `BESTSELLER` | `NEW` | `PREMIUM`, or null. Varchar because the frontend owns the union. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  badge: string | null;

  // Brief §30 product detail fields.
  @Column({ type: 'varchar', length: 120 })
  origin: string;

  @Column({ type: 'varchar', length: 80 })
  grade: string;

  @Column({ type: 'varchar', length: 200 })
  processing: string;

  @Column({ type: 'varchar', length: 120 })
  shelfLife: string;

  @Column({ type: 'varchar', length: 300 })
  storage: string;

  @Column({ type: 'varchar', length: 300 })
  ingredients: string;

  @Column({ type: 'varchar', length: 12 })
  hsn: string;

  /** Whole or fractional percent, e.g. 5 or 12.5. Not money, so `numeric` is right here. */
  @Column({ type: 'numeric', precision: 5, scale: 2 })
  gstRate: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  moqKg: string;

  @Column({ type: 'boolean', default: false })
  quoteOnly: boolean;

  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  /**
   * Denormalised review aggregates, recomputed when a review is approved or rejected.
   * The frontend's `Product` type carries `rating` and `reviewCount`, and computing them
   * with a correlated subquery on every product-list request would not scale.
   */
  @Column({ type: 'numeric', precision: 3, scale: 2, default: 0 })
  ratingAvg: string;

  @Column({ type: 'int', default: 0 })
  reviewCount: number;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };

  @OneToMany('ProductVariant', 'product')
  variants: ProductVariant[];

  @OneToMany('ProductImage', 'product')
  images: ProductImage[];

  @OneToMany('PricingTier', 'product')
  pricingTiers: PricingTier[];
}
