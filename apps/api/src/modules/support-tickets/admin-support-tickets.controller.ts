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
import type { AdminSupportTicket, AdminSupportTicketSummary, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminSupportTicketsService } from './admin-support-tickets.service';
import {
  AdminSupportTicketQueryDto,
  ChangeSupportTicketDto,
  CreateSupportTicketNoteDto,
} from './dto/admin-support-ticket.dto';

/**
 * Brief §38's support queue — spec §6.4's `/admin/support/tickets` block.
 *
 * **A second controller beside `SupportTicketsController`, which is `@Controller('contact')` and
 * carries one `@Public()` `POST`.** No class mixes scopes: that one is reachable by an anonymous
 * visitor, and every route here is `@Roles(UserRole.ADMIN)` at the class, carrying the database
 * enum — the token carries `ADMIN` while an auth body carries `admin`, so `@Roles('admin')`
 * compiles and refuses every admin.
 *
 * **`:ticketNumber`, not `:id`**, and no `ParseUUIDPipe` for the same reason: the parameter is
 * `ST-2026-000123`, so a uuid pipe would reject every real reference. `AdminSupportTicketsService`
 * carries the correction §6.4 needs, and validates the format itself — answering **404** for a
 * malformed reference rather than 400, because "no such ticket" is the one honest answer to both
 * ways of naming a ticket that does not exist.
 *
 * **Declaration order is routing order.** `@Get()` is the collection and `@Get(':ticketNumber')`
 * sits below it; a literal sibling added later — `admin/support/tickets/export`, say — must be
 * declared **above** the detail route or Express matches the pattern first and answers 404 for a
 * ticket nobody named. The `@Patch` and `@Post` below are safe wherever they sit: each is a
 * different verb, and the note route is a longer path.
 *
 * Worth recording while this file is open: **spec §6.3's `GET /support/tickets` — "own tickets
 * only" — still does not exist.** It is a customer-facing route and outside this plan's scope
 * (§6.4 plus §6.1's `GET /settings`), but it is a real gap in the same area, found here.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/support/tickets')
export class AdminSupportTicketsController {
  constructor(private readonly tickets: AdminSupportTicketsService) {}

  @Get()
  @ApiOperation({ summary: 'The support queue, newest first, paginated (brief §38)' })
  list(@Query() query: AdminSupportTicketQueryDto): Promise<Paginated<AdminSupportTicketSummary>> {
    return this.tickets.list(query);
  }

  @Get(':ticketNumber')
  @ApiOperation({ summary: 'One ticket in full, with its message and its note trail' })
  get(@Param('ticketNumber') ticketNumber: string): Promise<AdminSupportTicket> {
    return this.tickets.get(ticketNumber);
  }

  @Patch(':ticketNumber')
  @ApiOperation({ summary: 'Move a ticket: status, priority and assignment' })
  update(
    @Param('ticketNumber') ticketNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeSupportTicketDto,
  ): Promise<AdminSupportTicket> {
    // `actorUserId` after the spread: the audit row's "who" is the signed token's, never a body
    // field's — and here it would otherwise be confusable with `assignedToUserId`, which *is* a
    // legitimate body field naming a different person.
    return this.tickets.update(ticketNumber, { ...dto, actorUserId: user.id });
  }

  /**
   * `POST /admin/support/tickets/:ticketNumber/notes` — an internal note, or a reply the day
   * something sends one.
   *
   * `@HttpCode(HttpStatus.OK)` even though a row is genuinely created, matching
   * `AdminOrdersController.createShipment`: the body is the whole ticket with its note trail, not
   * the created note, so a 201 with no `Location` and a body describing something other than the
   * created resource would be worse than the small inconsistency. The console re-renders the
   * conversation from the response.
   */
  @Post(':ticketNumber/notes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add an internal note to a ticket (brief §38)' })
  addNote(
    @Param('ticketNumber') ticketNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSupportTicketNoteDto,
  ): Promise<AdminSupportTicket> {
    // `actorUserId` after the spread, as everywhere: the note's author is the token's.
    return this.tickets.addNote(ticketNumber, { ...dto, actorUserId: user.id });
  }
}
