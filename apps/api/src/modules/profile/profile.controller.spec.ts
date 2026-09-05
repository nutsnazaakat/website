import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '@nutwala/shared';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { ProfileController } from './profile.controller';
import type { ProfileService } from './profile.service';

const ASHA: AuthenticatedUser = {
  id: 'f0000000-0000-4000-8000-00000000000a',
  role: 'CUSTOMER',
  sessionId: 'session-1',
};

const PROFILE: AuthUser = {
  id: ASHA.id,
  name: 'Asha Rao',
  email: 'b2c@demo.in',
  phone: '9876543210',
  role: 'b2c',
  createdAt: '2025-11-04T09:12:00.000Z',
};

interface Harness {
  controller: ProfileController;
  profile: { read: jest.Mock; update: jest.Mock };
}

function harness(): Harness {
  const profile = {
    read: jest.fn().mockResolvedValue(PROFILE),
    update: jest.fn().mockResolvedValue({ ...PROFILE, name: 'Asha R Rao' }),
  };

  return {
    controller: new ProfileController(profile as unknown as ProfileService),
    profile,
  };
}

describe('ProfileController', () => {
  /**
   * **The owner comes from the session and from nowhere else**, which on this endpoint is the whole
   * IDOR story: there is no `:id` in either path and no `email` in either body, so there is no
   * identifier for a caller to substitute. The assertion is that the id passed on is the session's.
   */
  it('reads the profile of the session’s user id', async () => {
    const { controller, profile } = harness();

    await expect(controller.read(ASHA)).resolves.toEqual(PROFILE);

    expect(profile.read).toHaveBeenCalledWith(ASHA.id);
  });

  it('sends the body straight through, with the owner from the session', async () => {
    const { controller, profile } = harness();

    await controller.update(ASHA, { name: 'Asha R Rao', phone: '9812345678' });

    expect(profile.update).toHaveBeenCalledWith(ASHA.id, {
      name: 'Asha R Rao',
      phone: '9812345678',
    });
  });

  /**
   * **200 with the profile, not 204.** The client holds a session snapshot of this exact shape
   * (`features/auth/storage`), and a body it can write straight in is what stops the header and the
   * page disagreeing about a name that has just changed. A 204 would force a follow-up `GET /auth/me`
   * and leave a window where the two disagree.
   */
  it('answers the edit with the profile as it now stands', async () => {
    const { controller } = harness();

    await expect(controller.update(ASHA, { name: 'Asha R Rao' })).resolves.toMatchObject({
      name: 'Asha R Rao',
    });
  });
});

function handlerOf(name: string): (...args: never[]) => unknown {
  const handler: unknown = Object.getOwnPropertyDescriptor(
    ProfileController.prototype,
    name,
  )?.value;
  if (typeof handler !== 'function') throw new Error(`ProfileController has no \`${name}\``);
  return handler as (...args: never[]) => unknown;
}

interface DeclaredRoute {
  name: string;
  method: string;
  path: string;
}

function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = ProfileController.prototype;
  const routes: DeclaredRoute[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path !== 'string') continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    routes.push({ name, method: RequestMethod[verb], path });
  }

  return routes;
}

/** The handler names, read off the routing table rather than listed, so a third route is covered. */
const ROUTED = declaredRoutes().map((route) => route.name);

describe('ProfileController routing table', () => {
  /**
   * `account/profile` on the class, so both routes sit where §6.3 puts them. Read off the class because
   * the prefix is the half of every path no handler mentions: `@Controller('profile')` would move the
   * whole thing to `/api/v1/profile` and every assertion above would still pass.
   */
  it('routes both under the account prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProfileController)).toBe('account/profile');
    expect(declaredRoutes()).toEqual([
      { name: 'read', method: 'GET', path: '/' },
      { name: 'update', method: 'PATCH', path: '/' },
    ]);
  });

  /**
   * **No `@HttpCode` override on either, and that is a decision.** Nest answers 201 only for `POST`, so
   * a `PATCH` is already 200 — an explicit `@HttpCode(HttpStatus.OK)` here would be noise, and a `POST`
   * added to this controller later would inherit 201 and have to say otherwise. Asserted over the whole
   * table rather than about one route, so a third route has to make the decision explicitly.
   */
  it('answers both with Nest’s default status', () => {
    const codes = declaredRoutes().map((route) => ({
      name: route.name,
      code: Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(route.name)) as unknown,
    }));

    expect(codes).toEqual([
      { name: 'read', code: undefined },
      { name: 'update', code: undefined },
    ]);
  });

  /**
   * **`PATCH`, not `PUT`.** Both DTO fields are optional, so a one-field request is legal; `PUT` would
   * promise the body is the whole resource, which it can never be here — `email`, `role` and `isActive`
   * are part of this record and none of them is writable through it.
   */
  it('offers no PUT, because the body is never the whole resource', () => {
    expect(declaredRoutes().map((route) => route.method)).not.toContain('PUT');
  });
});

interface ArgEntry {
  factory?: (data: unknown, context: ExecutionContext) => unknown;
  pipes?: unknown[];
}

const argEntries = (method: string): ArgEntry[] => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ProfileController, method) as
    Record<string, ArgEntry> | undefined;
  return Object.values(args ?? {});
};

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

const customParamFactories = (method: string): ParamFactory[] =>
  argEntries(method)
    .map((entry) => entry.factory)
    .filter((factory): factory is ParamFactory => typeof factory === 'function');

const GUEST_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }),
} as unknown as ExecutionContext;

const SIGNED_IN_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {}, user: ASHA }) }),
} as unknown as ExecutionContext;

/**
 * **`@CurrentUser()`, not `@OptionalUser()`.**
 *
 * The two are interchangeable to `tsc` — a param decorator's return type is not the declared parameter
 * type — so `@OptionalUser() user: AuthenticatedUser` compiles and hands the handler `undefined` for a
 * caller with no session. The 500 that follows is survivable; the *repair* is not. `user?.id ??
 * undefined` reaches TypeORM with a criterion it silently drops
 * (`SelectQueryBuilder.js:2496-2504`), and `findOne` with no criteria answers with whichever `users`
 * row comes back first — a stranger's name, email and phone number in a 200 body. The `PATCH` half is
 * *safer* than the read, which is the opposite of what it looks like: `Repository.update` normalises
 * away the `undefined` and then refuses the empty criteria, so it 500s rather than writing to every
 * row. Measured by mutating both.
 *
 * Unreachable today only because neither route carries `@Public()` and `JwtAuthGuard` refuses an
 * anonymous caller first — which is why both halves are pinned. The strict decorator's whole observable
 * behaviour is that it throws, so this is the only test that can see the difference.
 */
describe('ProfileController param decorators', () => {
  it.each(ROUTED)(
    'refuses to resolve a caller with no session on %s, so neither route is optional-user',
    (method) => {
      const factories = customParamFactories(method);

      // Exactly one custom factory per handler: the user. `@Body()` is a built-in and carries no
      // factory, so a second entry here would be a second identity source on the route.
      expect(factories).toHaveLength(1);
      for (const factory of factories) {
        expect(() => factory(undefined, GUEST_CONTEXT)).toThrow(
          'CurrentUser used on a route without JwtAuthGuard',
        );
        // The positive control: with a session it resolves, so the throw above is about the absent
        // user rather than a factory that throws unconditionally.
        expect(factory(undefined, SIGNED_IN_CONTEXT)).toBe(ASHA);
      }
    },
  );

  /**
   * No `@Public()`, and the absence *is* the guard: `JwtAuthGuard` is global, so an anonymous request
   * is a 401 before this class is reached. A profile has no guest equivalent, so there is nothing here
   * that could plausibly answer an empty shape and hide a missing guard behind it.
   */
  it.each(ROUTED)('leaves %s authenticated, with no @Public()', (method) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(method))).toBeUndefined();
  });

  /** Nothing is named in either path, so there is no parameter to validate and no pipe to pass. */
  it.each(ROUTED)('passes no pipe on %s', (method) => {
    expect(argEntries(method).flatMap((entry) => entry.pipes ?? [])).toEqual([]);
  });
});
