import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { RfqKind } from '../enums';
import { User } from '../identity/user.entity';
import type { RfqGiftingDetail } from './rfq-gifting-detail.entity';
import type { RfqItem } from './rfq-item.entity';
import type { RfqNote } from './rfq-note.entity';

/**
 * Brief §17 and §34. Created publicly — a prospect need not have an account, which is why
 * `userId` is nullable and the contact fields are stored on the RFQ rather than read from a
 * user record.
 */
@Entity('rfqs')
export class Rfq extends BaseEntity {
  @Index('uq_rfqs_rfq_number', { unique: true })
  @Column({ type: 'varchar', length: 20 })
  rfqNumber: string;

  @Index('idx_rfqs_user')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId: string | null;

  @Column({ type: 'enum', enum: RfqKind, default: RfqKind.BULK })
  kind: RfqKind;

  @Column({ type: 'varchar', length: 160 })
  businessName: string;

  @Column({ type: 'varchar', length: 120 })
  contactPerson: string;

  @Column({ type: 'varchar', length: 15 })
  mobile: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'char', length: 15, nullable: true })
  gstin: string | null;

  @Column({ type: 'varchar', length: 60 })
  businessType: string;

  @Column({ type: 'char', length: 6 })
  pincode: string;

  /**
   * Null for a gifting enquiry, which has no packaging question — brief §45's gift box *is* the
   * packaging. Never a written sentinel: see `RfqGiftingNullable20260822110000`'s docblock.
   */
  @Column({ type: 'varchar', length: 60, nullable: true })
  packaging: string | null;

  /** Null for a gifting enquiry, which is inherently one-off. Same rule as `packaging`. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  frequency: string | null;

  /**
   * **The prospect's own free text** — brief §17's "additional requirements", typed into the public
   * form and written by `CreateRfqDto.notes`. `RfqDetail.notes` shows it straight back to them, and
   * `AdminRfq.notes` shows the operator the same string under the same name.
   *
   * **Not the sales desk's notes, and not legacy.** Brief §34's internal notes are `RfqNote` /
   * `notesList` below, which `rfq-note.entity.ts` says are never exposed on a customer-facing
   * endpoint. Recorded here because the two are one word apart and plan 9.3 had to decide which
   * `POST /admin/rfqs/:rfqNumber/notes` writes: writing this column would destroy what the customer
   * wrote *and* publish a confidential note back to them. Nothing on the admin surface writes it.
   */
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  /** One of `RFQ_STATUSES` from `@nutwala/shared`. Brief §34's seven-state pipeline. */
  @Index('idx_rfqs_status')
  @Column({ type: 'varchar', length: 20, default: 'new' })
  status: string;

  /**
   * Brief §34's assigned salesperson — an **admin** user, matching the identical column on
   * `Business` and its stated reasoning ("an admin user, not a separate staff table").
   *
   * The reference is a bare `users(id)`, so nothing at the database level stops an enquiry being
   * assigned to a customer; `AdminRfqsService.requireAdmin` is what enforces the role, and
   * `PATCH /admin/rfqs/:rfqNumber` is its only writer. `ON DELETE SET NULL`, so an admin who leaves
   * takes their assignments with them rather than blocking their own deletion.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_salesperson_id' })
  assignedSalesperson: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_salesperson_id' })
  assignedSalespersonId: string | null;

  /** Brief §34's "expected value", set by the sales desk. */
  @PaiseColumn({ nullable: true })
  expectedValuePaise: bigint | null;

  @OneToMany('RfqItem', 'rfq', { cascade: ['insert'] })
  items: RfqItem[];

  @OneToMany('RfqNote', 'rfq')
  notesList: RfqNote[];

  @OneToOne('RfqGiftingDetail', 'rfq', { cascade: ['insert'] })
  gifting: RfqGiftingDetail | null;
}
