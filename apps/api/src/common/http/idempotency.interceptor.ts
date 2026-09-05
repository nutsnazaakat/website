import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { defer, from, Observable, of, switchMap, tap } from 'rxjs';
import type { QueryDeepPartialEntity, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../errors/domain-error';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';

/** Lower-case, because Node normalises incoming header names and `request.headers` is keyed that way. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Postgres unique-violation SQLSTATE. The only error this interceptor treats as "someone beat me". */
const UNIQUE_VIOLATION = '23505';

/**
 * The longest client key this interceptor will accept, and the reason it exists at all.
 *
 * The stored key is `` `${scope}:${clientKey}` `` against `idempotency_keys.key`, a
 * `varchar(200)`. Without a cap, a longer header made the insert fail with SQLSTATE `22001`
 * (*value too long*); `claim()` only recognises `23505`, so it rethrew and the request died as an
 * Internal Server Error — an alarm-worthy log line and a 500 for what is plainly a client error.
 * Express accepts headers far longer than this by default (its own limit is measured in kilobytes),
 * so it takes no malice to reach: the first client with a base64 blob for a key finds it.
 *
 * **128 rather than the 139 the arithmetic allows**, because the limit has to be one number a
 * client can be told rather than one that depends on which route it is calling. `scope` is
 * `varchar(60)`, so the worst case any scope can impose is `200 - 60 - 1 = 139`; 128 is under that
 * for *every* possible scope, is a number an API doc can state, and is generously above anything
 * real — a UUIDv4 is 36 characters and a ULID 26. A per-scope cap would answer 400 at different
 * lengths on different routes, which is the kind of contract nobody can write a client against.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly keys: Repository<IdempotencyKey>,
    private readonly scope: string,
  ) {}

  /**
   * The request body, hashed, so a replay can be checked against what was originally sent.
   *
   * `JSON.stringify` over the **raw parsed body**, not the validated DTO. An earlier version of
   * this docblock claimed the body had already been through `ValidationPipe` with
   * `whitelist: true`, and that is wrong in a way worth recording: Nest runs interceptors *before*
   * pipes — `RouterExecutionContext.create` builds `handler = async () => { await fnApplyPipes(...);
   * return callback.apply(...) }` and hands that to `interceptorsConsumer.intercept`, so
   * `next.handle()` is what triggers validation. `request.body` here is whatever `express.json()`
   * produced.
   *
   * The mechanism survives that, because it only ever compares one client's retry against its own
   * first attempt: a re-sent request serialises its keys in the same order it did the first time, so
   * the hashes match. What it is *not* is canonical — `{"a":1,"b":2}` and `{"b":2,"a":1}` are the
   * same request and hash differently — which is why this is a method on the interceptor rather
   * than a general helper someone might reuse against arbitrary objects.
   */
  hashOf(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const clientKey = request.headers[IDEMPOTENCY_HEADER];

    // Absent header means "not a retryable attempt", which is the ordinary case for every route that
    // is not placement. Requiring it would break every existing client.
    if (typeof clientKey !== 'string' || clientKey.length === 0) return next.handle();

    /**
     * Checked **before** the concatenation below, which is the only place it can be checked.
     *
     * Past that point the over-long value is inside the primary key and the only thing left to
     * report is the driver's `22001`, which `claim()` does not recognise and which therefore
     * surfaces as a 500. 400 is the honest answer: nothing about the request reached a handler, and
     * the fix is entirely the caller's. `VALIDATION_FAILED` with `details` keyed by the field —
     * here a header name rather than a body path — is the same envelope `validationExceptionFactory`
     * produces for a rejected body, so a client has one shape to read.
     *
     * Interceptors run **before** pipes (`RouterExecutionContext.create` puts `fnApplyPipes` inside
     * the `handler` that `next.handle()` invokes), so no `ValidationPipe` has run yet and there is
     * no DTO this could have been expressed as a decorator on. A header is not a body field.
     */
    if (clientKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'Validation failed',
        HttpStatus.BAD_REQUEST,
        {
          'Idempotency-Key': [
            `Must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters, and was ${clientKey.length}`,
          ],
        },
      );
    }

    // Scoped, because `key` is this table's primary key and `scope` is only a column — see the
    // task note. The bare header value would let two features share a namespace.
    const key = `${this.scope}:${clientKey}`;
    const requestHash = this.hashOf(request.body);

    return from(this.claim(key, requestHash)).pipe(
      switchMap((replay) => {
        // Truthiness, not `!== null`, matching `claim`'s sentinel. Sound only because every route
        // this interceptor is applied to answers with an object: a handler whose whole body were
        // `0`, `false` or `''` would store fine and then be replayed as "no claim", re-running the
        // handler. `POST /checkout/orders` returns the created order, so it cannot arise — but
        // whoever applies this to a scalar-returning route needs to know.
        if (replay) return of(replay);

        // `defer`, not a bare `next.handle()`: a handler that throws *synchronously* would throw
        // before `.pipe()` was ever reached, so the `error:` callback below would never be
        // attached and the claim would be left behind for ever. Deferring moves the call inside
        // the subscription, where a synchronous throw becomes an error notification the operators
        // below can see.
        return defer(() => next.handle()).pipe(
          tap({
            next: (body: unknown) => {
              const statusCode = context.switchToHttp().getResponse<Response>().statusCode;
              // The assertion is TypeORM's, not ours: `QueryDeepPartialEntity` maps a `jsonb`
              // column declared `Record<string, unknown>` into a deep partial whose values must
              // extend `{}`, and `unknown` does not — so an arbitrary JSON body cannot be
              // expressed through `update()`'s parameter type at all without one.
              void this.keys.update({ key }, {
                responseBody: body as Record<string, unknown>,
                statusCode,
              } as QueryDeepPartialEntity<IdempotencyKey>);
            },
            // A failed attempt must leave no claim, or the customer's retry meets their own key and
            // is refused for ever against a response that was never written.
            error: () => void this.keys.delete({ key }),
          }),
        );
      }),
    );
  }

  /**
   * Claims the key, or returns the response to replay.
   *
   * The insert comes **first**, and that ordering is the whole mechanism: two concurrent requests
   * both reach here, exactly one insert survives the primary key, and the loser is told so. Writing
   * the row after the handler instead would let both run and place two orders — which is precisely
   * the double-click this exists to stop.
   *
   * Resolves `null` when the key was claimed and the caller should go on to run the handler, or the
   * stored response body when it should not. Typed `Promise<unknown>` rather than
   * `Promise<unknown | null>` because `null` is already one of `unknown`'s inhabitants and
   * `no-redundant-type-constituents` rejects spelling it twice.
   */
  private async claim(key: string, requestHash: string): Promise<unknown> {
    try {
      await this.keys.insert({
        key,
        scope: this.scope,
        requestHash,
        responseBody: null,
        statusCode: null,
      });
      return null;
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    }

    const existing = await this.keys.findOne({ where: { key } });
    if (!existing) throw new ConflictException('Duplicate request could not be resolved.');

    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        'This Idempotency-Key was already used with a different request body.',
      );
    }

    // Claimed but unanswered: the first attempt is still in flight. Refusing is the honest answer —
    // the alternative is waiting on a transaction whose duration we do not control.
    if (existing.responseBody === null) {
      throw new ConflictException('An identical request is already in progress.');
    }

    return existing.responseBody;
  }
}
