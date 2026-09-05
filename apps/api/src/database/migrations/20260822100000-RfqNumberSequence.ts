import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sequence RFQ numbers are drawn from — `order_number_seq`'s sibling, for the identical
 * reason: `nextval` is atomic where `max(rfqNumber) + 1` is a read-then-write gap, and it is
 * deliberately **not** rolled back by a failed transaction, so a rejected RFQ burns a number
 * rather than handing it to the next enquiry. A gap in the sequence is invisible to everyone; a
 * duplicate reference is not.
 *
 * `START 100000` for the same reason `order_number_seq` starts there: headroom above whatever a
 * seeder writes with a fixed reference, so the sequence's first live issue cannot collide with a
 * fixture.
 *
 * Not `CYCLE`: wrapping would re-issue a reference a customer has already been quoted against.
 */
export class RfqNumberSequence20260822100000 implements MigrationInterface {
  name = 'RfqNumberSequence20260822100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "rfq_number_seq" START 100000 INCREMENT 1 NO CYCLE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "rfq_number_seq"`);
  }
}
