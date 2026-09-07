import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { PaiseColumn } from '../../common/money/paise.transformer';
import { PaymentMethodEnum, PaymentStatusEnum } from '../enums';
import { Order } from './order.entity';

/** COD opens PENDING and moves to COLLECTED when admin records collection. Spec §10.4. */
@Entity('payments')
export class Payment extends BaseEntity {
  @Index('idx_payments_order')
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'enum', enum: PaymentMethodEnum })
  method: PaymentMethodEnum;

  @Column({ type: 'enum', enum: PaymentStatusEnum, default: PaymentStatusEnum.PENDING })
  status: PaymentStatusEnum;

  @PaiseColumn()
  amountPaise: bigint;

  @Column({ type: 'timestamptz', nullable: true })
  collectedAt: Date | null;

  /** A gateway reference once online payment is enabled; a receipt number for COD. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  reference: string | null;
  @Index('uq_payments_gateway_order_id', { unique: true })
  @Column({ name: 'gateway_order_id', type: 'varchar', length: 120, nullable: true })
  gatewayOrderId: string | null;
}
