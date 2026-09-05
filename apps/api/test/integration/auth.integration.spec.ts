import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { Response } from 'supertest';
import { UserRole } from '../../src/entities/enums';
import { Business } from '../../src/entities/identity/business.entity';
import { Session } from '../../src/entities/identity/session.entity';
import { TokenService } from '../../src/modules/auth/token.service';
import { REUSE_DETECTED, ROTATED } from '../../src/modules/sessions/sessions.service';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import {
  agent,
  cookieEntry,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  responseBody,
  useIntegrationApp,
  type ErrorBody,
  type SuccessBody,
} from './helpers';

const BASE = '/api/v1/auth';

/**
 * Cookie and header names are spelled out rather than imported from `CookieService` and
 * `CsrfGuard`.
 *
 * They are wire contract: the Phase 1 frontend reads `nn_csrf` by name and echoes it in
 * `X-CSRF-Token`, and the log redactor defends `nn_access_token` and `nn_refresh_token` only
 * because those spellings contain `token` (see the comment on `CookieService`). Importing the
 * constants would make a rename typecheck and keep these tests green while every existing client
 * broke, which is the one thing a contract test must not do.
 */
const ACCESS_COOKIE = 'nn_access_token';
const REFRESH_COOKIE = 'nn_refresh_token';
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

/** Stands in for the three values that legitimately differ between any two error responses. */
const PER_REQUEST = '<per-request>';

/**
 * The user shape the API returns. Declared here rather than imported from `@nutwala/shared`'s
 * `AuthUser` on purpose: the point of these tests is to catch the response drifting away from the
 * contract, and asserting against the very type the code is built from could not do that.
 * `passwordHash` is optional so a test can assert it is absent.
 */
interface AuthUserBody {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'b2c' | 'b2b' | 'admin';
  company?: { companyName: string; contactPerson: string; businessType: string; gstin?: string };
  createdAt: string;
  passwordHash?: never;
}

interface AuthResponseBody {
  user: AuthUserBody;
  csrfToken: string;
}

describe('auth', () => {
  // `COOKIE_DOMAIN` is pinned to `127.0.0.1` in `test/integration/setup.ts`, which is what lets
  // `agent()`'s cookie jar hold anything at all — see the comment there.
  //
  // One call handles the whole lifecycle: connect the test DataSource, boot the app with a
  // generous timeout, `cleanDatabase` after every test, then close both.
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests.
   *
   * `useIntegrationApp` boots one application for the whole file, so `ThrottlerGuard`'s in-memory
   * storage is shared by every test in it, and the limits on these routes are deliberately tight:
   * three registrations per hour and five login attempts per fifteen minutes, per IP — and every
   * supertest request arrives from 127.0.0.1. Without this the fourth registration in the file
   * 429s, and the failure lands on whichever test happens to be fourth rather than on anything
   * that test did. Both rate-limit tests below exhaust their own budget inside a single test, so
   * the reset cannot weaken them.
   *
   * `onApplicationShutdown()` is called for its documented effect — cancelling the pending
   * per-hit decrement timers — not because anything is shutting down, and it is not optional.
   * Every hit schedules a `setTimeout` that reads `storage.get(key)` when it fires, so emptying
   * the map without cancelling them leaves callbacks that destructure `undefined` and take the
   * worker down a minute later, mid-test, nowhere near the cause.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'New Customer',
    email: 'new@demo.in',
    phone: '9876543210',
    password: TEST_PASSWORD,
    isBusiness: false,
    ...overrides,
  });

  const credentials = (email: string, password = TEST_PASSWORD): Record<string, unknown> => ({
    email,
    password,
  });

  describe('POST /register', () => {
    it('creates a b2c account and sets three cookies', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'New@Demo.in' }))
        .expect(201);

      // `expectSuccess<T>` is the single place the untyped supertest boundary is crossed. Reaching
      // into `response.body` directly raises `no-unsafe-member-access` on every assertion.
      const data = expectSuccess<AuthResponseBody>(response);
      expect(data.user).toMatchObject({ email: 'new@demo.in', role: 'b2c' });
      expect(data.user.company).toBeUndefined();
      expect(data.csrfToken.length).toBeGreaterThan(0);

      expect(cookieValue(response, ACCESS_COOKIE).length).toBeGreaterThan(0);
      expect(cookieValue(response, REFRESH_COOKIE).length).toBeGreaterThan(0);
      // The body's token and the cookie's are the same value — that identity is what makes
      // double-submit work at all, since the client echoes one to prove it can read the other.
      expect(cookieValue(response, CSRF_COOKIE)).toBe(data.csrfToken);
    });

    it('flags the session cookies httpOnly and the csrf cookie readable', async () => {
      // Spec §13, "XSS to account takeover". If nn_access_token is ever readable by script, one
      // injection anywhere on the site becomes a full account compromise.
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'cookies@demo.in' }))
        .expect(201);

      expect(cookieEntry(response, ACCESS_COOKIE)).toMatch(/HttpOnly/i);
      expect(cookieEntry(response, REFRESH_COOKIE)).toMatch(/HttpOnly/i);
      expect(cookieEntry(response, REFRESH_COOKIE)).toMatch(/SameSite=Strict/i);
      // Scoped to the auth routes, so the 30-day credential is not attached to every request and
      // cannot leak through an unrelated endpoint.
      expect(cookieEntry(response, REFRESH_COOKIE)).toMatch(/Path=\/api\/v1\/auth/i);
      expect(cookieEntry(response, CSRF_COOKIE)).not.toMatch(/HttpOnly/i);
      expect(cookieEntry(response, ACCESS_COOKIE)).toMatch(/Path=\/;/i);
    });

    it('never returns the password hash', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'nohash@demo.in' }))
        .expect(201);

      // `response.text` rather than a stringified `response.body`: the raw bytes are what actually
      // crossed the wire, so a hash nested anywhere at all is caught.
      expect(response.text).not.toContain('$2b$');
      expect(expectSuccess<AuthResponseBody>(response).user.passwordHash).toBeUndefined();
    });

    it('creates a b2b account with its business record', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(
          registration({
            name: 'Bulk Buyer',
            email: 'bulk@demo.in',
            phone: '9876543211',
            isBusiness: true,
            company: {
              companyName: 'Sharma Sweets',
              contactPerson: 'R Sharma',
              businessType: 'Sweet shop',
            },
          }),
        )
        .expect(201);

      const { user } = expectSuccess<AuthResponseBody>(response);
      expect(user.role).toBe('b2b');
      expect(user.company).toMatchObject({ companyName: 'Sharma Sweets' });

      // The row, not just the response: `register` writes the business through a second service,
      // and a response assembled from the request body would satisfy the check above on its own.
      const businesses = await integration.dataSource.getRepository(Business).find();
      expect(businesses).toHaveLength(1);
      expect(businesses[0]).toMatchObject({ userId: user.id, companyName: 'Sharma Sweets' });
    });

    it('rejects a role sent by the client, so an account cannot self-promote', async () => {
      // Spec §13, "privilege escalation" and "mass assignment". forbidNonWhitelisted makes
      // this a 400 rather than a silently ignored field.
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'sneaky@demo.in', role: 'admin' }))
        .expect(400);

      expect(expectError(response).code).toBe('VALIDATION_FAILED');
      // Nothing was written, so there is no admin to promote later either.
      expect(await integration.dataSource.getRepository(Session).count()).toBe(0);
    });

    it('rejects a malformed phone number using the shared regex', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'badphone@demo.in', phone: '1234567890' }))
        .expect(400);

      expect(expectError(response).details).toEqual({
        phone: ['Enter a valid 10-digit Indian mobile number'],
      });
    });

    it('rejects a duplicate email regardless of case', async () => {
      await createTestUser(integration.dataSource, { email: 'taken@demo.in' });

      const response = await request(integration.app)
        .post(`${BASE}/register`)
        .send(registration({ email: 'TAKEN@DEMO.IN' }))
        .expect(409);

      expect(expectError(response).code).toBe('EMAIL_IN_USE');
    });

    it('rate-limits registration after three attempts from one address', async () => {
      // Spec §9, and the §13 enumeration note: until email-verified signup lands this limit is the
      // only control in front of the account-existence oracle, so it must not be relaxed.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await request(integration.app)
          .post(`${BASE}/register`)
          .send(registration({ email: `flood-${String(attempt)}@demo.in` }));
        statuses.push(response.status);
      }

      expect(statuses).toEqual([201, 201, 201, 429]);
    });
  });

  describe('POST /login', () => {
    it('signs in with correct credentials', async () => {
      const user = await createTestUser(integration.dataSource);
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);

      expect(expectSuccess<AuthResponseBody>(response).user.id).toBe(user.id);
    });

    it('returns an identical body for all three login failure paths', async () => {
      // Spec §13, and the definition-of-done item this suite exists for. All three must be
      // indistinguishable: unknown email, wrong password, and a live account with the right
      // password but `isActive: false`. The deactivated path is the one most likely to drift,
      // because it is the only one where the account exists and the password is correct.
      const active = await createTestUser(integration.dataSource);
      const inactive = await createTestUser(integration.dataSource, {
        email: 'deactivated@demo.in',
        isActive: false,
      });

      const attempt = (email: string, password: string): Promise<Response> =>
        request(integration.app)
          .post(`${BASE}/login`)
          .send(credentials(email, password))
          .expect(401);

      const [wrongPassword, unknownEmail, deactivated] = await Promise.all([
        attempt(active.email, 'definitely-wrong'),
        attempt('nobody@demo.in', 'definitely-wrong'),
        attempt(inactive.email, TEST_PASSWORD),
      ]);

      /**
       * Compare the *whole* envelope rather than three named fields.
       *
       * Picking fields is what lets a leak through: asserting `message`, `code` and `statusCode`
       * means anything the filter adds later — a `details` object, a differing `path`, a `stack`
       * — would discriminate the paths while this test stayed green. Only the three per-request
       * values are neutralised, and each is asserted present first.
       *
       * They are overwritten with a marker rather than deleted so that a field vanishing from the
       * response entirely still fails, instead of quietly matching a counterpart that is also
       * missing — the same trap as hand-picking fields, one level down.
       */
      const comparable = (response: Response): ErrorBody => {
        const anyString: unknown = expect.any(String);
        const body = expectError(response);
        expect(body.timestamp).toEqual(anyString);
        expect(body.errorId).toEqual(anyString);
        expect(body.requestId).toEqual(anyString);
        return {
          ...body,
          timestamp: PER_REQUEST,
          errorId: PER_REQUEST,
          requestId: PER_REQUEST,
        };
      };

      expect(comparable(wrongPassword).message).toBe('Invalid email or password.');
      expect(comparable(unknownEmail)).toEqual(comparable(wrongPassword));
      expect(comparable(deactivated)).toEqual(comparable(wrongPassword));
      // No session was created for the account that does exist and did give the right password.
      expect(await integration.dataSource.getRepository(Session).count()).toBe(0);
    });

    it('refuses a deactivated account with the same message', async () => {
      const user = await createTestUser(integration.dataSource, { isActive: false });
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(401);

      expect(expectError(response).message).toBe('Invalid email or password.');
      expect(expectError(response).code).toBe('INVALID_CREDENTIALS');
    });

    it('issues a fresh session family per login, preventing fixation', async () => {
      const user = await createTestUser(integration.dataSource);

      await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);
      await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);

      const sessions = await integration.dataSource
        .getRepository(Session)
        .find({ where: { userId: user.id } });

      expect(sessions).toHaveLength(2);
      expect(new Set(sessions.map((session) => session.familyId)).size).toBe(2);
    });

    it('stores only a hash of the refresh token', async () => {
      const user = await createTestUser(integration.dataSource);
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);

      const refreshToken = cookieValue(response, REFRESH_COOKIE);
      const [session] = await integration.dataSource
        .getRepository(Session)
        .find({ where: { userId: user.id } });

      expect(session?.refreshTokenHash).not.toBe(refreshToken);
      // A database disclosure must hand over a digest, never a usable credential.
      expect(session?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(response.text).not.toContain(session?.refreshTokenHash ?? 'unreachable');
    });

    it('signs the database role into the token while the body carries the wire role', async () => {
      // Two vocabularies, both intentional: `RolesGuard` narrows the claim against the database
      // enum, and the Phase 1 frontend already types and persists `b2c`. Signing the wire value
      // instead would leave every admin route silently returning 403.
      const user = await createTestUser(integration.dataSource);
      const response = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);

      const claims = integration.app
        .get(TokenService)
        .verifyAccessToken(cookieValue(response, ACCESS_COOKIE));

      expect(claims.sub).toBe(user.id);
      expect(claims.role).toBe(UserRole.CUSTOMER);
      expect(expectSuccess<AuthResponseBody>(response).user.role).toBe('b2c');
    });

    it('rate-limits repeated failures', async () => {
      const user = await createTestUser(integration.dataSource);

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await request(integration.app)
          .post(`${BASE}/login`)
          .send(credentials(user.email, 'wrong'));
        statuses.push(response.status);
      }

      // Five attempts per fifteen minutes per the @Throttle on the route, then 429 — and the
      // limiter must keep refusing rather than letting the sixth failure reset the window.
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    });

    it('answers a rate-limited request with an envelope that carries no code', async () => {
      // `ThrottlerException` is not a `DomainError`, so there is no machine-readable `code` for
      // the one failure a customer is most likely to hit by accident. Pinned because the frontend
      // has to branch on `status === 429` instead, and a `code` appearing later would mean the
      // frontend could stop doing that.
      const user = await createTestUser(integration.dataSource);
      let last: Response | undefined;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        last = await request(integration.app)
          .post(`${BASE}/login`)
          .send(credentials(user.email, 'wrong'));
      }

      const body = expectError(last ?? ({} as Response));
      expect(body.statusCode).toBe(429);
      expect(body.code).toBeUndefined();
      // The wording is customer-facing copy, not a class name: the sign-in form renders
      // `error.message` straight into the page, and with no `code` to branch on the message has to
      // carry its own advice. Pinned literally because that is the whole content of `7f5a6cf`.
      expect(body.message).toBe('Too many attempts. Please wait a few minutes and try again.');
    });
  });

  describe('GET /me', () => {
    it('returns the signed-in user', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);

      const response = await client.get(`${BASE}/me`).expect(200);
      expect(expectSuccess<AuthUserBody>(response)).toMatchObject({
        id: user.id,
        email: user.email,
        role: 'b2c',
      });
    });

    it('refuses an anonymous request with 401, because a safe method skips the csrf check', async () => {
      // Not 403: `CsrfGuard` runs before `JwtAuthGuard`, but GET is a safe method and is exempt,
      // so the rejection is authentication's. The contrast with the anonymous POST below is what
      // makes the guard order visible from outside.
      await request(integration.app).get(`${BASE}/me`).expect(401);
    });

    it('refuses a forged access token', async () => {
      await request(integration.app)
        .get(`${BASE}/me`)
        .set('Cookie', `${ACCESS_COOKIE}=not.a.real.jwt`)
        .expect(401);
    });

    it('ignores an Authorization header, since the token comes from the cookie', async () => {
      const user = await createTestUser(integration.dataSource);
      const login = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);

      await request(integration.app)
        .get(`${BASE}/me`)
        .set('Authorization', `Bearer ${cookieValue(login, ACCESS_COOKIE)}`)
        .expect(401);
    });
  });

  describe('POST /refresh', () => {
    it('rotates the refresh token and issues a new session', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      const login = await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);

      const refreshed = await client.post(`${BASE}/refresh`).expect(200);

      expect(cookieValue(refreshed, REFRESH_COOKIE)).not.toBe(cookieValue(login, REFRESH_COOKIE));

      // A new refresh token on its own would not prove the session rotated; the access token's
      // `sessionId` claim is what `JwtAuthGuard` looks up on every request.
      const tokens = integration.app.get(TokenService);
      const before = tokens.verifyAccessToken(cookieValue(login, ACCESS_COOKIE));
      const after = tokens.verifyAccessToken(cookieValue(refreshed, ACCESS_COOKIE));
      expect(after.sessionId).not.toBe(before.sessionId);
      expect(after.sub).toBe(before.sub);

      const sessions = await integration.dataSource
        .getRepository(Session)
        .find({ where: { userId: user.id }, order: { createdAt: 'ASC' } });
      expect(sessions).toHaveLength(2);
      // Same family, predecessor retired as `rotated`, successor live.
      expect(new Set(sessions.map((session) => session.familyId)).size).toBe(1);
      expect(sessions[0]?.revokedReason).toBe(ROTATED);
      expect(sessions[1]?.revokedAt).toBeNull();
    });

    it('revokes the whole family when a rotated token is presented again', async () => {
      // Spec §13, "session theft". This is the stolen-token signature: two parties hold one
      // credential, neither can be told from the other, so both are signed out.
      const user = await createTestUser(integration.dataSource);
      const login = await request(integration.app)
        .post(`${BASE}/login`)
        .send(credentials(user.email))
        .expect(200);
      const original = cookieValue(login, REFRESH_COOKIE);

      await request(integration.app)
        .post(`${BASE}/refresh`)
        .set('Cookie', `${REFRESH_COOKIE}=${original}`)
        .expect(200);

      const replayed = await request(integration.app)
        .post(`${BASE}/refresh`)
        .set('Cookie', `${REFRESH_COOKIE}=${original}`)
        .expect(401);

      expect(expectError(replayed).code).toBe('REFRESH_TOKEN_REUSED');
      // The message must not distinguish theft from an ordinary expiry.
      expect(expectError(replayed).message).toBe('Your session has expired. Please sign in again.');

      const sessions = await integration.dataSource
        .getRepository(Session)
        .find({ where: { userId: user.id } });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);
      // Including the replacement the legitimate client had just been issued — that is the point.
      expect(sessions.map((session) => session.revokedReason).sort()).toEqual(
        [REUSE_DETECTED, ROTATED].sort(),
      );
    });

    it('refuses a request with no refresh cookie', async () => {
      const response = await request(integration.app).post(`${BASE}/refresh`).expect(401);
      expect(expectError(response).code).toBe('SESSION_EXPIRED');
    });
  });

  describe('POST /logout', () => {
    it('refuses an anonymous request with 403, before spending a session lookup', async () => {
      // `CsrfGuard` is registered ahead of `JwtAuthGuard` deliberately, so a forged
      // state-changing request is refused as a CSRF failure rather than an auth one.
      const response = await request(integration.app).post(`${BASE}/logout`).expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('requires the CSRF header even from a signed-in client', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);

      // The cookie alone is not enough: a cross-site page can cause a cookie to be sent but
      // cannot read it, which is the whole basis of double-submit.
      const response = await client.post(`${BASE}/logout`).expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('rejects a CSRF header that does not match the cookie', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      const login = await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);
      const issued = expectSuccess<AuthResponseBody>(login).csrfToken;

      const response = await client
        .post(`${BASE}/logout`)
        .set(CSRF_HEADER, `${issued.slice(0, -1)}x`)
        .expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    it('revokes the session, so an unexpired access token stops working immediately', async () => {
      const client = agent(integration.app);
      const tokens = integration.app.get(TokenService);
      const user = await createTestUser(integration.dataSource);
      const login = await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);

      const accessToken = cookieValue(login, ACCESS_COOKIE);
      const { csrfToken } = expectSuccess<AuthResponseBody>(login);

      const logout = await client.post(`${BASE}/logout`).set(CSRF_HEADER, csrfToken).expect(200);
      expect(responseBody<SuccessBody<null>>(logout)).toEqual({
        success: true,
        data: null,
        message: 'Signed out.',
      });

      // The row is what makes logout real — spec §9.
      const [session] = await integration.dataSource
        .getRepository(Session)
        .find({ where: { userId: user.id } });
      expect(session?.revokedAt).not.toBeNull();
      expect(session?.revokedReason).toBe('logout');

      /**
       * The load-bearing half, and the reason this project keeps a session table instead of
       * trusting a stateless JWT.
       *
       * The captured token is replayed through a *fresh* client, not through `client`: logout
       * calls `clearCookie`, which empties the agent's jar, so `client.get('/me')` would send no
       * access cookie at all and 401 for the wrong reason. That version of this test stays green
       * against a `logout` handler that never touches the database, which makes it worthless.
       *
       * `verifyAccessToken` not throwing is the other half: it proves the token is still inside
       * its fifteen minutes and still correctly signed, so the 401 below can only be coming from
       * the revoked session row.
       */
      expect(() => tokens.verifyAccessToken(accessToken)).not.toThrow();
      await request(integration.app)
        .get(`${BASE}/me`)
        .set('Cookie', `${ACCESS_COOKIE}=${accessToken}`)
        .expect(401);
    });

    it('clears all three cookies', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      const login = await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);
      const { csrfToken } = expectSuccess<AuthResponseBody>(login);

      const logout = await client.post(`${BASE}/logout`).set(CSRF_HEADER, csrfToken).expect(200);

      for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
        expect(cookieValue(logout, name)).toBe('');
        expect(cookieEntry(logout, name)).toMatch(/Expires=Thu, 01 Jan 1970/i);
      }
      // Cleared on the same path it was set on, or the browser keeps the original alongside it.
      expect(cookieEntry(logout, REFRESH_COOKIE)).toMatch(/Path=\/api\/v1\/auth/i);
    });
  });

  describe('authorization', () => {
    it('lets an authenticated customer read their own session without a csrf header', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource);
      await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);
      await client.get(`${BASE}/me`).expect(200);
    });

    it('promotes a customer to a business account per brief §46', async () => {
      const client = agent(integration.app);
      const user = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const login = await client.post(`${BASE}/login`).send(credentials(user.email)).expect(200);

      const response = await client
        .post(`${BASE}/upgrade-to-business`)
        .set(CSRF_HEADER, expectSuccess<AuthResponseBody>(login).csrfToken)
        .expect(200);

      expect(expectSuccess<AuthUserBody>(response).role).toBe('b2b');
      // Brief §46 forbids a second account: the same row is promoted in place.
      const promoted = await integration.dataSource.getRepository(Business).find();
      expect(promoted).toHaveLength(0);
      expect(expectSuccess<AuthUserBody>(response).id).toBe(user.id);
    });

    it('refuses to promote an anonymous caller', async () => {
      await request(integration.app).post(`${BASE}/upgrade-to-business`).expect(403);
    });
  });
});
