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
import { Rfq } from './rfq.entity';

/**
 * Brief §34 internal notes.
 *
 * Never exposed on a customer-facing endpoint. `GET /rfqs/:rfqNumber` must not select this
 * relation — a sales note about a prospect's negotiating position is not for the prospect.
 */
@Entity('rfq_notes')
export class RfqNote {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('idx_rfq_notes_rfq')
  @ManyToOne(() => Rfq, (rfq) => rfq.notesList, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'author_user_id' })
  authorUser: User;

  @Column({ type: 'uuid', name: 'author_user_id' })
  authorUserId: string;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
