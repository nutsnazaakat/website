import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import type { AdjustStockDto } from './dto/adjust-stock.dto';
import type { UpdateThresholdDto } from './dto/update-threshold.dto';
import { InventoryController } from './inventory.controller';
import type { InventoryService } from './inventory.service';

const VARIANT = '11111111-1111-4111-8111-111111111111';
const ADMIN: AuthenticatedUser = { id: 'admin-1', role: UserRole.ADMIN, sessionId: 'session-1' };

const PAGE = { items: [], total: 0, page: 1, limit: 24 };

function harness() {
  const inventory = {
    adjust: jest.fn().mockResolvedValue({ onHand: 115, balanceAfter: 115 }),
    list: jest.fn().mockResolvedValue(PAGE),
    transactions: jest.fn().mockResolvedValue(PAGE),
    setThreshold: jest.fn().mockResolvedValue({ variantId: VARIANT, lowStockThreshold: 25 }),
  };
  return {
    controller: new InventoryController(inventory as unknown as InventoryService),
    inventory,
  };
}

const dto = (overrides: Partial<AdjustStockDto> = {}): AdjustStockDto => ({
  delta: -5,
  reason: 'Damaged in transit',
  ...overrides,
});

describe('InventoryController', () => {
  /**
   * The only admin-only route in the service, and the first thing to pin about it is that the
   * decorator is actually on it.
   *
   * `RolesGuard` is registered globally in `app.module.ts` and returns `true` early for a route
   * with no `@Roles()` — so a controller that lost the decorator is not refused, it is quietly
   * opened to every authenticated customer. Nothing about the handler's behaviour changes, no test
   * of its arguments or its response fails, and `roles.guard.ts` has no spec of its own to notice.
   * This reads the metadata the guard reads.
   */
  it('is restricted to admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, InventoryController)).toEqual([UserRole.ADMIN]);
  });

  it('passes the variant from the path and the adjustment from the body', async () => {
    const { controller, inventory } = harness();

    await controller.adjust(VARIANT, ADMIN, dto({ delta: 12, reason: 'Restocked from the mill' }));

    expect(inventory.adjust).toHaveBeenCalledWith({
      variantId: VARIANT,
      delta: 12,
      reason: 'Restocked from the mill',
      actorUserId: ADMIN.id,
    });
  });

  /**
   * The actor is read from the token and never from the request, which is spec §13's IDOR defence
   * applied at the point of use — an audit trail whose "who" a caller can choose is not one.
   *
   * `whitelist: true` strips an unknown body property before a handler ever sees it, so this is the
   * second line rather than the first. It is worth pinning anyway because it is pinned by nothing
   * else and it is invisible: the defence here is that `actorUserId` is spelled *after* the `...dto`
   * spread, and reordering the two object keys is a one-token change that no assertion about the
   * handler's response would notice.
   */
  it('takes the actor from the token even if the body carries one', async () => {
    const { controller, inventory } = harness();
    const forged = { ...dto(), actorUserId: 'someone-else' } as AdjustStockDto;

    await controller.adjust(VARIANT, ADMIN, forged);

    expect(inventory.adjust).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ADMIN.id }),
    );
  });

  it('returns the new balance', async () => {
    const { controller } = harness();

    await expect(controller.adjust(VARIANT, ADMIN, dto())).resolves.toEqual({
      onHand: 115,
      balanceAfter: 115,
    });
  });

  describe('the stock reads', () => {
    it('passes the query straight through to the list', async () => {
      const { controller, inventory } = harness();

      await controller.list({ status: 'low', page: 2 });

      expect(inventory.list).toHaveBeenCalledWith({ status: 'low', page: 2 });
    });

    it('passes the variant and the page to the ledger read', async () => {
      const { controller, inventory } = harness();

      await controller.transactions(VARIANT, { page: 3, limit: 10 });

      expect(inventory.transactions).toHaveBeenCalledWith(VARIANT, { page: 3, limit: 10 });
    });
  });

  describe('the threshold change', () => {
    const threshold = (overrides: Partial<UpdateThresholdDto> = {}): UpdateThresholdDto => ({
      lowStockThreshold: 25,
      ...overrides,
    });

    it('passes the variant from the path and the threshold from the body', async () => {
      const { controller, inventory } = harness();

      await controller.setThreshold(VARIANT, ADMIN, threshold());

      expect(inventory.setThreshold).toHaveBeenCalledWith(VARIANT, {
        lowStockThreshold: 25,
        actorUserId: ADMIN.id,
      });
    });

    /**
     * The same one-token defence as `adjust`, and it needs its own case: `actorUserId` is spelled
     * after the `...dto` spread, and reordering the two keys would let a body choose who the audit
     * row blames. `whitelist: true` strips an unknown property first, so this is the second line
     * rather than the only one — but it is the line that is a property of this code.
     */
    it('takes the actor from the token even if the body carries one', async () => {
      const { controller, inventory } = harness();
      const forged = { ...threshold(), actorUserId: 'someone-else' } as UpdateThresholdDto;

      await controller.setThreshold(VARIANT, ADMIN, forged);

      expect(inventory.setThreshold).toHaveBeenCalledWith(
        VARIANT,
        expect.objectContaining({ actorUserId: ADMIN.id }),
      );
    });
  });
});
