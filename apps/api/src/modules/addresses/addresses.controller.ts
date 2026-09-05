import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SavedAddress } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/save-address.dto';
import { toSavedAddress } from './mappers/address.mapper';

/**
 * The account address book — spec §6.3's five address routes.
 *
 * **Every route answers with the whole book, not with the address that changed**, and that is the
 * contract rather than laziness. One address's `isDefault` is a function of the others: promoting one
 * demotes another, deleting the default promotes a third. A response carrying only the row the client
 * named would leave that client's copy of a *different* row stale — showing two *Default* badges, or
 * none — so the answer to every one of these five requests is the same list `GET` returns. It is also
 * what lets `useAddressMutations` write the result straight into the query cache instead of refetching,
 * which is how the page was already written.
 *
 * **Every route is authenticated and none carries `@Public()`.** `JwtAuthGuard` is global, so the
 * absence of that decorator *is* the guard: an anonymous `GET /account/addresses` is a 401 before this
 * class is reached. There is no guest address book — a guest's address exists only inside the order
 * they placed, as `addressSnapshot` — so a route that answered `[]` to an anonymous caller would be
 * hiding a missing guard behind a plausible empty array.
 *
 * **`@CurrentUser()`, never `@OptionalUser()`.** The strict decorator throws when `request.user` is
 * absent, and the danger is not the crash but its repair: `user?.id ?? undefined` reaches TypeORM with
 * a criterion it silently drops, and the customer is answered with every address in the database. The
 * two decorators are interchangeable to `tsc` — a param decorator's return type is not the declared
 * parameter type — so `addresses.controller.spec.ts` runs the factories against a user-less context and
 * asserts they **throw**.
 *
 * **A miss is a 404 and never a 403**, through one shared `notFound` helper. `AddressesService` answers
 * `null` for both "no such address" and "not yours" and cannot tell them apart by design; two statuses
 * here would make the endpoint an existence oracle for other customers' address ids. `ErrorCodes` has
 * no `FORBIDDEN` member at all, which is the registry saying the same thing.
 *
 * **`ParseUUIDPipe` on every `:id`, and it is a bug fix rather than a formality.** `addresses.id` is a
 * `uuid` column, so a non-uuid path parameter reaches Postgres as SQLSTATE `22P02` (*invalid input
 * syntax for type uuid*), which nothing catches — a **500** for a mistyped URL. It is reachable
 * today, not hypothetically: the page this replaces minted ids of the form `adr-b2c-home`, so any
 * browser still holding one sends exactly that.
 *
 * **Declaration order is routing order.** Nest registers handlers in `Object.getOwnPropertyNames`
 * order and Express matches the first that fits. `@Post()` and `@Post(':id/default')` cannot shadow
 * each other — different path lengths — but a `@Post(':id')` added above the default route later
 * would swallow it, and `addresses.controller.spec.ts` pins the whole table rather than one route so
 * that a sibling added later is covered without anyone remembering to extend it.
 */
@ApiTags('account')
@Controller('account/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  /**
   * `GET /account/addresses` — the caller's own addresses, default first.
   *
   * The owner comes from the session and from nowhere else. It is deliberately not a query parameter
   * or an email: the seam this replaces took an `email` and filtered a client-side array by it, which
   * as a server route would be spec §13's IDOR hole — anyone who can guess an address reads its book.
   */
  @Get()
  @ApiOperation({ summary: 'The signed-in customer’s saved addresses, default first' })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SavedAddress[]> {
    const book = await this.addresses.list(user.id);
    return book.map(toSavedAddress);
  }

  /**
   * `POST /account/addresses` — a new address.
   *
   * **201, the Nest default, and left alone on purpose.** A row really is created here, unlike the
   * `/default` route below. There is no `Location` header because there is no single-address route to
   * point one at: the id is in the answered book.
   */
  @Post()
  @ApiOperation({ summary: 'Save a new address' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ): Promise<SavedAddress[]> {
    const book = await this.addresses.create(user.id, dto);
    return book.map(toSavedAddress);
  }

  /** `PATCH /account/addresses/:id` — edit one of the caller's addresses. */
  @Patch(':id')
  @ApiOperation({ summary: 'Edit one of the signed-in customer’s addresses' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<SavedAddress[]> {
    const book = await this.addresses.update(user.id, id, dto);
    if (book === null) throw this.notFound(id);
    return book.map(toSavedAddress);
  }

  /**
   * `DELETE /account/addresses/:id` — a soft delete.
   *
   * **200 with the remaining book, not 204.** A 204 would be the tidier-looking answer and it would
   * hide the one thing the client has to know: deleting the default promotes another address, so the
   * page must re-render a badge it did not move. `wishlist.controller.ts` answers its removals the
   * same way for the same reason.
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Remove one of the signed-in customer’s addresses' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SavedAddress[]> {
    const book = await this.addresses.remove(user.id, id);
    if (book === null) throw this.notFound(id);
    return book.map(toSavedAddress);
  }

  /**
   * `POST /account/addresses/:id/default` — make one address the default.
   *
   * **`@HttpCode(HttpStatus.OK)`, because Nest answers a `POST` with 201 by default** and nothing is
   * created: this is a flag moving from one existing row to another. A 201 would tell every client
   * that a resource had come into being, which is a lie the client cannot act on.
   *
   * `POST` rather than `PATCH ?default=true` because the whole request *is* the promotion — there is
   * no body, nothing else can be changed through it, and the two-statement clear-then-set it runs is
   * not expressible as a field on one row.
   */
  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Make one of the signed-in customer’s addresses the default' })
  async setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SavedAddress[]> {
    const book = await this.addresses.setDefault(user.id, id);
    if (book === null) throw this.notFound(id);
    return book.map(toSavedAddress);
  }

  /**
   * The one 404 all three id-bearing routes throw, so an edit, a delete and a promotion are
   * **indistinguishable** on a miss.
   *
   * Written once because that identity is the property: the first divergence — a delete that said
   * "this address is not yours" while an edit said "no such address" — hands an attacker the
   * difference between "no such address" and "someone else's".
   *
   * `HttpStatus.NOT_FOUND` is passed explicitly, because `DomainError` defaults to **422** and a
   * client's not-found branch would never run.
   */
  private notFound(id: string): DomainError {
    return new DomainError(
      ErrorCodes.NOT_FOUND,
      `No address ${id} in your account.`,
      HttpStatus.NOT_FOUND,
      { id },
    );
  }
}
