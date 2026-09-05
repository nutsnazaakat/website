import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * UUID primary keys throughout.
 *
 * Sequential integer ids leak volume (an order id of 42 tells a competitor how many orders
 * exist) and make an IDOR probe trivial to enumerate. Access is scoped by session anyway
 * (spec §13), but there is no reason to hand out a guessable key as well.
 *
 * Customer-facing references — `NN-2026-000123`, `RFQ-2026-000123` — are separate human
 * columns, not the primary key.
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
