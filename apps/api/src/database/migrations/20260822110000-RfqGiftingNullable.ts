import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `rfqs.packaging` and `rfqs.frequency` become nullable, because a gifting enquiry genuinely has
 * neither: brief §45's gift box *is* the packaging, and a festive order *is* one-off. Measured
 * against `frontend/src/features/gifting/schema.ts`: it asks for neither field, and both columns
 * are `NOT NULL` today, so `POST /rfqs/gifting` cannot be stored at all until this runs.
 *
 * **Not** a sentinel (`'unspecified'`, `'One-time'`) written by the server — Plan 3's Task 20 made
 * the identical call about a customer cancellation writing no `cancelReason`: a server-written
 * value here would be a claim on the row an admin reads as fact, and there is nothing true to
 * claim for a question the gifting form never asked.
 *
 * `businessType` stays `NOT NULL` and is **not** touched by this migration — Task 9's own answer
 * to the same gap is to ask the gifting form for it instead, since it is a real question about a
 * real customer and `BUSINESS_TYPES` already carries "Corporate gifting" as an answer.
 */
export class RfqGiftingNullable20260822110000 implements MigrationInterface {
  name = 'RfqGiftingNullable20260822110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "rfqs" ALTER COLUMN "packaging" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "rfqs" ALTER COLUMN "frequency" DROP NOT NULL`);
  }

  /**
   * **Lossy by nature, and said so rather than hidden.** Relaxing `NOT NULL` is not reversible in
   * general: restoring the constraint on a table that by then holds genuine gifting enquiries with
   * null `packaging`/`frequency` would fail outright, so this coerces those nulls to a sentinel
   * first. That sentinel is exactly the claim-on-the-row this migration's `up()` docblock argues
   * against making in the first place — acceptable only because `down()` runs on a revert, where
   * the alternative is a migration that cannot revert at all.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "rfqs" SET "packaging" = 'unspecified' WHERE "packaging" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "rfqs" SET "frequency" = 'unspecified' WHERE "frequency" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "rfqs" ALTER COLUMN "packaging" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "rfqs" ALTER COLUMN "frequency" SET NOT NULL`);
  }
}
