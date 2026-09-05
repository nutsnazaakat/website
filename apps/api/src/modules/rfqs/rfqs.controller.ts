import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RfqDetail, RfqSummary } from '@nutwala/shared';
import { CurrentUser, OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { RfqKind } from '../../entities/enums';
import { CreateGiftingRfqDto } from './dto/create-gifting-rfq.dto';
import { CreateRfqDto } from './dto/create-rfq.dto';
import { toRfqDetail, toRfqSummary } from './mappers/rfq.mapper';
import { RfqsService } from './rfqs.service';

/**
 * The two `create` routes are `@Public()` with `@OptionalUser()` — never `@CurrentUser()`, which
 * throws when `request.user` is absent and was measured as a 500 on every guest request when it
 * happened on the wishlist. A prospect needs no account to raise an enquiry; a signed-in
 * business's enquiry must still be attributed to them so it appears under `GET /rfqs` below.
 *
 * That is `user?.id ?? null` at both `create` call sites, and it is worth naming why the
 * identical expression is *correct* there and is exactly backwards on the two read routes below:
 * an absent user is a legitimate caller on a public write — a prospect genuinely has no id —
 * while on a session-scoped read it would turn a missing auth guard into a silent `200 []`
 * instead of the 401 it should be. `list`/`findOne` use `@CurrentUser()` for that reason: there is
 * no such thing as a prospect's RFQ list, so nothing here needs to tolerate an absent one.
 *
 * **A prospect who raised an enquiry with no account cannot read it back through this
 * controller — `userId` is null and both GET routes are session-scoped.** The RFQ number in the
 * `create` response is their only handle, and quoting it to the sales desk is the recovery path.
 * `GET /rfqs/lookup?number=&email=` would close that gap and needs its own throttling and
 * decision, exactly like guest order tracking; it is not this milestone's to build.
 */
@ApiTags('rfqs')
@Controller('rfqs')
export class RfqsController {
  constructor(private readonly rfqs: RfqsService) {}

  /**
   * Five per hour per IP, not the global default of 120/minute — spec §6.1 marks this route
   * rate-limited, and the global default is not a limit for an unauthenticated row-writing
   * endpoint. Looser than registration's 3/hour: a genuine prospect may send a bulk enquiry, a
   * gifting enquiry and a correction inside an hour, and an RFQ carries no account, so it poses
   * none of the enumeration risk that makes registration's limit the tighter one.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Raise a bulk quote request' })
  async create(
    @Body() dto: CreateRfqDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<RfqDetail> {
    const rfq = await this.rfqs.create(
      {
        kind: RfqKind.BULK,
        businessName: dto.businessName,
        contactPerson: dto.contactPerson,
        mobile: dto.mobile,
        email: dto.email,
        gstin: dto.gstin,
        businessType: dto.businessType,
        pincode: dto.pincode,
        lines: dto.lines,
        packaging: dto.packaging,
        frequency: dto.frequency,
        notes: dto.notes,
      },
      user?.id ?? null,
    );
    return toRfqDetail(rfq);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('gifting')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Raise a corporate gifting enquiry' })
  async createGifting(
    @Body() dto: CreateGiftingRfqDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<RfqDetail> {
    const rfq = await this.rfqs.create(
      {
        kind: RfqKind.GIFTING,
        // The gifting form's own word for the field; `create` and the column both call it
        // `businessName` — see `CreateGiftingRfqDto`'s docblock for why the mapping lives here.
        businessName: dto.companyName,
        contactPerson: dto.contactPerson,
        mobile: dto.mobile,
        email: dto.email,
        gstin: dto.gstin,
        businessType: dto.businessType,
        pincode: dto.pincode,
        gifting: {
          occasion: dto.occasion,
          giftBoxSlug: dto.giftBoxSlug,
          boxes: dto.boxes,
          budgetPerBox: dto.budgetPerBox,
          brandingRequired: dto.brandingRequired,
          deliveryDate: dto.deliveryDate,
          message: dto.message,
        },
      },
      user?.id ?? null,
    );
    return toRfqDetail(rfq);
  }

  /**
   * `GET /rfqs` — the caller's own enquiries, newest first, both kinds in one list.
   *
   * The owner comes from `@CurrentUser()` and from nowhere else — not a query parameter, not an
   * email — the identical rule `OrdersController.list` states for the identical reason: a
   * parameter that scoped the read would let anyone who can guess or is told an email read a
   * stranger's enquiries.
   */
  @Get()
  @ApiOperation({ summary: 'The signed-in caller’s RFQs, newest first' })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<RfqSummary[]> {
    const found = await this.rfqs.list(user.id);
    return found.map((rfq) => toRfqSummary(rfq));
  }

  /**
   * `GET /rfqs/:rfqNumber` — one of the caller's enquiries, by the number they can read down a
   * phone line.
   *
   * The 404 is built here rather than in the service, matching `OrdersController.findOne`'s own
   * reasoning: `HttpStatus.NOT_FOUND` is passed explicitly because `DomainError` defaults to
   * **422**, and `details: { rfqNumber }` echoes the caller's own input back — revealing nothing,
   * since it is the value they just sent — rather than saying which of "no such RFQ" and "not
   * yours" occurred. `RfqsService.findOne` cannot tell the two apart on purpose: `RFQ_NUMBER_
   * PATTERN`'s sequence is exactly as guessable as an order number, so a second status here would
   * make this endpoint an oracle an attacker walks.
   */
  @Get(':rfqNumber')
  @ApiOperation({ summary: 'One of the signed-in caller’s RFQs, with its lines or gifting detail' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rfqNumber') rfqNumber: string,
  ): Promise<RfqDetail> {
    const rfq = await this.rfqs.findOne(user.id, rfqNumber);
    if (rfq === null) throw this.notFound(rfqNumber);
    return toRfqDetail(rfq);
  }

  private notFound(rfqNumber: string): DomainError {
    return new DomainError(
      ErrorCodes.NOT_FOUND,
      `No RFQ ${rfqNumber} in your account.`,
      HttpStatus.NOT_FOUND,
      { rfqNumber },
    );
  }
}
