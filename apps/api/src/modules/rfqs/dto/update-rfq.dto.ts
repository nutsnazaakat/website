import { ApiPropertyOptional } from '@nestjs/swagger';
import { RFQ_STATUSES, type RfqStatus } from '@nutwala/shared';
import { IsIn, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';

/** ₹10,000,000. `rfqs."expectedValuePaise"` is a `bigint`, so nothing at the database level caps
 * this; the ceiling is here so a typo — an extra zero on a quote — is a 400 rather than a figure
 * that quietly skews every pipeline report. Well below `Number.MAX_SAFE_INTEGER` in paise. */
const MAX_EXPECTED_VALUE = 10_000_000;

/**
 * `PATCH /admin/rfqs/:rfqNumber` — brief §34's three editable facts about an enquiry.
 *
 * **All three fields are optional and an omitted one is left unchanged**, which is what `PATCH`
 * means and what `UpdateProductDto` and `UpdateCategoryDto` already do. A body with none of them is
 * accepted and writes nothing, including no audit row — plan 9.1's rule that a write which changes
 * nothing leaves no trace.
 *
 * **`null` and "omitted" are different for the two nullable fields**, and the difference is the
 * only way to clear one: `{ "assignedSalespersonId": null }` unassigns the enquiry, while omitting
 * the key leaves whoever is on it. `@ValidateIf` is what makes `null` reach the handler at all —
 * `@IsOptional()` treats `null` as absent, so the pair `@IsOptional()` + `@IsUUID()` would silently
 * accept `null` *and* discard it, and there would be no way to unassign anybody.
 *
 * **There is no `notes` field here.** `rfqs.notes` is the *prospect's* own "additional
 * requirements" from brief §17's public form, and `RfqDetail.notes` shows it straight back to them;
 * an admin route that overwrote it would destroy what the customer wrote and publish whatever
 * replaced it. Brief §34's internal notes are `POST /admin/rfqs/:rfqNumber/notes`.
 */
export class UpdateRfqDto {
  /**
   * The move, checked against `RFQ_TRANSITIONS` by `RfqStatusService` — **not here**. `@IsIn` only
   * says the value is one of brief §34's seven; whether it may follow the status the enquiry
   * currently holds is a question about the row, and `RFQ_TRANSITIONS` is the only rule about it.
   * A second rule in this DTO is exactly the drift the shared table exists to prevent.
   */
  @ApiPropertyOptional({ enum: RFQ_STATUSES })
  @IsOptional()
  @IsIn(RFQ_STATUSES)
  status?: RfqStatus;

  /**
   * Brief §34's assigned salesperson — `rfqs.assigned_salesperson_id`, a `users(id)` reference that
   * has existed since the initial schema. `null` unassigns.
   *
   * The service checks that the id names an account with `role = ADMIN`, which no DTO can do
   * without a database read: `business.entity.ts` already settled that a salesperson is "an admin
   * user, not a separate staff table", and assigning an enquiry to a *customer* would put their
   * name on the operator's queue.
   */
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsOptional()
  @IsUUID()
  assignedSalespersonId?: string | null;

  /**
   * Brief §34's "expected value", **in rupees** — spec §8's money boundary, converted to
   * `expectedValuePaise` by the service. `null` clears it.
   *
   * `maxDecimalPlaces: 2` because a rupee has two, and `toPaise` rejects sub-paise input anyway —
   * refusing it here makes the answer a 400 naming the field rather than a 422 from the money
   * helper.
   */
  @ApiPropertyOptional({ nullable: true, example: 84500 })
  @ValidateIf((_object, value) => value !== null)
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_EXPECTED_VALUE)
  expectedValue?: number | null;
}
