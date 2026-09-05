import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema20260819120000 implements MigrationInterface {
  name = 'InitialSchema20260819120000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('CUSTOMER', 'BUSINESS', 'ADMIN')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(120) NOT NULL, "email" character varying(255) NOT NULL, "phone" character varying(15) NOT NULL, "passwordHash" character varying(100) NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'CUSTOMER', "isActive" boolean NOT NULL DEFAULT true, "lastLoginAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "support_tickets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ticketNumber" character varying(20) NOT NULL, "user_id" uuid, "name" character varying(120) NOT NULL, "email" character varying(255) NOT NULL, "phone" character varying(15), "topic" character varying(60) NOT NULL, "orderNumber" character varying(20), "message" text NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'new', "priority" integer NOT NULL DEFAULT '2', "assigned_to_user_id" uuid, "resolvedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_942e8d8f5df86100471d2324643" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_support_tickets_ticket_number" ON "support_tickets" ("ticketNumber") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_support_tickets_user" ON "support_tickets" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_support_tickets_status" ON "support_tickets" ("status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "support_ticket_notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticket_id" uuid NOT NULL, "author_user_id" uuid NOT NULL, "body" text NOT NULL, "isInternal" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ce42d5ec9d5731befe4fdd7c190" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_support_ticket_notes_ticket" ON "support_ticket_notes" ("ticket_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "settings" ("key" character varying(60) NOT NULL, "value" jsonb NOT NULL, "isPublic" boolean NOT NULL DEFAULT true, "updated_by_user_id" uuid, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c8639b7626fa94ba8265628f214" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_channel_enum" AS ENUM('EMAIL', 'WHATSAPP')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_status_enum" AS ENUM('QUEUED', 'SENT', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "notifications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid, "channel" "public"."notifications_channel_enum" NOT NULL, "template" character varying(60) NOT NULL, "payload" jsonb NOT NULL, "status" "public"."notifications_status_enum" NOT NULL DEFAULT 'QUEUED', "sentAt" TIMESTAMP WITH TIME ZONE, "error" character varying(300), CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_user" ON "notifications" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_notifications_status" ON "notifications" ("status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("key" character varying(200) NOT NULL, "scope" character varying(60) NOT NULL, "requestHash" character(64) NOT NULL, "responseBody" jsonb, "statusCode" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_idempotency_keys_created_at" ON "idempotency_keys" ("createdAt") `,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actor_user_id" uuid NOT NULL, "action" character varying(60) NOT NULL, "entity" character varying(40) NOT NULL, "entityId" character varying(60), "before" jsonb, "after" jsonb, "ip" character varying(45), "userAgent" character varying(255), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" ("actor_user_id") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" ("entity") `);
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "refreshTokenHash" character(64) NOT NULL, "familyId" uuid NOT NULL, "userAgent" character varying(255), "ip" character varying(45), "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, "revokedReason" character varying(40), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_sessions_user" ON "sessions" ("user_id") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sessions_refresh_token_hash" ON "sessions" ("refreshTokenHash") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_sessions_family" ON "sessions" ("familyId") `);
    await queryRunner.query(
      `CREATE TABLE "businesses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "companyName" character varying(160) NOT NULL, "contactPerson" character varying(120) NOT NULL, "mobile" character varying(15) NOT NULL, "gstin" character(15), "businessType" character varying(60) NOT NULL, "billing_address_id" uuid, "shipping_address_id" uuid, "assigned_salesperson_id" uuid, CONSTRAINT "UQ_cbb98c2d1e4c7bdf6eabc305c42" UNIQUE ("user_id"), CONSTRAINT "REL_cbb98c2d1e4c7bdf6eabc305c4" UNIQUE ("user_id"), CONSTRAINT "PK_bc1bf63498dd2368ce3dc8686e8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_businesses_assigned_salesperson" ON "businesses" ("assigned_salesperson_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "label" character varying(40) NOT NULL, "fullName" character varying(120) NOT NULL, "phone" character varying(15) NOT NULL, "email" character varying(255) NOT NULL, "line1" character varying(255) NOT NULL, "line2" character varying(255), "city" character varying(80) NOT NULL, "state" character varying(80) NOT NULL, "pincode" character(6) NOT NULL, "isDefault" boolean NOT NULL DEFAULT false, "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_addresses_user" ON "addresses" ("user_id") `);
    await queryRunner.query(
      `CREATE TABLE "categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "slug" character varying(80) NOT NULL, "name" character varying(120) NOT NULL, "image" character varying(500) NOT NULL, "blurb" character varying(300) NOT NULL, "description" text NOT NULL, "sortOrder" integer NOT NULL DEFAULT '0', "isPublished" boolean NOT NULL DEFAULT true, "seo" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_categories_slug" ON "categories" ("slug") `);
    await queryRunner.query(
      `CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "slug" character varying(120) NOT NULL, "name" character varying(200) NOT NULL, "category_id" uuid NOT NULL, "subtitle" character varying(300) NOT NULL, "description" text NOT NULL, "badge" character varying(20), "origin" character varying(120) NOT NULL, "grade" character varying(80) NOT NULL, "processing" character varying(200) NOT NULL, "shelfLife" character varying(120) NOT NULL, "storage" character varying(300) NOT NULL, "ingredients" character varying(300) NOT NULL, "hsn" character varying(12) NOT NULL, "gstRate" numeric(5,2) NOT NULL, "moqKg" numeric(8,2) NOT NULL DEFAULT '0', "quoteOnly" boolean NOT NULL DEFAULT false, "isPublished" boolean NOT NULL DEFAULT false, "publishedAt" TIMESTAMP WITH TIME ZONE, "ratingAvg" numeric(3,2) NOT NULL DEFAULT '0', "reviewCount" integer NOT NULL DEFAULT '0', "seo" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_products_slug" ON "products" ("slug") `);
    await queryRunner.query(`CREATE INDEX "idx_products_category" ON "products" ("category_id") `);
    await queryRunner.query(
      `CREATE TYPE "public"."reviews_status_enum" AS ENUM('PENDING', 'APPROVED', 'REJECTED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "reviews" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "product_id" uuid NOT NULL, "user_id" uuid, "author" character varying(120) NOT NULL, "rating" integer NOT NULL, "body" text NOT NULL, "imageUrl" character varying(500), "verifiedPurchase" boolean NOT NULL DEFAULT false, "status" "public"."reviews_status_enum" NOT NULL DEFAULT 'PENDING', "moderated_by_user_id" uuid, "moderatedAt" TIMESTAMP WITH TIME ZONE, "rejectionReason" character varying(200), CONSTRAINT "PK_231ae565c273ee700b283f15c1d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_reviews_product" ON "reviews" ("product_id") `);
    await queryRunner.query(`CREATE INDEX "idx_reviews_status" ON "reviews" ("status") `);
    await queryRunner.query(
      `CREATE TABLE "blog_posts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "slug" character varying(160) NOT NULL, "title" character varying(250) NOT NULL, "category" character varying(40) NOT NULL, "excerpt" character varying(400) NOT NULL, "image" character varying(500) NOT NULL, "author" character varying(120) NOT NULL, "body" text NOT NULL, "isPublished" boolean NOT NULL DEFAULT false, "publishedAt" TIMESTAMP WITH TIME ZONE, "seo" jsonb NOT NULL DEFAULT '{}'::jsonb, CONSTRAINT "PK_dd2add25eac93daefc93da9d387" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_blog_posts_slug" ON "blog_posts" ("slug") `);
    await queryRunner.query(`CREATE INDEX "idx_blog_posts_category" ON "blog_posts" ("category") `);
    await queryRunner.query(
      `CREATE INDEX "idx_blog_posts_published_at" ON "blog_posts" ("publishedAt") `,
    );
    await queryRunner.query(`CREATE TYPE "public"."orders_channel_enum" AS ENUM('RETAIL', 'BULK')`);
    await queryRunner.query(
      `CREATE TYPE "public"."orders_paymentmethod_enum" AS ENUM('COD', 'ONLINE')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_paymentstatus_enum" AS ENUM('PENDING', 'COLLECTED', 'FAILED', 'REFUNDED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "orderNumber" character varying(20) NOT NULL, "user_id" uuid, "business_id" uuid, "channel" "public"."orders_channel_enum" NOT NULL, "status" character varying(24) NOT NULL, "paymentMethod" "public"."orders_paymentmethod_enum" NOT NULL, "paymentStatus" "public"."orders_paymentstatus_enum" NOT NULL DEFAULT 'PENDING', "subtotalPaise" bigint NOT NULL, "discountPaise" bigint NOT NULL DEFAULT '0', "gstPaise" bigint NOT NULL, "shippingPaise" bigint NOT NULL DEFAULT '0', "totalPaise" bigint NOT NULL, "couponCode" character varying(40), "addressSnapshot" jsonb NOT NULL, "billingSnapshot" jsonb, "companyName" character varying(160), "gstin" character(15), "poNumber" character varying(60), "specialInstructions" text, "placedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "estimatedDelivery" TIMESTAMP WITH TIME ZONE NOT NULL, "cancelledAt" TIMESTAMP WITH TIME ZONE, "cancelReason" character varying(200), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_orders_order_number" ON "orders" ("orderNumber") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_orders_user" ON "orders" ("user_id") `);
    await queryRunner.query(`CREATE INDEX "idx_orders_status" ON "orders" ("status") `);
    await queryRunner.query(`CREATE INDEX "idx_orders_placed_at" ON "orders" ("placedAt") `);
    await queryRunner.query(
      `CREATE INDEX "idx_orders_status_placed_at" ON "orders" ("status", "placedAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_user_placed_at" ON "orders" ("user_id", "placedAt") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."shipments_status_enum" AS ENUM('PENDING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "shipments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" uuid NOT NULL, "courier" character varying(80), "trackingNumber" character varying(120), "status" "public"."shipments_status_enum" NOT NULL DEFAULT 'PENDING', "shippedAt" TIMESTAMP WITH TIME ZONE, "deliveredAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6deda4532ac542a93eab214b564" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_shipments_order" ON "shipments" ("order_id") `);
    await queryRunner.query(
      `CREATE TABLE "serviceable_pincodes" ("pincode_prefix" character varying(6) NOT NULL, "isServiceable" boolean NOT NULL DEFAULT true, "etaDays" integer NOT NULL DEFAULT '4', "shippingPaise" bigint NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_121a030e86322e52060127bb330" PRIMARY KEY ("pincode_prefix"))`,
    );
    await queryRunner.query(`CREATE TYPE "public"."payments_method_enum" AS ENUM('COD', 'ONLINE')`);
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum" AS ENUM('PENDING', 'COLLECTED', 'FAILED', 'REFUNDED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" uuid NOT NULL, "method" "public"."payments_method_enum" NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'PENDING', "amountPaise" bigint NOT NULL, "collectedAt" TIMESTAMP WITH TIME ZONE, "reference" character varying(120), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_payments_order" ON "payments" ("order_id") `);
    await queryRunner.query(
      `CREATE TYPE "public"."product_variants_channel_enum" AS ENUM('RETAIL', 'BULK')`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_variants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "product_id" uuid NOT NULL, "sku" character varying(60) NOT NULL, "size" character varying(20) NOT NULL, "grams" integer NOT NULL, "channel" "public"."product_variants_channel_enum" NOT NULL, "pricePaise" bigint NOT NULL, "mrpPaise" bigint NOT NULL, "moq" integer NOT NULL DEFAULT '1', "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_281e3f2c55652d6a22c0aa59fd7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_product_variants_product" ON "product_variants" ("product_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_product_variants_sku" ON "product_variants" ("sku") `,
    );
    await queryRunner.query(
      `CREATE TABLE "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "order_id" uuid NOT NULL, "product_id" uuid, "variant_id" uuid, "productSlug" character varying(120) NOT NULL, "name" character varying(200) NOT NULL, "hsn" character varying(12), "detail" character varying(40) NOT NULL, "size" character varying(20), "grams" integer, "kg" numeric(8,2), "qty" integer NOT NULL, "unitPricePaise" bigint NOT NULL, "lineTotalPaise" bigint, "gstRate" numeric(5,2) NOT NULL, "gstAmountPaise" bigint NOT NULL DEFAULT '0', CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_order_items_order" ON "order_items" ("order_id") `);
    await queryRunner.query(
      `CREATE TABLE "order_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "status" character varying(24) NOT NULL, "note" character varying(300), "actor_user_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cc1b82b0fcf1be577d9d7ecbf8b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_order_events_order" ON "order_events" ("order_id") `,
    );
    await queryRunner.query(`CREATE TYPE "public"."coupons_type_enum" AS ENUM('PERCENT', 'FLAT')`);
    await queryRunner.query(
      `CREATE TYPE "public"."coupons_appliesto_enum" AS ENUM('ALL', 'CATEGORY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."coupons_channel_enum" AS ENUM('ALL', 'RETAIL', 'BULK')`,
    );
    await queryRunner.query(
      `CREATE TABLE "coupons" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "code" character varying(40) NOT NULL, "type" "public"."coupons_type_enum" NOT NULL, "percentValue" numeric(5,2), "flatValuePaise" bigint, "minOrderValuePaise" bigint, "maxDiscountPaise" bigint, "appliesTo" "public"."coupons_appliesto_enum" NOT NULL DEFAULT 'ALL', "category_id" uuid, "channel" "public"."coupons_channel_enum" NOT NULL DEFAULT 'ALL', "firstOrderOnly" boolean NOT NULL DEFAULT false, "usageLimit" integer, "usageLimitPerUser" integer, "startsAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE, "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_d7ea8864a0150183770f3e9a8cb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_coupons_code" ON "coupons" ("code") `);
    await queryRunner.query(
      `CREATE TABLE "coupon_redemptions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "coupon_id" uuid NOT NULL, "user_id" uuid, "order_id" uuid NOT NULL, "discountPaise" bigint NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_coupon_redemptions_coupon_order" UNIQUE ("coupon_id", "order_id"), CONSTRAINT "PK_5086813ea980d21dbeb190ed0a7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_coupon_redemptions_user" ON "coupon_redemptions" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "carts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, CONSTRAINT "PK_b5f695a59f5ebb50af3c8160816" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_carts_user" ON "carts" ("user_id") `);
    await queryRunner.query(
      `CREATE TYPE "public"."cart_items_mode_enum" AS ENUM('RETAIL', 'BULK')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cart_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "cart_id" uuid NOT NULL, "product_id" uuid NOT NULL, "variant_id" uuid, "mode" "public"."cart_items_mode_enum" NOT NULL, "kg" numeric(8,2), "qty" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_6fccf5ec03c172d27a28a82928b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_cart_items_cart" ON "cart_items" ("cart_id") `);
    await queryRunner.query(
      `CREATE TABLE "product_images" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "product_id" uuid NOT NULL, "url" character varying(500) NOT NULL, "alt" character varying(200) NOT NULL DEFAULT '', "sortOrder" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_1974264ea7265989af8392f63a1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_product_images_product" ON "product_images" ("product_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."pricing_tiers_segment_enum" AS ENUM('DEFAULT', 'RETAILER', 'DISTRIBUTOR', 'HORECA')`,
    );
    await queryRunner.query(
      `CREATE TABLE "pricing_tiers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "product_id" uuid NOT NULL, "minKg" numeric(8,2) NOT NULL, "maxKg" numeric(8,2), "pricePerKgPaise" bigint, "segment" "public"."pricing_tiers_segment_enum" NOT NULL DEFAULT 'DEFAULT', "business_id" uuid, CONSTRAINT "PK_f5f75ade45fc37142b2cdbaa2f5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pricing_tiers_product" ON "pricing_tiers" ("product_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "inventory" ("variant_id" uuid NOT NULL, "onHand" integer NOT NULL DEFAULT '0', "reserved" integer NOT NULL DEFAULT '0', "lowStockThreshold" integer NOT NULL DEFAULT '10', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ceba910e3505fc54c3c7f92c943" PRIMARY KEY ("variant_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_transactions_type_enum" AS ENUM('RECEIPT', 'SALE', 'ADJUSTMENT', 'RETURN', 'CANCELLATION')`,
    );
    await queryRunner.query(
      `CREATE TABLE "inventory_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "variant_id" uuid NOT NULL, "delta" integer NOT NULL, "type" "public"."inventory_transactions_type_enum" NOT NULL, "reason" character varying(200) NOT NULL, "order_id" uuid, "actor_user_id" uuid, "balanceAfter" integer NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9b7144851f08f9eededde7edd42" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_inventory_transactions_variant" ON "inventory_transactions" ("variant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_inventory_transactions_order" ON "inventory_transactions" ("order_id") `,
    );
    await queryRunner.query(`CREATE TYPE "public"."rfqs_kind_enum" AS ENUM('BULK', 'GIFTING')`);
    await queryRunner.query(
      `CREATE TABLE "rfqs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "rfqNumber" character varying(20) NOT NULL, "user_id" uuid, "kind" "public"."rfqs_kind_enum" NOT NULL DEFAULT 'BULK', "businessName" character varying(160) NOT NULL, "contactPerson" character varying(120) NOT NULL, "mobile" character varying(15) NOT NULL, "email" character varying(255) NOT NULL, "gstin" character(15), "businessType" character varying(60) NOT NULL, "pincode" character(6) NOT NULL, "packaging" character varying(60) NOT NULL, "frequency" character varying(40) NOT NULL, "notes" text, "status" character varying(20) NOT NULL DEFAULT 'new', "assigned_salesperson_id" uuid, "expectedValuePaise" bigint, CONSTRAINT "PK_c8b7481584218bdee534e5fc436" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_rfqs_rfq_number" ON "rfqs" ("rfqNumber") `);
    await queryRunner.query(`CREATE INDEX "idx_rfqs_user" ON "rfqs" ("user_id") `);
    await queryRunner.query(`CREATE INDEX "idx_rfqs_status" ON "rfqs" ("status") `);
    await queryRunner.query(
      `CREATE TABLE "rfq_notes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rfq_id" uuid NOT NULL, "author_user_id" uuid NOT NULL, "body" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3f1c7c42dbc457b327d9334dd8c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_rfq_notes_rfq" ON "rfq_notes" ("rfq_id") `);
    await queryRunner.query(
      `CREATE TABLE "rfq_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "rfq_id" uuid NOT NULL, "product_id" uuid, "productSlug" character varying(120) NOT NULL, "kg" numeric(10,2) NOT NULL, CONSTRAINT "PK_2694c253e3966a3a8d5e9dc3d60" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_rfq_items_rfq" ON "rfq_items" ("rfq_id") `);
    await queryRunner.query(
      `CREATE TABLE "rfq_gifting_details" ("rfq_id" uuid NOT NULL, "occasion" character varying(60) NOT NULL, "giftBoxSlug" character varying(120) NOT NULL, "boxes" integer NOT NULL, "budgetPerBoxPaise" bigint NOT NULL, "brandingRequired" boolean NOT NULL DEFAULT false, "deliveryDate" date NOT NULL, "message" text NOT NULL DEFAULT '', CONSTRAINT "PK_f64aedd776d4d81bc459623d6fc" PRIMARY KEY ("rfq_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD CONSTRAINT "FK_0b1eb4f1f984aab3c481c48468a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" ADD CONSTRAINT "FK_04574eaf14f1ffa833597a1e0c6" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "FK_ce997a05626cd5a5861ca288dda" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "FK_508578cea415f0ee98227fe6c26" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "settings" ADD CONSTRAINT "FK_e4acbfebd9823138223505e09f9" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_f160d97a931844109de9d04228f" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "FK_085d540d9f418cfbdc7bd55bb19" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "FK_cbb98c2d1e4c7bdf6eabc305c42" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" ADD CONSTRAINT "FK_e4bd44665f939a7a926b7363d26" FOREIGN KEY ("assigned_salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_9a5f6868c96e0069e699f33e124" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD CONSTRAINT "FK_728447781a30bc3fcfe5c2f1cdf" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD CONSTRAINT "FK_b93b2ada7f387d010aee885e885" FOREIGN KEY ("moderated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_0e78f67403faf37092dce90d73a" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipments" ADD CONSTRAINT "FK_e86fac2a18a75dcb82bfbb23f43" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_b2f7b823a21562eeca20e72b006" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_6343513e20e2deab45edfce1316" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_db2d0ea722e16e0fe8ab3bce111" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_events" ADD CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_events" ADD CONSTRAINT "FK_6de21c12ce26e84e404a1c57ae2" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupons" ADD CONSTRAINT "FK_fb46e7532ccb8a560fde1a8f48a" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "FK_9df1b9bc48e3eea5da3762f8e56" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "FK_986f8dd830915cf2835f89709df" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "carts" ADD CONSTRAINT "FK_2ec1c94a977b940d85a4f498aea" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_6385a745d9e12a89b859bb25623" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_30e89257a105eab7648a35c7fce" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "FK_ede780fc2b865d1d1323e598038" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_4f166bb8c2bfcef2498d97b4068" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_tiers" ADD CONSTRAINT "FK_e10984f37155f6ba5248f44750d" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_tiers" ADD CONSTRAINT "FK_c283e49660cbcef42dacfd76840" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory" ADD CONSTRAINT "FK_ceba910e3505fc54c3c7f92c943" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" ADD CONSTRAINT "FK_aeb0f3a59ed2fd95e1a13097eda" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" ADD CONSTRAINT "FK_23afde96676fc44e4e554968c99" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" ADD CONSTRAINT "FK_2c54e69c4c1a7e82706ab238a72" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfqs" ADD CONSTRAINT "FK_f15ecc57ada8be2b81e2b01676b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfqs" ADD CONSTRAINT "FK_40f5a4afb69f492abc3f3fa3c45" FOREIGN KEY ("assigned_salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_notes" ADD CONSTRAINT "FK_0e29eb67965ac210600fcc8217b" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_notes" ADD CONSTRAINT "FK_416530e9473288166f36123193b" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_items" ADD CONSTRAINT "FK_ef8f022c5f4d9e27e47e03a1202" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_items" ADD CONSTRAINT "FK_e053c9ddba2d8ebf0ac2cd6ef9e" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_gifting_details" ADD CONSTRAINT "FK_f64aedd776d4d81bc459623d6fc" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---------------------------------------------------------------------------------
    // Hand-written invariants. TypeORM has no decorator for any of these, so they exist
    // only here — the generated section above is everything its metadata can express.
    // ---------------------------------------------------------------------------------

    // Stock can never go negative. This is the backstop behind the conditional UPDATE in
    // the checkout transaction (spec §10.2): if that guard were ever removed or bypassed,
    // the database still refuses.
    await queryRunner.query(`
      ALTER TABLE "inventory"
        ADD CONSTRAINT "ck_inventory_non_negative"
        CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "onHand" >= "reserved")
    `);

    // Brief §33's retail and bulk vocabularies, as one constraint. The canonical definition
    // is the tuple in @nutwala/shared; this mirrors it so a bad write fails at the database.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD CONSTRAINT "ck_orders_status"
        CHECK ("status" IN (
          'pending','confirmed','processing','packed','shipped','out-for-delivery',
          'delivered','cancelled','refunded',
          'quote-requested','quote-sent','quote-accepted','awaiting-payment','approved'
        ))
    `);

    await queryRunner.query(`
      ALTER TABLE "order_events"
        ADD CONSTRAINT "ck_order_events_status"
        CHECK ("status" IN (
          'pending','confirmed','processing','packed','shipped','out-for-delivery',
          'delivered','cancelled','refunded',
          'quote-requested','quote-sent','quote-accepted','awaiting-payment','approved'
        ))
    `);

    await queryRunner.query(`
      ALTER TABLE "reviews"
        ADD CONSTRAINT "ck_reviews_rating" CHECK ("rating" BETWEEN 1 AND 5)
    `);

    await queryRunner.query(`
      ALTER TABLE "rfqs"
        ADD CONSTRAINT "ck_rfqs_status"
        CHECK ("status" IN ('new','contacted','quote-sent','negotiation','approved','rejected','converted'))
    `);

    await queryRunner.query(`
      ALTER TABLE "support_tickets"
        ADD CONSTRAINT "ck_support_tickets_status"
        CHECK ("status" IN ('new','open','waiting','resolved','closed'))
    `);

    // Exactly one of the coupon's two value columns is populated, matching its type. They were
    // split out of a single polymorphic `numeric` column that held either a percentage or a paise
    // amount — which meant the paise case bypassed the money convention entirely.
    await queryRunner.query(`
      ALTER TABLE "coupons"
        ADD CONSTRAINT "ck_coupons_value_exclusive"
        CHECK (
          ("type" = 'PERCENT' AND "percentValue" IS NOT NULL AND "flatValuePaise" IS NULL)
          OR
          ("type" = 'FLAT' AND "flatValuePaise" IS NOT NULL AND "percentValue" IS NULL)
        )
    `);

    // A tier is either open-ended or ordered. maxKg < minKg is a data-entry error that would
    // make the slab unreachable and silently fall through to the wrong price.
    await queryRunner.query(`
      ALTER TABLE "pricing_tiers"
        ADD CONSTRAINT "ck_pricing_tiers_range"
        CHECK ("maxKg" IS NULL OR "maxKg" >= "minKg")
    `);

    // Money is never negative anywhere.
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD CONSTRAINT "ck_orders_money_non_negative"
        CHECK ("subtotalPaise" >= 0 AND "discountPaise" >= 0 AND "gstPaise" >= 0
               AND "shippingPaise" >= 0 AND "totalPaise" >= 0)
    `);

    // A partial unique index, so one user can have many addresses but only one default.
    // A plain unique index on (user_id, isDefault) would wrongly forbid two non-defaults.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_addresses_one_default_per_user"
        ON "addresses" ("user_id")
        WHERE "isDefault" = true AND "deletedAt" IS NULL
    `);

    // Email uniqueness must be case-insensitive: Kunal@x.test and kunal@x.test are one account.
    // The service lowercases on write; this stops anything that forgets.
    //
    // This index is the ONLY thing enforcing email uniqueness. The entity deliberately carries no
    // `@Index` decorator, because a plain unique index on the column would permanently disagree
    // with this functional one and every `migration:generate` would propose re-adding it. Until
    // this migration runs there is a real (currently dormant, since nothing writes users yet)
    // window in which two accounts could share an address — so this must not be dropped or
    // deferred, and `migration:generate` output must be checked for a spurious plain
    // `uq_users_email` addition, which is to be discarded.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_users_email" ON "users" (LOWER("email"))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The hand-written invariants come off first, in reverse order of `up()`. They sit on the
    // tables the generated section below drops, so they have to go before it — and the two
    // indexes are dropped explicitly rather than left to fall with their table, so a partial
    // revert cannot leave one behind.
    await queryRunner.query(`DROP INDEX "public"."uq_users_email"`);
    await queryRunner.query(`DROP INDEX "public"."uq_addresses_one_default_per_user"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_money_non_negative"`);
    await queryRunner.query(`ALTER TABLE "pricing_tiers" DROP CONSTRAINT "ck_pricing_tiers_range"`);
    await queryRunner.query(`ALTER TABLE "coupons" DROP CONSTRAINT "ck_coupons_value_exclusive"`);
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP CONSTRAINT "ck_support_tickets_status"`,
    );
    await queryRunner.query(`ALTER TABLE "rfqs" DROP CONSTRAINT "ck_rfqs_status"`);
    await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "ck_reviews_rating"`);
    await queryRunner.query(`ALTER TABLE "order_events" DROP CONSTRAINT "ck_order_events_status"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "ck_orders_status"`);
    await queryRunner.query(`ALTER TABLE "inventory" DROP CONSTRAINT "ck_inventory_non_negative"`);

    await queryRunner.query(
      `ALTER TABLE "rfq_gifting_details" DROP CONSTRAINT "FK_f64aedd776d4d81bc459623d6fc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_items" DROP CONSTRAINT "FK_e053c9ddba2d8ebf0ac2cd6ef9e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_items" DROP CONSTRAINT "FK_ef8f022c5f4d9e27e47e03a1202"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_notes" DROP CONSTRAINT "FK_416530e9473288166f36123193b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rfq_notes" DROP CONSTRAINT "FK_0e29eb67965ac210600fcc8217b"`,
    );
    await queryRunner.query(`ALTER TABLE "rfqs" DROP CONSTRAINT "FK_40f5a4afb69f492abc3f3fa3c45"`);
    await queryRunner.query(`ALTER TABLE "rfqs" DROP CONSTRAINT "FK_f15ecc57ada8be2b81e2b01676b"`);
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" DROP CONSTRAINT "FK_2c54e69c4c1a7e82706ab238a72"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" DROP CONSTRAINT "FK_23afde96676fc44e4e554968c99"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_transactions" DROP CONSTRAINT "FK_aeb0f3a59ed2fd95e1a13097eda"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory" DROP CONSTRAINT "FK_ceba910e3505fc54c3c7f92c943"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_tiers" DROP CONSTRAINT "FK_c283e49660cbcef42dacfd76840"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pricing_tiers" DROP CONSTRAINT "FK_e10984f37155f6ba5248f44750d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_4f166bb8c2bfcef2498d97b4068"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_ede780fc2b865d1d1323e598038"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_30e89257a105eab7648a35c7fce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT "FK_6385a745d9e12a89b859bb25623"`,
    );
    await queryRunner.query(`ALTER TABLE "carts" DROP CONSTRAINT "FK_2ec1c94a977b940d85a4f498aea"`);
    await queryRunner.query(
      `ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "FK_986f8dd830915cf2835f89709df"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupon_redemptions" DROP CONSTRAINT "FK_9df1b9bc48e3eea5da3762f8e56"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coupons" DROP CONSTRAINT "FK_fb46e7532ccb8a560fde1a8f48a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_events" DROP CONSTRAINT "FK_6de21c12ce26e84e404a1c57ae2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_events" DROP CONSTRAINT "FK_b33cbf9a59cbee112d94bcb59de"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_db2d0ea722e16e0fe8ab3bce111"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_6343513e20e2deab45edfce1316"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_b2f7b823a21562eeca20e72b006"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipments" DROP CONSTRAINT "FK_e86fac2a18a75dcb82bfbb23f43"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_0e78f67403faf37092dce90d73a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_b93b2ada7f387d010aee885e885"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_728447781a30bc3fcfe5c2f1cdf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_9482e9567d8dcc2bc615981ef44"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_9a5f6868c96e0069e699f33e124"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023"`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" DROP CONSTRAINT "FK_e4bd44665f939a7a926b7363d26"`,
    );
    await queryRunner.query(
      `ALTER TABLE "businesses" DROP CONSTRAINT "FK_cbb98c2d1e4c7bdf6eabc305c42"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" DROP CONSTRAINT "FK_085d540d9f418cfbdc7bd55bb19"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_f160d97a931844109de9d04228f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "settings" DROP CONSTRAINT "FK_e4acbfebd9823138223505e09f9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_ticket_notes" DROP CONSTRAINT "FK_508578cea415f0ee98227fe6c26"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_ticket_notes" DROP CONSTRAINT "FK_ce997a05626cd5a5861ca288dda"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP CONSTRAINT "FK_04574eaf14f1ffa833597a1e0c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_tickets" DROP CONSTRAINT "FK_0b1eb4f1f984aab3c481c48468a"`,
    );
    await queryRunner.query(`DROP TABLE "rfq_gifting_details"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rfq_items_rfq"`);
    await queryRunner.query(`DROP TABLE "rfq_items"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rfq_notes_rfq"`);
    await queryRunner.query(`DROP TABLE "rfq_notes"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rfqs_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_rfqs_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_rfqs_rfq_number"`);
    await queryRunner.query(`DROP TABLE "rfqs"`);
    await queryRunner.query(`DROP TYPE "public"."rfqs_kind_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_inventory_transactions_order"`);
    await queryRunner.query(`DROP INDEX "public"."idx_inventory_transactions_variant"`);
    await queryRunner.query(`DROP TABLE "inventory_transactions"`);
    await queryRunner.query(`DROP TYPE "public"."inventory_transactions_type_enum"`);
    await queryRunner.query(`DROP TABLE "inventory"`);
    await queryRunner.query(`DROP INDEX "public"."idx_pricing_tiers_product"`);
    await queryRunner.query(`DROP TABLE "pricing_tiers"`);
    await queryRunner.query(`DROP TYPE "public"."pricing_tiers_segment_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_product_images_product"`);
    await queryRunner.query(`DROP TABLE "product_images"`);
    await queryRunner.query(`DROP INDEX "public"."idx_cart_items_cart"`);
    await queryRunner.query(`DROP TABLE "cart_items"`);
    await queryRunner.query(`DROP TYPE "public"."cart_items_mode_enum"`);
    await queryRunner.query(`DROP INDEX "public"."uq_carts_user"`);
    await queryRunner.query(`DROP TABLE "carts"`);
    await queryRunner.query(`DROP INDEX "public"."idx_coupon_redemptions_user"`);
    await queryRunner.query(`DROP TABLE "coupon_redemptions"`);
    await queryRunner.query(`DROP INDEX "public"."uq_coupons_code"`);
    await queryRunner.query(`DROP TABLE "coupons"`);
    await queryRunner.query(`DROP TYPE "public"."coupons_channel_enum"`);
    await queryRunner.query(`DROP TYPE "public"."coupons_appliesto_enum"`);
    await queryRunner.query(`DROP TYPE "public"."coupons_type_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_events_order"`);
    await queryRunner.query(`DROP TABLE "order_events"`);
    await queryRunner.query(`DROP INDEX "public"."idx_order_items_order"`);
    await queryRunner.query(`DROP TABLE "order_items"`);
    await queryRunner.query(`DROP INDEX "public"."uq_product_variants_sku"`);
    await queryRunner.query(`DROP INDEX "public"."idx_product_variants_product"`);
    await queryRunner.query(`DROP TABLE "product_variants"`);
    await queryRunner.query(`DROP TYPE "public"."product_variants_channel_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_payments_order"`);
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payments_method_enum"`);
    await queryRunner.query(`DROP TABLE "serviceable_pincodes"`);
    await queryRunner.query(`DROP INDEX "public"."idx_shipments_order"`);
    await queryRunner.query(`DROP TABLE "shipments"`);
    await queryRunner.query(`DROP TYPE "public"."shipments_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_user_placed_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_status_placed_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_placed_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_orders_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_orders_order_number"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "public"."orders_paymentstatus_enum"`);
    await queryRunner.query(`DROP TYPE "public"."orders_paymentmethod_enum"`);
    await queryRunner.query(`DROP TYPE "public"."orders_channel_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_blog_posts_published_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_blog_posts_category"`);
    await queryRunner.query(`DROP INDEX "public"."uq_blog_posts_slug"`);
    await queryRunner.query(`DROP TABLE "blog_posts"`);
    await queryRunner.query(`DROP INDEX "public"."idx_reviews_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_reviews_product"`);
    await queryRunner.query(`DROP TABLE "reviews"`);
    await queryRunner.query(`DROP TYPE "public"."reviews_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."idx_products_category"`);
    await queryRunner.query(`DROP INDEX "public"."uq_products_slug"`);
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(`DROP INDEX "public"."uq_categories_slug"`);
    await queryRunner.query(`DROP TABLE "categories"`);
    await queryRunner.query(`DROP INDEX "public"."idx_addresses_user"`);
    await queryRunner.query(`DROP TABLE "addresses"`);
    await queryRunner.query(`DROP INDEX "public"."idx_businesses_assigned_salesperson"`);
    await queryRunner.query(`DROP TABLE "businesses"`);
    await queryRunner.query(`DROP INDEX "public"."idx_sessions_family"`);
    await queryRunner.query(`DROP INDEX "public"."uq_sessions_refresh_token_hash"`);
    await queryRunner.query(`DROP INDEX "public"."idx_sessions_user"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_entity"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_actor"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "public"."idx_idempotency_keys_created_at"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP INDEX "public"."idx_notifications_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_notifications_user"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TYPE "public"."notifications_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."notifications_channel_enum"`);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`DROP INDEX "public"."idx_support_ticket_notes_ticket"`);
    await queryRunner.query(`DROP TABLE "support_ticket_notes"`);
    await queryRunner.query(`DROP INDEX "public"."idx_support_tickets_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_support_tickets_user"`);
    await queryRunner.query(`DROP INDEX "public"."uq_support_tickets_ticket_number"`);
    await queryRunner.query(`DROP TABLE "support_tickets"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
  }
}
