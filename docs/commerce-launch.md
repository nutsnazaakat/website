# Nuts & Nazaakat commerce launch

This branch adds the monochrome branded storefront, generated product/gifting banners, live public settings, guest receipt access, Razorpay payment collection and an email outbox. The existing PostgreSQL catalogue, inventory, cart, customer accounts, COD checkout and admin console are retained. A successful build is not proof that live payments, delivery or emails are configured.

## Local review

Use Node 24, `npm ci`, then `npm run build`. Follow the root README for the development database and separate API/storefront/admin dev servers. Development seeds contain fictional products, prices, inventories, reviews and demo users; do not use them to populate the production store. New banner packaging is a design mockup, not a representation of approved sale inventory.

## Production deployment

1. Provision a dedicated PostgreSQL database (PostgreSQL 15 or newer) with backups and TLS. Use schema `public` for the existing migration chain. Do not reuse another brand's database.
2. Copy `deploy/.env.production.example` to `deploy/.env.production` and fill in actual database, random JWT/Swagger secrets and the two HTTPS origins. Leave COOKIE_DOMAIN empty for separate, host-only storefront/admin sessions. Never commit secrets.
3. Build with `docker compose -f deploy/compose.production.yml build`. Run the release migration once: `docker compose -f deploy/compose.production.yml run --rm api ../../node_modules/.bin/typeorm -d dist/data-source.js migration:run`. Back up an existing database before applying migrations.
4. Create an admin using the one-time environment variables ADMIN_EMAIL, ADMIN_PASSWORD (16–72 bytes), ADMIN_PHONE and optional ADMIN_NAME. Run `node dist/operations/create-admin.js` in the API release container with those variables passed by your secret manager. This command refuses to overwrite an existing account. Remove the admin password from the environment afterwards.
5. Run `docker compose -f deploy/compose.production.yml up -d`. Terminate TLS on the host/load balancer: shop domain to localhost:8080; a separate admin domain to localhost:8081. Keep the API port private. The host TLS proxy must overwrite X-Forwarded-For with the real client IP. Nginx appends that proxy hop; the API trusts exactly two hops for this topology. Adjust TRUST_PROXY_HOPS if the deployment topology changes. Put an access policy in front of the admin origin if available. Do not expose the HTTP ports directly to customers.
6. Configure the actual brand contacts, address, tax/food registration details, shipping pincodes, delivery estimates, prices, variants and on-hand quantities using the admin console. Publish only owner-approved catalogue data, policies and product imagery. Verify GST configuration against the actual products and business setup.

## Online payments

Configure RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET on the API only. Subscribe to `payment.captured` at `https://YOUR_SHOP_DOMAIN/api/v1/checkout/webhooks/razorpay`, using the same webhook secret. Enable automatic capture in the Razorpay account. Enable `onlinePaymentEnabled` in admin settings only after a complete test-mode purchase. Without all three credentials, the API hides online payment even if the admin toggle is on. COD is independently controlled.

Checkout reserves stock and creates a pending order. The receipt page opens Razorpay; the API verifies the signature against the stored gateway order, fetches the provider payment, checks INR and the exact paise amount, and records collection transactionally. Signed webhooks also reconcile a captured payment if the browser closes. Repeated capture events do not duplicate collection. Unpaid online orders cannot enter fulfilment. A late capture on a cancelled order does not reinstate stock or fulfilment; it creates a refund-review event.

Guest receipt tokens expire after 30 days and stay in sessionStorage, not URLs. Customers need the original browser tab/session or support assistance to recover a guest receipt. Never share these tokens publicly.

**Operational limits:** abandoned online reservations require admin cancellation to restore stock; automatic expiration is not implemented. Refunds are performed and reconciled manually in the payment provider dashboard; an admin order status is not a gateway refund. Monitor pending/cancelled paid orders and webhook failures. Test success, failed payment, dismissed checkout, duplicate webhook, wrong signature, cancellation and late capture before accepting live money.

## Transactional email

Set RESEND_API_KEY and EMAIL_FROM to a verified sender. Production transactions create QUEUED outbox rows; the background worker sends only committed email notifications, using a per-notification idempotency key. Provider acceptance marks SENT (this is not an inbox-delivery guarantee). Missing provider configuration leaves production rows queued; production never marks a development log as delivery. Unsupported channels and provider failures are marked FAILED for operational review. There is no automated retry campaign or newsletter subscription.

Monitor the notifications table. After fixing a failed delivery, retry an individual row deliberately by setting its status to QUEUED and error to NULL; avoid bulk retries of old messages because provider idempotency retention is finite. Low-stock internal notifications have no email recipient adapter and must be monitored in inventory/admin. Test delivery to your own address before launch.

## Release verification

Run shared/API/web/admin tests and the full build. Database integration tests require a Docker-capable environment (`npm run test:integration -w @nutwala/api`). Then verify real sign-in, a guest COD purchase, Razorpay test-mode checkout/webhook, admin fulfilment, customer receipt refresh, inventory restoration on cancellation and email delivery on the deployed test environment. Configure uptime monitoring against `/api/v1/health`, backups, shipping operations and domain DNS before switching payment keys to live mode.

Provider references: [Razorpay standard checkout](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) and [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).
