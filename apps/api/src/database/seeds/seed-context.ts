import type { DataSource } from 'typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { User } from '../../entities/identity/user.entity';

/**
 * Shared plumbing for the seeders in this directory.
 *
 * Every seeder is standalone — `npm run seed -- orders` must work against an already-seeded
 * database — so nothing here caches ids between seeders. The lookup helpers read the
 * database each time instead, which is what makes a single-domain reseed possible.
 */

/** A seeder takes the DataSource and returns the number of rows it wrote. */
export type Seeder = (dataSource: DataSource) => Promise<number>;

/**
 * Ported from the `img` map in `frontend/src/mocks/categories.ts`.
 *
 * The four non-placeholder entries are `import`ed image files there, which Vite rewrites to
 * a content-hashed bundle URL at build time. A hash is not something a database row can
 * hold, so the stored value is a site-relative path naming the same file in
 * `frontend/src/assets/`. `placeholder` keeps the mock's remote URL verbatim.
 *
 * Consequence, recorded rather than hidden: these four paths only resolve once those assets
 * are served from a stable public path. That is a Phase 3 wiring step, not something this
 * seeder can invent a URL for — and inventing a remote URL for a photograph nobody has
 * taken would be worse, since brief §1 forbids generated imagery.
 */
export const IMAGES = {
  almonds: '/assets/cat-almonds.jpg',
  cashews: '/assets/cat-cashews.jpg',
  pistachios: '/assets/cat-pistachios.jpg',
  mixed: '/assets/hero-dryfruits.jpg',
  placeholder: 'https://placehold.co/800x800',
} as const;

/**
 * Fails loudly on a missing lookup.
 *
 * A seeder that silently skips a row it could not resolve produces a database that looks
 * seeded and is quietly incomplete — which every later test then asserts against. A slug
 * that no longer exists is a broken port, so it stops the run.
 */
export function requireValue<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`Seed data references ${description}, which does not exist in the database`);
  }
  return value;
}

/** slug -> product id, for the seeders that reference products by slug. */
export async function loadProductIdsBySlug(
  dataSource: DataSource,
): Promise<ReadonlyMap<string, string>> {
  const products = await dataSource
    .getRepository(Product)
    .find({ select: { id: true, slug: true } });
  return new Map(products.map((product) => [product.slug, product.id]));
}

/** slug -> product `hsn`, so an order line can snapshot the HSN of what it sold. */
export async function loadProductHsnBySlug(
  dataSource: DataSource,
): Promise<ReadonlyMap<string, string>> {
  const products = await dataSource
    .getRepository(Product)
    .find({ select: { slug: true, hsn: true } });
  return new Map(products.map((product) => [product.slug, product.hsn]));
}

/** `${slug}|${size}` -> variant id. Two products can share a size, so the slug is part of the key. */
export function variantKey(productSlug: string, size: string): string {
  return `${productSlug}|${size}`;
}

export async function loadVariantIdsByKey(
  dataSource: DataSource,
): Promise<ReadonlyMap<string, string>> {
  const variants = await dataSource.getRepository(ProductVariant).find({
    select: { id: true, size: true },
    relations: { product: true },
  });
  return new Map(
    variants.map((variant) => [variantKey(variant.product.slug, variant.size), variant.id]),
  );
}

/** email -> user id. Emails are stored lowercased, and the keys here are lowercased to match. */
export async function loadUserIdsByEmail(
  dataSource: DataSource,
): Promise<ReadonlyMap<string, string>> {
  const users = await dataSource.getRepository(User).find({ select: { id: true, email: true } });
  return new Map(users.map((user) => [user.email.toLowerCase(), user.id]));
}
