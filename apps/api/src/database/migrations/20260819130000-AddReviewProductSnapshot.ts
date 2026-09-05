import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reviews.product_id` was `NOT NULL` with `ON DELETE CASCADE`, so deleting a product (the
 * planned `DELETE /admin/products/:id`) would silently delete every review of it — the rating,
 * the body, the image, `verifiedPurchase`, and the whole moderation trail
 * (`moderatedByUserId`, `moderatedAt`, `rejectionReason`). `order_items` and `rfq_items` already
 * protect exactly this kind of evidence with a nullable `SET NULL` id plus a `productSlug`
 * snapshot column; this brings `reviews` in line with that convention. The column is named
 * `"productSlug"` (camelCase, unmapped) rather than `product_slug`, matching how those two
 * tables already store it.
 *
 * The backfill has to run between adding `productSlug` and making it `NOT NULL`: the column is
 * added nullable first so the 14 existing rows can be populated from `products.slug` before the
 * constraint is applied — a bare `NOT NULL` add would fail on rows that predate the column.
 */
export class AddReviewProductSnapshot20260819130000 implements MigrationInterface {
  name = 'AddReviewProductSnapshot20260819130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reviews" ADD "productSlug" character varying(120)`);

    await queryRunner.query(`
      UPDATE "reviews" AS r
      SET "productSlug" = p."slug"
      FROM "products" AS p
      WHERE p."id" = r."product_id"
    `);

    await queryRunner.query(`ALTER TABLE "reviews" ALTER COLUMN "productSlug" SET NOT NULL`);

    await queryRunner.query(`CREATE INDEX "idx_reviews_product_slug" ON "reviews" ("productSlug")`);

    await queryRunner.query(`ALTER TABLE "reviews" ALTER COLUMN "product_id" DROP NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44"`,
    );
    await queryRunner.query(`
      ALTER TABLE "reviews"
        ADD CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44"`,
    );
    await queryRunner.query(`
      ALTER TABLE "reviews"
        ADD CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`ALTER TABLE "reviews" ALTER COLUMN "product_id" SET NOT NULL`);

    await queryRunner.query(`DROP INDEX "public"."idx_reviews_product_slug"`);

    await queryRunner.query(`ALTER TABLE "reviews" DROP COLUMN "productSlug"`);
  }
}
