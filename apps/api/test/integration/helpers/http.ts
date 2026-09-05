import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import supertest, { type Response } from 'supertest';

/**
 * supertest types `Response.body` as `any`, so every assertion that reaches into it raises
 * `no-unsafe-member-access` or `no-unsafe-assignment`. That cost is per assertion, not per spec:
 * left alone it grows to hundreds of warnings and the one warning that matters stops being
 * findable. Naming the expected shape at the call site fixes it without turning either rule off.
 *
 * The `as` is the whole point of the helper — it is the single place the untyped boundary is
 * crossed, and the caller states what it expects instead of asserting against `any`.
 */
export function responseBody<T>(response: { body: unknown }): T {
  return response.body as T;
}

/**
 * Binds supertest to this app's HTTP server. Every spec so far has spelled out
 * `request(app.getHttpServer())` by hand; with dozens more specs to come, this is the one place
 * that wiring needs to exist. `INestApplication<Server>` — the type `useIntegrationApp` already
 * hands back — is what keeps `getHttpServer()` a real type instead of the default
 * `INestApplication<TServer = any>`.
 */
export function request(app: INestApplication<Server>): ReturnType<typeof supertest> {
  return supertest(app.getHttpServer());
}

/**
 * A cookie-persisting client, for a flow that spans more than one request.
 *
 * `request()` starts fresh every call, which is right for a single endpoint and useless for the
 * thing auth actually has to prove: that logging in and *then* calling a protected route works,
 * that logout kills the session for the next request, and that a rotated refresh cookie replaces
 * its predecessor. Those are sequences, and the cookie jar is the state under test.
 *
 * Note this is `supertest.agent`, not a method on what `request()` returns — a `SuperTest`
 * instance has no `.agent`, so `request(app).agent(...)` does not exist.
 */
export function agent(app: INestApplication<Server>): ReturnType<typeof supertest.agent> {
  return supertest.agent(app.getHttpServer());
}

/** The success envelope `TransformInterceptor` puts on every 2xx. */
export interface SuccessBody<T> {
  success: true;
  data: T;
  message?: string;
}

/** The error envelope `GlobalExceptionFilter` puts on every failure. */
export interface ErrorBody {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string;
  code?: string;
  errorId: string;
  requestId: string;
  details?: Record<string, string[]>;
}

/**
 * Asserts a response carries the success envelope and hands back just the payload, typed. Every
 * spec that only cares about `data` would otherwise repeat `responseBody<SuccessBody<T>>(...)`
 * and then reach into `.data` itself; this is that in one call, plus the shape check most call
 * sites were skipping.
 */
export function expectSuccess<T>(response: { body: unknown }): T {
  const body = responseBody<SuccessBody<T>>(response);
  expect(body.success).toBe(true);
  return body.data;
}

/**
 * Asserts a response carries the error envelope and hands back the whole envelope, typed — unlike
 * `expectSuccess`, callers of this one are usually asserting on `code`, `details` or `errorId`
 * next, not just one field, so unwrapping down to a single property would only make them rebuild
 * the envelope type themselves.
 */
export function expectError(response: { body: unknown }): ErrorBody {
  const body = responseBody<ErrorBody>(response);
  expect(body.success).toBe(false);
  return body;
}

/**
 * Asserts a response's status and, on a mismatch, reports the **body** alongside it.
 *
 * Supertest's own `.expect(200)` throws through `_assertStatus`, whose message carries the two
 * status codes and nothing else. That is enough when the failure is reproducible and not enough
 * when it is not: the intermittent flake recorded as item 1 in `docs/known-issues.md` has now been
 * captured twice — same test, same line, an arrange-step `PUT /cart` answering 400 — and lost both
 * times, because a bare "expected 200, got 400" names no field and no rule. A 400 from this service
 * always carries a `code` and usually `details`, which is exactly the missing information.
 *
 * Use this in **arrange** steps whose failure would otherwise be attributed to the assertion the
 * test exists to make. It is not a blanket replacement for `.expect()`; where a specific status is
 * the thing under test, `.expect()` reads better and its failure is already unambiguous.
 */
export function expectStatus(response: Response, status: number): Response {
  if (response.status !== status) {
    const body = JSON.stringify(response.body, null, 2);
    throw new Error(
      `Expected HTTP ${String(status)}, received ${String(response.status)}.\n` +
        `Response body:\n${body}`,
    );
  }
  return response;
}

/**
 * The whole `Set-Cookie` entry for one cookie, attributes included, or a thrown error.
 *
 * `response.get('Set-Cookie')` is the typed route across this boundary — `Response.headers` is
 * declared `{ [index: string]: string }` by `@types/superagent` even though Node hands `set-cookie`
 * back as an array, so `headers['set-cookie'] as string[]` does not compile. The overload does.
 *
 * Throwing on a missing cookie rather than returning `''` is deliberate: `expect('').not.toMatch(
 * /HttpOnly/)` passes, so a response that stopped setting the cookie at all would satisfy every
 * negative assertion below.
 */
export function cookieEntry(response: Response, name: string): string {
  const headers = response.get('Set-Cookie') ?? [];
  const entry = headers.find((header) => header.startsWith(`${name}=`));
  if (entry === undefined) {
    throw new Error(`Response set no ${name} cookie. Set-Cookie was: ${JSON.stringify(headers)}`);
  }
  return entry;
}

/** Just the value, with the attributes stripped. */
export function cookieValue(response: Response, name: string): string {
  const pair = cookieEntry(response, name).split(';', 1)[0] ?? '';
  return pair.slice(name.length + 1);
}
