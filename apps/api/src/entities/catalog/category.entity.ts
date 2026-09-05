import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import type { Product } from './product.entity';

@Entity('categories')
export class Category extends BaseEntity {
  @Index('uq_categories_slug', { unique: true })
  @Column({ type: 'varchar', length: 80 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500 })
  image: string;

  @Column({ type: 'varchar', length: 300 })
  blurb: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isPublished: boolean;

  /** Brief §39. Held as jsonb because the three fields always travel together. */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };

  @OneToMany('Product', 'category')
  products: Product[];
}
