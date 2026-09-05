import { buildLogEnvelope } from './winston-logger.service';

describe('buildLogEnvelope', () => {
  it('carries the request identifiers and service name, and omits meta when none is given', () => {
    const envelope = buildLogEnvelope({
      context: 'OrdersController',
      request: { requestId: 'req-1', correlationId: 'corr-1', method: 'GET', url: '/orders' },
    });

    expect(envelope).toMatchObject({
      service: 'nutwala-backend',
      context: 'OrdersController',
      requestId: 'req-1',
      correlationId: 'corr-1',
      method: 'GET',
      url: '/orders',
    });
    expect(envelope).not.toHaveProperty('meta');
  });

  it('redacts meta on the way out so a caller cannot forget to', () => {
    const envelope = buildLogEnvelope({ context: 'Auth', meta: { password: 'hunter2' } });
    expect(envelope.meta).toMatchObject({ password: '[REDACTED]' });
  });

  it('regression: an Error whose message embeds a DSN password does not leak it, the way GlobalExceptionFilter logs a raw 5xx exception', () => {
    // GlobalExceptionFilter does `this.logger.error(message, { ...logMeta, error: exception })`
    // — the raw caught exception, unmodified, ends up as `meta.error`. A pg/TypeORM connection
    // failure quotes the DSN, password included, straight into `Error.message`.
    const dsn = 'postgres://app_user:s3cr3t-pw@db.internal:5432/nutwala';
    const exception = new Error(`connection failed: ${dsn}`);

    const envelope = buildLogEnvelope({
      context: 'GlobalExceptionFilter',
      meta: { error: exception },
    });
    const serialised = JSON.stringify(envelope);

    expect(serialised).not.toContain('s3cr3t-pw');
  });
});
