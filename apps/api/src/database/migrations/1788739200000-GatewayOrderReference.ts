import type { MigrationInterface, QueryRunner } from 'typeorm';
export class GatewayOrderReference1788739200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "payments" ADD COLUMN "gateway_order_id" varchar(120)');
    await queryRunner.query(
      'CREATE UNIQUE INDEX "uq_payments_gateway_order_id" ON "payments" ("gateway_order_id")',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "uq_payments_gateway_order_id"');
    await queryRunner.query('ALTER TABLE "payments" DROP COLUMN "gateway_order_id"');
  }
}
