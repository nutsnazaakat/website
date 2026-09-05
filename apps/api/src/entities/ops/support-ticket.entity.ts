import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from '../identity/user.entity';
import type { SupportTicketNote } from './support-ticket-note.entity';

/**
 * The user's "help support queries". Fed by the existing contact form, which already submits
 * name, email, optional phone, topic, optional order id and message.
 *
 * `orderNumber` is a soft link, not a foreign key: a customer may type an order number that
 * does not exist or belongs to someone else, and the ticket must still be created so support
 * can answer. Admin resolves it to an order for display.
 */
@Entity('support_tickets')
export class SupportTicket extends BaseEntity {
  @Index('uq_support_tickets_ticket_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  ticketNumber: string;

  @Index('idx_support_tickets_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 15, nullable: true })
  phone: string | null;

  /** One of `CONTACT_TOPICS` from `@nutwala/shared`. */
  @Column({ type: 'varchar', length: 60 })
  topic: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  orderNumber: string | null;

  @Column({ type: 'text' })
  message: string;

  /** One of `SUPPORT_TICKET_STATUSES` from `@nutwala/shared`. */
  @Index('idx_support_tickets_status')
  @Column({ type: 'varchar', length: 20, default: 'new' })
  status: string;

  @Column({ type: 'int', default: 2 })
  priority: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_to_user_id' })
  assignedToUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_to_user_id' })
  assignedToUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @OneToMany('SupportTicketNote', 'ticket')
  notes: SupportTicketNote[];
}
