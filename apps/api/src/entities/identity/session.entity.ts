import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from './user.entity';

/**
 * A server-side session, so logout genuinely invalidates and an admin can force-logout.
 * Spec §9 / §3.1 departure 1 — this table is what a stateless JWT cannot give us.
 */
@Entity('sessions')
export class Session extends BaseEntity {
  @Index('idx_sessions_user')
  @ManyToOne(() => User, (user) => user.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  /**
   * SHA-256 of the refresh token, never the token. A database disclosure must not hand over
   * usable credentials. Unique so a reuse check is a single indexed lookup.
   */
  @Index('uq_sessions_refresh_token_hash', { unique: true })
  @Column({ type: 'char', length: 64 })
  refreshTokenHash: string;

  /**
   * Sessions form a family through rotation, and reuse of a revoked token revokes the whole family.
   *
   * A rotated session keeps its **`familyId`**, not its `id`: rotation revokes the presented row and
   * inserts a *new* row with a fresh primary key and the same `familyId`. An earlier version of this
   * comment said "keeps the id it descended from", which is the opposite of how the reuse check
   * works — `rotate` finds the presented row by its token hash and then revokes every row sharing
   * this column, so if the id were carried forward there would be nothing to group.
   */
  @Index('idx_sessions_family')
  @Column({ type: 'uuid' })
  familyId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  revokedReason: string | null;
}
