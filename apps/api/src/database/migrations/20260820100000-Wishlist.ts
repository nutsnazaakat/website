import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The saved-items table, per spec §5.3 and brief §8's heart on the product card.
 *
 * Fourth in the chain. Ordering comes from the last 13 characters of the *class name*, not the
 * filename — `MigrationExecutor.getMigrations()` does `parseInt(migrationClassName.substr(-13), 10)`
 * — so `Wishlist20260820100000` yields 260820100000 and sorts after `GuestCarts20260820090000`'s
 * 260820090000. Verified against `migration:show` rather than assumed; the row this writes into
 * `migrations` carries `timestamp = 260820100000`, the leading `2` of the 14-digit stamp dropped.
 *
 * `migration:generate` output for this table, checked once so the next reader does not have to:
 * it proposes dropping `ck_wishlist_items_owner_exclusive` and both unique indexes, exactly as it
 * already does for `ck_carts_owner_exclusive`, `uq_carts_guest_token`, `uq_users_email`,
 * `ck_inventory_non_negative` and every other hand-written invariant in this chain — discard it, per
 * the note in `20260819120000-InitialSchema.ts`. It also proposes renaming
 * `fk_wishlist_items_user`/`fk_wishlist_items_product` to `FK_<hash>`, because the 46 foreign keys in
 * the initial schema were generated and carry hash names while these two are hand-written. Discard
 * that too: the definitions are identical and a constraint name that says what it constrains is
 * worth more in an error message than agreement with a hash. `pk_wishlist_items` provokes no such
 * proposal — TypeORM compares primary keys by column, not by constraint name.
 */
export class Wishlist20260820100000 implements MigrationInterface {
  name = 'Wishlist20260820100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wishlist_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid,
        "guest_token" character varying(64),
        "product_id" uuid NOT NULL,
        CONSTRAINT "pk_wishlist_items" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "wishlist_items"
        ADD CONSTRAINT "fk_wishlist_items_user"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "wishlist_items"
        ADD CONSTRAINT "fk_wishlist_items_product"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "wishlist_items" ADD CONSTRAINT "ck_wishlist_items_owner_exclusive"
      CHECK (("user_id" IS NOT NULL AND "guest_token" IS NULL)
          OR ("user_id" IS NULL AND "guest_token" IS NOT NULL))
    `);

    /**
     * Two unique indexes, one per owner kind, so the same product cannot be saved twice.
     *
     * *Two* of them is the load-bearing part. With a single `UNIQUE (user_id, product_id)` every
     * guest row has `user_id` NULL, Postgres treats NULLs as distinct, and a guest can save the same
     * product without limit. Measured on a throwaway database: with only that one index, the same
     * `guest_token`/`product_id` pair inserted three times returned `INSERT 0 1` three times.
     *
     * The `WHERE` predicates are **not** what enforces it, and the earlier "partial rather than a
     * plain composite" reading of this was wrong. Measured too: swapping
     * `uq_wishlist_items_guest_product` for a plain composite on the same two columns still rejects
     * the duplicate guest save, because a user-owned row's `guest_token` is NULL and NULLs are
     * distinct there as well. What the predicates buy is that each index holds only the rows it is
     * about — roughly half the table each — and that it reads as governing one owner kind. They
     * would become load-bearing only under Postgres 15's opt-in `NULLS NOT DISTINCT`, which this
     * schema does not use.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_wishlist_items_user_product"
        ON "wishlist_items" ("user_id", "product_id") WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_wishlist_items_guest_product"
        ON "wishlist_items" ("guest_token", "product_id") WHERE "guest_token" IS NOT NULL
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_wishlist_items_user" ON "wishlist_items" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_wishlist_items_guest" ON "wishlist_items" ("guest_token")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table takes its indexes and constraints with it. Listed explicitly anyway,
    // because an accidental partial revert leaving an orphaned index is what makes the next `up`
    // fail with "relation already exists" rather than anything informative.
    await queryRunner.query(`DROP INDEX "public"."idx_wishlist_items_guest"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wishlist_items_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wishlist_items_guest_product"`);
    await queryRunner.query(`DROP INDEX "public"."uq_wishlist_items_user_product"`);
    await queryRunner.query(`DROP TABLE "wishlist_items"`);
  }
}
