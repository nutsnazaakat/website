import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { ShipmentStatus } from '../enums';
import { Order } from './order.entity';

@Entity('shipments')
export class Shipment extends BaseEntity {
  @Index('idx_shipments_order')
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  courier: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  trackingNumber: string | null;

  @Column({ type: 'enum', enum: ShipmentStatus, default: ShipmentStatus.PENDING })
  status: ShipmentStatus;

  @Column({ type: 'timestamptz', nullable: true })
  shippedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;
}
