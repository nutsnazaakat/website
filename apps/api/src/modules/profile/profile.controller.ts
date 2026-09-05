import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileService } from './profile.service';

/**
 * The customer's own account record — spec §6.3's two profile routes.
 *
 * **Two routes and no `:id`, which is the IDOR defence stated as a URL.** There is no
 * `/account/profile/:id` and there is no `?email=`: the row is named by the session cookie and by
 * nothing a caller can type. That is the same rule `AddressesController` and `OrdersController` apply,
 * and it is cheaper to hold here than anywhere else — with no identifier in the request there is no
 * identifier to forge.
 *
 * **`@CurrentUser()`, never `@OptionalUser()`.** The two are interchangeable to `tsc` — a param
 * decorator's return type is not the declared parameter type — so the swap compiles and hands the
 * handler `undefined` for a caller with no session. The crash that follows is survivable; the *repair*
 * is not, because `user?.id ?? undefined` reaches TypeORM with a criterion it silently drops, and
 * `findOne` with no criteria answers with whichever `users` row comes back first. On this endpoint that
 * is a stranger's name, email and phone number in the response body — the `GET` is the dangerous half,
 * measured: the `PATCH` fails loudly instead, because `Repository.update` refuses a criteria that
 * normalises to empty. `profile.controller.spec.ts` runs the param factories against a user-less
 * context and asserts they **throw**.
 *
 * **Neither route carries `@Public()`, and the absence is the guard.** `JwtAuthGuard` is global, so an
 * anonymous `GET /account/profile` is a 401 before this class is reached. A profile has no guest
 * equivalent to fall back to, so there is nothing here that could plausibly answer an empty shape and
 * hide a missing guard.
 *
 * **`PATCH`, not `PUT`.** `UpdateProfileDto`'s two fields are both optional, so a client may send one;
 * a `PUT` would promise that the body is the whole resource, which it can never be — `email`, `role`
 * and `isActive` are all part of this record and none of them is writable here.
 */
@ApiTags('account')
@Controller('account/profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  /**
   * `GET /account/profile` — the signed-in customer's own details.
   *
   * **The same payload as `GET /auth/me`, from the same read and the same mapper.** That is not
   * duplication to be tidied away: the two questions are genuinely the same one ("who is this
   * session?"), and the alternative — a second query with its own relation list and its own object
   * literal — is how one of them ends up missing the `company` block. `ProfileService.read` is the
   * single implementation; this route and `AuthService.me` are two doors onto it.
   *
   * The browser does not currently open this door: `AuthProvider` hydrates from `GET /auth/me` on
   * mount and holds the only client-side copy of `AuthUser`, so a second read would be a second copy
   * free to disagree with the header. It exists because §6.3 puts it here, because the `PATCH` answers
   * through it, and because a client that is not this browser has no `/auth/me` habit.
   */
  @Get()
  @ApiOperation({ summary: 'The signed-in customer’s own profile' })
  read(@CurrentUser() user: AuthenticatedUser): Promise<AuthUser> {
    return this.profile.read(user.id);
  }

  /**
   * `PATCH /account/profile` — the customer's name and mobile number.
   *
   * **200 with the whole profile**, not 204. The client has a session snapshot to correct, and a body
   * it can write straight in is what stops the page and the header disagreeing about a name that has
   * just changed.
   *
   * The owner comes from the session and the fields from the body, and there is nothing in between:
   * `email`, `role` and `isActive` are absent from the DTO, so `forbidNonWhitelisted` refuses each with
   * a **400** before this method runs.
   */
  @Patch()
  @ApiOperation({ summary: 'Edit the signed-in customer’s name and mobile number' })
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto): Promise<AuthUser> {
    return this.profile.update(user.id, dto);
  }
}
