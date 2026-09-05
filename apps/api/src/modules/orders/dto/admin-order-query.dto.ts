import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  type OrderChannel,
  type OrderStatus,
} from '@nutwala/shared';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Both of brief §33's vocabularies, spread from `shared/`'s own tuples.
 *
 * A **filter**, so the union is right and the channel is not consulted: `?status=processing` is
 * legal for either channel and an operator narrowing to `shipped` wants both. A status belonging to
 * the other channel simply matches nothing, which is the honest answer to a question about a filter
 * rather than a request that should be refused.
 */
const ORDER_STATUSES: readonly OrderStatus[] = [...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES];

/**
 * Derived from the shared union through a `satisfies` record, the way `order-query.dto.ts` and
 * `product-query.dto.ts` both do it: a missing key and an extra key are each a compile error, so a
 * channel added in `shared/` cannot reach this DTO as a value the client's own types call legal and
 * the server answers 400 for.
 */
const ORDER_CHANNELS = Object.keys({
  retail: true,
  bulk: true,
} satisfies Record<OrderChannel, true>) as OrderChannel[];

/**
 * `GET /admin/orders`' query string — the plan's *"filterable by status, channel and date range;
 * paginated"* and nothing beyond it.
 *
 * No free-text search, deliberately. Brief §33 names seven columns and no search box, and the one
 * thing an operator most often arrives with — an order number read off an email — is
 * `GET /admin/orders/:orderNumber`, an exact route one hop away. `admin-product-query.dto.ts`
 * states the general rule: the global `ValidationPipe` runs with `forbidNonWhitelisted`, so an
 * undeclared parameter is a 400 today rather than a filter silently ignored while an unfiltered
 * page comes back — which makes adding one later safe and declaring speculative ones now not free.
 */
export class AdminOrderQueryDto {
  /** One of brief §33's fourteen. Omitted means every status. */
  @ApiPropertyOptional({ enum: ORDER_STATUSES, example: 'processing' })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  /**
   * Brief §33's **B2C/B2B** column as a filter.
   *
   * `@IsIn` is load-bearing rather than decorative, for the reason `order-query.dto.ts` measures at
   * length: the value is resolved through a `Record` keyed on the wire union, so anything outside it
   * resolves to `undefined` — and an `undefined` handed to TypeORM is *dropped* from the query
   * rather than narrowing it. `?channel=gold` would answer with every channel instead of none.
   */
  @ApiPropertyOptional({ enum: ORDER_CHANNELS, example: 'bulk' })
  @IsOptional()
  @IsIn(ORDER_CHANNELS)
  channel?: OrderChannel;

  /**
   * Inclusive lower bound on `placedAt`, ISO-8601.
   *
   * **A date-only value is that day in the business's timezone** — the `business.timezone` setting,
   * `Asia/Kolkata` by default. A full instant is used exactly as sent.
   *
   * It used to be midnight **UTC**, which was a real edge for an IST operator: `?from=2026-08-27`
   * started at 05:30 IST, so five and a half hours of that day's orders fell outside a filter that
   * named their day. That was deliberate and consistent rather than convenient — plan 9.2 left it
   * on UTC precisely because `salesOverTime` grouped by UTC day too, and spec §5b required a
   * business timezone to be added and applied to **every dated admin figure at once**, since a
   * per-endpoint fix is how two figures start disagreeing. Plan 9.4 moved both in one commit;
   * `AdminOrdersService.list` and `DashboardService.salesOverTime` now read the same setting
   * through the same `businessTimezone(manager)`.
   */
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  /**
   * Inclusive upper bound on `placedAt`, ISO-8601. See `from` on what a date-only value means.
   *
   * A date-only bound covers the whole of that day in the business's timezone, up to but not
   * including the following midnight — so `?from=2026-08-27&to=2026-08-27` is exactly the 27th as
   * an IST operator counts it.
   */
  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * Capped at 60, matching every other admin list — a list endpoint must not be turnable into a
   * table dump. The service clamps as well, so this is about telling a caller their request was
   * wrong rather than quietly answering a different question.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/**
 * The global pipe runs with `transformOptions: { enableImplicitConversion: false }`, so nothing else
 * coerces a query string. Returns the original value when it is not numeric rather than `NaN`, so a
 * rejected input stays legible in a log — `product-query.dto.ts` has the full reasoning.
 */
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
