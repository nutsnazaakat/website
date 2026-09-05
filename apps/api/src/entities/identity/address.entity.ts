import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { User } from './user.entity';

/**
 * The account address book. Orders never reference this table — they store an
 * `addressSnapshot` jsonb instead (spec §5.3), so deleting an address cannot rewrite where a
 * past order was delivered. Soft-deleted so a restore is possible.
 */
@Entity('addresses')
export class Address extends BaseEntity {
  @Index('idx_addresses_user')
  @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid', name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 40 })
  label: string;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Column({ type: 'varchar', length: 15 })
  phone: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  line1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  line2: string | null;

  @Column({ type: 'varchar', length: 80 })
  city: string;

  @Column({ type: 'varchar', length: 80 })
  state: string;

  @Column({ type: 'char', length: 6 })
  pincode: string;

  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
