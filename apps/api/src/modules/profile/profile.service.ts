import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { AuthUser } from '@nutwala/shared';
import { Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { User } from '../../entities/identity/user.entity';
import { toAuthUser } from '../users/user.mapper';
import { UsersService } from '../users/users.service';
import type { UpdateProfileDto } from './dto/update-profile.dto';

/** The two columns of `users` a customer may write about themselves. There is no third. */
type WritableColumns = Pick<User, 'name' | 'phone'>;

/**
 * The one place a customer edits their own `User` row — spec §6.3's `GET`/`PATCH /account/profile`.
 *
 * **The read is `UsersService.findById`, not a query of its own, and that is the whole reason this
 * class has two dependencies.** `GET /auth/me` answers `toAuthUser(await users.findById(id))`
 * (`auth.service.ts:95-105`), and `findById` is what carries `relations: { business: true }` — the
 * company block a `b2b` account's payload needs. A local `findOne({ where: { id } })` here would
 * type-check, pass every test written against a `b2c` fixture, and answer a business customer with no
 * company at all; worse, it would be a *second* definition of "the current user", so the next relation
 * added to that payload would appear on one of the two endpoints and not the other. One read, one
 * mapper, two URLs.
 *
 * **The write is not delegated, for the opposite reason.** `UPDATE users … WHERE id = $1` is the only
 * statement in this module and its owner clause is the only thing standing between a customer editing
 * their own name and a customer renaming **every account the predicate matches**. `users.id` is the
 * primary key, so there is no unique index, no foreign key and no check constraint that a misscoped
 * `UPDATE` would violate — Task 21's lesson generalised: an index refuses *two*, never *zero*, and here
 * there is not even an index to refuse anything. So the clause lives where it can be mutated and
 * asserted (`profile.service.spec.ts`) rather than behind a delegating call that a spec can only
 * observe the arguments of.
 *
 * Note the shape that is *not* the hazard: TypeORM refuses an empty criteria for `update` outright, so
 * dropping the clause altogether is a 500 rather than a breach. `requireOwner` below records the
 * measurement.
 *
 * **No transaction, and no lock.** `AddressesService` needs both because "exactly one default" is an
 * invariant *across rows* that no constraint enforces. Nothing here is cross-row: one statement
 * touches one row, `name` and `phone` are unique to nobody, and the read that follows is only there to
 * answer with the committed state. Two concurrent `PATCH`es settle as last-write-wins on a single row,
 * which is what a profile form should do.
 *
 * **`email` is not writable and this class never mentions it**, which is the point: `uq_users_email` is
 * a case-insensitive functional unique index, so an email edit is the one write here that could collide
 * — and it is an account-recovery flow with verification rather than a profile field. `UpdateProfileDto`
 * declares no such property, so `forbidNonWhitelisted` answers 400 before this service is reached.
 */
@Injectable()
export class ProfileService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly directory: UsersService,
  ) {}

  /**
   * The signed-in customer's own profile.
   *
   * The `null` branch is a **401 and not a 404**, matching `AuthService.me` letter for letter: the
   * session that got this far is valid, so a missing row means the account behind it is gone, and
   * "your session has expired" is the only thing a client can act on. It is close to unreachable over
   * HTTP — `sessions.user_id` is `onDelete: 'CASCADE'`, so deleting a user destroys their sessions and
   * `JwtAuthGuard` refuses the request first — which is exactly why it must not be a 500: the one way
   * to reach it is an operator deleting a row mid-request, and that is not an internal error.
   */
  async read(userId: string): Promise<AuthUser> {
    this.requireOwner(userId);

    const user = await this.directory.findById(userId);
    if (user === null) throw this.sessionExpired();

    return toAuthUser(user);
  }

  /**
   * A name and a phone number, and the profile as it now stands.
   *
   * **An empty `PATCH {}` issues no statement**, and what it avoids is subtler than it looks —
   * measured, because the obvious reason is wrong. `repository.update({ id }, {})` does *not* raise
   * `UpdateValuesMissingError`: that error is for a `valuesSet` that is `undefined`, and `{}` is
   * defined. Nor does it produce an empty `SET` clause, because `User extends BaseEntity` and
   * `BaseEntity.updatedAt` is an `@UpdateDateColumn`, which TypeORM adds to every update expression
   * whether or not the caller named a column. So the statement succeeds and does exactly one thing:
   * **bumps `updatedAt`**. That is an audit trail claiming the customer edited their profile on a
   * request that changed nothing, which is worth a key count on its own — and on any entity that did
   * not carry an update-date column, the same statement would be a 500.
   * `AddressesService.update` counts its keys too, though its docblock gives the `UpdateValuesMissingError`
   * reason; `Address` also extends `BaseEntity`, so that reason is wrong there for the same reason.
   *
   * **Answers the whole profile rather than the fields that changed**, and re-reads rather than
   * patching the fetched row in memory: the answer is then the committed state, so a client can write
   * it straight into the session snapshot — which is what `AuthProvider.updateProfile` does with it,
   * keeping the header, the route guards and this page from disagreeing about the customer's name.
   */
  async update(userId: string, dto: UpdateProfileDto): Promise<AuthUser> {
    this.requireOwner(userId);

    const patch = this.patchOf(dto);
    if (Object.keys(patch).length > 0) {
      await this.users.update({ id: userId }, patch);
    }

    return this.read(userId);
  }

  /**
   * The guard that makes an ownerless call a crash instead of a disclosure.
   *
   * Unreachable over HTTP — every route on `ProfileController` is authenticated and `@CurrentUser()`
   * throws rather than resolving nobody — which is precisely why it is cheap. TypeORM **drops** an
   * `undefined` from a find-options `where` (`SelectQueryBuilder.js:2496-2504`, default
   * `invalidWhereValuesBehavior.undefined: 'ignore'`), so `findOne({ where: { id: undefined } })` is not
   * a query for a user with no id — it is a query with no criteria, and it answers with **whichever row
   * Postgres returns first**: a stranger's name, email and phone number in a 200.
   *
   * The write half fails *loudly*, and it is worth recording which way round that is, because the
   * intuition runs the other way. `Repository.update` normalises its criteria and then refuses an empty
   * one (`EntityManager.normalizeAndValidateWhereCriteria` → `rejectEmpty`), and normalisation drops
   * `undefined` values — so `update({ id: undefined }, patch)` is *"Empty criteria(s) are not allowed
   * for the update method."* and a 500, **not** an `UPDATE` with no `WHERE`. Measured by mutating both
   * shapes. So the disclosure risk on this endpoint is the read, and the write's real exposure is an
   * owner clause that is present but wrong.
   */
  private requireOwner(userId: string): void {
    if (!userId) throw new Error('ProfileService: a profile has no meaning without an owner');
  }

  /**
   * The patch's columns, written out key by key rather than spread from the DTO.
   *
   * `address.mapper.ts` gives the reason applied to a read and `AddressesService.patchOf` the same
   * reason applied to a write: a spread forwards whatever survived validation, which makes the global
   * pipe's `whitelist` the *only* thing between a request body and this table. One layer of defence for
   * a mass assignment of `role`, `isActive` or `passwordHash` is one too few — and the return type is
   * `Partial<WritableColumns>` rather than `Partial<User>`, so a third key added here has to be
   * declared writable in one more place first.
   */
  private patchOf(dto: UpdateProfileDto): Partial<WritableColumns> {
    const patch: Partial<WritableColumns> = {};

    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.phone !== undefined) patch.phone = dto.phone;

    return patch;
  }

  private sessionExpired(): DomainError {
    return new DomainError(
      ErrorCodes.SESSION_EXPIRED,
      'Your session has expired. Please sign in again.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
