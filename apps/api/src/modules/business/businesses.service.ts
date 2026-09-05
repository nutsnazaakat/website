import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { CompanyProfile, CustomerSegment } from '@nutwala/shared';
import { In, IsNull, Repository } from 'typeorm';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { CustomerSegment as CustomerSegmentEnum } from '../../entities/enums';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import type { ResolvedBusiness } from './mappers/business.mapper';

/**
 * Compile-time proof that the wire's `CustomerSegment` and the backend's `CustomerSegment` enum
 * name exactly the same four members, the same guard `coupon.service.ts` keeps for
 * `CouponRefusalCode` against `ErrorCode` — and for the same reason it cannot move into `shared`:
 * `shared` has no access to `entities/enums.ts`.
 *
 * Nothing here calls this map yet — Milestone 9's `PATCH /admin/businesses/:id` is the first
 * writer of a non-`DEFAULT` segment, and `PricingResolver` (Task 2) only ever reads the backend
 * enum off a loaded `Business` row. The guard is written now, in the same task that adds the
 * column, so the two vocabularies cannot drift apart before anything consumes either of them.
 * It checks both directions: a segment added to one and not the other is a missing property or
 * an unknown one, the same way renaming `COUPON_EXPIRED` in `shared` alone produced
 * `TS2353 … does not exist in type Record<CouponRefusalCode, ErrorCode>`.
 */
const _segmentsMap: Record<CustomerSegment, CustomerSegmentEnum> = {
  default: CustomerSegmentEnum.DEFAULT,
  retailer: CustomerSegmentEnum.RETAILER,
  distributor: CustomerSegmentEnum.DISTRIBUTOR,
  horeca: CustomerSegmentEnum.HORECA,
};
void _segmentsMap;

/** `PUT /business/me`'s input, once `UpdateBusinessDto` has been validated against shape and
 * vocabulary. `billingAddressId`/`shippingAddressId` are what this service still has to check —
 * ownership and liveness, which no DTO can do without a database read. */
export interface UpdateBusinessInput {
  companyName: string;
  contactPerson: string;
  mobile: string;
  gstin?: string;
  businessType: string;
  billingAddressId: string | null;
  shippingAddressId: string | null;
}

@Injectable()
export class BusinessesService {
  constructor(
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    @InjectRepository(Address) private readonly addresses: Repository<Address>,
  ) {}

  /** Called during registration when the "buying for a business" box is ticked. */
  async createFor(userId: string, company: CompanyProfile): Promise<Business> {
    return this.businesses.save(
      this.businesses.create({
        userId,
        companyName: company.companyName,
        contactPerson: company.contactPerson,
        businessType: company.businessType,
        gstin: company.gstin ?? null,
        // Registration collects only the essentials; `/business/profile` captures the rest.
        mobile: '',
      }),
    );
  }

  /**
   * `GET /business/me`'s read: the caller's own business, with both address references resolved.
   *
   * `null` when the caller has no business row at all — unreachable over HTTP, since every route
   * on `BusinessesController` carries `@Roles(UserRole.BUSINESS)` and a `BUSINESS` account always
   * gains one at registration (`createFor`, above) — but the controller still has to have an
   * answer for it rather than assuming.
   */
  async getProfile(userId: string): Promise<ResolvedBusiness | null> {
    const business = await this.businesses.findOne({ where: { userId } });
    if (business === null) return null;
    const { billing, shipping } = await this.resolveAddresses(business);
    return { business, billing, shipping };
  }

  /**
   * `PUT /business/me`'s write: a full replace of every profile field, `segment` and
   * `assignedSalespersonId` untouched.
   *
   * **Both address ids are checked before anything is written**, and checked against the same
   * predicate `AddressesService.findOwned` uses: owned by this caller, and `deletedAt IS NULL`.
   * An unvalidated id here is an IDOR — business A naming business B's address, and `GET
   * /business/me` resolving and displaying it right back — and a soft-deleted id would let a
   * customer keep pointing at an address that no longer exists in their own book. Either check
   * failing throws a 404 naming the id, exactly `AddressesController.notFound`'s shape, so this
   * cannot become a silent accept.
   *
   * **The write's `where` is `{ userId }`, never `{ id: business.id }`.** Both narrow to one row
   * today — a business is 1:1 with a user — but only `userId` ties the statement to the *caller*
   * rather than to a row this method already trusts it found correctly. `AddressesService`'s own
   * methods make the identical choice for the identical reason.
   */
  async update(userId: string, input: UpdateBusinessInput): Promise<ResolvedBusiness> {
    if (input.billingAddressId !== null) {
      await this.requireOwnedAddress(userId, input.billingAddressId);
    }
    if (input.shippingAddressId !== null) {
      await this.requireOwnedAddress(userId, input.shippingAddressId);
    }

    await this.businesses.update(
      { userId },
      {
        companyName: input.companyName,
        contactPerson: input.contactPerson,
        mobile: input.mobile,
        gstin: input.gstin ?? null,
        businessType: input.businessType,
        billingAddressId: input.billingAddressId,
        shippingAddressId: input.shippingAddressId,
      },
    );

    const reread = await this.getProfile(userId);
    if (reread === null) {
      throw new Error(`Business for user ${userId} was updated but could not be read back`);
    }
    return reread;
  }

  /**
   * Resolves a business's two address references, treating a reference to a **soft-deleted**
   * address as absent rather than as the deleted row.
   *
   * `Business.billingAddress`/`.shippingAddress` are plain `@ManyToOne` relations, and TypeORM's
   * join does not know about `Address.deletedAt` — it is a bare `@Column`, not a
   * `@DeleteDateColumn` — so resolving through the relation would happily return a row the
   * customer deleted from their own book. `businesses.billing_address_id`'s own docblock states
   * this obligation for exactly this reason: the `ON DELETE SET NULL` foreign key clears the
   * reference on a **hard** delete, but this address book only ever soft-deletes, so the stale
   * reference is a reachable state this method is what closes.
   */
  private async resolveAddresses(
    business: Business,
  ): Promise<{ billing: Address | null; shipping: Address | null }> {
    const ids = [business.billingAddressId, business.shippingAddressId].filter(
      (id): id is string => id !== null,
    );
    if (ids.length === 0) return { billing: null, shipping: null };

    const rows = await this.addresses.find({ where: { id: In(ids), deletedAt: IsNull() } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      billing: business.billingAddressId ? (byId.get(business.billingAddressId) ?? null) : null,
      shipping: business.shippingAddressId ? (byId.get(business.shippingAddressId) ?? null) : null,
    };
  }

  /** Throws the same 404 shape `AddressesController.notFound` answers, so a stranger's address id
   * and a soft-deleted one are refused identically rather than distinguishably. */
  private async requireOwnedAddress(userId: string, id: string): Promise<void> {
    const found = await this.addresses.findOne({ where: { id, userId, deletedAt: IsNull() } });
    if (found === null) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        `No address ${id} in your account.`,
        HttpStatus.NOT_FOUND,
        { id },
      );
    }
  }
}
