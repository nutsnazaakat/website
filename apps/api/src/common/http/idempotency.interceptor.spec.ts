import { CallHandler, ConflictException, ExecutionContext, HttpStatus } from '@nestjs/common';
import { of } from 'rxjs';
import { DomainError } from '../errors/domain-error';
import {
  IdempotencyInterceptor,
  IDEMPOTENCY_HEADER,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './idempotency.interceptor';

interface Row {
  key: string;
  scope: string;
  requestHash: string;
  responseBody: Record<string, unknown> | null;
  statusCode: number | null;
}

/**
 * An in-memory stand-in for `idempotency_keys` that enforces the one property the interceptor leans
 * on: the primary key is unique, so a second insert of the same key **throws** rather than
 * overwriting. A double that silently accepted it would make every test here pass while the real
 * table rejected the second claim — the failure this whole file exists to prevent.
 */
function fakeStore() {
  const rows = new Map<string, Row>();
  return {
    rows,
    insert: jest.fn((row: Row) => {
      if (rows.has(row.key)) {
        return Promise.reject(
          Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          }),
        );
      }
      rows.set(row.key, { ...row });
      return Promise.resolve({ identifiers: [{ key: row.key }] });
    }),
    findOne: jest.fn(({ where }: { where: { key: string } }) =>
      Promise.resolve(rows.get(where.key) ?? null),
    ),
    update: jest.fn((criteria: { key: string }, patch: Partial<Row>) => {
      const existing = rows.get(criteria.key);
      if (existing) rows.set(criteria.key, { ...existing, ...patch });
      return Promise.resolve({ affected: existing ? 1 : 0 });
    }),
    // Present because the interceptor releases a claim whose handler failed. Without it the
    // release test could not observe anything, and a missing release would surface as a
    // `TypeError` from inside the `error:` callback rather than as the assertion it belongs to.
    delete: jest.fn((criteria: { key: string }) => {
      const existed = rows.delete(criteria.key);
      return Promise.resolve({ affected: existed ? 1 : 0 });
    }),
  };
}

function contextFor(header: string | undefined, body: unknown) {
  const request = { headers: header ? { [IDEMPOTENCY_HEADER]: header } : {}, body };
  const response = { statusCode: 201 };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

/**
 * Deliberately *not* annotated `: CallHandler`. It is still structurally assignable to one, which is
 * all `intercept` asks for, but leaving the type inferred makes `handle` an ordinary object property
 * rather than an interface *method* — so `expect(handler.handle)` does not trip
 * `@typescript-eslint/unbound-method`, which this repo has at error.
 */
const handlerReturning = (value: unknown) => ({
  handle: jest.fn(() => of(value)),
});

describe('IdempotencyInterceptor', () => {
  /**
   * No header is not an error. Placement is the only route that will carry one at first, and a route
   * that silently required it would fail every existing client and every integration test written
   * before this task.
   */
  it('passes a request with no key straight through', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const handler = handlerReturning({ orderNumber: 'NN-2026-000001' });

    const result = await interceptor
      .intercept(contextFor(undefined, { a: 1 }), handler)
      .toPromise();

    expect(result).toEqual({ orderNumber: 'NN-2026-000001' });
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('runs the handler once and stores its response', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');

    await interceptor
      .intercept(contextFor('abc', { lines: [] }), handlerReturning({ orderNumber: 'NN-1' }))
      .toPromise();

    // Stored under the *scoped* key, not the bare header. `key` is the table's primary key and
    // `scope` is an ordinary column, so the bare value would let two features collide — which the
    // entity's own docblock promises cannot happen.
    expect([...store.rows.keys()]).toEqual(['checkout:orders:abc']);
    expect(store.rows.get('checkout:orders:abc')).toMatchObject({
      scope: 'checkout:orders',
      responseBody: { orderNumber: 'NN-1' },
      statusCode: 201,
    });
  });

  /**
   * The point of the whole task: a replayed key answers with the stored response and **does not run
   * the handler**. If the handler runs, stock is decremented twice.
   */
  it('replays the stored response without running the handler again', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const body = { lines: [{ slug: 'almonds', qty: 1 }] };

    const first = handlerReturning({ orderNumber: 'NN-1' });
    await interceptor.intercept(contextFor('abc', body), first).toPromise();

    const second = handlerReturning({ orderNumber: 'NN-2' });
    const replayed = await interceptor.intercept(contextFor('abc', body), second).toPromise();

    expect(replayed).toEqual({ orderNumber: 'NN-1' });
    expect(second.handle).not.toHaveBeenCalled();
  });

  /**
   * The same key with a *different* body is a client bug, not a retry. Answering it with the first
   * response would tell a customer their second, different basket had been ordered.
   */
  it('refuses the same key carrying a different body', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');

    await interceptor
      .intercept(
        contextFor('abc', { lines: [{ qty: 1 }] }),
        handlerReturning({ orderNumber: 'NN-1' }),
      )
      .toPromise();

    await expect(
      interceptor
        .intercept(
          contextFor('abc', { lines: [{ qty: 2 }] }),
          handlerReturning({ orderNumber: 'NN-2' }),
        )
        .toPromise(),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /**
   * Two concurrent requests with one key. The loser must not run the handler — this is the
   * double-click case, and it is the reason the row is claimed **before** the handler runs rather
   * than written after it. A design that inserted afterwards would let both execute.
   */
  it('refuses a second request that arrives while the first is still running', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const body = { lines: [] };

    // The first claim succeeds but has not yet written a response — exactly the in-flight state.
    await store.insert({
      key: 'checkout:orders:abc',
      scope: 'checkout:orders',
      requestHash: interceptor.hashOf(body),
      responseBody: null,
      statusCode: null,
    });

    const handler = handlerReturning({ orderNumber: 'NN-2' });
    await expect(
      interceptor.intercept(contextFor('abc', body), handler).toPromise(),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  /**
   * Only SQLSTATE `23505` means "someone beat me to this key". Any other insert failure has to
   * propagate rather than being reported as 409 "duplicate request", which would tell the customer
   * to stop retrying an order that never reached the handler.
   *
   * `22001` is used as the example because it is the one this branch really did answer: an
   * over-long client key overflowed `varchar(200)` and died as a 500. That path is now closed by
   * the length cap two tests below, so the example is historical — but the branch is not, and what
   * still reaches it is every other way an insert can fail: a lost connection, a full disk, a
   * `not_null_violation` from a schema change. Those must surface as themselves.
   *
   * Added beyond the task's six tests: the task expected this branch to be unprovable against the
   * fake and deferred it to the integration task. It is provable here, and one `mockRejectedValueOnce`
   * is cheaper than a branch with no coverage until then.
   */
  it('propagates an insert failure that is not a unique violation', async () => {
    const store = fakeStore();
    store.insert.mockRejectedValueOnce(
      Object.assign(new Error('value too long for type character varying(200)'), { code: '22001' }),
    );
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const handler = handlerReturning({ orderNumber: 'NN-1' });

    await expect(interceptor.intercept(contextFor('abc', {}), handler).toPromise()).rejects.toThrow(
      'value too long',
    );
    expect(handler.handle).not.toHaveBeenCalled();
  });

  /**
   * A key too long for the column is a **400**, not the 500 it used to be.
   *
   * `key` is `${scope}:${clientKey}` against a `varchar(200)`, so with the 15-character
   * `checkout:orders` scope any client key past 184 characters made the insert fail with SQLSTATE
   * `22001`; `claim()` recognises only `23505`, so it rethrew and the request died as an Internal
   * Server Error — see the test above, which pins exactly that propagation for a genuinely
   * unexpected driver error. Express accepts headers far longer than 184 characters, so this needed
   * no malice to reach.
   *
   * The cap is checked before the concatenation, which is the only place it can be: past that point
   * the value is inside the primary key and the driver is the only thing left to complain.
   *
   * Asserted right at the boundary in both directions, because an off-by-one here is either a 500
   * that is still reachable or a 400 for a key that would have fitted.
   */
  it('refuses an over-long key with a 400 rather than letting the column reject it', () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const handler = handlerReturning({ orderNumber: 'NN-1' });
    const tooLong = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);

    expect(() => interceptor.intercept(contextFor(tooLong, {}), handler)).toThrow(DomainError);

    try {
      interceptor.intercept(contextFor(tooLong, {}), handler);
      throw new Error('the over-long key was accepted');
    } catch (error) {
      const thrown = error as DomainError;
      expect(thrown.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(thrown.code).toBe('VALIDATION_FAILED');
      // Keyed by the header's canonical spelling, matching `validationExceptionFactory`'s
      // "details keyed by field path" contract — a client reads one shape for both.
      expect(thrown.details).toEqual({
        'Idempotency-Key': [`Must be at most 128 characters, and was 129`],
      });
    }

    // Nothing was claimed and nothing ran: the refusal has to happen before either.
    expect(store.insert).not.toHaveBeenCalled();
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('accepts a key of exactly the maximum length', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const longest = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH);

    await interceptor
      .intercept(contextFor(longest, {}), handlerReturning({ orderNumber: 'NN-1' }))
      .toPromise();

    expect([...store.rows.keys()]).toEqual([`checkout:orders:${longest}`]);
  });

  /**
   * A handler that throws must leave no claim behind, or the customer's retry is refused for ever
   * with a key they cannot reuse and a response that was never stored.
   */
  it('releases the key when the handler fails', async () => {
    const store = fakeStore();
    const interceptor = new IdempotencyInterceptor(store as never, 'checkout:orders');
    const failing: CallHandler = {
      handle: jest.fn(() => {
        throw new Error('out of stock');
      }),
    };

    await expect(interceptor.intercept(contextFor('abc', {}), failing).toPromise()).rejects.toThrow(
      'out of stock',
    );
    expect(store.rows.size).toBe(0);
  });
});
