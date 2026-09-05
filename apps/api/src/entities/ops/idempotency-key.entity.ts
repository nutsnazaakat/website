import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Gateway's idempotency pattern. Spec §10.4 applies it to order placement, so a
 * double-clicked Place Order replays the first response instead of creating a second order
 * and decrementing stock twice.
 *
 * `requestHash` is compared on replay: the same key with a *different* body is a client bug
 * and must be rejected, not silently answered with the first response.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  key: string;

  /** Namespaces the key, e.g. `checkout:orders`, so two features cannot collide. */
  @Column({ type: 'varchar', length: 60 })
  scope: string;

  @Column({ type: 'char', length: 64 })
  requestHash: string;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: Record<string, unknown> | null;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  @Index('idx_idempotency_keys_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
