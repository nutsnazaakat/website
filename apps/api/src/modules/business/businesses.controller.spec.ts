import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import {
  OrderChannelEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
  UserRole,
} from '../../entities/enums';
import type { Order } from '../../entities/commerce/order.entity';
import type { OrdersService } from '../orders/orders.service';
import type { BusinessStatsService } from './business-stats.service';
import { BusinessesController } from './businesses.controller';
import type { UpdateBusinessDto } from './dto/update-business.dto';
import type { BusinessesService } from './businesses.service';

const BUSINESS_USER: AuthenticatedUser = {
  id: 'user-1',
  role: UserRole.BUSINESS,
  sessionId: 's-1',
};

const BASE_BUSINESS = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  gstin: null,
  businessType: 'Sweet shop',
};

/** A `BusinessesService.getProfile`/`.update` return value, complete enough for the mapper. */
function resolvedFixture(overrides: Record<string, unknown> = {}) {
  return {
    business: BASE_BUSINESS,
    billing: null,
    shipping: null,
    ...overrides,
  } as never;
}

const DTO: UpdateBusinessDto = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  businessType: 'Sweet shop',
};

function harness() {
  const businesses = {
    getProfile: jest.fn().mockResolvedValue(resolvedFixture()),
    update: jest.fn().mockResolvedValue(resolvedFixture()),
  };
  const stats = {
    forUser: jest.fn().mockResolvedValue({ openRfqs: 0, bulkSpend: 0, bulkOrders: 0 }),
  };
  const orders = {
    list: jest.fn().mockResolvedValue([]),
  };
  return {
    controller: new BusinessesController(
      businesses as unknown as BusinessesService,
      stats as unknown as BusinessStatsService,
      orders as unknown as OrdersService,
    ),
    businesses,
    stats,
    orders,
  };
}

describe('BusinessesController', () => {
  /**
   * `RolesGuard` is global and returns `true` early for a route carrying no `@Roles()`, so a
   * controller that lost the decorator is not refused — it is quietly opened to a `CUSTOMER`
   * account. Nothing about either handler's arguments or response would notice; this reads the
   * exact metadata the guard reads.
   */
  it('is restricted to BUSINESS accounts', () => {
    expect(Reflect.getMetadata(ROLES_KEY, BusinessesController)).toEqual([UserRole.BUSINESS]);
  });

  describe('me', () => {
    it("asks the service for the caller's own userId", async () => {
      const { controller, businesses } = harness();

      await controller.me(BUSINESS_USER);

      expect(businesses.getProfile).toHaveBeenCalledWith(BUSINESS_USER.id);
    });

    it('maps the resolved business through toBusinessProfile', async () => {
      const { controller, businesses } = harness();
      businesses.getProfile.mockResolvedValue(
        resolvedFixture({ business: { ...BASE_BUSINESS, mobile: '' } }),
      );

      const result = await controller.me(BUSINESS_USER);

      expect(result.mobile).toBe('');
      expect(result).not.toHaveProperty('segment');
      expect(result).not.toHaveProperty('assignedSalespersonId');
    });

    it('throws rather than answering a body when the account has no business row', async () => {
      const { controller, businesses } = harness();
      businesses.getProfile.mockResolvedValue(null);

      await expect(controller.me(BUSINESS_USER)).rejects.toBeInstanceOf(Error);
    });
  });

  describe('updateMe', () => {
    it("passes the caller's own userId and every DTO field through, defaulting absent address ids to null", async () => {
      const { controller, businesses } = harness();

      await controller.updateMe(BUSINESS_USER, DTO);

      expect(businesses.update).toHaveBeenCalledWith(BUSINESS_USER.id, {
        companyName: DTO.companyName,
        contactPerson: DTO.contactPerson,
        mobile: DTO.mobile,
        gstin: undefined,
        businessType: DTO.businessType,
        billingAddressId: null,
        shippingAddressId: null,
      });
    });

    it('forwards a given address id rather than defaulting it away', async () => {
      const { controller, businesses } = harness();
      const withAddress: UpdateBusinessDto = { ...DTO, billingAddressId: 'addr-uuid-1' };

      await controller.updateMe(BUSINESS_USER, withAddress);

      expect(businesses.update).toHaveBeenCalledWith(
        BUSINESS_USER.id,
        expect.objectContaining({ billingAddressId: 'addr-uuid-1' }),
      );
    });

    it('returns the updated profile, mapped', async () => {
      const { controller, businesses } = harness();
      businesses.update.mockResolvedValue(
        resolvedFixture({ business: { ...BASE_BUSINESS, companyName: 'Renamed Co' } }),
      );

      const result = await controller.updateMe(BUSINESS_USER, DTO);

      expect(result.companyName).toBe('Renamed Co');
    });
  });

  describe('getStats', () => {
    it("asks the stats service for the caller's own userId and returns its answer unchanged", async () => {
      const { controller, stats } = harness();
      stats.forUser.mockResolvedValue({ openRfqs: 3, bulkSpend: 12500.5, bulkOrders: 4 });

      const result = await controller.getStats(BUSINESS_USER);

      expect(stats.forUser).toHaveBeenCalledWith(BUSINESS_USER.id);
      expect(result).toEqual({ openRfqs: 3, bulkSpend: 12500.5, bulkOrders: 4 });
    });
  });

  describe('listOrders', () => {
    /**
     * The one thing this route exists to guarantee: the filter is `bulk`, not left open or
     * defaulted to `retail`. `OrdersService.list`'s own scoping and ordering are
     * `orders.service.spec.ts`'s to prove; this controller's whole job is asking for the right
     * slice.
     */
    it("delegates to OrdersService.list with the caller's userId and channel: 'bulk'", async () => {
      const { controller, orders } = harness();

      await controller.listOrders(BUSINESS_USER);

      expect(orders.list).toHaveBeenCalledWith(BUSINESS_USER.id, { channel: 'bulk' });
    });

    it('maps every found order through toAccountOrder', async () => {
      const { controller, orders } = harness();
      const bulkOrder: Order = {
        id: 'b0000000-0000-4000-8000-000000000001',
        orderNumber: 'NN-2026-100000',
        userId: BUSINESS_USER.id,
        businessId: null,
        channel: OrderChannelEnum.BULK,
        status: 'shipped',
        paymentMethod: PaymentMethodEnum.COD,
        paymentStatus: PaymentStatusEnum.PENDING,
        subtotalPaise: 100000n,
        discountPaise: 0n,
        gstPaise: 5000n,
        shippingPaise: 0n,
        totalPaise: 105000n,
        couponCode: null,
        addressSnapshot: {
          fullName: 'Rakesh Anand',
          phone: '9845012345',
          email: 'purchase@anandsweets.example',
          line1: '12 Industrial Estate',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560004',
        },
        billingSnapshot: null,
        companyName: null,
        gstin: null,
        poNumber: null,
        specialInstructions: null,
        placedAt: new Date('2026-08-08T04:30:00.000Z'),
        estimatedDelivery: new Date('2026-08-16T12:00:00.000Z'),
        cancelledAt: null,
        cancelReason: null,
        items: [],
        events: [],
      } as unknown as Order;
      orders.list.mockResolvedValue([bulkOrder]);

      const result = await controller.listOrders(BUSINESS_USER);

      expect(result).toEqual([expect.objectContaining({ id: 'NN-2026-100000', channel: 'bulk' })]);
    });
  });
});
