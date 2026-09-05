import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../identity/user.entity';

/**
 * Backs `frontend/src/config/settings.ts`. Brief §26 and §37 require the WhatsApp number,
 * contact details and certification text to be admin-editable and never hardcoded.
 *
 * A key/value table rather than a one-row table with 13 columns, so adding a setting in a
 * later phase is an insert rather than a migration.
 */
@Entity('settings')
export class Setting {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  /** False keeps a setting out of the public `GET /settings` response. */
  @Column({ type: 'boolean', default: true })
  isPublic: boolean;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedByUser: User | null;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by_user_id' })
  updatedByUserId: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
