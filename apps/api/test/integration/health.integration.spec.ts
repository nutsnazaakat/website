import { expectError, expectSuccess, request, useIntegrationApp } from './helpers';

interface HealthReport {
  status: string;
  uptimeSeconds: number;
  database: string;
}

describe('GET /api/v1/health', () => {
  const integration = useIntegrationApp();

  it('reports ok with the database up, inside the success envelope', async () => {
    const response = await request(integration.app).get('/api/v1/health').expect(200);

    // `expect.any()` is typed `any`. Widening it to `unknown` through an annotated const keeps the
    // matcher usable inside `toEqual` with `no-unsafe-assignment` still on.
    const anyNumber: unknown = expect.any(Number);

    expect(expectSuccess<HealthReport>(response)).toEqual({
      status: 'ok',
      uptimeSeconds: anyNumber,
      database: 'up',
    });
  });

  it('sets the request id header, on a route that exists and one that does not', async () => {
    // `RequestTrackingMiddleware` is mounted by `AppModule.configure` on `'/{*path}'`; this header
    // is the only external evidence it ran, and both paths are asserted because the wildcard is
    // the thing at risk if that route pattern is ever changed again.
    const ok = await request(integration.app).get('/api/v1/health').expect(200);
    const missing = await request(integration.app).get('/api/v1/nope').expect(404);

    expect(ok.get('X-Request-Id')).toMatch(/[0-9a-f-]{36}/);
    expect(missing.get('X-Request-Id')).toMatch(/[0-9a-f-]{36}/);
  });

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(integration.app).get('/api/v1/nope').expect(404);
    const body = expectError(response);

    expect(body).toMatchObject({
      statusCode: 404,
      path: '/api/v1/nope',
      method: 'GET',
    });
    expect(body.errorId).toMatch(/^err_/);
    expect(body.requestId).toBeDefined();
  });
});
