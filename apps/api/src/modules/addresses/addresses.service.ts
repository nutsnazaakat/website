import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, type EntityManager, type Repository } from 'typeorm';
import { Address } from '../../entities/identity/address.entity';
import type { CreateAddressDto, UpdateAddressDto } from './dto/save-address.dto';

/** The eight address columns a client may write, plus the label. `userId` is never one of them. */
type WritableColumns = Pick<
  Address,
  'label' | 'fullName' | 'phone' | 'email' | 'line1' | 'line2' | 'city' | 'state' | 'pincode'
>;

/**
 * `line2: ''` from the form, stored as `NULL`.
 *
 * **`@IsOptional()` does not stop this**, and that is the whole reason this function exists:
 * `AddressForm`'s `emptyValues` (`AddressForm.tsx:30-42`) sets `line2: ''`, and `@IsOptional()` skips
 * its sibling validators only for `undefined` and `null` — an empty string is a *present* value, so it
 * validates against `@IsString() @MaxLength(255)` and lands in the column. The book would then hold two
 * spellings of "no second line", `NULL` for an address created by the seeder or by checkout and `''`
 * for every address a customer typed, and every consumer would have to know both. Task 13 has the
 * identical problem in the order snapshot for the identical reason.
 *
 * Trimmed before the test, so `'   '` is also nothing. Nothing else here is trimmed, deliberately:
 * `AddressDto` does not trim and neither does `addressSchema`, and a service that quietly trimmed
 * `fullName` while the form did not would make the round trip lossy for a value the customer can see.
 */
const normaliseLine2 = (line2: string | undefined): string | null =>
  line2 === undefined || line2.trim() === '' ? null : line2;

/** Oldest first, uuid as the tiebreaker — the promotion order, spelled out where it is used. */
const oldestFirst = (left: Address, right: Address): number =>
  left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);

/**
 * A customer's own address book, and nobody else's — spec §6.3's five address routes.
 *
 * **`Address` is the one table in this schema with a partial unique index, and every method here is
 * shaped by it.** Measured:
 *
 * ```sql
 * CREATE UNIQUE INDEX uq_addresses_one_default_per_user ON public.addresses
 *   USING btree (user_id) WHERE (("isDefault" = true) AND ("deletedAt" IS NULL))
 * ```
 *
 * Three consequences, and none of them is optional:
 *
 * 1. **Clear first, then set.** The index is checked per statement and is not deferrable, so
 *    `UPDATE … SET "isDefault" = true` before the old default has been cleared violates it
 *    *immediately* — the write fails with a constraint error rather than producing two defaults.
 *    Every promotion below is two statements in that order.
 * 2. **It stops two defaults; nothing stops zero.** The index has no opinion about a customer whose
 *    book has three addresses and no default, which is the state a naive delete or a demotion leaves
 *    behind, and a book with no default silently changes what checkout offers first. `settle()` is what
 *    closes that half, and it is the invariant this service enforces that the database cannot.
 * 3. **A soft-deleted default does not block a new one**, because `deletedAt IS NULL` is inside the
 *    predicate. That is what makes the soft delete safe instead of something that wedges the book.
 *
 * **The soft delete is for restorability, not for order history.** `address.entity.ts`'s own docblock
 * says orders never reference this table — they hold an `addressSnapshot` jsonb (spec §5.3) — so a hard
 * delete could not blank out where a past order went. Do not add a join from `orders` to `addresses` in
 * the belief that it protects anything; that coupling is exactly what the snapshot exists to avoid.
 *
 * **Every write is one transaction, and every transaction starts by locking the owner's row.** The
 * transaction alone is not enough: two concurrent creates on an empty book each count zero addresses,
 * each decide to promote themselves, and the second dies on the unique index — a **500** on an
 * ordinary double-click of *Add Address*. `SELECT … FROM users … FOR NO KEY UPDATE` serialises the two
 * so the loser counts one address and does not promote itself. `FOR NO KEY UPDATE` rather than
 * `FOR UPDATE` is deliberate: it conflicts with itself, which is all that is wanted, while
 * `FOR UPDATE` also conflicts with the `FOR KEY SHARE` that *any* insert referencing this user takes —
 * so it would put an address save in front of that customer's checkout.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The caller's live addresses, default first.
   *
   * `isDefault DESC` is the load-bearing half: `/account/addresses` tells the customer *"the default
   * one is offered first"*, and checkout prefills from the head of this list. `createdAt ASC, id ASC`
   * behind it buys **stability, not meaning** — the same trade `ITEMS_IN_ORDER` documents for order
   * lines. Without a total order two reads of one book can return the same addresses in different
   * sequences, and the only symptom is a page that rearranges itself between visits.
   */
  async list(userId: string): Promise<Address[]> {
    this.requireOwner(userId);
    return this.book(this.dataSource.getRepository(Address), userId);
  }

  /**
   * A new address, and the whole book back.
   *
   * **The first address in a book is always the default**, whatever the request said. A customer with
   * addresses and no default is the state the unique index permits and nothing wants: checkout would
   * have no address to offer first and the page would show no *Default* badge, with no error anywhere
   * to explain it.
   *
   * The client-supplied id is gone with the mock that needed one. `Address extends BaseEntity`, whose
   * `id` is a generated uuid, and `routes/account/addresses.tsx` used to fabricate
   * `` `adr-${Date.now().toString(36)}` `` — which collides for two addresses added in the same
   * millisecond, and which is not even a uuid, so it reaches a `uuid` column as SQLSTATE `22P02`.
   */
  async create(userId: string, dto: CreateAddressDto): Promise<Address[]> {
    this.requireOwner(userId);

    return this.dataSource.transaction(async (manager) => {
      const addresses = manager.getRepository(Address);
      await this.lockOwner(manager, userId);

      const live = await addresses.count({ where: { userId, deletedAt: IsNull() } });
      const asDefault = dto.isDefault === true || live === 0;
      // Clear first, then set: see the class docblock. Reversing these two lines is a constraint
      // violation and a 500, not two defaults.
      if (asDefault) await this.clearDefault(addresses, userId);

      await addresses.insert({
        ...this.columnsOf(dto),
        userId,
        isDefault: asDefault,
      });

      return this.settle(addresses, userId);
    });
  }

  /**
   * An edit, or `null` when the caller does not own an address with that id — which the controller
   * turns into the same 404 a missing id gets, because "not yours" and "no such address" must not be
   * distinguishable.
   *
   * **`isDefault: false` on the only default does not leave the book with none.** `settle()` promotes
   * the oldest address instead, so a customer who unticks the box on their default address sees the
   * badge move rather than disappear — which is what the mock's `commit` did (it promoted index 0) and
   * what checkout needs to be true. A default can be *moved*, never removed.
   */
  async update(userId: string, id: string, dto: UpdateAddressDto): Promise<Address[] | null> {
    this.requireOwner(userId);

    return this.dataSource.transaction(async (manager) => {
      const addresses = manager.getRepository(Address);
      await this.lockOwner(manager, userId);

      const owned = await this.findOwned(addresses, userId, id);
      if (owned === null) return null;

      if (dto.isDefault === true) await this.clearDefault(addresses, userId);

      const patch = this.patchOf(dto);
      // An empty `PATCH {}` is a legal request the DTO accepts, and `UPDATE … SET` with nothing to
      // set is a syntax error rather than a no-op. TypeORM skips `undefined` values but does not
      // skip the statement.
      if (Object.keys(patch).length > 0) {
        await addresses.update({ id: owned.id, userId }, patch);
      }

      return this.settle(addresses, userId);
    });
  }

  /**
   * A soft delete, and a promotion if the address being removed was the default.
   *
   * `isDefault` is cleared **in the same statement** as `deletedAt`, and it is not redundant: the
   * index's predicate already excludes deleted rows, so leaving the flag set would not violate
   * anything *today* — it would violate on the day someone restores the row, which is the entire
   * stated reason this delete is soft. A restore must bring back an address, not a second default.
   */
  async remove(userId: string, id: string): Promise<Address[] | null> {
    this.requireOwner(userId);

    return this.dataSource.transaction(async (manager) => {
      const addresses = manager.getRepository(Address);
      await this.lockOwner(manager, userId);

      const owned = await this.findOwned(addresses, userId, id);
      if (owned === null) return null;

      await addresses.update({ id: owned.id, userId }, { deletedAt: new Date(), isDefault: false });

      return this.settle(addresses, userId);
    });
  }

  /**
   * `POST /account/addresses/:id/default` — the one write whose only job is the flag.
   *
   * Clear then set, so it is safe against the index, and idempotent: promoting the address that is
   * already the default clears it and sets it again, ending where it started rather than 409-ing on a
   * double click.
   */
  async setDefault(userId: string, id: string): Promise<Address[] | null> {
    this.requireOwner(userId);

    return this.dataSource.transaction(async (manager) => {
      const addresses = manager.getRepository(Address);
      await this.lockOwner(manager, userId);

      const owned = await this.findOwned(addresses, userId, id);
      if (owned === null) return null;

      await this.clearDefault(addresses, userId);
      await addresses.update({ id: owned.id, userId }, { isDefault: true });

      return this.settle(addresses, userId);
    });
  }

  /**
   * The ordered live book. Every read and every write's answer goes through here, so there is one
   * definition of "this customer's addresses" and one ordering.
   *
   * `deletedAt: IsNull()` is not optional and is not inherited from anywhere: `Address.deletedAt` is a
   * plain `@Column`, **not** a `@DeleteDateColumn`, so TypeORM adds no filter of its own and a `find`
   * without this clause returns every address the customer has ever deleted.
   */
  private book(addresses: Repository<Address>, userId: string): Promise<Address[]> {
    return addresses.find({
      where: { userId, deletedAt: IsNull() },
      order: { isDefault: 'DESC', createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * One of the caller's addresses, or `null`.
   *
   * `userId` is a clause in the query rather than a check on a fetched row, for the reason
   * `orders.service.ts` spells out: the two behave identically today, and only the query stays correct
   * after someone refactors an `if (row.userId !== userId) throw` away.
   */
  private findOwned(
    addresses: Repository<Address>,
    userId: string,
    id: string,
  ): Promise<Address | null> {
    return addresses.findOne({ where: { id, userId, deletedAt: IsNull() } });
  }

  /** The clear half of every promotion. Scoped to the index's own predicate, column for column. */
  private async clearDefault(addresses: Repository<Address>, userId: string): Promise<void> {
    await addresses.update({ userId, isDefault: true, deletedAt: IsNull() }, { isDefault: false });
  }

  /**
   * **The invariant the database does not enforce: a book with addresses has exactly one default.**
   *
   * `uq_addresses_one_default_per_user` guarantees *at most* one. This guarantees *at least* one, and
   * it is the reason it is a separate step run at the end of every write rather than a branch inside
   * each of them: create, edit, delete and promote can each end with zero defaults, three of them
   * without mentioning `isDefault` at all — deleting the default is the obvious one, unticking the box
   * on the default is the second, and a create is the third the day the book was empty.
   *
   * Promotes the **oldest** live address, matching the rule the mock's `commit` applied to index 0 of
   * an insertion-ordered array. Sorted here rather than read off `book()`'s ordering: that ordering
   * puts the default first, so relying on its head to be the oldest would be correct only for as long
   * as this method is only ever reached with no default at all.
   */
  private async settle(addresses: Repository<Address>, userId: string): Promise<Address[]> {
    const live = await this.book(addresses, userId);
    if (live.length === 0 || live.some((address) => address.isDefault)) return live;

    const oldest = [...live].sort(oldestFirst)[0];
    if (oldest === undefined) return live;

    await addresses.update({ id: oldest.id, userId }, { isDefault: true });
    // Re-read rather than patched in memory, so the answer is the committed row order rather than
    // this method's idea of it — the promoted address has to come back *first*.
    return this.book(addresses, userId);
  }

  /**
   * Serialises this customer's own address writes, and only theirs.
   *
   * A genuine `SELECT`, so the `[rows, rowCount]` trap that `PostgresQueryRunner` sets for a raw
   * `UPDATE`/`DELETE` does not apply — nothing here reads the result at all, only the lock it takes.
   *
   * Locking the `users` row rather than the addresses is what makes it work on an **empty** book:
   * there is no address row to lock, and two creates that both find zero addresses both promote
   * themselves and collide on the unique index. `FOR NO KEY UPDATE` conflicts with itself and not with
   * `FOR KEY SHARE`, so two address writes queue while an order placement's foreign-key check does
   * not.
   */
  private async lockOwner(manager: EntityManager, userId: string): Promise<void> {
    await manager.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  }

  /**
   * The guard that makes an ownerless call a crash instead of a disclosure.
   *
   * Every route on this controller is authenticated and `@CurrentUser()` throws rather than resolving
   * nobody, so this is unreachable over HTTP — which is precisely why it is cheap and why it is here.
   * TypeORM **drops** an `undefined` from a find-options `where`
   * (`SelectQueryBuilder.js:2496-2504`, default `invalidWhereValuesBehavior.undefined: 'ignore'`), so
   * `where: { userId, deletedAt: IsNull() }` with no owner is not a query for unowned addresses — it is
   * a query with no owner clause, and it answers with **every address in the table**. A 500 is a bad
   * day; that is a data breach.
   */
  private requireOwner(userId: string): void {
    if (!userId)
      throw new Error('AddressesService: an address book has no meaning without an owner');
  }

  /** A create's columns, with `line2` normalised. */
  private columnsOf(dto: CreateAddressDto): WritableColumns {
    return {
      label: dto.label,
      fullName: dto.fullName,
      phone: dto.phone,
      email: dto.email,
      line1: dto.line1,
      line2: normaliseLine2(dto.line2),
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
    };
  }

  /**
   * A patch's columns — only the keys the request actually carried.
   *
   * Written out key by key rather than spread from the DTO, for `order.mapper.ts`'s reason applied to
   * a write: a spread forwards whatever the client sent, and the global pipe's `whitelist` is the only
   * thing standing between that and a mass assignment of `userId` or `deletedAt`. One layer of defence
   * for that is one too few.
   *
   * `line2` is only normalised when it is *present*, so an absent `line2` leaves the stored value
   * alone while `line2: ''` clears it — TypeORM skips an `undefined` in an `UPDATE`'s value set
   * (`UpdateQueryBuilder.js:294`, *"it doesn't make sense to update undefined properties"*), which is
   * what makes this shape a patch rather than a replace.
   */
  private patchOf(dto: UpdateAddressDto): Partial<WritableColumns & Pick<Address, 'isDefault'>> {
    const patch: Partial<WritableColumns & Pick<Address, 'isDefault'>> = {};

    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.fullName !== undefined) patch.fullName = dto.fullName;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.line1 !== undefined) patch.line1 = dto.line1;
    if (dto.line2 !== undefined) patch.line2 = normaliseLine2(dto.line2);
    if (dto.city !== undefined) patch.city = dto.city;
    if (dto.state !== undefined) patch.state = dto.state;
    if (dto.pincode !== undefined) patch.pincode = dto.pincode;
    if (dto.isDefault !== undefined) patch.isDefault = dto.isDefault;

    return patch;
  }
}
