import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sequence order numbers are drawn from.
 *
 * `START 100000` clears the seeded fixtures, which occupy `004488`–`005107`. From 1 the sequence would
 * issue perfectly good numbers for 4,487 orders and then collide with `NN-2026-004488` inside a
 * placement transaction — the kind of defect that arrives long after everyone has forgotten the seeder
 * wrote fixed numbers.
 *
 * Not `CYCLE`: wrapping would re-issue a reference a customer has already quoted to support.
 */
export class OrderNumberSequence20260821090000 implements MigrationInterface {
  name = 'OrderNumberSequence20260821090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "order_number_seq" START 100000 INCREMENT 1 NO CYCLE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "order_number_seq"`);
  }
}
