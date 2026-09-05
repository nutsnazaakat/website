import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, type Repository } from 'typeorm';
import { appConfig } from '../../common/config/app.config';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import type { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { Session } from '../../entities/identity/session.entity';
import { TokenService } from '../auth/token.service';
import { SessionsModule } from './sessions.module';
import { SessionsService } from './sessions.service';

type FakeRepository = Repository<Session> & { rows: Session[] };

/**
 * Minimal in-memory stand-in for the repository surface the service uses.
 *
 * `update` honours every criterion it is handed, including `id`. It used to honour only
 * `familyId` and `userId` and silently ignore the rest, which made the `revoke` test below
 * vacuous: it passed against a `revoke` with no filter at all, because the fake revoked both rows
 * and then reported the survivor inactive. A regression where logging out of one device signs you
 * out of every device shipped green against that fake. `IsNull()` is interpreted rather than
 * assumed, and an operator the service does not use throws instead of quietly matching everything.
 */
function fakeRepository(): FakeRepository {
  const rows: Session[] = [];

  const matches = (row: Session, criteria: Record<string, unknown>): boolean =>
    Object.entries(criteria).every(([key, expected]) => {
      const actual = row[key as keyof Session];
      if (expected instanceof FindOperator) {
        if (expected.type !== 'isNull') {
          throw new Error(`fakeRepository: unsupported FindOperator "${expected.type}"`);
        }
        return actual === null || actual === undefined;
      }
      return actual === expected;
    });

  const repository = {
    rows,
    create: (input: Partial<Session>) => ({ ...input }) as Session,
    save: (entity: Session) => {
      const existing = rows.findIndex((row) => row.id === entity.id);
      if (existing >= 0) {
        rows[existing] = { ...rows[existing], ...entity };
        return rows[existing];
      }
      const created = { ...entity, id: entity.id ?? randomUUID() };
      rows.push(created);
      return created;
    },
    findOne: ({ where }: { where: { refreshTokenHash?: string; id?: string } }) =>
      rows.find(
        (row) =>
          (where.refreshTokenHash !== undefined &&
            row.refreshTokenHash === where.refreshTokenHash) ||
          (where.id !== undefined && row.id === where.id),
      ) ?? null,
    update: (criteria: Record<string, unknown>, patch: Partial<Session>) => {
      const affected = rows.filter((row) => matches(row, criteria));
      for (const row of affected) Object.assign(row, patch);
      // The real count, not `rows.length`. `rotate` now branches on `affected !== 1`, so a fake
      // that always reported "all of them" would make the winner-takes-the-row check untestable.
      return { affected: affected.length, raw: [], generatedMaps: [] };
    },
    /**
     * `rotate` claims the row and inserts its replacement inside one transaction. The fake runs
     * the callback against itself: there is no isolation to model here, because there is nothing
     * to isolate from — see the note above `describe('SessionsService.rotate')`.
     */
    manager: {
      transaction: <T>(run: (manager: { getRepository: () => FakeRepository }) => Promise<T>) =>
        run({ getRepository: () => repository as unknown as FakeRepository }),
    },
  };

  return repository as unknown as FakeRepository;
}

interface RecordedLog {
  level: 'warn' | 'error';
  message: string;
  meta?: unknown;
}

type FakeLogger = WinstonLoggerService & { entries: RecordedLog[] };

/**
 * Records what the service logged. Deliberately does *not* apply `redact()` — the real
 * `WinstonLoggerService` does, and a fake that scrubbed too would hide a field the service should
 * never have passed in the first place. `pii-redactor.spec.ts` owns redaction; this owns "the
 * service does not hand the credential over at all".
 */
function fakeLogger(): FakeLogger {
  const entries: RecordedLog[] = [];
  const logger = {
    entries,
    setContext: () => logger,
    warn: (message: string, meta?: unknown) => void entries.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: unknown) =>
      void entries.push({ level: 'error', message, meta }),
    log: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return logger as unknown as FakeLogger;
}

function build() {
  const repository = fakeRepository();
  const tokens = new TokenService(new JwtService({ secret: 'a'.repeat(48) }), {
    accessTokenTtl: '15m',
    refreshTokenTtlDays: 30,
  });
  const logger = fakeLogger();
  return { repository, service: new SessionsService(repository, tokens, logger), tokens, logger };
}

const meta = { userAgent: 'jest', ip: '127.0.0.1' };

/**
 * Returns the value a promise rejected with, so a test can assert more than one thing about it.
 *
 * `expect(...).rejects.toMatchObject({ code })` — what these tests used to do — cannot see the HTTP
 * status, and nothing here asserted it: changing any throw site in `rotate` to
 * `UNPROCESSABLE_ENTITY` left every session test green even though spec §9 requires 401.
 *
 * Duplicated in `test/integration/sessions.integration.spec.ts` rather than shared. The unit and
 * integration Jest projects have disjoint `roots`, so a shared helper would have to live in `src/`
 * — production source carrying test-only code — and it is eight lines.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** A type predicate, per the house convention in `eslint.config.mjs`: narrow off a real check. */
function assertDomainError(error: unknown): asserts error is DomainError {
  expect(error).toBeInstanceOf(DomainError);
  if (!(error instanceof DomainError)) throw error;
}

/** Every refresh rejection is a 401 `DomainError`, whatever the code. Spec §9. */
function expectUnauthorized(error: unknown, code: DomainError['code']): void {
  assertDomainError(error);
  expect(error.code).toBe(code);
  expect(error.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
}

describe('SessionsService.issue', () => {
  it('creates a session and returns a refresh token that is not what was stored', async () => {
    const { service, repository, tokens } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);

    expect(repository.rows).toHaveLength(1);
    expect(session.refreshTokenHash).toBe(tokens.hashRefreshToken(refreshToken));
    // The raw token must never be persisted.
    expect(repository.rows[0]?.refreshTokenHash).not.toBe(refreshToken);
  });

  it('starts a new family per login, so two devices are independent', async () => {
    const { service } = build();
    const first = await service.issue('user-1', meta);
    const second = await service.issue('user-1', meta);
    expect(first.session.familyId).not.toBe(second.session.familyId);
  });
});

/**
 * What these tests cannot cover, and why the integration suite exists.
 *
 * The fake's `findOne`, `save` and `update` are synchronous, so `Promise.all([rotate(t), rotate(t)])`
 * runs the two rotations strictly one after the other. Against the *broken* read-then-write
 * implementation that fake reported "1 fulfilled, reuse detected" every single time, while real
 * Postgres produced two fulfilled rotations in 19 of 20 trials. A concurrency test written here
 * would have certified the vulnerability as fixed.
 *
 * So the race itself is pinned in `test/integration/sessions.integration.spec.ts`, against real
 * connections. What is testable here is the *branching*: a lost claim is distinguishable from a
 * won one, and the two tests below drive that branch directly by making the claim report zero
 * affected rows, which is exactly what the loser of a real race observes.
 */
describe('SessionsService.rotate', () => {
  it('issues a new token and revokes the presented one', async () => {
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);

    const rotated = await service.rotate(refreshToken, meta);

    expect(rotated.refreshToken).not.toBe(refreshToken);
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(repository.rows[0]?.revokedReason).toBe('rotated');
    expect(repository.rows[1]?.revokedAt).toBeNull();
  });

  it('keeps the rotated session in the same family', async () => {
    const { service } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);
    const rotated = await service.rotate(refreshToken, meta);
    expect(rotated.session.familyId).toBe(session.familyId);
  });

  it('revokes the whole family when a already-used token is presented again', async () => {
    // This is the stolen-refresh-token signature: the legitimate client rotated, and now
    // something else is presenting the old token. Neither party can be trusted, so the
    // family dies and both must sign in again.
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    await service.rotate(refreshToken, meta);

    // `DomainError#message` is deliberately the human-readable string — its own doc comment
    // says the code "must not change when the human-readable message is reworded" — and
    // `HttpException.initMessage()` copies `response.message`, never `code`, into
    // `Error.message`. A regex on `.message` can therefore never observe the code, so this
    // asserts the actual contract (`.code`) instead: the same property a caller — and Task
    // 27's integration test, via `response.body.code` — switches on. Confirmed empirically:
    // constructing a `DomainError` and inspecting it shows `.message` holds only the human
    // text and `.code` holds the machine code, as separate own-enumerable properties.
    //
    // The status is asserted alongside it now. It was not, and spec §9 requires 401: every one of
    // these four throw sites could have been changed to 422 with all ten session tests still green.
    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.REFRESH_TOKEN_REUSED,
    );
    expect(repository.rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(repository.rows.some((row) => row.revokedReason === 'reuse-detected')).toBe(true);
    // No third session was handed out to the replay.
    expect(repository.rows).toHaveLength(2);
  });

  it('logs a security event naming the family and user, and never the token', async () => {
    // Spec §9 requires a security event for reuse detection, and nothing was logged at all.
    const { service, logger, tokens } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);
    await service.rotate(refreshToken, meta);
    await rejectionOf(service.rotate(refreshToken, meta));

    expect(logger.entries).toHaveLength(1);
    const [entry] = logger.entries;
    expect(entry?.level).toBe('warn');
    expect(entry?.meta).toMatchObject({
      event: 'refresh_token_reuse_detected',
      familyId: session.familyId,
      userId: 'user-1',
      familyRevoked: true,
    });
    // Identifiers, not credentials. `pii-redactor` strips any key containing "token" or "hash", so
    // a field named for the credential would arrive as `[REDACTED]` and be useless anyway — but
    // the service must not hand it over in the first place.
    const written = JSON.stringify(logger.entries);
    expect(written).not.toContain(refreshToken);
    expect(written).not.toContain(tokens.hashRefreshToken(refreshToken));
  });

  it('still rejects with 401 when revoking the family fails', async () => {
    // The family revoke and the `throw` used to be two bare statements. A deadlock, lock timeout
    // or dropped connection on the `UPDATE` propagated the driver error instead: 500 rather than
    // 401, no `DomainError`, and the family left alive after producing the theft signature.
    const { service, repository, logger } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    await service.rotate(refreshToken, meta);

    const failure = new Error('deadlock detected');
    jest.spyOn(repository, 'update').mockRejectedValueOnce(failure);

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.REFRESH_TOKEN_REUSED,
    );
    // Escalated, not swallowed: the family may still have a live member, so a human has to know.
    expect(logger.entries).toMatchObject([
      { level: 'error', meta: { familyRevoked: false, revokeFailure: failure } },
    ]);
  });

  it('treats a lost claim as a replay, because whoever won it stamped "rotated"', async () => {
    // Drives the branch a loser of a real race takes: the conditional claim finds no unrevoked row
    // to take, and the row now carries the winner's reason. Real Postgres reaching this state
    // concurrently is what the integration suite proves; this pins what happens once it does.
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);

    jest.spyOn(repository, 'update').mockImplementationOnce(() => {
      const row = repository.rows[0];
      if (row) {
        row.revokedAt = new Date();
        row.revokedReason = 'rotated';
      }
      return { affected: 0, raw: [], generatedMaps: [] } as never;
    });

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.REFRESH_TOKEN_REUSED,
    );
    // No replacement was issued to the loser.
    expect(repository.rows).toHaveLength(1);
  });

  it('treats a claim lost to a logout as an expired session, not as theft', async () => {
    // The same race, but the row was taken by the user's own logout rather than by a rotation.
    // Reporting a stolen credential here would raise an alert on somebody signing out.
    const { service, repository, logger } = build();
    const { refreshToken } = await service.issue('user-1', meta);

    jest.spyOn(repository, 'update').mockImplementationOnce(() => {
      const row = repository.rows[0];
      if (row) {
        row.revokedAt = new Date();
        row.revokedReason = 'logout';
      }
      return { affected: 0, raw: [], generatedMaps: [] } as never;
    });

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.SESSION_EXPIRED,
    );
    expect(logger.entries).toEqual([]);
    expect(repository.rows[0]?.revokedReason).toBe('logout');
  });

  it('rejects a refresh after logout as expired, not as a reused token', async () => {
    // Log out, then a stale tab refreshes — the most ordinary sequence there is. Every revoked
    // token used to yield `REFRESH_TOKEN_REUSED`, so this reported a stolen credential.
    const { service, repository, logger } = build();
    const { refreshToken, session } = await service.issue('user-1', meta);
    await service.revoke(session.id, 'logout');

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.SESSION_EXPIRED,
    );
    // The user's own reason survives, and no security event was raised.
    expect(repository.rows[0]?.revokedReason).toBe('logout');
    expect(logger.entries).toEqual([]);
  });

  it('rejects a refresh after an admin force-logout as expired', async () => {
    const { service, logger } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    await service.revokeAllForUser('user-1', 'admin-forced');

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.SESSION_EXPIRED,
    );
    expect(logger.entries).toEqual([]);
  });

  it('rejects an unknown token', async () => {
    const { service } = build();
    expectUnauthorized(
      await rejectionOf(service.rotate('never-issued', meta)),
      ErrorCodes.SESSION_EXPIRED,
    );
  });

  it('rejects an expired token without rotating it', async () => {
    const { service, repository } = build();
    const { refreshToken } = await service.issue('user-1', meta);
    repository.rows[0]!.expiresAt = new Date(Date.now() - 1000);

    expectUnauthorized(
      await rejectionOf(service.rotate(refreshToken, meta)),
      ErrorCodes.SESSION_EXPIRED,
    );
    expect(repository.rows).toHaveLength(1);
    // The expiry check runs before the claim, so an expired row is not stamped `'rotated'`.
    expect(repository.rows[0]?.revokedAt).toBeNull();
  });
});

describe('SessionsService.revoke', () => {
  it('revokes a single session on logout', async () => {
    const { service, repository } = build();
    const { session } = await service.issue('user-1', meta);
    await service.revoke(session.id, 'logout');
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    expect(repository.rows[0]?.revokedReason).toBe('logout');
  });

  it('leaves the user other sessions alone', async () => {
    // This assertion is why the fake had to start honouring `id`: with the old fake it passed
    // against a `revoke` with no filter whatsoever. The same property is asserted against real
    // Postgres in the integration suite, which is the version that cannot be fooled by a fake.
    const { service, repository } = build();
    const phone = await service.issue('user-1', meta);
    const laptop = await service.issue('user-1', meta);

    await service.revoke(phone.session.id, 'logout');

    await expect(service.isActive(phone.session.id)).resolves.toBe(false);
    await expect(service.isActive(laptop.session.id)).resolves.toBe(true);
    expect(repository.rows.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  it('keeps the first reason when a revoked session is revoked again', async () => {
    const { service, repository } = build();
    const { session } = await service.issue('user-1', meta);
    await service.revoke(session.id, 'logout');
    const revokedAt = repository.rows[0]?.revokedAt;

    await service.revoke(session.id, 'admin-forced');

    expect(repository.rows[0]?.revokedReason).toBe('logout');
    expect(repository.rows[0]?.revokedAt).toBe(revokedAt);
  });

  it('revokes every session for a user, for admin force-logout', async () => {
    const { service, repository } = build();
    await service.issue('user-1', meta);
    await service.issue('user-1', meta);
    await service.revokeAllForUser('user-1', 'admin-forced');
    expect(repository.rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('scopes an admin force-logout to one user', async () => {
    const { service } = build();
    const mine = await service.issue('user-1', meta);
    const theirs = await service.issue('user-2', meta);

    await service.revokeAllForUser('user-1', 'admin-forced');

    await expect(service.isActive(mine.session.id)).resolves.toBe(false);
    await expect(service.isActive(theirs.session.id)).resolves.toBe(true);
  });
});

describe('SessionsService.isActive', () => {
  it('is false once revoked, which is what makes logout real', async () => {
    const { service, repository } = build();
    const { session } = await service.issue('user-1', meta);
    await expect(service.isActive(session.id)).resolves.toBe(true);
    await service.revoke(session.id, 'logout');
    expect(repository.rows[0]?.revokedAt).toBeInstanceOf(Date);
    await expect(service.isActive(session.id)).resolves.toBe(false);
  });
});

/**
 * `SessionsModule` could not be instantiated at all: `SessionsService` injects `TokenService` at
 * constructor index 1, and the module neither provided it nor imported a module exporting it. Nest
 * refused to build it — "Please make sure that the argument TokenService at index [1] is available
 * in the SessionsModule module" — and because Nest resolves a provider's dependencies in its
 * *declaring* module's scope, no later `AuthModule` could have fixed that from the outside.
 *
 * A compile-time repair with no test would leave that free to come back, so the module is booted in
 * a real Nest container here. The repository is the only thing stubbed; `JwtModule`,
 * `TOKEN_SETTINGS`, `TokenService` and the logger all have to resolve for real.
 */
describe('SessionsModule', () => {
  // `test/setup.ts` sets only `NODE_ENV` and `JWT_SECRET`, but `appConfig` parses the whole
  // environment in one pass and refuses to boot on a missing variable. These are placeholders: no
  // connection is ever opened, because the repository is overridden below.
  const PLACEHOLDER_ENV: Record<string, string> = {
    DB_HOST: 'localhost',
    DB_USER: 'unit',
    DB_PASSWORD: 'unit',
    DB_NAME: 'unit',
    CORS_ORIGINS: 'http://localhost:5173',
    SWAGGER_USER: 'docs',
    SWAGGER_PASSWORD: 'docs',
    LOG_LEVEL: 'error',
  };
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  // Restored, because Jest workers share one `process.env` across every spec file they run.
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('resolves SessionsService and its TokenService in a real Nest container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [appConfig], ignoreEnvFile: true }),
        SessionsModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Session))
      .useValue(fakeRepository())
      .compile();

    try {
      expect(moduleRef.get(SessionsService)).toBeInstanceOf(SessionsService);
      expect(moduleRef.get(TokenService)).toBeInstanceOf(TokenService);
    } finally {
      await moduleRef.close();
    }
  });
});
