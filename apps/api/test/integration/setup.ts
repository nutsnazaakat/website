process.env.TZ = 'UTC';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-secret-at-least-thirty-two-chars';
process.env.SWAGGER_USER = 'docs';
process.env.SWAGGER_PASSWORD = 'docs';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';
/**
 * Must match the host supertest addresses, or `agent()`'s cookie jar silently drops everything.
 *
 * `COOKIE_DOMAIN` defaults to `localhost`, so `CookieService` emits `Domain=localhost`; supertest
 * addresses the in-process server as `http://127.0.0.1:<port>`, and `cookiejar` only sends a cookie
 * whose domain is a suffix of the request host. `localhost` is not a suffix of `127.0.0.1`, so the
 * jar stores nothing, the next request carries no `Cookie` header at all, and the test fails as a
 * bare 401 or 403 that reads like an authorization bug rather than a jar problem.
 *
 * This relaxes nothing: a browser always talks to the host its cookies are scoped to, so aligning
 * the two restores the production relationship instead of bypassing it. The `Domain` attribute is
 * still emitted exactly as configured, and specs assert the flags on it as before.
 */
process.env.COOKIE_DOMAIN = '127.0.0.1';
process.env.LOG_LEVEL = 'error';
