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
import { SupportTicket } from './support-ticket.entity';

@Entity('support_ticket_notes')
export class SupportTicketNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_support_ticket_notes_ticket')
  @ManyToOne(() => SupportTicket, (ticket) => ticket.notes, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: SupportTicket;

  @Column({ type: 'uuid', name: 'ticket_id' })
  ticketId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_user_id' })
  authorUser: User;

  @Column({ type: 'uuid', name: 'author_user_id' })
  authorUserId: string;

  @Column({ type: 'text' })
  body: string;

  /** True is staff-only. A customer-visible reply is false. */
  @Column({ type: 'boolean', default: true })
  isInternal: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
