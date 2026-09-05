import { ApiPropertyOptional } from '@nestjs/swagger';
import type { OrderChannel, OrderFilters } from '@nutwala/shared';
import { IsIn, IsOptional } from 'class-validator';

/**
 * The accepted channels, derived from the shared union rather than hand-listed.
 *
 * A `Record` keyed on the union is checked in both directions — a missing key and an extra key are
 * both compile errors — so a channel added in `shared/` cannot reach this DTO as a value the
 * client's own types call legal and the server answers 400 for. `product-query.dto.ts` derives its
 * `CHANNELS` the same way, and `order.mapper.ts` and `orders.service.ts` each hold the same
 * two-value map pointed at the entity enum: four places, one vocabulary, and none of them able to
 * grow alone.
 */
const ORDER_CHANNELS = Object.keys({
  retail: true,
  bulk: true,
} satisfies Record<OrderChannel, true>) as OrderChannel[];

/**
 * `GET /account/orders`'s query string, which is `OrderFilters` and nothing else.
 *
 * **`@IsIn` is the load-bearing decorator here, not `@IsOptional`.** `OrdersService.list` resolves
 * the wire value through `CHANNEL[filters.channel]`, so a string outside the union resolves to
 * `undefined` — and TypeORM *drops* an `undefined` from a find-options `where`
 * (`SelectQueryBuilder.js:2496-2504`, default `invalidWhereValuesBehavior.undefined: 'ignore'`)
 * rather than narrowing on it. `?channel=gold` would therefore **widen** the query to every channel
 * instead of matching none: a bulk customer asking for their retail orders would be shown all of
 * them, with a 200 and no error anywhere. `@IsOptional() @IsString()` — the pairing a reader reaches
 * for first — accepts `gold` and is exactly the hole. The answer stays inside the caller's own
 * history either way, because `userId` is a separate clause, so this is a wrong answer and never a
 * leak.
 *
 * `implements OrderFilters` so the compiler checks the two against each other: the controller hands
 * this instance straight to `list()`, which takes `OrderFilters`, and a field added here without a
 * home on the wire type would be a field the service silently ignores.
 *
 * No `page`/`limit`, because the seam this replaces has none: `accountApi.listOrders` answers a bare
 * `AccountOrder[]` filtered by channel, and `OrdersTable` renders the whole array. A `Paginated<T>`
 * response would be a shape change to the frontend rather than an addition to this DTO, and the
 * volume does not ask for one — the seeded fixture's largest history is four orders. Adding it later
 * is safe precisely because the global `ValidationPipe` runs with `forbidNonWhitelisted`, so `?page=2`
 * is a 400 today rather than a parameter quietly ignored while page one is returned.
 */
export class OrderQueryDto implements OrderFilters {
  @ApiPropertyOptional({ enum: ORDER_CHANNELS })
  @IsOptional()
  @IsIn(ORDER_CHANNELS)
  channel?: OrderChannel;
}
