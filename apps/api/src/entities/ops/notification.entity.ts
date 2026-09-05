import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { NotificationChannel, NotificationStatus } from '../enums';
import { User } from '../identity/user.entity';

/**
 * Brief §38 asks the architecture to *support* notifications, not to deliver them yet.
 *
 * Rows are persisted and a logging no-op driver marks them SENT. Adding a real provider is a
 * driver swap: nothing else reads this table's shape.
 */
@Entity('notifications')
export class Notification extends BaseEntity {
  @Index('idx_notifications_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  /** e.g. `order.confirmed`, `rfq.received`, `stock.low`. Brief §38's list. */
  @Column({ type: 'varchar', length: 60 })
  template: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Index('idx_notifications_status')
  @Column({ type: 'enum', enum: NotificationStatus, default: NotificationStatus.QUEUED })
  status: NotificationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error: string | null;
}
