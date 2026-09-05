import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { ROLES_KEY } from '../../src/common/auth/decorators/roles.decorator';
import { UserRole } from '../../src/entities/enums';
import { useIntegrationApp } from './helpers';

/**
 * Every route the application actually registers, paired with the `@Roles()` metadata `RolesGuard`
 * would read for it.
 *
 * `roles` is deliberately `readonly string[]`, not `UserRole[]`: narrowing it here would hide the
 * one mistake this suite most needs to catch. `@Roles('admin')` — the wire role instead of the
 * database enum — type-checks at the call site only if someone casts, but the metadata it writes is
 * `['admin']`, and `RolesGuard` then compares `'ADMIN'` from the token against it and refuses every
 * admin. Filtering the array down to known `UserRole` values would turn that into `[]`, which the
 * guard treats as *no* `@Roles()` at all, i.e. open. So the raw strings are carried through and
 * compared against `[UserRole.ADMIN]` exactly.
 */
interface DiscoveredRoute {
  controller: string;
  handler: string;
  verb: string;
  /** No global prefix: `admin/inventory/:variantId`, not `api/v1/admin/inventory/:variantId`. */
  path: string;
  /** What the guard resolves — handler metadata overriding class metadata, or `undefined`. */
  roles: readonly string[] | undefined;
  /** Class-level metadata on its own, which is where the convention requires the decorator. */
  classRoles: readonly string[] | undefined;
}

/** `Reflect.getMetadata` is typed `any`; this is the one place that `any` is allowed to exist. */
function readMetadata(key: string, target: object): unknown {
  const value: unknown = Reflect.getMetadata(key, target);
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * `undefined` means no `@Roles()` — which `RolesGuard` reads as "any authenticated user". A value
 * that is present but not an array of strings is impossible through the decorator and is reported
 * verbatim rather than discarded, so a route holding one fails loudly instead of looking unguarded.
 */
function readRoles(target: object): readonly string[] | undefined {
  const raw = readMetadata(ROLES_KEY, target);
  if (raw === undefined) return undefined;
  return isStringArray(raw) ? raw : [`<not a string[]: ${JSON.stringify(raw)}>`];
}

function readPaths(target: object): string[] {
  const raw = readMetadata(PATH_METADATA, target);
  if (typeof raw === 'string') return [raw];
  if (isStringArray(raw)) return raw;
  return [];
}

function readVerb(target: object): string | undefined {
  const raw = readMetadata(METHOD_METADATA, target);
  // `RequestMethod.GET` is `0`, so a truthiness check here would drop every GET route on the floor.
  if (typeof raw !== 'number') return undefined;
  const name: string | undefined = RequestMethod[raw];
  return name ?? `METHOD_${String(raw)}`;
}

/** `'admin'` + `':id'` -> `'admin/:id'`; `'/'` and `''` contribute nothing. */
function joinPath(controllerPath: string, handlerPath: string): string {
  return [controllerPath, handlerPath]
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Walks the compiled application rather than a list somebody has to maintain.
 *
 * `ModulesContainer` is what Nest's own `RoutesResolver` iterates to build the router, so every
 * controller reachable here is a controller the application serves — including one added by a
 * module a future task imports without telling this file about it. That is the entire point: a
 * hand-written roster of admin controllers would be the same "someone must remember" failure as the
 * missing decorator it is meant to catch, one level up.
 *
 * Route paths are read the way the router builds them (class `PATH_METADATA` joined to each
 * handler's) and the `@Roles()` lookup mirrors `RolesGuard`'s `getAllAndOverride([handler, class])`
 * precedence, so what this suite measures is what the guard will actually enforce at runtime.
 */
function discoverRoutes(app: INestApplication): DiscoveredRoute[] {
  const scanner = new MetadataScanner();
  const routes: DiscoveredRoute[] = [];

  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const prototype: unknown = controller.prototype;
      if (typeof prototype !== 'object' || prototype === null) continue;

      const classRoles = readRoles(controller);
      const controllerPaths = readPaths(controller);

      for (const handler of scanner.getAllMethodNames(prototype)) {
        const method: unknown = Reflect.get(prototype, handler);
        if (typeof method !== 'function') continue;
        const verb = readVerb(method);
        if (verb === undefined) continue;

        const handlerRoles = readRoles(method);
        for (const controllerPath of controllerPaths) {
          for (const handlerPath of readPaths(method)) {
            routes.push({
              controller: controller.name,
              handler,
              verb,
              path: joinPath(controllerPath, handlerPath),
              roles: handlerRoles ?? classRoles,
              classRoles,
            });
          }
        }
      }
    }
  }

  return routes;
}

const isAdminRoute = (route: DiscoveredRoute): boolean => /^admin(\/|$)/.test(route.path);

const describeRoute = (route: DiscoveredRoute): string =>
  `${route.controller}.${route.handler} (${route.verb} /${route.path}) has ` +
  (route.roles === undefined ? 'no @Roles()' : `@Roles(${route.roles.join(', ')})`);

/**
 * The one test that has to exist before the endpoints do.
 *
 * `RolesGuard` **fails open**: it is registered globally in `app.module.ts` and returns `true` early
 * for a route carrying no `@Roles()`. A controller that loses the decorator is therefore not
 * refused — it is quietly opened to every authenticated customer. No assertion about the handler's
 * arguments or its response changes, nothing throws, and the only thing that would notice is a
 * per-controller metadata assertion that each of the milestone's admin controllers has to remember
 * to include. Twenty-seven `@Roles(ADMIN)` endpoints reachable from the public internet is too much
 * surface to secure by everyone remembering, so this discovers them instead.
 *
 * It lives in the integration suite because discovery has to be authoritative to be worth having.
 * Re-deriving the module graph from `imports` metadata would put a second, subtly different scanner
 * in the repository, and the failure mode of a scanner that is subtly wrong is finding nothing and
 * passing — which is why "the discovered set is non-empty" is asserted below rather than assumed.
 * Booting the real application removes that whole class of bug: these are the controllers Nest
 * itself resolved.
 */
describe('every admin route is guarded', () => {
  const integration = useIntegrationApp();
  let routes: DiscoveredRoute[] = [];

  beforeAll(() => {
    routes = discoverRoutes(integration.app);
  });

  /**
   * The control on the control. Two of the three assertions below are about an *absence*, and a
   * discovery bug that returned an empty array would make them pass while measuring nothing — the
   * same trap `frontend/src/test/no-admin-routes.test.ts` guards against with its "is actually
   * reading the route files" case.
   *
   * The floors are deliberately far below the real figures (about 15 controllers and 60 routes at
   * Milestone 9's start, and this milestone only adds) so that they never need maintaining. They are
   * here to catch zero, not to pin a count.
   */
  it('is actually reading the application routes', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(new Set(routes.map((route) => route.controller)).size).toBeGreaterThan(8);
    expect(routes.filter((route) => route.path.length === 0 || route.verb.length === 0)).toEqual(
      [],
    );
  });

  it('finds admin routes at all', () => {
    expect(routes.filter(isAdminRoute).length).toBeGreaterThan(0);
  });

  it('restricts every admin route to @Roles(UserRole.ADMIN)', () => {
    const adminRoutes = routes.filter(isAdminRoute);
    expect(adminRoutes.length).toBeGreaterThan(0);

    const unguarded = adminRoutes
      .filter((route) => {
        const roles = route.roles;
        return roles === undefined || roles.length !== 1 || roles[0] !== UserRole.ADMIN;
      })
      .map(describeRoute);

    expect(unguarded).toEqual([]);
  });

  /**
   * Where the decorator sits is not a style question. At the class, every handler the controller
   * ever grows is guarded by default; repeated per handler, the next handler somebody adds is open,
   * and the assertion above would not catch it until after it shipped.
   */
  it('carries the decorator on the admin controller class, not per handler', () => {
    const offenders = [
      ...new Map(
        routes.filter(isAdminRoute).map((route) => [route.controller, route] as const),
      ).values(),
    ]
      .filter((route) => {
        const roles = route.classRoles;
        return roles === undefined || roles.length !== 1 || roles[0] !== UserRole.ADMIN;
      })
      .map((route) => `${route.controller} does not carry @Roles(UserRole.ADMIN) at class level`);

    expect(offenders).toEqual([]);
  });

  /**
   * The mirror image, and the reason it is worth asserting: `@Roles(UserRole.ADMIN)` on a
   * customer-facing route is a 403 for every legitimate caller, which reads in production as "the
   * endpoint is broken" rather than as a permissions mistake.
   */
  it('puts no route outside admin/* behind @Roles(UserRole.ADMIN)', () => {
    const offenders = routes
      .filter((route) => !isAdminRoute(route))
      .filter((route) => route.roles?.includes(UserRole.ADMIN) === true)
      .map(describeRoute);

    expect(offenders).toEqual([]);
  });
});
