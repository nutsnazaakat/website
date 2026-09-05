import { PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import { ContentController } from './content.controller';

interface DeclaredRoute {
  method: string;
  path: string;
  handler: (...args: never[]) => unknown;
}

/**
 * The controller's routes, in the order the class declares them.
 *
 * `catalog.controller.spec.ts`'s helper, unchanged and for the identical reason: `@Get('…')` writes
 * `PATH_METADATA` onto the handler function itself, and Nest registers handlers in
 * `Object.getOwnPropertyNames(prototype)` order — declaration order — which is the order Express
 * then matches them in. So this reads the routing table rather than restating the source.
 */
function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = ContentController.prototype;
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

describe('ContentController', () => {
  it('exposes spec §6.1’s three /content/posts routes', () => {
    expect(declaredRoutes().map((route) => route.path)).toEqual([
      'posts',
      'posts/:slug',
      'posts/:slug/related',
    ]);
  });

  /**
   * The control rather than the inventory, written the way `catalog.controller.spec.ts` writes its
   * equivalent: an invariant over the whole list, so a literal added later is covered without
   * anyone remembering to extend this test.
   *
   * `posts/:slug` matches a single literal segment, so any literal route under `posts/` declared
   * *after* it is unreachable — `GET /content/posts/featured` would land on `get('featured')` and
   * answer 404 for a post nobody named. There is no such route today, which is exactly when one
   * gets added and nobody can work out why it 404s.
   */
  it('declares every literal posts/ route above the posts/:slug pattern', () => {
    const paths = declaredRoutes().map((route) => route.path);
    const slugAt = paths.indexOf('posts/:slug');
    expect(slugAt).toBeGreaterThanOrEqual(0);

    const shadowed = paths
      .slice(slugAt + 1)
      .filter((path) => path.startsWith('posts/') && !path.includes(':'));
    expect(shadowed).toEqual([]);
  });

  /**
   * `JwtAuthGuard` is global, so a route without `@Public()` 401s — and the blog is read by
   * visitors who have never signed in. A missing decorator is invisible in review and obvious in
   * production.
   */
  it('marks every route public, because the blog has no session behind it', () => {
    const guarded = declaredRoutes()
      .filter((route) => Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) !== true)
      .map((route) => route.path);
    expect(guarded).toEqual([]);
  });
});
