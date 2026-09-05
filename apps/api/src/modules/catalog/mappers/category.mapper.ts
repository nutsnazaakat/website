import type { Category as WireCategory } from '@nutwala/shared';
import type { Category } from '../../../entities/catalog/category.entity';

export function toWireCategory(category: Category): WireCategory {
  return {
    slug: category.slug,
    name: category.name,
    image: category.image,
    blurb: category.blurb,
    description: category.description,
  };
}
