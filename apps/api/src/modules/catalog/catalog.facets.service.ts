import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { toRupees, type CatalogFacets } from '@nutwala/shared';
import { Repository } from 'typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { KG_PRICE_JOIN } from './catalog.service';

/**
 * The raw shape the aggregate query returns.
 *
 * `array_agg(...)` arrives as a real JS array — `pg` parses a Postgres array literal for us — so
 * `?? []` is the only guard the aggregate needs. The two money columns are the trap: `MIN()` over a
 * `bigint` column arrives as the **string** `'44900'`, because `pg` refuses to risk a 64-bit integer
 * in a JS `number`. Declaring them `string | null` is what forces the `BigInt()` call below, without
 * which `toRupees` divides a string and ₹449 renders as ₹4.49.
 */
interface FacetRow {
  origins: string[] | null;
  grades: string[] | null;
  min_price: string | null;
  max_price: string | null;
}

interface CategoryCountRow {
  slug: string;
  name: string;
  product_count: string;
}

@Injectable()
export class CatalogFacetsService {
  constructor(@InjectRepository(Product) private readonly products: Repository<Product>) {}

  /**
   * Filter options across the whole **published** catalogue, in two queries rather than by fetching
   * every product.
   *
   * The price bounds join `KG_PRICE_JOIN` — the same SQL text `CatalogService` filters and sorts on,
   * imported rather than respelled. That is the point of the import: the slider's ends have to
   * correspond to products the price filter can actually return, and two spellings of "the per-kg
   * price" that agree today are exactly how a slider comes to have a range that matches nothing.
   *
   * Raw SQL rather than the query builder because these are aggregates over the whole table with no
   * entity to hydrate. It also sidesteps the `leftJoin` restriction documented on `KG_PRICE_JOIN`.
   */
  async facets(): Promise<CatalogFacets> {
    const [row] = await this.products.query<FacetRow[]>(`
      SELECT array_agg(DISTINCT p.origin ORDER BY p.origin) AS origins,
             array_agg(DISTINCT p.grade ORDER BY p.grade)   AS grades,
             MIN(kg.kg_price)                               AS min_price,
             MAX(kg.kg_price)                               AS max_price
        FROM products p
        LEFT JOIN ${KG_PRICE_JOIN} kg ON kg.product_id = p.id
       WHERE p."isPublished" = true
    `);

    const categories = await this.products.query<CategoryCountRow[]>(`
      SELECT c.slug, c.name, count(p.id)::text AS product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p."isPublished" = true
       WHERE c."isPublished" = true
       GROUP BY c.slug, c.name, c."sortOrder"
       ORDER BY c."sortOrder" ASC
    `);

    return {
      origins: row?.origins ?? [],
      grades: row?.grades ?? [],
      // An empty catalogue yields nulls, which must not become NaN — a slider with NaN ends renders
      // as an unusable control rather than an empty one.
      minPrice: row?.min_price ? toRupees(BigInt(row.min_price)) : 0,
      maxPrice: row?.max_price ? toRupees(BigInt(row.max_price)) : 0,
      categories: categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        productCount: Number(category.product_count),
      })),
    };
  }
}
