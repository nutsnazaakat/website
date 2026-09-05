import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brief §16/§31. The gate on Milestone 7: `PricingResolver` (Task 2) cannot read a segment off a
 * business that has no `segment` column. See "The design gap nobody has closed" in the B2B plan
 * for why this is admin-set rather than derived from `businessType`.
 *
 * Sixth in the chain. Ordering comes from the last 13 characters of the *class name*, not the
 * filename — `MigrationExecutor.js:430` is `parseInt(migrationClassName.substr(-13), 10)` — so
 * `BusinessSegment20260822090000` yields `260822090000` and sorts after
 * `OrderNumberSequence20260821090000`'s `260821090000`.
 *
 * **The enum type is `pricing_tiers_segment_enum`, not a new `customer_segment_enum`.**
 * `PricingTier.segment` already uses `CustomerSegment` (`entities/enums.ts`), and Postgres has it
 * under the name TypeORM generated for that column — verified with
 * `SELECT typname FROM pg_type WHERE typtype = 'e'` against the live database, which lists
 * `pricing_tiers_segment_enum` and no `customer_segment_enum`. Reusing it, not creating a second
 * type with the same four members: two types with identical labels is how a comparison starts
 * needing an explicit cast, and `down()` below never drops this type for the same reason —
 * `pricing_tiers` still owns it after this migration reverts.
 *
 * `DEFAULT 'DEFAULT'` on a `NOT NULL` add is what makes this safe on a populated table: one
 * business row exists (`Anand Sweets & Namkeen`) and it must come out `DEFAULT`, i.e. its prices
 * must not change. `schema-invariants.integration.spec.ts` pins that.
 *
 * The two address foreign keys travel in the same migration because both were measured against
 * the live schema at the same time: `billing_address_id` and `shipping_address_id` have been bare
 * `uuid` columns with no constraint since `InitialSchema` — the only FKs `businesses` ever had were
 * `user_id` and `assigned_salesperson_id`. `ON DELETE SET NULL`, not `RESTRICT`: an address book
 * entry is the customer's to remove, and a business record must not be the thing that blocks it —
 * the opposite call from `coupon_redemptions.order_id`, and for the opposite reason.
 */
export class BusinessSegment20260822090000 implements MigrationInterface {
  name = 'BusinessSegment20260822090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD "segment" "public"."pricing_tiers_segment_enum" NOT NULL DEFAULT 'DEFAULT'`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "fk_businesses_billing_address"
         FOREIGN KEY ("billing_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "fk_businesses_shipping_address"
         FOREIGN KEY ("shipping_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "businesses" DROP CONSTRAINT "fk_businesses_shipping_address"`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" DROP CONSTRAINT "fk_businesses_billing_address"`,
    );
    await queryRunner.query(`ALTER TABLE "businesses" DROP COLUMN "segment"`);
  }
}
