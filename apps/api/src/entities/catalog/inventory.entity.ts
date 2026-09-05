import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ProductVariant } from './product-variant.entity';

/**
 * Stock, one row per variant. Brief §32.
 *
 * A separate table from `ProductVariant` for two reasons: a stock write during checkout must
 * not lock a row that catalogue reads and admin product edits also touch, and the ledger in
 * `InventoryTransaction` needs a single clear owner.
 *
 * `available` is `onHand - reserved`, computed rather than stored — a third column would be a
 * third thing that can disagree with the other two.
 */
@Entity('inventory')
export class Inventory {
  @PrimaryColumn({ type: 'uuid', name: 'variant_id' })
  variantId: string;

  /**
   * `CASCADE` is correct here and deliberately different from `InventoryTransaction.variant`
   * (`RESTRICT`): `Inventory` is genuinely 1:1 with the variant and part of its lifecycle, not
   * an independent audit record. It also can never be orphaned by this — a variant with ledger
   * history already cannot be deleted because `InventoryTransaction` restricts first.
   */
  @OneToOne(() => ProductVariant, (variant) => variant.inventory, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariant;

  /** Physical stock. Never negative — enforced by a check constraint in the migration. */
  @Column({ type: 'int', default: 0 })
  onHand: number;

  /**
   * Held for in-flight operations. Adding to cart reserves nothing (spec §10.1), so this is
   * zero in normal operation; it exists so a future hold mechanism does not need a migration.
   */
  @Column({ type: 'int', default: 0 })
  reserved: number;

  @Column({ type: 'int', default: 10 })
  lowStockThreshold: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
