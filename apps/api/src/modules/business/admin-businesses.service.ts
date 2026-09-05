import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type {
  AdminBusiness,
  AdminBusinessSummary,
  CustomerSegment,
  Paginated,
} from '@nutwala/shared';
import { DataSource, In, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { CustomerSegment as CustomerSegmentEnum } from '../../entities/enums';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { NO_ORDER_TOTALS, orderTotalsByUser } from '../orders/customer-order-totals';
import { OPEN_RFQ_STATUSES } from './business-stats.service';
import { BusinessesService } from './businesses.service';
import type { AdminBusinessQueryDto } from './dto/admin-business-query.dto';
import {
  NO_RFQ_COUNTS,
  toAdminBusiness,
  toAdminBusinessSummary,
  type AdminBusinessRow,
  type BusinessRfqCounts,
} from './mappers/admin-business.mapper';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The wire band a filter names, mapped to the column's enum. Never `toUpperCase()`: `@IsIn` has
 * already refused anything outside `CUSTOMER_SEGMENTS`, and this is the map that cannot grow on one
 * side alone. */
const SEGMENT: Record<CustomerSegment, CustomerSegmentEnum> = {
  default: CustomerSegmentEnum.DEFAULT,
  retailer: CustomerSegmentEnum.RETAILER,
  distributor: CustomerSegmentEnum.DISTRIBUTOR,
  horeca: CustomerSegmentEnum.HORECA,
};

/** What the RFQ aggregate answers. Both counts are cast to `int`; `pg` returns a bare `count(*)` as
 * a string. */
interface RfqCountRow {
  userId: string;
  rfqs: number;
  openRfqs: number;
}

/**
 * `GET /admin/businesses` and `GET /admin/businesses/:id` — spec §6.4, brief §35's B2B profile.
 *
 * **A second service and a second controller beside `BusinessesController`, which is
 * `@Roles(UserRole.BUSINESS)` and stays that way.** That controller answers a business's own
 * profile and scopes every read to `user.id`; these routes read every business in the shop. Widening
 * the existing class would mean one class serving two roles with per-handler decorators deciding
 * which — and `RolesGuard` resolves handler metadata *over* class metadata, so a handler that lost
 * one would inherit `BUSINESS` and serve a customer the whole customer base.
 *
 * **Both the addresses and the order figures come from somewhere that already owns them.**
 * `BusinessesService.getProfile` is the one implementation of "a reference to a soft-deleted address
 * reads back as absent", and `orderTotalsByUser` is the one implementation of the order aggregates
 * `GET /admin/customers` reports for the same account. Neither is re-derived here, because two
 * admin screens disagreeing about the same business is the failure this whole surface exists to
 * avoid.
 *
 * **Every aggregate is scoped by `userId`, never by `orders.business_id` or `rfqs` having one.**
 * `BusinessStatsService`'s docblock records the measurement for orders — `CheckoutService.place`
 * writes `businessId: null` into every order — and `rfqs` has no business column at all: an enquiry
 * carries `user_id` and a free-text `businessName`, because brief §17's form is public and a
 * prospect need not have an account.
 */
@Injectable()
export class AdminBusinessesService {
  constructor(
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly profiles: BusinessesService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * `GET /admin/businesses` — paginated, searchable, filterable by segment.
   *
   * **Ordered `createdAt DESC`, then `id DESC`.** `businesses.createdAt` is not unique — the seeder
   * writes its rows in one transaction and Postgres's `now()` is transaction-start time — so an
   * unstable tiebreak over `LIMIT`/`OFFSET` returns the same business on two pages and loses
   * another entirely.
   *
   * The page is selected first and every aggregate fetched for exactly those ids, rather than
   * joined: a join against `orders` and `rfqs` would multiply the rows and make `getManyAndCount`
   * count order lines rather than businesses. Three statements, issued concurrently, bounded at
   * `limit` rows.
   */
  async list(query: AdminBusinessQueryDto): Promise<Paginated<AdminBusinessSummary>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.businesses.createQueryBuilder('business');

    if (query.segment !== undefined) {
      builder.andWhere('business.segment = :segment', { segment: SEGMENT[query.segment] });
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      builder.andWhere(
        `(business.companyName ILIKE :q
          OR business.contactPerson ILIKE :q
          OR business.gstin ILIKE :q)`,
        { q: `%${query.q.trim()}%` },
      );
    }

    const [rows, total] = await builder
      .orderBy('business.createdAt', 'DESC')
      .addOrderBy('business.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const assembled = await this.assemble(rows);

    return { items: assembled.map(toAdminBusinessSummary), total, page, limit };
  }

  /**
   * `GET /admin/businesses/:id` — by the **business's** uuid, spec §6.4's spelling.
   *
   * Not the account's: `GET /admin/customers/:id` is already addressed by that, and one uuid
   * reaching two resources would make a mistyped reference answer the wrong screen rather than a
   * 404.
   */
  async get(id: string): Promise<AdminBusiness> {
    const business = await this.businesses.findOne({ where: { id } });
    if (business === null) {
      throw new DomainError(ErrorCodes.NOT_FOUND, 'No such business.', HttpStatus.NOT_FOUND, {
        businessId: id,
      });
    }

    const [assembled] = await this.assemble([business]);
    if (assembled === undefined) {
      throw new Error(`Business ${id} was read but could not be assembled`);
    }
    return toAdminBusiness(assembled);
  }

  /**
   * The four reads behind every row: the accounts, the resolved addresses, the order aggregates and
   * the RFQ counts.
   *
   * **The addresses go through `BusinessesService.getProfile`, one call per row**, and that is a
   * deliberate cost. A page of 24 businesses is 24 small reads of an address book that is at most a
   * handful of rows, against the alternative of a second implementation of the soft-delete rule
   * here — which is the drift this whole service is arranged to avoid. Worth revisiting the day a
   * page is slow; not worth pre-empting with a copy.
   *
   * A business whose account has been deleted cannot exist — `businesses.user_id` is
   * `ON DELETE CASCADE` — so a missing account is a real error rather than a row to skip.
   */
  private async assemble(businesses: Business[]): Promise<AdminBusinessRow[]> {
    if (businesses.length === 0) return [];

    const userIds = businesses.map((business) => business.userId);
    const salespersonIds = [
      ...new Set(
        businesses
          .map((business) => business.assignedSalespersonId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const [accounts, totals, rfqCounts, salespeople, profiles] = await Promise.all([
      this.users.find({ where: { id: In(userIds) } }),
      orderTotalsByUser(this.dataSource, userIds),
      this.rfqCountsFor(userIds),
      salespersonIds.length === 0
        ? Promise.resolve<User[]>([])
        : this.users.find({ where: { id: In(salespersonIds) } }),
      Promise.all(businesses.map((business) => this.profiles.getProfile(business.userId))),
    ]);

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const salespersonById = new Map(salespeople.map((person) => [person.id, person]));

    return businesses.map((business, index) => {
      const account = accountById.get(business.userId);
      if (account === undefined) {
        throw new Error(`Business ${business.id} has no account, which the schema forbids`);
      }
      const resolved = profiles[index];
      if (resolved === undefined || resolved === null) {
        throw new Error(`Business ${business.id} could not resolve its own addresses`);
      }

      return {
        resolved,
        account,
        totals: totals.get(business.userId) ?? NO_ORDER_TOTALS,
        rfqCounts: rfqCounts.get(business.userId) ?? NO_RFQ_COUNTS,
        salesperson:
          business.assignedSalespersonId === null
            ? null
            : (salespersonById.get(business.assignedSalespersonId) ?? null),
      };
    });
  }

  /**
   * Brief §35's "RFQs" column, and the live subset beside it, in one statement.
   *
   * **`OPEN_RFQ_STATUSES` is imported rather than restated.** `BusinessStatsService` derives it from
   * a total `Record<RfqStatus, boolean>` precisely so an eighth status added to `RFQ_STATUSES`
   * becomes a compile error rather than a silently-uncounted enquiry, and a second list here would
   * be the copy that misses it — leaving the operator's "open enquiries" figure disagreeing with the
   * one the business reads on its own dashboard.
   */
  private async rfqCountsFor(userIds: readonly string[]): Promise<Map<string, BusinessRfqCounts>> {
    if (userIds.length === 0) return new Map();

    const rows = await this.dataSource.query<RfqCountRow[]>(
      `SELECT r.user_id AS "userId",
              count(*)::int AS rfqs,
              count(*) FILTER (WHERE r.status = ANY($2))::int AS "openRfqs"
         FROM rfqs r
        WHERE r.user_id = ANY($1)
        GROUP BY r.user_id`,
      [[...userIds], OPEN_RFQ_STATUSES],
    );

    return new Map(rows.map((row) => [row.userId, { rfqs: row.rfqs, openRfqs: row.openRfqs }]));
  }
}
