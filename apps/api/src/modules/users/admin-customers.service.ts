import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { AdminCustomer, AdminCustomerSummary, Paginated } from '@nutwala/shared';
import { DataSource, IsNull, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { UserRole } from '../../entities/enums';
import { toSavedAddress } from '../addresses/mappers/address.mapper';
import { NO_ORDER_TOTALS, orderTotalsByUser } from '../orders/customer-order-totals';
import { toAdminCustomer, toAdminCustomerSummary } from './admin-customer.mapper';
import type { AdminCustomerQueryDto } from './dto/admin-customer-query.dto';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The wire role a filter names, mapped to the column's enum. Never `toUpperCase()`: `@IsIn` has
 * already refused anything outside the tuple, and this is the map that cannot grow on one side
 * alone — `AdminOrdersService.list` states the same rule for `channel`. */
const ROLE: Record<'b2c' | 'b2b', UserRole> = {
  b2c: UserRole.CUSTOMER,
  b2b: UserRole.BUSINESS,
};

/**
 * `GET /admin/customers` and `GET /admin/customers/:id` — brief §35's customer management.
 *
 * **A second service beside `UsersService`, not extra methods on it**, the same separation
 * `AdminOrdersService` keeps from `OrdersService`: every read in `UsersService` is by email or by
 * the caller's own id, and these are unscoped reads of the whole customer base. Putting one beside
 * the other would leave a method one careless reuse away from serving a customer somebody else's
 * account.
 *
 * **`role <> 'ADMIN'` is pinned into every read here.** An operator account is not a customer:
 * brief §35's screen is "separate B2C and B2B customers", `GET /admin/dashboard`'s `customers` card
 * already counts `role <> 'ADMIN'`, and a list that included admins would disagree with the card
 * beside it. `GET /admin/customers/:id` therefore answers **404 for an admin's own uuid** — not a
 * 403, because the resource genuinely does not exist under this collection, and a distinguishable
 * refusal would make the endpoint an oracle for which uuids are admin accounts.
 *
 * **Nothing here ever selects `passwordHash`.** The column is `select: false` so the repository
 * does not load it, the aggregates are a separate statement that touches `orders` only, and the
 * mapper builds its result field by field — three independent reasons, because one of them is one
 * careless edit from being untrue. See `toAdminCustomerSummary`.
 */
@Injectable()
export class AdminCustomersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    @InjectRepository(Address) private readonly addresses: Repository<Address>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * `GET /admin/customers` — paginated, searchable by name/email/phone, filterable by role.
   *
   * **Two statements, and the aggregates are the second one.** Joining `orders` into the page query
   * would either multiply the rows (a customer with four orders appearing four times) or force a
   * `GROUP BY` over every selected column, and `getManyAndCount`'s count would then be counting
   * order lines rather than customers. So the page is selected first and the aggregates are fetched
   * for exactly those ids — one extra round trip, bounded at `limit` rows, and correct.
   *
   * **Ordered `createdAt DESC`, then `id DESC`.** `users.createdAt` is not unique: `seedUsers`
   * writes its accounts in one transaction and Postgres's `now()` is transaction-start time, so a
   * whole batch shares one timestamp exactly and an unstable tiebreak over `LIMIT`/`OFFSET` returns
   * the same customer on two pages and loses another entirely. `id` is arbitrary but *total*, which
   * is the property paging needs. `AdminOrdersService.list` and `AdminProductsService.list` both
   * carry this note; it has bitten this schema before.
   */
  async list(query: AdminCustomerQueryDto): Promise<Paginated<AdminCustomerSummary>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.users
      .createQueryBuilder('user')
      .where('user.role != :admin', { admin: UserRole.ADMIN });

    if (query.role !== undefined) {
      builder.andWhere('user.role = :role', { role: ROLE[query.role] });
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      builder.andWhere('(user.name ILIKE :q OR user.email ILIKE :q OR user.phone ILIKE :q)', {
        q: `%${query.q.trim()}%`,
      });
    }

    const [rows, total] = await builder
      .orderBy('user.createdAt', 'DESC')
      .addOrderBy('user.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const totals = await orderTotalsByUser(
      this.dataSource,
      rows.map((user) => user.id),
    );

    return {
      items: rows.map((user) =>
        toAdminCustomerSummary(user, totals.get(user.id) ?? NO_ORDER_TOTALS),
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * `GET /admin/customers/:id` — one account in full.
   *
   * The address book is filtered to `deletedAt IS NULL` and mapped through `toSavedAddress`, which
   * is the same predicate and the same mapper `GET /account/addresses` serves the customer with —
   * so the operator reading a delivery address over the phone is reading the customer's own book,
   * not a tombstone. Ordered defaults first, then oldest, so the address most deliveries go to is
   * at the top.
   *
   * The business record is read separately rather than through `User.business`, because that
   * relation is a lazy-typed `@OneToOne('Business', 'user')` reached by string and loading it would
   * put a join on a read that is already three statements; issued concurrently with the addresses
   * and the totals, so it costs one round trip's latency rather than three.
   */
  async get(id: string): Promise<AdminCustomer> {
    const user = await this.users.findOne({ where: { id } });

    // The role check is *after* the read and before anything else is fetched: an admin's own uuid
    // must answer exactly what an unknown uuid answers. See this service's docblock.
    if (user === null || user.role === UserRole.ADMIN) throw noSuchCustomer(id);

    const [totals, addresses, business] = await Promise.all([
      orderTotalsByUser(this.dataSource, [user.id]),
      this.addresses.find({
        where: { userId: user.id, deletedAt: IsNull() },
        order: { isDefault: 'DESC', createdAt: 'ASC' },
      }),
      this.businesses.findOne({ where: { userId: user.id } }),
    ]);

    return toAdminCustomer(
      user,
      totals.get(user.id) ?? NO_ORDER_TOTALS,
      addresses.map(toSavedAddress),
      business,
    );
  }
}

/** The one refusal both routes answer with, so a mistyped uuid and an admin's own uuid are
 * indistinguishable. */
function noSuchCustomer(id: string): DomainError {
  return new DomainError(ErrorCodes.NOT_FOUND, 'No such customer.', HttpStatus.NOT_FOUND, {
    customerId: id,
  });
}
