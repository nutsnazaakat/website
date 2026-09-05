import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { AuthenticatedUser } from '../jwt.strategy';
import { CurrentUser, OptionalUser } from './current-user.decorator';

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

/**
 * Reaches the factory inside a `createParamDecorator` result.
 *
 * There is no other way in: `createParamDecorator` hands back a decorator, and the factory is only
 * reachable through the `__routeArguments__` metadata Nest stores on the class when the decorator is
 * applied. Applying it to a throwaway method and reading that metadata back is what the Nest source
 * does in its own tests.
 */
function factoryOf(decorator: () => ParameterDecorator): ParamFactory {
  class Probe {
    handle(@decorator() _user: unknown): void {}
  }

  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handle') as Record<
    string,
    { factory: ParamFactory }
  >;
  const [first] = Object.values(args);
  if (!first) throw new Error('The decorator stored no route-argument metadata');
  return first.factory;
}

const contextWith = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => (user ? { user } : {}) }),
  }) as unknown as ExecutionContext;

const SIGNED_IN: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };

describe('CurrentUser', () => {
  it('injects the authenticated user', () => {
    expect(factoryOf(CurrentUser)(undefined, contextWith(SIGNED_IN))).toEqual(SIGNED_IN);
  });

  /**
   * The strict decorator stays strict, and this pins it rather than merely describing it.
   *
   * An absent user on a guarded route means `JwtAuthGuard` never ran, and returning `undefined`
   * there is how `undefined` reaches a `where: { userId }` — which TypeORM answers with *any* row
   * rather than none. Loud is correct. It is also why a route that legitimately has no user needs
   * `OptionalUser` below instead of a `| undefined` on the parameter type: the parameter's declared
   * type is not what this factory returns, so `@CurrentUser() user: AuthenticatedUser | undefined`
   * type-checks cleanly and then throws on the first guest request at runtime.
   */
  it('throws rather than yielding undefined when no user was resolved', () => {
    expect(() => factoryOf(CurrentUser)(undefined, contextWith())).toThrow(/without JwtAuthGuard/i);
  });
});

describe('OptionalUser', () => {
  it('injects the authenticated user when there is one', () => {
    expect(factoryOf(OptionalUser)(undefined, contextWith(SIGNED_IN))).toEqual(SIGNED_IN);
  });

  /**
   * The whole reason this exists. A guest must be able to hold a basket, so the cart routes are
   * `@Public()` and have to distinguish "no session" from "broken wiring" — which `CurrentUser`
   * cannot, by design.
   */
  it('yields undefined for a guest instead of throwing', () => {
    expect(factoryOf(OptionalUser)(undefined, contextWith())).toBeUndefined();
  });
});
