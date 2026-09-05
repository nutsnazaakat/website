import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { Rfq } from './rfq.entity';

/**
 * Brief §24. Spec §3.2 maps brief §45's `GiftOrders` here, because the Phase 1 frontend
 * already models a gifting enquiry as `Rfq.kind = "gifting"` and both should land in one
 * numbered sales queue rather than two with separate statuses.
 */
@Entity('rfq_gifting_details')
export class RfqGiftingDetail {
  @PrimaryColumn({ type: 'uuid', name: 'rfq_id' })
  rfqId: string;

  @OneToOne(() => Rfq, (rfq) => rfq.gifting, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rfq_id' })
  rfq: Rfq;

  @Column({ type: 'varchar', length: 60 })
  occasion: string;

  @Column({ type: 'varchar', length: 120 })
  giftBoxSlug: string;

  @Column({ type: 'int' })
  boxes: number;

  @PaiseColumn()
  budgetPerBoxPaise: bigint;

  @Column({ type: 'boolean', default: false })
  brandingRequired: boolean;

  /** A calendar date, not an instant — `date` avoids a timezone shifting it by a day. */
  @Column({ type: 'date' })
  deliveryDate: string;

  @Column({ type: 'text', default: '' })
  message: string;
}
