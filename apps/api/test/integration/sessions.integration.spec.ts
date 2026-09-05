import { HttpStatus } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { DataSource, Repository } from 'typeorm';
import type { Logger } from 'winston';
import { DomainError, ErrorCodes } from '../../src/common/errors/domain-error';
import { WINSTON_LOGGER } from '../../src/common/logging/winston-logger.service';
import { Session } from '../../src/entities/identity/session.entity';
import { TokenService } from '../../src/modules/auth/token.service';
import { SessionsModule } from '../../src/modules/sessions/sessions.module';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { useIntegrationApp } from './helpers';

/**
 * `SessionsService` against a real Postgres, because the unit fake cannot express the two things
 * that matter most here.
 *
 * 1. Concurrency. The hand-written repository in `sessions.service.spec.ts` has synchronous
 *    `findOne`/`save`, so `Promise.all([rotate(t), rotate(t)])` runs the two rotations strictly
 *    one after the other and reports "1 fulfilled, reuse detected" no matter what the service
 *    does. It would certify a read-then-write race as fixed. Only two real connections racing for
 *    the same row can tell the difference.
 * 2. `UPDATE` criteria. The fake honoured `familyId` and `userId` and silently ignored `id`, so
 *    `revoke(id)` passed against an implementation with no filter at all — the regression where
 *    logging out of one device signs you out everywhere. That gap in the fake is closed too, but a
 *    fake is only ever as honest as the last person to edit it; Postgres honours the criterion it
 *    is given whatever anyone believes about it.
 */

const meta = { userAgent: 'integration', ip: '127.0.0.1' };

/**
 * Widened to `number` deliberately. `HttpException#getStatus()` returns `number`, and comparing it
 * to an `HttpStatus` member directly trips `no-unsafe-enum-comparison`. Naming the widened value
 * once is clearer than an inline cast at each use, and it stays tied to the enum member.
 */
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;

/** How many rows the family holds, and how each one was revoked. */
interface FamilyRow {
  id: string;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/**
 * How many trials produced each distinct outcome, keyed by a one-line signature.
 *
 * Asserted as a tally rather than as an array of twenty objects on purpose: a twenty-element
 * object array blows past Jest's diff context and prints a wall of near-identical blocks with the
 * interesting count nowhere in it. A tally fails as, literally,
 * `{"1 fulfilled, 4 reused, 2 rows, 0 live": 1, "5 fulfilled, 0 reused, 6 rows, 5 live": 19}` —
 * which is both the assertion and the measurement.
 */
type RotationTally = Record<string, number>;

describe('SessionsService against Postgres', () => {
  // `SessionsModule` is not imported by `AppModule` yet (no `AuthModule` exists to pull it in), so
  // it is merged in beside it here. That is also the finding-C proof: if the module cannot resolve
  // its own `TokenService`, this boot fails and every test below fails with it.
  const integration = useIntegrationApp({ imports: [SessionsModule] });

  let sessions: SessionsService;
  let tokens: TokenService;
  let repository: Repository<Session>;
  let dataSource: DataSource;
  let userId: string;

  beforeEach(async () => {
    sessions = integration.app.get(SessionsService);
    tokens = integration.app.get(TokenService);
    repository = integration.app.get<Repository<Session>>(getRepositoryToken(Session));
    dataSource = integration.dataSource;
    userId = await insertUser('primary@sessions.test');
  });

  async function insertUser(email: string): Promise<string> {
    const rows = await dataSource.query<{ id: string }[]>(
      `INSERT INTO users (name, email, phone, "passwordHash", role)
       VALUES ('Session Fixture', $1, '9000000000', 'not-a-real-hash', 'CUSTOMER')
       RETURNING id`,
      [email],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`inserting the fixture user ${email} returned no id`);
    return id;
  }

  async function familyRows(familyId: string): Promise<FamilyRow[]> {
    return dataSource.query<FamilyRow[]>(
      `SELECT id, "revokedAt", "revokedReason" FROM sessions
        WHERE "familyId" = $1 ORDER BY "createdAt", id`,
      [familyId],
    );
  }

  async function sessionRow(id: string): Promise<FamilyRow | undefined> {
    const rows = await dataSource.query<FamilyRow[]>(
      `SELECT id, "revokedAt", "revokedReason" FROM sessions WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  describe('module wiring', () => {
    it('stands SessionsModule up in a real Nest container', () => {
      // Finding C: `SessionsService` injects `TokenService` at constructor index 1, and
      // `SessionsModule` neither provided it nor imported a module exporting it. Nest resolves a
      // provider's dependencies in its *declaring* module's scope, so no later `AuthModule` could
      // have repaired this from the outside.
      expect(integration.app.get(SessionsService)).toBeInstanceOf(SessionsService);
      expect(integration.app.get(TokenService)).toBeInstanceOf(TokenService);
    });
  });

  describe('rotate under concurrency', () => {
    it('lets exactly one of five simultaneous presentations of one token through', async () => {
      // The bug this pins failed 19 of 20 trials, so one trial proves close to nothing in either
      // direction. Every trial is asserted, and the whole table is printed on failure.
      const TRIALS = 20;
      const PARALLEL = 5;
      const tally: RotationTally = {};

      for (let trial = 0; trial < TRIALS; trial += 1) {
        const issued = await sessions.issue(userId, meta);
        const outcomes = await Promise.allSettled(
          Array.from({ length: PARALLEL }, () => sessions.rotate(issued.refreshToken, meta)),
        );

        const rejections = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        const reused = rejections.filter(
          (rejection) =>
            rejection.reason instanceof DomainError &&
            rejection.reason.code === ErrorCodes.REFRESH_TOKEN_REUSED &&
            rejection.reason.getStatus() === UNAUTHORIZED,
        );
        const rows = await familyRows(issued.session.familyId);
        const signature = describeTrial({
          fulfilled: outcomes.length - rejections.length,
          reused: reused.length,
          otherRejections: rejections.length - reused.length,
          rowsInFamily: rows.length,
          liveInFamily: rows.filter((row) => row.revokedAt === null).length,
        });
        tally[signature] = (tally[signature] ?? 0) + 1;
      }

      // What each number pins:
      //  - 1 fulfilled   exactly one caller gets a token. Two is the vulnerability.
      //  - 4 reused      every loser is rejected as a replay — 401, with the machine code, and
      //                  as a `DomainError`, all three checked above. Not a quiet failure, and
      //                  not the 500 a raw driver error would produce.
      //  - 2 rows        the original plus one replacement. A third row would mean a second
      //                  replacement was issued even if that caller's promise rejected.
      //  - 0 live        losing the claim revokes the family, and the winner's brand-new row is a
      //                  member of that family, so it dies with it. See the note on `rotate`.
      expect(tally).toEqual({
        [describeTrial({
          fulfilled: 1,
          reused: PARALLEL - 1,
          otherRejections: 0,
          rowsInFamily: 2,
          liveInFamily: 0,
        })]: TRIALS,
      });
    });

    it('leaves a rotated-away token unusable even when it lost a race', async () => {
      const issued = await sessions.issue(userId, meta);
      const outcomes = await Promise.allSettled([
        sessions.rotate(issued.refreshToken, meta),
        sessions.rotate(issued.refreshToken, meta),
      ]);
      const winner = outcomes.find(
        (
          outcome,
        ): outcome is PromiseFulfilledResult<Awaited<ReturnType<SessionsService['rotate']>>> =>
          outcome.status === 'fulfilled',
      );
      expect(winner).toBeDefined();

      // The token the winner was handed is worthless: the loser's family revoke reached it. A
      // caller that treats a 200 from `rotate` as "the family is healthy" is wrong, which is why
      // `AuthController` must surface the rejection and not the winner.
      await expect(sessions.isActive(winner?.value.session.id ?? '')).resolves.toBe(false);
      expect(await sessionRow(issued.session.id)).toMatchObject({ revokedReason: 'rotated' });
    });
  });

  describe('rotate reuse detection', () => {
    it('revokes the whole family when a rotated token is presented again', async () => {
      const issued = await sessions.issue(userId, meta);
      const rotated = await sessions.rotate(issued.refreshToken, meta);

      const error = await rejectionOf(sessions.rotate(issued.refreshToken, meta));
      assertDomainError(error);
      expect(error.code).toBe(ErrorCodes.REFRESH_TOKEN_REUSED);
      expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);

      const rows = await familyRows(issued.session.familyId);
      // Two rows, not three: the replay must not have been served a session of its own.
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.revokedAt === null)).toEqual([]);
      expect(rows.filter((row) => row.revokedReason === 'reuse-detected')).toHaveLength(1);
      expect(await sessionRow(rotated.session.id)).toMatchObject({
        revokedReason: 'reuse-detected',
      });
      await expect(sessions.isActive(rotated.session.id)).resolves.toBe(false);
    });

    it('still rejects with 401 when revoking the family fails', async () => {
      // Finding B. The family revoke and the `throw` were two statements: a deadlock, lock timeout
      // or reset connection on the `UPDATE` propagated the raw driver error instead, so the caller
      // saw 500, `DomainError` was never constructed, and the family survived. The rejection has to
      // be a property of having *detected* the signature, not of the repair succeeding.
      const issued = await sessions.issue(userId, meta);
      await sessions.rotate(issued.refreshToken, meta);

      const logger = integration.app.get<Logger>(WINSTON_LOGGER);
      const logged = jest.spyOn(logger, 'error');
      // The message names itself: this line really is written to the log while this test runs, and
      // someone scanning the run output should not read it as a genuine failure.
      const failure = new Error('simulated deadlock — expected, asserted by this test');
      const update = jest.spyOn(repository, 'update').mockRejectedValueOnce(failure);
      try {
        const error = await rejectionOf(sessions.rotate(issued.refreshToken, meta));
        assertDomainError(error);
        expect(error.code).toBe(ErrorCodes.REFRESH_TOKEN_REUSED);
        expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);

        // Not swallowed either: the driver failure is escalated to error level, with the family it
        // could not revoke, because a family that may still have a live member needs a human.
        expect(logged).toHaveBeenCalledTimes(1);
        const written = JSON.stringify(logged.mock.calls);
        expect(written).toContain(issued.session.familyId);
        expect(written).toContain('"familyRevoked":false');
        expect(written).toContain('simulated deadlock');
      } finally {
        update.mockRestore();
        logged.mockRestore();
      }
    });

    it('logs the family and user but never the token or its hash', async () => {
      // Spec §9 requires a security event. `WINSTON_LOGGER` is fetched from the container rather
      // than injected: `LoggingModule` provides it without exporting it, so it is reachable through
      // `app.get` but not through DI — see the note in `sessions.module.ts`. It is the same winston
      // instance `WinstonLoggerService` wraps, so this observes what production would write.
      const logger = integration.app.get<Logger>(WINSTON_LOGGER);
      const warn = jest.spyOn(logger, 'warn');
      try {
        const issued = await sessions.issue(userId, meta);
        await sessions.rotate(issued.refreshToken, meta);
        await rejectionOf(sessions.rotate(issued.refreshToken, meta));

        expect(warn).toHaveBeenCalledTimes(1);
        const written = JSON.stringify(warn.mock.calls);
        expect(written).toContain(issued.session.familyId);
        expect(written).toContain(userId);
        // The credential itself must never reach a log aggregator, in either form.
        expect(written).not.toContain(issued.refreshToken);
        expect(written).not.toContain(tokens.hashRefreshToken(issued.refreshToken));
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects an unknown token as expired', async () => {
      const error = await rejectionOf(sessions.rotate('never-issued', meta));
      assertDomainError(error);
      expect(error.code).toBe(ErrorCodes.SESSION_EXPIRED);
      expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('rejects an expired token without rotating it', async () => {
      const issued = await sessions.issue(userId, meta);
      await dataSource.query(`UPDATE sessions SET "expiresAt" = now() - interval '1 minute'`);

      const error = await rejectionOf(sessions.rotate(issued.refreshToken, meta));
      assertDomainError(error);
      expect(error.code).toBe(ErrorCodes.SESSION_EXPIRED);
      expect(await familyRows(issued.session.familyId)).toHaveLength(1);
      expect(await sessionRow(issued.session.id)).toMatchObject({ revokedAt: null });
    });
  });

  describe('logout is not theft', () => {
    it('reports a refresh after logout as expired, not as a stolen token', async () => {
      // The most ordinary sequence there is: sign out on one tab, a second tab refreshes a moment
      // later. Reporting `REFRESH_TOKEN_REUSED` there would raise a stolen-credential alert on a
      // user who simply logged out, and would revoke a family that is already dead.
      const issued = await sessions.issue(userId, meta);
      await sessions.revoke(issued.session.id, 'logout');

      const error = await rejectionOf(sessions.rotate(issued.refreshToken, meta));
      assertDomainError(error);
      expect(error.code).toBe(ErrorCodes.SESSION_EXPIRED);
      expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      // The reason on the row is still the user's own logout, not a reuse verdict.
      expect(await sessionRow(issued.session.id)).toMatchObject({ revokedReason: 'logout' });
    });

    it('reports a refresh after an admin force-logout as expired', async () => {
      const issued = await sessions.issue(userId, meta);
      await sessions.revokeAllForUser(userId, 'admin-forced');

      const error = await rejectionOf(sessions.rotate(issued.refreshToken, meta));
      assertDomainError(error);
      expect(error.code).toBe(ErrorCodes.SESSION_EXPIRED);
      expect(await sessionRow(issued.session.id)).toMatchObject({ revokedReason: 'admin-forced' });
    });

    it('logs nothing for a logged-out session, so logout raises no security alert', async () => {
      const logger = integration.app.get<Logger>(WINSTON_LOGGER);
      const warn = jest.spyOn(logger, 'warn');
      try {
        const issued = await sessions.issue(userId, meta);
        await sessions.revoke(issued.session.id, 'logout');
        await rejectionOf(sessions.rotate(issued.refreshToken, meta));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('revoke', () => {
    it('revokes exactly the named session and leaves the other device signed in', async () => {
      // Finding D1: the unit fake ignores the `id` criterion entirely, so this assertion passed
      // there against a `revoke` with no filter at all. Postgres does not.
      const phone = await sessions.issue(userId, meta);
      const laptop = await sessions.issue(userId, meta);

      await sessions.revoke(phone.session.id, 'logout');

      await expect(sessions.isActive(phone.session.id)).resolves.toBe(false);
      await expect(sessions.isActive(laptop.session.id)).resolves.toBe(true);
      expect(await sessionRow(phone.session.id)).toMatchObject({ revokedReason: 'logout' });
      expect(await sessionRow(laptop.session.id)).toMatchObject({
        revokedAt: null,
        revokedReason: null,
      });
      // The laptop's refresh token still works, which is the whole point of scoping the revoke.
      await expect(sessions.rotate(laptop.refreshToken, meta)).resolves.toMatchObject({
        session: { familyId: laptop.session.familyId },
      });
    });

    it('does not re-stamp a session that was already revoked', async () => {
      const issued = await sessions.issue(userId, meta);
      await sessions.revoke(issued.session.id, 'logout');
      const afterFirst = await sessionRow(issued.session.id);
      await sessions.revoke(issued.session.id, 'admin-forced');
      // `revokedAt IS NULL` in the criteria is what keeps the first, true reason on the row.
      expect(await sessionRow(issued.session.id)).toEqual(afterFirst);
    });
  });

  describe('revokeAllForUser', () => {
    it('is scoped to one user and leaves every other user signed in', async () => {
      const otherUserId = await insertUser('other@sessions.test');
      const mineOne = await sessions.issue(userId, meta);
      const mineTwo = await sessions.issue(userId, meta);
      const theirs = await sessions.issue(otherUserId, meta);

      await sessions.revokeAllForUser(userId, 'admin-forced');

      await expect(sessions.isActive(mineOne.session.id)).resolves.toBe(false);
      await expect(sessions.isActive(mineTwo.session.id)).resolves.toBe(false);
      await expect(sessions.isActive(theirs.session.id)).resolves.toBe(true);
      expect(await sessionRow(theirs.session.id)).toMatchObject({
        revokedAt: null,
        revokedReason: null,
      });
    });
  });

  describe('isActive', () => {
    it('is false for an unknown id, a revoked session and an expired one', async () => {
      const revoked = await sessions.issue(userId, meta);
      const expired = await sessions.issue(userId, meta);
      const live = await sessions.issue(userId, meta);

      await sessions.revoke(revoked.session.id, 'logout');
      await dataSource.query(
        `UPDATE sessions SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
        [expired.session.id],
      );

      await expect(sessions.isActive('11111111-1111-1111-1111-111111111111')).resolves.toBe(false);
      await expect(sessions.isActive(revoked.session.id)).resolves.toBe(false);
      await expect(sessions.isActive(expired.session.id)).resolves.toBe(false);
      await expect(sessions.isActive(live.session.id)).resolves.toBe(true);
    });

    /**
     * `JwtAuthGuard` calls this on **every** authenticated request, so what it does with an id it
     * cannot resolve is a property of the whole request pipeline, not a corner of one service.
     *
     * A value Postgres cannot parse as a `uuid` used to raise `QueryFailedError: invalid input
     * syntax for type uuid`, which surfaced as a 500 and an error-level log line. A session that
     * cannot be identified is not an active session, so the honest answer is `false` and a clean
     * 401 — a 500 tells the client the server is broken when the request was simply unauthorised,
     * and it buries a real fault among noise if this ever does start happening.
     *
     * Not reachable by an attacker today: the id arrives inside a JWT this service signed. It is
     * reachable by a token that outlived a database reset, which is an ordinary thing to happen in
     * development, and there is no reason for it to page anyone.
     */
    it('treats an unparseable session id as inactive rather than raising a 500', async () => {
      await expect(sessions.isActive('not-a-uuid')).resolves.toBe(false);
      await expect(sessions.isActive('')).resolves.toBe(false);
      await expect(sessions.isActive('12345')).resolves.toBe(false);
    });
  });
});

/** The one-line signature a single concurrency trial is tallied under. */
function describeTrial(trial: {
  fulfilled: number;
  reused: number;
  otherRejections: number;
  rowsInFamily: number;
  liveInFamily: number;
}): string {
  return (
    `${String(trial.fulfilled)} fulfilled, ${String(trial.reused)} reused, ` +
    `${String(trial.otherRejections)} other rejections, ` +
    `${String(trial.rowsInFamily)} rows in family, ${String(trial.liveInFamily)} live`
  );
}

/**
 * Returns the value a promise rejected with. `expect(...).rejects` cannot hand the error back for
 * further assertions, and these tests assert three things about every rejection — that it is a
 * `DomainError`, its `code`, and its HTTP status. Nothing asserted the status before, so changing
 * any throw site to 422 left all ten session tests green while breaking spec §9.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/**
 * A type predicate rather than a cast, per the house convention in `eslint.config.mjs`: the runtime
 * check is the assertion, and the compiler narrows off the same check instead of being asserted
 * past.
 */
function assertDomainError(error: unknown): asserts error is DomainError {
  expect(error).toBeInstanceOf(DomainError);
  if (!(error instanceof DomainError)) throw error;
}
