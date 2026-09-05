import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes a guest cart storable, per spec §5.3.
 *
 * `user_id` becomes nullable and `guest_token` arrives, with a check constraint asserting that exactly
 * one of them is set. Without that constraint the table permits a row belonging to nobody and a row
 * belonging to both, and both would be resolved by whichever `WHERE` clause happened to run first.
 *
 * The existing `uq_carts_user` unique index keeps working on a nullable column: Postgres treats NULLs
 * as distinct in a unique index, so any number of guest carts coexist while a user still has at most
 * one. That is exactly the semantics wanted, so the index is left alone rather than rebuilt as partial.
 *
 * The column is `guest_token`, not the `guestKey` spec §5.3 names, and that is a security requirement
 * rather than a preference. `common/logging/pii-redactor.ts` redacts on the key *name* — a key
 * containing `token` is removed, and it holds no list of this application's field names. Measured:
 * `redact({ guest_key: 'S' })` returns `{ guest_key: 'S' }` while `redact({ guest_token: 'S' })`
 * returns `{ guest_token: '[REDACTED]' }`. The value is a bearer credential — whoever holds it can
 * read and replace that basket — so under `guestKey` every log line that serialises a `Cart` row
 * would write it in plaintext. Naming it `guest_token` makes the existing redactor catch it.
 */
export class GuestCarts20260820090000 implements MigrationInterface {
  name = 'GuestCarts20260820090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "carts" ALTER COLUMN "user_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "carts" ADD "guest_token" character varying(64)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_carts_guest_token" ON "carts" ("guest_token") WHERE "guest_token" IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "carts" ADD CONSTRAINT "ck_carts_owner_exclusive"
      CHECK (("user_id" IS NOT NULL AND "guest_token" IS NULL)
          OR ("user_id" IS NULL AND "guest_token" IS NOT NULL))
    `);
  }

  /**
   * Guest carts are deleted rather than adopted on the way down: there is no user to attribute them
   * to, and leaving them would violate the restored NOT NULL. A `DELETE` in a `down()` deserves the
   * comment — this is a development-only reversal, and losing anonymous baskets is the correct
   * outcome of un-shipping the feature that created them.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "carts" DROP CONSTRAINT "ck_carts_owner_exclusive"`);
    await queryRunner.query(`DROP INDEX "public"."uq_carts_guest_token"`);
    await queryRunner.query(`DELETE FROM "carts" WHERE "user_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "carts" DROP COLUMN "guest_token"`);
    await queryRunner.query(`ALTER TABLE "carts" ALTER COLUMN "user_id" SET NOT NULL`);
  }
}
