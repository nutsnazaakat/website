import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import { CatalogController } from './catalog.controller';

interface DeclaredRoute {
  method: string;
  path: string;
  handler: (...args: never[]) => unknown;
}

/**
 * The controller's routes, in the order the class declares them.
 *
 * `@Get('…')` stores its path on the handler function itself (`RequestMapping` writes
 * `PATH_METADATA` to `descriptor.value`), and Nest registers handlers in
 * `Object.getOwnPropertyNames(prototype)` order — declaration order — which is the order Express
 * then matches them in. So reading the paths off the prototype in that order reads the routing
 * table, not a restatement of the source.
 */
function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = CatalogController.prototype;
  const routes: DeclaredRoute[] = [];

  for (const method of Object.getOwnPropertyNames(prototype)) {
    if (method === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, method)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path === 'string') {
      routes.push({ method, path, handler: handler as (...args: never[]) => unknown });
    }
  }

  return routes;
}

describe('CatalogController', () => {
  it('exposes the routes the catalogue seam calls', () => {
    expect(declaredRoutes().map((route) => route.path)).toEqual([
      'products',
      'products/facets',
      'products/bestsellers',
      'products/:slug',
      'products/:slug/related',
      'categories',
      'categories/:slug',
      'combos',
      'bulk/products',
      'bulk/quote-preview',
    ]);
  });

  /**
   * The one ordering rule this controller has, and the only thing enforcing it.
   *
   * `products/:slug` matches a single literal segment, so any literal route under `products/`
   * declared *after* it is unreachable: the request lands on `getProduct` and answers 404 for a
   * product nobody named. Verified by experiment before this test was written — with the two
   * swapped, `GET /catalog/products/bestsellers` returned
   * `{"code":"NOT_FOUND","message":"That product may have been renamed or is no longer stocked."}`.
   *
   * Written as an invariant over the whole list rather than an assertion about `bestsellers`, so
   * `products/facets` — the route the plan warns about, and which 404s identically if it lands
   * below the slug pattern — was covered the moment it was added, without anyone remembering to
   * extend this test. The list assertion above is not that: it enumerates, so it had to be
   * extended when the facets route arrived. That is the difference between a control and an
   * inventory, and both are worth having.
   */
  it('declares every literal products/ route above the products/:slug pattern', () => {
    const paths = declaredRoutes().map((route) => route.path);
    const slugAt = paths.indexOf('products/:slug');
    expect(slugAt).toBeGreaterThanOrEqual(0);

    const shadowed = paths
      .slice(slugAt + 1)
      .filter((path) => path.startsWith('products/') && !path.includes(':'));
    expect(shadowed).toEqual([]);
  });

  /**
   * `JwtAuthGuard` is global, so a route without `@Public()` 401s — and the catalogue is what an
   * anonymous visitor sees first. A missing decorator is invisible in review and obvious in
   * production.
   */
  it('marks every route public, because most visitors have no session', () => {
    const guarded = declaredRoutes()
      .filter((route) => Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) !== true)
      .map((route) => route.path);
    expect(guarded).toEqual([]);
  });
});
