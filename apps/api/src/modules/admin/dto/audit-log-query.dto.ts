import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * `GET /admin/audit-logs`' query string — spec §6.4's last row.
 *
 * **`entity` and `action` are free strings, not `@IsIn` against the enums**, unlike every other
 * admin filter in this codebase. That is deliberate, and it is the same argument
 * `AdminAuditLogEntry` makes on the wire: `AuditAction` and `AuditEntity` gain members with every
 * admin write path that ships, and rows already written keep whatever vocabulary wrote them. A
 * closed list here would mean an old row becoming unfilterable the day its action was renamed, and
 * would make the admin console's build a gate on the server's vocabulary. An unknown value simply
 * matches nothing, which is the honest answer to a question about a filter.
 *
 * `actorUserId` **is** a uuid check, because that column is a real foreign key and a non-uuid there
 * is a client bug rather than a search that finds nothing.
 */
export class AuditLogQueryDto {
  /** The admin who acted — `audit_logs.actor_user_id`, indexed by `idx_audit_logs_actor`. */
  @ApiPropertyOptional({ example: '5f9b2c1e-0000-4000-8000-000000000000' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  /**
   * The kind of thing acted on — `audit_logs.entity`, indexed by `idx_audit_logs_entity`.
   *
   * `product`, `variant`, `category`, `inventory`, `order`, `payment`, `shipment`, `coupon`,
   * `review`, `post`, `support-ticket`, `setting` at the time of writing. **Not `inventory`
   * movements**: see `AdminAuditLogsService`.
   */
  @ApiPropertyOptional({ example: 'coupon' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  entity?: string;

  /**
   * That thing's identifier — the column is a `varchar(60)`, not a uuid, because what identifies a
   * row differs by entity: a product's uuid, an order's uuid, a coupon's **code**, a post's
   * **slug**, a ticket's **number**, a setting's **key**. `AuditAction`'s members each say which.
   */
  @ApiPropertyOptional({ example: 'WELCOME10' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  entityId?: string;

  /** One action — `product.update`, `order.status-change`. Narrower than `entity`. */
  @ApiPropertyOptional({ example: 'coupon.delete' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  action?: string;

  /**
   * Inclusive lower bound on `createdAt`, ISO-8601.
   *
   * **A date-only value is that day in the business's timezone**, exactly as on
   * `GET /admin/orders` — spec §5b requires the timezone to govern *every* dated admin figure, and
   * this filter is one that plan 9.4 introduced rather than inherited, so it is born consistent
   * rather than converted. A full instant is used as sent.
   */
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive upper bound on `createdAt`. A date-only value covers the whole of that business day. */
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

  /** Capped at 60, matching every other admin list. The service clamps as well. */
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
