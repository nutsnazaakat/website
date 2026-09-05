import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { User } from '../identity/user.entity';

/**
 * The order tracking timeline. Append-only.
 *
 * The customer's tracking page and the admin status history read the same rows, so admin
 * action and what the customer sees cannot disagree — spec §10.3.
 */
@Entity('order_events')
export class OrderEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_order_events_order')
  @ManyToOne(() => Order, (order) => order.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'varchar', length: 24 })
  status: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note: string | null;

  /** Null for a system-generated event such as the initial `pending`. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'actor_user_id' })
  actorUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
