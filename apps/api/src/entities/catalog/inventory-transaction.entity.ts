import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InventoryTransactionType } from '../enums';
import { ProductVariant } from './product-variant.entity';
import { User } from '../identity/user.entity';
import { Order } from '../commerce/order.entity';

/**
 * Append-only stock ledger. Brief §32 wants stock added, sold and adjusted with a reason, a
 * date and the admin responsible.
 *
 * No `updatedAt`, and nothing ever updates or deletes a row: an audit trail that can be
 * edited is not an audit trail. A correction is a new compensating row.
 *
 * The invariant `SUM(delta) = inventory.on_hand` per variant is asserted by an integration
 * test in Task 21, which is what stops the denormalised column drifting from the ledger.
 */
@Entity('inventory_transactions')
export class InventoryTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * `RESTRICT`, not `CASCADE`: this ledger is append-only and must outlive the variant it
   * describes, so a variant with stock history cannot be hard-deleted — admin deactivates it
   * instead (`ProductVariant.isActive = false`). Matches the `Product → Category` pattern
   * elsewhere in this schema.
   */
  @Index('idx_inventory_transactions_variant')
  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant;

  @Column({ type: 'uuid', name: 'variant_id' })
  variantId: string;

  /** Signed. Negative for a sale, positive for a receipt, either for an adjustment. */
  @Column({ type: 'int' })
  delta: number;

  @Column({ type: 'enum', enum: InventoryTransactionType })
  type: InventoryTransactionType;

  @Column({ type: 'varchar', length: 200 })
  reason: string;

  /** Set for SALE, CANCELLATION and RETURN. Null for a manual receipt or adjustment. */
  @ManyToOne(() => Order, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'order_id' })
  order: Order | null;

  @Index('idx_inventory_transactions_order')
  @Column({ type: 'uuid', nullable: true, name: 'order_id' })
  orderId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'actor_user_id' })
  actorUserId: string | null;

  /** `onHand` after this row was applied, so the ledger reads without recomputing a sum. */
  @Column({ type: 'int' })
  balanceAfter: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
