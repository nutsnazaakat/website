import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { ApiError } from '@nutwala/shared';
import type { AppConfiguration } from '../config/app.config';
import { DomainError } from '../errors/domain-error';
import type { WinstonLoggerService } from '../logging/winston-logger.service';
import { GlobalExceptionFilter } from './global-exception.filter';

/**
 * The filter's own spec, and it did not exist until Milestone 10's security review went looking
 * for it.
 *
 * Spec §13 carries two rows whose Test column names this file's work — *"Enumeration via
 * `Error.stack` (development only)"* and *"Internal detail leakage → Production-mode response
 * contains no stack"* — and a `grep -rln GlobalExceptionFilter` across every spec in `backend/src`
 * found nothing. The control was real when read; nothing measured it. That is the more dangerous of
 * the two failure shapes, because `isDevelopment` is one word in one expression: inverting it, or
 * widening it to `!== 'production'`, turns a fail-closed check into a fail-open one with no test
 * anywhere in 1,206 unit and 761 integration cases going red.
 *
 * **Every environment assertion pins the whole key list, never `not.toHaveProperty('stack')`.**
 * Two reasons. `expect(x).not.toHaveProperty('a.b')` reads a dotted string as a property *path*
 * and has shipped in this repository passing unconditionally, so the negative form is not trusted
 * here. And the absence of `stack` is not the whole property being claimed: what production
 * promises is that its response body is *byte-identical in shape* to any other non-development
 * environment's, and a second internal field added later — a `driverError`, a `query`, a
 * `constraint` — would satisfy every `not.toHaveProperty('stack')` ever written while leaking
 * exactly what the row exists to prevent. `toEqual` over `Object.keys(...).sort()` fails for both.
 */

/**
 * Every key a `DomainError` carrying no `details` produces outside development — the exact shape of
 * a failed sign-in, which is the response §13's enumeration row is about.
 *
 * `details` is absent rather than `undefined`: the filter spreads it conditionally
 * (`...(details ? { details } : {})`), so a refusal with nothing to itemise does not publish an
 * empty bucket. That is worth pinning here, because the whole point of comparing the key *list* is
 * that a key appearing at all is the event.
 */
const DOMAIN_ERROR_KEYS = [
  'code',
  'errorId',
  'message',
  'method',
  'path',
  'requestId',
  'statusCode',
  'success',
  'timestamp',
].sort();

interface Captured {
  status: number;
  body: ApiError;
}

interface Logged {
  level: 'error' | 'warn';
  message: string;
  meta: unknown;
}

function hostFor(request: Partial<Request>, captured: Captured[]): ArgumentsHost {
  const response = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    statusCode: 200,
    json(body: ApiError) {
      captured.push({ status: this.statusCode, body });
      return this;
    },
  };

  return {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: '/api/v1/auth/login', method: 'POST', ...request }),
      getResponse: () => response as unknown as Response,
    }),
  } as unknown as ArgumentsHost;
}

function filterFor(env: AppConfiguration['env']): {
  filter: GlobalExceptionFilter;
  logs: Logged[];
} {
  const logs: Logged[] = [];
  const logger = {
    setContext: () => logger,
    error: (message: string, meta?: unknown) => logs.push({ level: 'error', message, meta }),
    warn: (message: string, meta?: unknown) => logs.push({ level: 'warn', message, meta }),
  } as unknown as WinstonLoggerService;

  const config = {
    getOrThrow: () => ({ env }) as AppConfiguration,
  } as unknown as ConfigService;

  return { filter: new GlobalExceptionFilter(logger, config), logs };
}

function catchIn(
  env: AppConfiguration['env'],
  exception: unknown,
  request: Partial<Request> = {},
): { captured: Captured; logs: Logged[] } {
  const { filter, logs } = filterFor(env);
  const captured: Captured[] = [];
  filter.catch(exception, hostFor(request, captured));

  const only = captured[0];
  if (only === undefined) throw new Error('the filter sent no response');
  expect(captured).toHaveLength(1);
  return { captured: only, logs };
}

/**
 * A `pg`/TypeORM driver failure as it actually arrives: a bare `Error` — not an `HttpException` —
 * whose `message` names the table, the column and the constraint, with the failing statement in
 * the stack. Every one of those strings is asserted absent from a non-development body below.
 */
function driverError(): Error {
  const error = new Error(
    'duplicate key value violates unique constraint "uq_users_email" — ' +
      'DETAIL: Key ("email")=(asha@demo.in) already exists.',
  );
  error.stack = `${error.message}\n    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:283:98)\n    query: INSERT INTO "users"("email") VALUES ($1)`;
  return error;
}

const DRIVER_INTERNALS = [
  'uq_users_email',
  'duplicate key value',
  'pg-protocol',
  'INSERT INTO',
  'asha@demo.in',
] as const;

describe('GlobalExceptionFilter', () => {
  describe('Error.stack crosses the wire in development only — spec §13', () => {
    it('emits the stack in development, so the two environments are genuinely different', () => {
      const { captured } = catchIn(
        'development',
        new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.', HttpStatus.UNAUTHORIZED),
      );

      // The positive half, and it is not decoration: without it, an assertion that production
      // omits `stack` would pass just as happily against a filter that never emitted one at all,
      // and the row's whole claim is that the *difference* is what is controlled.
      expect(Object.keys(captured.body)).toContain('stack');
      expect(captured.body.stack).toContain('DomainError');
    });

    it('omits it in production, asserted as the whole key list rather than one absence', () => {
      const { captured } = catchIn(
        'production',
        new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.', HttpStatus.UNAUTHORIZED),
      );

      expect(Object.keys(captured.body).sort()).toEqual(DOMAIN_ERROR_KEYS);
      expect(captured.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(captured.body.message).toBe('Invalid email or password.');
    });

    /**
     * The fail-closed property, and the reason the filter tests `env === 'development'` rather than
     * `env !== 'production'`.
     *
     * §13's row states it in the strongest terms available — *"never run a staging or demo box on
     * `NODE_ENV=development`"* — which is advice about deployment. This is the half that is a
     * property of the code: any environment value that is not the literal `development` gets the
     * safe body, so a `staging` or `demo` value added to the enum later is safe before anybody
     * remembers to think about it.
     */
    it('omits it for every environment that is not literally development', () => {
      for (const env of ['test', 'production'] as const) {
        const { captured } = catchIn(env, new Error('boom'));
        expect(Object.keys(captured.body)).not.toContain('stack');
      }
    });
  });

  describe('internal detail leakage — spec §13', () => {
    it('replaces an unclassified throw with a generic message outside development', () => {
      const { captured } = catchIn('production', driverError());

      expect(captured.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(captured.body.message).toBe('Internal server error');

      // The message is not the only place a driver error can surface. Serialising the whole body
      // is what makes this an assertion about the response rather than about one field: a `stack`,
      // a `details.query` or a future `driverError` key would all be caught here.
      const serialised = JSON.stringify(captured.body);
      for (const internal of DRIVER_INTERNALS) {
        expect(serialised).not.toContain(internal);
      }
    });

    it('reports the real message in development, so the assertion above is measuring something', () => {
      const { captured } = catchIn('development', driverError());

      expect(captured.body.message).toContain('uq_users_email');
      expect(captured.body.stack).toContain('INSERT INTO');
    });

    /**
     * `errorId` is the whole of what a production caller is given, so it has to be in the body and
     * in the log entry, and it has to be the *same* value. Two independently generated ids would
     * leave a support conversation ("my error id was err_…") unable to find the log line, which is
     * the only reason the field exists.
     */
    it('gives the caller an error id that the log entry also carries', () => {
      const { captured, logs } = catchIn('production', driverError());

      expect(captured.body.errorId).toMatch(/^err_[a-z0-9]+_[0-9a-f]{8}$/);
      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe('error');
      expect(logs[0]?.meta).toMatchObject({ errorId: captured.body.errorId });
    });
  });

  describe('PII in logs — spec §13', () => {
    /**
     * `redact()` has its own spec; what that spec cannot show is that the filter *calls* it. This
     * is the join. A 4xx is used deliberately: the warn branch is the one a failed login takes, and
     * a failed login is the request most likely to be carrying a password.
     */
    it('redacts the request body before logging it, credentials removed and email masked', () => {
      const { captured, logs } = catchIn(
        'production',
        new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.', HttpStatus.UNAUTHORIZED),
        { body: { email: 'asha@demo.in', password: 'Password123!' } },
      );

      expect(logs).toHaveLength(1);
      expect(logs[0]?.level).toBe('warn');
      expect(logs[0]?.meta).toMatchObject({
        body: { email: 'a***@demo.in', password: '[REDACTED]' },
      });

      // And the plaintext appears nowhere in the entry, not merely under a different key.
      const serialised = JSON.stringify(logs[0]?.meta);
      expect(serialised).not.toContain('Password123!');
      expect(serialised).not.toContain('asha@demo.in');

      // The refusal the caller sees is unchanged by any of this.
      expect(captured.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('redacts the query string too, which carries a token on any callback-shaped URL', () => {
      const { logs } = catchIn('production', new HttpException('Nope', HttpStatus.BAD_REQUEST), {
        query: { token: 'live-secret-value', page: '2' },
      });

      expect(logs[0]?.meta).toMatchObject({ query: { token: '[REDACTED]', page: '2' } });
      expect(JSON.stringify(logs[0]?.meta)).not.toContain('live-secret-value');
    });
  });

  describe('the envelope', () => {
    it('logs a 5xx at error with the exception attached, and a 4xx at warn without it', () => {
      expect(catchIn('production', driverError()).logs[0]).toMatchObject({ level: 'error' });

      const client = catchIn(
        'production',
        new DomainError('NOT_FOUND', 'No such order.', HttpStatus.NOT_FOUND),
      );
      expect(client.logs[0]?.level).toBe('warn');
      // The key list, not `expect.anything()`: `toMatchObject` with a matcher value is typed `any`,
      // and the property being claimed is that a 4xx entry carries no `error` at all.
      expect(Object.keys(client.logs[0]?.meta as Record<string, unknown>).sort()).toEqual([
        'body',
        'errorId',
        'method',
        'path',
        'query',
        'statusCode',
      ]);
    });

    /**
     * A `ValidationPipe` failure that reached here as Nest's own `message: string[]` rather than
     * through `validationExceptionFactory`. The envelope still has to carry a `code`, because
     * `ApiError.code` is what every client branches on.
     */
    it('turns a string[] message into VALIDATION_FAILED with the entries under details', () => {
      const { captured } = catchIn(
        'production',
        new HttpException({ message: ['email must be an email'] }, HttpStatus.BAD_REQUEST),
      );

      expect(captured.body.message).toBe('Validation failed');
      expect(captured.body.code).toBe('VALIDATION_FAILED');
      expect(captured.body.details).toEqual({ _errors: ['email must be an email'] });
    });

    it('reports requestId as "unknown" outside a tracked request rather than throwing', () => {
      const { captured } = catchIn('production', new Error('boom'));
      expect(captured.body.requestId).toBe('unknown');
    });
  });
});
