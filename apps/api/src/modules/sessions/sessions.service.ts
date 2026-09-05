import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { Session } from '../../entities/identity/session.entity';
import { TokenService } from '../auth/token.service';

/**
 * Matches the canonical 8-4-4-4-12 hex form Postgres stores. Deliberately not version-aware: the
 * question is only whether the value can be compared against a `uuid` column, not which UUID
 * version produced it.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a session was revoked. A union rather than `string` because the column is `varchar(40)`, so
 * free text puts the width one careless caller away from a driver error — and because these four
 * values are read back and branched on: `rotate` reports theft only for `'rotated'`, which is what
 * keeps an ordinary logout from being reported as a stolen token.
 */
export type RevokeReason = 'logout' | 'admin-forced' | 'rotated' | 'reuse-detected';

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

/**
 * The two reasons this service writes itself. `revoke` and `revokeAllForUser` take their reason
 * from the caller (`'logout'`, `'admin-forced'`, `'account-deactivated'`, …), and the distinction
 * between those and these two is load-bearing, not cosmetic — see `rotate`.
 */
export const ROTATED = 'rotated';
export const REUSE_DETECTED = 'reuse-detected';

/**
 * One message for every refresh failure, whatever the cause. A client must not be able to tell
 * "that token was replayed" from "that session was logged out" from the response text; only the
 * machine `code` distinguishes them, and only for our own telemetry.
 */
const GENERIC_REFRESH_FAILURE = 'Your session has expired. Please sign in again.';

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly tokens: TokenService,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(SessionsService.name);
  }

  /**
   * Starts a new session family. Called on every login, never reused — issuing a fresh
   * session per login is what prevents session fixation (spec §9).
   */
  async issue(userId: string, meta: SessionMeta): Promise<IssuedSession> {
    const refreshToken = this.tokens.generateRefreshToken();
    const session = await this.sessions.save(
      this.sessions.create({
        userId,
        familyId: randomUUID(),
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
        expiresAt: this.tokens.refreshExpiryFrom(),
        revokedAt: null,
        revokedReason: null,
      }),
    );
    return { session, refreshToken };
  }

  /**
   * Exchanges a refresh token for a new one, revoking the old.
   *
   * Presenting a token that has already been rotated means two parties hold it: the
   * legitimate client and whoever copied it. There is no way to tell which is which, so the
   * entire family is revoked and both must sign in again. Silently issuing a new token here
   * would let a thief keep a session alive indefinitely.
   *
   * ## Why the rotation is a conditional UPDATE and not a read-then-write
   *
   * This method used to read the row, test `revokedAt` in memory, then `save()` an UPDATE by
   * primary key. Two concurrent presentations of the same token both read `revokedAt IS NULL`,
   * both passed the guard, and both saved — 19 of 20 measured trials produced two fulfilled
   * rotations from one token, five of five under a five-way race, with `REFRESH_TOKEN_REUSED`
   * raised zero times. The family split into two independently rotating branches, nobody was
   * signed out, and nothing was logged: precisely the outcome this comment claims to prevent. An
   * attacker firing two refreshes in parallel only has to win that race once.
   *
   * The replacement is the discipline spec §10.2 already mandates for inventory: claim the row
   * with a single `UPDATE … WHERE id = $1 AND "revokedAt" IS NULL`, which has no read-then-write
   * gap to lose. Under Postgres's READ COMMITTED, a second concurrent `UPDATE` of the same row
   * blocks on the first one's row lock, then re-evaluates its `WHERE` clause against the
   * committed row — where `revokedAt` is now set — and reports `affected: 0`. Exactly one caller
   * can ever see `affected: 1`, however many present the token and whatever the interleaving.
   *
   * The claim and the insert of the replacement share one transaction, which is what makes the
   * *loser's* view deterministic too: the loser cannot observe `affected: 0` until the winner has
   * committed its replacement row, so the family revoke that follows always sees that row and
   * always includes it. Without the transaction the two would race and the family would sometimes
   * be left with a live member.
   *
   * A consequence worth stating plainly, because it is a deliberate choice and not an oversight:
   * the winner's own brand-new token is revoked by the loser's family revoke, so a five-way race
   * ends with one fulfilled call, four 401s, and *no* live session in the family. That is correct
   * — two parties presented one token, and neither can be trusted — but it means a client that
   * fires two refreshes at once (two tabs, a retry on a slow response) signs the user out. The
   * fix for that belongs in the client, or in a future grace window on the immediately-preceding
   * token; it must not be a hole in the reuse check.
   */
  async rotate(presentedToken: string, meta: SessionMeta): Promise<IssuedSession> {
    const hash = this.tokens.hashRefreshToken(presentedToken);
    const existing = await this.sessions.findOne({ where: { refreshTokenHash: hash } });

    if (!existing) throw this.expired();

    // Already revoked when we read it: the serial replay case, and the ordinary
    // logged-out-tab-refreshes case. `reject` tells them apart by reason.
    if (existing.revokedAt) return this.reject(existing, existing.revokedReason);

    // Before the claim, deliberately: an expired token is not a theft signal, and claiming it
    // would stamp `'rotated'` on a row that was never rotated.
    if (existing.expiresAt.getTime() <= Date.now()) throw this.expired();

    const issued = await this.sessions.manager.transaction(async (manager) => {
      const sessions = manager.getRepository(Session);

      const claim = await sessions.update(
        { id: existing.id, revokedAt: IsNull() },
        { revokedAt: new Date(), revokedReason: ROTATED },
      );

      // Someone else claimed this exact row first. Returning rather than throwing so the
      // transaction commits cleanly — the rejection, and the family revoke it performs, must
      // happen outside this transaction or they would be rolled back with it.
      if (claim.affected !== 1) return null;

      const refreshToken = this.tokens.generateRefreshToken();
      const session = await sessions.save(
        sessions.create({
          userId: existing.userId,
          familyId: existing.familyId,
          refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
          userAgent: meta.userAgent ?? existing.userAgent,
          ip: meta.ip ?? existing.ip,
          expiresAt: this.tokens.refreshExpiryFrom(),
          revokedAt: null,
          revokedReason: null,
        }),
      );

      return { session, refreshToken };
    });

    if (issued) return issued;

    // The claim was lost. Re-read to find out *how* the row was revoked in the meantime: a
    // concurrent rotation leaves `'rotated'` and is theft-shaped, while a logout or an admin
    // force-logout that landed in the same instant is not. Fail closed if the row has vanished.
    const claimed = await this.sessions.findOne({ where: { id: existing.id } });
    return this.reject(existing, claimed?.revokedReason ?? ROTATED);
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.sessions.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /** Admin force-logout, and the correct response to a deactivated account. */
  async revokeAllForUser(userId: string, reason: RevokeReason): Promise<void> {
    await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason },
    );
  }

  /**
   * Checked by `JwtAuthGuard` on every authenticated request. This one indexed lookup is what
   * a stateless JWT cannot offer: without it, logout could not take effect until the access
   * token expired.
   */
  async isActive(sessionId: string): Promise<boolean> {
    // Checked before the query rather than caught after it. An id Postgres cannot parse as a
    // `uuid` raises `QueryFailedError: invalid input syntax for type uuid`, which reached the
    // client as a 500 and wrote an error-level log line — for a request that was simply
    // unauthorised. A session that cannot be identified is not an active session.
    //
    // Rejecting it here rather than catching the driver error keeps the two kinds of failure
    // apart: this returns `false` for a malformed id, while a genuine database fault still
    // propagates as the 500 it deserves. A `try`/`catch` around the query would have swallowed
    // both, which is how an outage starts looking like a wave of failed logins.
    if (!UUID_PATTERN.test(sessionId)) return false;

    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) return false;
    if (session.revokedAt) return false;
    return session.expiresAt.getTime() > Date.now();
  }

  /**
   * Rejects a refresh against a session that is already revoked, choosing the code from *how* it
   * was revoked.
   *
   * Only `'rotated'` is the stolen-token signature: that row was exchanged for a successor, so a
   * second presentation means two parties hold one credential. Every other reason is an
   * intentional revocation — the user logged out, an admin forced a logout, the family was
   * already killed by an earlier reuse detection — and reporting `REFRESH_TOKEN_REUSED` for those
   * would raise a stolen-credential alert on the single most ordinary sequence there is: log out,
   * then a stale tab refreshes. Both codes are 401 with the same message, so this changes nothing
   * a client can see; it changes what our own telemetry claims happened.
   */
  private async reject(session: Session, revokedReason: string | null): Promise<never> {
    if (revokedReason !== ROTATED) throw this.expired();

    let revokedCount: number | null = null;
    let revokeFailure: Error | undefined;

    try {
      const result = await this.sessions.update(
        { familyId: session.familyId, revokedAt: IsNull() },
        { revokedAt: new Date(), revokedReason: REUSE_DETECTED },
      );
      revokedCount = result.affected ?? null;
    } catch (error) {
      // Deliberately caught, never swallowed: it is logged below at error level, and the
      // rejection still happens. The rejection has to be a property of having *detected* the
      // signature, not of the repair succeeding — this `update` used to sit bare in front of the
      // `throw`, so a deadlock or a lock timeout propagated the raw driver error instead, the
      // caller got a 500 rather than a 401, `DomainError` was never constructed, and the family
      // survived with a live member. Both halves of that were wrong.
      revokeFailure = error instanceof Error ? error : new Error(String(error));
    }

    // Spec §9's security event. Identifiers only — never the presented token or its digest.
    // `pii-redactor` strips any key containing "token" or "hash", so a field named for the
    // credential would be scrubbed to `[REDACTED]` and the line would carry nothing useful; the
    // ids are what an incident is actually reconstructed from. `event` is a stable string for
    // alerting to match on.
    const detail = {
      event: 'refresh_token_reuse_detected',
      sessionId: session.id,
      familyId: session.familyId,
      userId: session.userId,
      familyRevoked: revokeFailure === undefined,
      sessionsRevoked: revokedCount,
      ...(revokeFailure === undefined ? {} : { revokeFailure }),
    };

    if (revokeFailure === undefined) {
      this.logger.warn('Refresh token reuse detected; revoked the whole session family', detail);
    } else {
      // Escalated, because the family may still have a live member: this needs a human.
      this.logger.error(
        'Refresh token reuse detected, but revoking the session family failed',
        detail,
      );
    }

    throw new DomainError(
      ErrorCodes.REFRESH_TOKEN_REUSED,
      GENERIC_REFRESH_FAILURE,
      HttpStatus.UNAUTHORIZED,
    );
  }

  private expired(): DomainError {
    return new DomainError(
      ErrorCodes.SESSION_EXPIRED,
      GENERIC_REFRESH_FAILURE,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
