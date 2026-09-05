import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminRfq, AdminRfqSummary, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminRfqsService } from './admin-rfqs.service';
import { AddRfqNoteDto } from './dto/add-rfq-note.dto';
import { AdminRfqQueryDto } from './dto/admin-rfq-query.dto';
import { UpdateRfqDto } from './dto/update-rfq.dto';

/**
 * The operator's RFQ screens — spec §6.4's `/admin/rfqs` block, brief §34.
 *
 * **A second controller beside `RfqsController`, not extra handlers on it.** That class is the
 * public front door: two `@Public()` create routes and two session-scoped reads whose owner comes
 * from `@CurrentUser()` and from nowhere else. These routes are unscoped by design, and mixing them
 * into one class would put the difference in per-handler decorators — which `RolesGuard` resolves
 * *over* class metadata, so a handler that lost one would inherit whatever the class carried.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the **database enum**: the token carries `ADMIN`
 * while an auth response body carries `admin`, so `@Roles('admin')` compiles and refuses every
 * admin.
 *
 * **`:rfqNumber`, not `:id`.** Spec §6.4 spells these `GET /admin/rfqs/:id` and
 * `PATCH /admin/rfqs/:id`, and an RFQ does have a uuid — but nothing addresses one by it:
 * `RfqSummary.id` *is* the number, `RfqsController.findOne` already uses it, and the number is what
 * a prospect quotes down a phone line. The same correction §6.4 already carries for
 * `PATCH /admin/inventory/:variantId` and the four order routes.
 *
 * **This controller returns internal notes and the customer-facing one must not.**
 * `rfq-note.entity.ts` is explicit — *"Never exposed on a customer-facing endpoint. `GET
 * /rfqs/:rfqNumber` must not select this relation"* — and `RfqsService.findOne` is what honours it
 * by not loading `notesList` at all. Two services, two `relations` clauses, and the distinction is
 * which one a route reaches.
 *
 * **`actorUserId` is assigned after the DTO spread**, on both writes below. The audit trail's and a
 * note's "who" comes from the signed token and must not be overridable by a body field, whatever
 * the validation pipe strips — `whitelist` would drop one today, and the spread order is what makes
 * that a property of this code rather than of the pipe's configuration.
 *
 * **Declaration order is routing order.** `@Get(':rfqNumber')` stays below any literal `@Get('...')`
 * sibling. There is none today, which is exactly when one gets added and nobody can work out why it
 * 404s. The `PATCH` and `POST` handlers below are safe wherever they sit: each is a different verb,
 * and the `POST` is a longer path as well, so the detail route cannot match either.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/rfqs')
export class AdminRfqsController {
  constructor(private readonly rfqs: AdminRfqsService) {}

  /**
   * `GET /admin/rfqs` — brief §34's queue: RFQ ID, business, contact, products, quantity, expected
   * value, status, assigned salesperson.
   */
  @Get()
  @ApiOperation({ summary: 'Quote requests, newest first, filterable by status and kind (§34)' })
  list(@Query() query: AdminRfqQueryDto): Promise<Paginated<AdminRfqSummary>> {
    return this.rfqs.list(query);
  }

  /**
   * `GET /admin/rfqs/:rfqNumber` — one enquiry in full, with its line items and its note history.
   *
   * No `ParseUUIDPipe`, unlike the `:id` routes on the catalogue and people controllers, and not by
   * oversight: the parameter is an RFQ **number**, so a uuid pipe here would reject every real
   * reference.
   */
  @Get(':rfqNumber')
  @ApiOperation({ summary: 'One enquiry in full, with its lines and its internal notes' })
  get(@Param('rfqNumber') rfqNumber: string): Promise<AdminRfq> {
    return this.rfqs.get(rfqNumber);
  }

  /**
   * `PATCH /admin/rfqs/:rfqNumber` — brief §34's three editable facts: status, assigned
   * salesperson, expected value.
   *
   * **The status change goes through `RfqStatusService.transition`**, which owns
   * `RFQ_TRANSITIONS`, the guarded write, the notification and the audit row — see
   * `AdminRfqsService.update`. An illegal move is a **422 `ILLEGAL_STATUS_TRANSITION`** carrying
   * `allowed`, exactly as `POST /admin/orders/:orderNumber/status` answers; a move racing another
   * admin's is a **409**; an unknown reference is a **404**. None of that is re-implemented here.
   *
   * The reply is the same `AdminRfq` the detail route answers, re-read after the write, so the
   * console re-renders the committed status, value and assignment from the response instead of
   * guessing what the server did.
   *
   * **No `@SkipCsrf()`**, so the global `CsrfGuard` applies as it does to every unsafe method — and
   * it matters here: `rejected` and `converted` are terminal, and nothing moves an enquiry
   * backwards.
   */
  @Patch(':rfqNumber')
  @ApiOperation({ summary: 'Move an enquiry along, or set its value or salesperson (§34)' })
  update(
    @Param('rfqNumber') rfqNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateRfqDto,
  ): Promise<AdminRfq> {
    // `actorUserId` after the spread, deliberately: the audit row's "who" comes from the signed
    // token and must not be overridable by a body field.
    return this.rfqs.update(rfqNumber, { ...dto, actorUserId: user.id });
  }

  /**
   * `POST /admin/rfqs/:rfqNumber/notes` — brief §34's *"Allow internal notes"*.
   *
   * **`@HttpCode(HttpStatus.OK)`, because Nest answers a `POST` with 201 by default.** A row is
   * genuinely created, so a 201 would be defensible — and is not what the response says: the body is
   * the whole enquiry, the same `AdminRfq` the detail route and the `PATCH` above both answer, so
   * the console re-renders the note history from the reply. A 201 with no `Location` and a body
   * describing something other than the created resource would be worse than the small
   * inconsistency. `AdminOrdersController.createShipment` makes the identical call.
   *
   * The note lands in `rfq_notes` and never in `rfqs.notes` — those are the sales desk's history and
   * the prospect's own "additional requirements" respectively, and `AdminRfqsService.addNote` has
   * the full case for keeping them apart.
   */
  @Post(':rfqNumber/notes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add an internal note to an enquiry (§34). Never customer-visible' })
  addNote(
    @Param('rfqNumber') rfqNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddRfqNoteDto,
  ): Promise<AdminRfq> {
    // `actorUserId` after the spread, as everywhere: the note's author is the token's.
    return this.rfqs.addNote(rfqNumber, { ...dto, actorUserId: user.id });
  }
}
