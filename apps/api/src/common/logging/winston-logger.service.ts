import { Inject, Injectable, Scope, type LoggerService } from '@nestjs/common';
import type { Logger } from 'winston';
import { getRequestContext, type RequestContext } from './request-context';
import { redact } from './pii-redactor';

/**
 * DI token for the shared winston `Logger` instance, provided via `useFactory` in
 * `LoggingModule`. Defined here rather than in `logging.module.ts` to avoid a circular import
 * between the two files: `LoggingModule` already imports `WinstonLoggerService` from this
 * module, so the token travels the same direction instead of importing back.
 *
 * Replaces the module-level `let singleton` this service used to hold, guarded by
 * `if (!singleton)`. That guard never re-fired within a process, so a second
 * `Test.createTestingModule()` silently inherited the first context's logger. Instance
 * lifetime is now Nest's to manage, not a hidden module global.
 */
export const WINSTON_LOGGER = Symbol('WINSTON_LOGGER');

export interface LogEnvelopeInput {
  context: string;
  meta?: unknown;
  request?: RequestContext;
}

/**
 * Every line carries the request identifiers and is scrubbed. `redact` runs on the way out so
 * a caller cannot forget to apply it — pulled out of the service so it can be unit tested
 * directly, which is where the redaction gap around `Error.stack` should have been caught.
 */
export function buildLogEnvelope({
  context,
  meta,
  request,
}: LogEnvelopeInput): Record<string, unknown> {
  return {
    service: 'nutwala-backend',
    context,
    requestId: request?.requestId,
    correlationId: request?.correlationId,
    userId: request?.userId,
    method: request?.method,
    url: request?.url,
    ...(meta === undefined ? {} : { meta: redact(meta) }),
  };
}

@Injectable({ scope: Scope.TRANSIENT })
export class WinstonLoggerService implements LoggerService {
  private context = 'Application';

  constructor(@Inject(WINSTON_LOGGER) private readonly logger: Logger) {}

  setContext(context: string): this {
    this.context = context;
    return this;
  }

  log(message: string, meta?: unknown): void {
    this.logger.info(message, this.envelope(meta));
  }

  error(message: string, meta?: unknown): void {
    this.logger.error(message, this.envelope(meta));
  }

  warn(message: string, meta?: unknown): void {
    this.logger.warn(message, this.envelope(meta));
  }

  debug(message: string, meta?: unknown): void {
    this.logger.debug(message, this.envelope(meta));
  }

  verbose(message: string, meta?: unknown): void {
    this.logger.verbose(message, this.envelope(meta));
  }

  private envelope(meta?: unknown): Record<string, unknown> {
    return buildLogEnvelope({ context: this.context, meta, request: getRequestContext() });
  }
}
