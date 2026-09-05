import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sequence support-ticket numbers are drawn from — `order_number_seq` and `rfq_number_seq`'s
 * sibling, for the identical reason: `nextval` is atomic where `max(ticketNumber) + 1` is a
 * read-then-write gap, and it is deliberately **not** rolled back by a failed transaction, so a
 * request that fails after allocating a number burns it rather than handing it to the next one.
 *
 * `START 100000`, matching both siblings: headroom above whatever a seeder writes with a fixed
 * reference, so the sequence's first live issue cannot collide with a fixture. `support_tickets`
 * has no seeder today, so this is precautionary rather than closing a known gap.
 *
 * Not `CYCLE`: wrapping would re-issue a reference a customer has already been given.
 */
export class TicketNumberSequence20260826100000 implements MigrationInterface {
  name = 'TicketNumberSequence20260826100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE "ticket_number_seq" START 100000 INCREMENT 1 NO CYCLE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "ticket_number_seq"`);
  }
}
