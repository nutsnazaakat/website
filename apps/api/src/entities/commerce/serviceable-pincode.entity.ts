import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PaiseColumn } from '../../common/money/paise.transformer';

/**
 * Admin-editable delivery rules, keyed by pincode prefix.
 *
 * Phase 1 answered the pincode checker with `/^[2-8]\d{5}$/` and a digit-sum ETA. That was
 * honest as a mock but is not a delivery policy. Longest-prefix match wins, so a single '1'
 * row can cover a whole region and a specific '110001' row can override it.
 */
@Entity('serviceable_pincodes')
export class ServiceablePincode {
  /** 1 to 6 digits. A 6-digit row is an exact pincode. */
  @PrimaryColumn({ type: 'varchar', length: 6, name: 'pincode_prefix' })
  pincodePrefix: string;

  @Column({ type: 'boolean', default: true })
  isServiceable: boolean;

  /** Working days from dispatch. */
  @Column({ type: 'int', default: 4 })
  etaDays: number;

  @PaiseColumn({ default: 0 })
  shippingPaise: bigint;

  /** Admin-curated config — "when was this rule added" is useful for audit purposes. */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
