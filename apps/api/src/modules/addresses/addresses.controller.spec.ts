import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import {
  BadRequestException,
  HttpStatus,
  ParseUUIDPipe,
  RequestMethod,
  type ExecutionContext,
} from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError } from '../../common/errors/domain-error';
import type { Address } from '../../entities/identity/address.entity';
import { AddressesController } from './addresses.controller';
import type { AddressesService } from './addresses.service';
import type { CreateAddressDto } from './dto/save-address.dto';

const ASHA: AuthenticatedUser = {
  id: 'f0000000-0000-4000-8000-00000000000a',
  role: 'CUSTOMER',
  sessionId: 'session-1',
};

const HOME_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OFFICE_ID = 'a1b2c3d4-0000-4000-8000-000000000002';

const row = (id: string, label: string, isDefault: boolean, line2: string | null): Address =>
  ({
    id,
    userId: ASHA.id,
    label,
    fullName: 'Asha Rao',
    phone: '9876543210',
    email: 'b2c@demo.in',
    line1: `${label} line one`,
    line2,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560025',
    isDefault,
    deletedAt: null,
    createdAt: new Date('2025-11-04T09:12:00.000Z'),
    updatedAt: new Date('2025-11-04T09:12:00.000Z'),
  }) as unknown as Address;

/** Default first, as `AddressesService.book` returns them. */
const BOOK: readonly Address[] = [
  row(HOME_ID, 'Home', true, 'Near Mayo Hall'),
  row(OFFICE_ID, 'Office', false, null),
];

const BODY: CreateAddressDto = {
  label: 'Studio',
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '9 Langford Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560027',
  isDefault: false,
};

interface Harness {
  controller: AddressesController;
  addresses: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    setDefault: jest.Mock;
  };
}

/**
 * Every method answers the book by default. The three that can miss are overridden per case with
 * `null`, which is the only thing `AddressesService` says about a row that is absent or someone
 * else's — it cannot tell the two apart, by design.
 */
function harness(answer: readonly Address[] | null = BOOK): Harness {
  const addresses = {
    list: jest.fn().mockResolvedValue(BOOK),
    create: jest.fn().mockResolvedValue(answer),
    update: jest.fn().mockResolvedValue(answer),
    remove: jest.fn().mockResolvedValue(answer),
    setDefault: jest.fn().mockResolvedValue(answer),
  };

  return {
    controller: new AddressesController(addresses as unknown as AddressesService),
    addresses,
  };
}

describe('AddressesController reads and writes', () => {
  it('scopes the read to the session’s user id, not to anything the caller sent', async () => {
    const { controller, addresses } = harness();

    await controller.list(ASHA);

    expect(addresses.list).toHaveBeenCalledWith(ASHA.id);
  });

  /**
   * The wire contract, answered by the mapper — and the assertion that matters is what is **not**
   * here. `SavedAddress` has no `userId`, so a spread in the mapper would ship the account's primary
   * key in the body of all five routes with nothing in the type system objecting.
   */
  it('answers the book in the wire shape, with no internal column on it', async () => {
    const { controller } = harness();

    await expect(controller.list(ASHA)).resolves.toEqual([
      {
        id: HOME_ID,
        label: 'Home',
        isDefault: true,
        fullName: 'Asha Rao',
        phone: '9876543210',
        email: 'b2c@demo.in',
        line1: 'Home line one',
        line2: 'Near Mayo Hall',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560025',
      },
      {
        id: OFFICE_ID,
        label: 'Office',
        isDefault: false,
        fullName: 'Asha Rao',
        phone: '9876543210',
        email: 'b2c@demo.in',
        line1: 'Office line one',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560025',
      },
    ]);
  });

  it('passes the body straight to the service, with the owner from the session', async () => {
    const { controller, addresses } = harness();

    await controller.create(ASHA, BODY);

    expect(addresses.create).toHaveBeenCalledWith(ASHA.id, BODY);
  });

  it('sends the id from the path and the patch from the body, and nothing else', async () => {
    const { controller, addresses } = harness();

    await controller.update(ASHA, OFFICE_ID, { label: 'Studio office' });

    expect(addresses.update).toHaveBeenCalledWith(ASHA.id, OFFICE_ID, { label: 'Studio office' });
  });

  it('removes by the id in the path, scoped to the session', async () => {
    const { controller, addresses } = harness();

    await controller.remove(ASHA, OFFICE_ID);

    expect(addresses.remove).toHaveBeenCalledWith(ASHA.id, OFFICE_ID);
  });

  it('promotes by the id in the path, scoped to the session', async () => {
    const { controller, addresses } = harness();

    await controller.setDefault(ASHA, OFFICE_ID);

    expect(addresses.setDefault).toHaveBeenCalledWith(ASHA.id, OFFICE_ID);
  });

  /**
   * **Every write answers with the whole book**, because one address's `isDefault` is a function of
   * the others: promoting one demotes another and deleting the default promotes a third. A response
   * carrying only the row the client named leaves the client's copy of a *different* row stale — two
   * *Default* badges on screen, or none.
   */
  it.each(['create', 'update', 'remove', 'setDefault'] as const)(
    'answers %s with the whole book rather than one address',
    async (route) => {
      const { controller } = harness();
      const answered =
        route === 'create'
          ? await controller.create(ASHA, BODY)
          : route === 'update'
            ? await controller.update(ASHA, OFFICE_ID, { label: 'Studio office' })
            : route === 'remove'
              ? await controller.remove(ASHA, OFFICE_ID)
              : await controller.setDefault(ASHA, OFFICE_ID);

      expect(answered.map((address) => address.label)).toEqual(['Home', 'Office']);
    },
  );
});

/**
 * **A miss is a 404, it is the same 404 on all three routes, and it is never a 403.**
 *
 * `AddressesService` answers `null` for both "no such address" and "not yours" and cannot tell them
 * apart; two statuses here would make the endpoint an oracle for other customers' address ids.
 * `ErrorCodes` has no `FORBIDDEN` member at all, which is the registry saying the same thing.
 *
 * `HttpStatus.NOT_FOUND` is passed explicitly at the throw site because **`DomainError` defaults to
 * 422** — omit it and a mistyped id answers "unprocessable entity", which no client's not-found branch
 * recognises.
 */
describe('AddressesController misses', () => {
  const attempt = async (route: 'update' | 'remove' | 'setDefault'): Promise<DomainError> => {
    const { controller } = harness(null);
    const call =
      route === 'update'
        ? controller.update(ASHA, OFFICE_ID, { label: 'Studio office' })
        : route === 'remove'
          ? controller.remove(ASHA, OFFICE_ID)
          : controller.setDefault(ASHA, OFFICE_ID);

    const failure: unknown = await call.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainError);
    return failure as DomainError;
  };

  it.each(['update', 'remove', 'setDefault'] as const)(
    'turns the service’s null into a 404 on %s',
    async (route) => {
      const failure = await attempt(route);

      expect(failure.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(failure.code).toBe('NOT_FOUND');
      expect(failure.message).toBe(`No address ${OFFICE_ID} in your account.`);
      expect(failure.details).toEqual({ id: OFFICE_ID });
    },
  );

  it('answers all three misses identically, letter for letter', async () => {
    const [edit, remove, promote] = await Promise.all([
      attempt('update'),
      attempt('remove'),
      attempt('setDefault'),
    ]);

    const shape = (failure: DomainError) => ({
      status: failure.getStatus(),
      code: failure.code,
      message: failure.message,
      details: failure.details,
    });

    expect(shape(remove)).toEqual(shape(edit));
    expect(shape(promote)).toEqual(shape(edit));
  });
});

function handlerOf(name: string): (...args: never[]) => unknown {
  const handler: unknown = Object.getOwnPropertyDescriptor(
    AddressesController.prototype,
    name,
  )?.value;
  if (typeof handler !== 'function') throw new Error(`AddressesController has no \`${name}\``);
  return handler as (...args: never[]) => unknown;
}

interface DeclaredRoute {
  name: string;
  method: string;
  path: string;
}

function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = AddressesController.prototype;
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

/** The handler names, read off the routing table rather than listed, so a sixth route is covered. */
const ROUTED = declaredRoutes().map((route) => route.name);

describe('AddressesController routing table', () => {
  /**
   * `account/addresses` on the class, so all five routes sit where §6.3 puts them. Read off the class
   * because the prefix is the half of every path no handler mentions: `@Controller('addresses')` would
   * move the whole address book to `/api/v1/addresses` and every assertion above would still pass.
   */
  it('routes all five under the account prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AddressesController)).toBe('account/addresses');
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'create', method: 'POST', path: '/' },
      { name: 'update', method: 'PATCH', path: ':id' },
      { name: 'remove', method: 'DELETE', path: ':id' },
      { name: 'setDefault', method: 'POST', path: ':id/default' },
    ]);
  });

  /**
   * **The literal-above-pattern rule, applied per verb because that is how Express matches.**
   *
   * Nest registers handlers in declaration order and Express serves the first that fits, so a
   * `@Post(':id')` declared above `@Post(':id/default')` would swallow it — `POST
   * /account/addresses/{uuid}/default` would reach the wrong handler with `id` set to the uuid and
   * `default` silently discarded. There is no such sibling today, which is exactly when one gets
   * added; written as an invariant over the whole table so the sibling is covered without anyone
   * remembering to extend this test. `catalog.controller.ts` has three literal siblings and its spec
   * pins the same rule.
   */
  it('declares no bare :id pattern above a longer path on the same verb', () => {
    for (const route of declaredRoutes()) {
      const laterOnSameVerb = declaredRoutes()
        .slice(declaredRoutes().indexOf(route) + 1)
        .filter((other) => other.method === route.method);

      const swallowed = laterOnSameVerb.filter(
        (other) => route.path === ':id' && other.path.startsWith(':id/'),
      );
      expect(swallowed).toEqual([]);
    }
  });

  /**
   * **`@HttpCode(HttpStatus.OK)` on the promotion, because Nest answers a `POST` with 201 by
   * default.** Nothing is created there — a flag moves from one existing row to another — so a 201
   * would tell every client a resource had come into being at a URL the response does not name.
   *
   * `create` deliberately carries **no** override: a row really is created, so Nest's 201 is right.
   * Asserted over the whole table rather than about one route, so a write added later has to make the
   * same decision explicitly.
   */
  it('answers the promotion with 200 and the create with Nest’s 201', () => {
    const codes = declaredRoutes().map((route) => ({
      name: route.name,
      code: Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(route.name)) as unknown,
    }));

    expect(codes).toEqual([
      { name: 'list', code: undefined },
      { name: 'create', code: undefined },
      { name: 'update', code: undefined },
      { name: 'remove', code: undefined },
      { name: 'setDefault', code: HttpStatus.OK },
    ]);
  });
});

interface ArgEntry {
  factory?: (data: unknown, context: ExecutionContext) => unknown;
  pipes?: unknown[];
}

const argEntries = (method: string): ArgEntry[] => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AddressesController, method) as
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
 * caller with no session. Every handler then reads `user.id` and 500s, which is survivable; the
 * *repair* is not. `user?.id ?? undefined` reaches TypeORM with a criterion it silently drops
 * (`SelectQueryBuilder.js:2496-2504`) and answers a stranger with every address in the database.
 *
 * Unreachable today only because these routes carry no `@Public()` and `JwtAuthGuard` refuses an
 * anonymous caller first — which is why both halves are pinned. The strict decorator's whole
 * observable behaviour is that it throws, so this is the only test that can see the difference.
 */
describe('AddressesController param decorators', () => {
  it.each(ROUTED)(
    'refuses to resolve a caller with no session on %s, so no route is optional-user',
    (method) => {
      const factories = customParamFactories(method);

      // Exactly one custom factory per handler: the user. `@Param()` and `@Body()` are built-ins and
      // carry no factory, so a second entry here would be a second identity source on the route.
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

  it.each(ROUTED)('leaves %s authenticated, with no @Public()', (method) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(method))).toBeUndefined();
  });

  /**
   * **`ParseUUIDPipe` on every `:id`, and it is a bug fix rather than ceremony.**
   *
   * `addresses.id` is a `uuid` column, so a non-uuid path parameter reaches Postgres as SQLSTATE
   * `22P02` (*invalid input syntax for type uuid*), which nothing catches — a **500** for a mistyped
   * URL, in the same family as the `22001` the label's `@MaxLength` closes. It is reachable today
   * rather than hypothetically: the page this endpoint replaces minted ids of the form
   * `adr-b2c-home`, so a browser holding a stale one sends exactly that.
   */
  it.each(['update', 'remove', 'setDefault'] as const)(
    'validates the :id on %s as a uuid before it reaches a query',
    (method) => {
      const pipes = argEntries(method).flatMap((entry) => entry.pipes ?? []);
      expect(pipes).toContain(ParseUUIDPipe);
    },
  );

  /** The two routes with no path parameter have nothing to validate, and pass no pipes. */
  it.each(['list', 'create'] as const)('passes no pipe on %s', (method) => {
    expect(argEntries(method).flatMap((entry) => entry.pipes ?? [])).toEqual([]);
  });

  /**
   * What the pipe buys, measured rather than asserted by name: the id the deleted mock used to mint is
   * refused with a **400** instead of reaching a `uuid` column.
   */
  it('refuses the deleted mock’s own id shape with a 400', async () => {
    const pipe = new ParseUUIDPipe();

    await expect(
      pipe.transform('adr-b2c-home', { type: 'param', data: 'id' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform(HOME_ID, { type: 'param', data: 'id' })).resolves.toBe(HOME_ID);
  });
});
