import { Column, Entity, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { UserRole } from '../enums';
import type { Address } from './address.entity';
import type { Business } from './business.entity';
import type { Session } from './session.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * Stored lowercased by the service. Postgres `citext` would also work but requires an
   * extension; normalising on write keeps the schema portable and makes the stored value
   * predictable.
   *
   * Uniqueness is enforced by a hand-written `LOWER(email)` functional unique index created
   * in the migration, not by a decorator here — TypeORM has no decorator for a functional
   * index, and there must be exactly one source of truth for this constraint. Case-insensitive
   * uniqueness at the database level is the stronger guarantee: it holds even if application
   * code ever forgets to lowercase before a write.
   *
   * Consequence: `migration:generate` output must always be reviewed after touching this
   * entity. TypeORM's metadata has no record of the functional index, so it will propose
   * re-adding a plain `uq_users_email` btree on the literal column — that proposed addition
   * must be discarded, not applied.
   */
  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 15 })
  phone: string;

  /** bcrypt hash, cost 10 — matching cug. Never selected by default. */
  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @OneToOne('Business', 'user')
  business: Business | null;

  @OneToMany('Address', 'user')
  addresses: Address[];

  @OneToMany('Session', 'user')
  sessions: Session[];
}
