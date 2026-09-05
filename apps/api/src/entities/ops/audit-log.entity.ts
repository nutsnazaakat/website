import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../identity/user.entity';

/**
 * Spec §13. One row per admin mutation.
 *
 * The initial schema anticipated a request-scoped `AuditInterceptor` in Plan 4 — which is where `ip`
 * and `userAgent` come from — and it was never built. The write path is instead
 * `AuditLogService.record` (`modules/admin/audit-log.service.ts`), which writes inside the caller's
 * own open transaction so the row and the change it describes commit or roll back together. Being
 * inside a transaction rather than a request, it has nothing to read those two columns from, so both
 * stay `null` until a caller starts passing them in.
 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_audit_logs_actor')
  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User;

  @Column({ type: 'uuid', name: 'actor_user_id' })
  actorUserId: string;

  /** e.g. `product.update`, `order.status.change`, `inventory.adjust`. */
  @Column({ type: 'varchar', length: 60 })
  action: string;

  @Index('idx_audit_logs_entity')
  @Column({ type: 'varchar', length: 40 })
  entity: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  entityId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
