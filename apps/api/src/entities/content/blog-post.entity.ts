import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../base.entity';

/** Brief §28. `readingMinutes` stays derived from the body, never stored. */
@Entity('blog_posts')
export class BlogPost extends BaseEntity {
  @Index('uq_blog_posts_slug', { unique: true })
  @Column({ type: 'varchar', length: 160 })
  slug: string;

  @Column({ type: 'varchar', length: 250 })
  title: string;

  /** One of `BLOG_CATEGORIES` from `@nutwala/shared`. */
  @Index('idx_blog_posts_category')
  @Column({ type: 'varchar', length: 40 })
  category: string;

  @Column({ type: 'varchar', length: 400 })
  excerpt: string;

  @Column({ type: 'varchar', length: 500 })
  image: string;

  @Column({ type: 'varchar', length: 120 })
  author: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'boolean', default: false })
  isPublished: boolean;

  @Index('idx_blog_posts_published_at')
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  seo: { title?: string; description?: string; ogImage?: string };
}
