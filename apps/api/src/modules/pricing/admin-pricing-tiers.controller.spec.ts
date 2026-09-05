import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppModule, VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminPricingTiersController } from './admin-pricing-tiers.controller';
import type { AdminPricingTiersService } from './admin-pricing-tiers.service';
import { AdminPricingTierQueryDto } from './dto/admin-pricing-tier-query.dto';
import { CreatePricingTierDto, UpdatePricingTierDto } from './dto/save-pricing-tier.dto';
import { PricingModule } from './pricing.module';

const PRODUCT_ID = 'c1000000-0000-4000-8000-000000000001';
const TIER_ID = 'p1000000-0000-4000-8000-000000000001';
const ADMIN: AuthenticatedUser = {
  id: 'f0000000-0000-4000-8000-00000000000c',
  role: UserRole.ADMIN,
  sessionId: 'session-1',
};

function harness() {
  const tiers = {
    list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 24 }),
    create: jest.fn().mockResolvedValue({ id: TIER_ID }),
    update: jest.fn().mockResolvedValue({ id: TIER_ID }),
  };
  return {
    controller: new AdminPricingTiersController(tiers as unknown as AdminPricingTiersService),
    tiers,
  };
}

/** The production pipe, imported rather than rebuilt — see `admin-orders.controller.spec.ts`. */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validateQuery = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'query', metatype: AdminPricingTierQueryDto }));
const validateCreate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: CreatePricingTierDto }));
const validateUpdate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: UpdatePricingTierDto }));

function declaredRoutes(): { name: string; method: string; path: string }[] {
  const prototype: object = AdminPricingTiersController.prototype;
  const routes: { name: string; method: string; path: string }[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path !== 'string') continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    routes.push({ name, method: RequestMethod[verb], path });
  }

  return routes;
}

describe('AdminPricingTiersController', () => {
  it('is restricted to admins at class level, carrying the database enum', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminPricingTiersController)).toEqual([UserRole.ADMIN]);
  });

  /** §6.4 lists three verbs for this resource and no `DELETE` — see the service's docblock for why
   * inventing one would be the wrong call as well as an unlisted route. */
  it('declares exactly §6.4’s three verbs', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminPricingTiersController)).toBe(
      'admin/pricing-tiers',
    );
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'create', method: 'POST', path: '/' },
      { name: 'update', method: 'PATCH', path: ':id' },
    ]);
  });

  /**
   * **Registered in `AppModule`, or all three routes 404** with typecheck, lint and every other
   * test in this file green — `rfqs.module.spec.ts` measured that failure mode directly, and this
   * module is brand new, which is exactly when the import line is forgotten.
   */
  it('is registered in AppModule, without which all three routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    expect(imported).toContain(PricingModule);
  });

  it('takes the actor from the token even if the body carries one', async () => {
    const { controller, tiers } = harness();
    const forged = {
      productId: PRODUCT_ID,
      minKg: 10,
      maxKg: 24,
      pricePerKg: 620,
      actorUserId: 'someone-else',
    } as CreatePricingTierDto;

    await controller.create(ADMIN, forged);
    await controller.update(TIER_ID, ADMIN, { pricePerKg: 590 });

    expect(tiers.create).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: ADMIN.id }));
    expect(tiers.update).toHaveBeenCalledWith(
      TIER_ID,
      expect.objectContaining({ actorUserId: ADMIN.id }),
    );
  });
});

describe('CreatePricingTierDto', () => {
  const VALID = { productId: PRODUCT_ID, minKg: 10, maxKg: 24, pricePerKg: 620 };

  it('accepts a rung with every field', async () => {
    await expect(validateCreate({ ...VALID, segment: 'retailer' })).resolves.toEqual({
      ...VALID,
      segment: 'retailer',
    });
  });

  /**
   * `null` has to survive on both, or brief §16's open-ended "50kg+" slab and brief §47's
   * quote-required slab cannot be expressed. `@IsOptional()` alone treats `null` as absent, which
   * would accept it *and* discard it.
   */
  it('carries an explicit null through for the open-ended and quote-required slabs', async () => {
    await expect(
      validateCreate({ ...VALID, maxKg: null, pricePerKg: null }),
    ).resolves.toMatchObject({ maxKg: null, pricePerKg: null });
  });

  it('requires the three fields that have no sensible default', async () => {
    await expect(validateCreate({ minKg: 10, maxKg: 24, pricePerKg: 620 })).rejects.toThrow();
    await expect(
      validateCreate({ productId: PRODUCT_ID, maxKg: 24, pricePerKg: 620 }),
    ).rejects.toThrow();
  });

  it('refuses sub-paise prices, negatives and absurd values', async () => {
    await expect(validateCreate({ ...VALID, pricePerKg: 620.005 })).rejects.toThrow();
    await expect(validateCreate({ ...VALID, pricePerKg: -1 })).rejects.toThrow();
    await expect(validateCreate({ ...VALID, minKg: -1 })).rejects.toThrow();
    await expect(validateCreate({ ...VALID, maxKg: 10_001 })).rejects.toThrow();
  });

  /** `products.moqKg` is a product field, already editable through `PATCH /admin/products/:id`. A
   * second writer would be a second answer to "what is the minimum for this product". */
  it('refuses an moqKg field, which belongs to the product', async () => {
    await expect(validateCreate({ ...VALID, moqKg: 5 })).rejects.toThrow();
  });

  it('refuses a band outside the shared vocabulary', async () => {
    await expect(validateCreate({ ...VALID, segment: 'wholesale' })).rejects.toThrow();
  });
});

describe('UpdatePricingTierDto', () => {
  it('accepts a body that names nothing — an omitted field is left unchanged', async () => {
    await expect(validateUpdate({})).resolves.toEqual({});
  });

  it('inherits the create validators rather than restating them', async () => {
    await expect(validateUpdate({ pricePerKg: 620.005 })).rejects.toThrow();
    await expect(validateUpdate({ productId: 'not-a-uuid' })).rejects.toThrow();
  });
});

describe('AdminPricingTierQueryDto', () => {
  it('accepts an empty query', async () => {
    await expect(validateQuery({})).resolves.toEqual({});
  });

  /** A query string has no null: `businessId=` is an empty string and `businessId=null` is four
   * characters, so "the rungs that belong to nobody" needs a sentinel to be askable at all. */
  it("accepts the 'none' sentinel and a real uuid, and refuses anything else", async () => {
    await expect(validateQuery({ businessId: 'none' })).resolves.toEqual({ businessId: 'none' });
    await expect(validateQuery({ businessId: PRODUCT_ID })).resolves.toEqual({
      businessId: PRODUCT_ID,
    });
    await expect(validateQuery({ businessId: 'null' })).rejects.toThrow();
  });

  it('refuses an undeclared filter rather than ignoring it', async () => {
    await expect(validateQuery({ minKg: '10' })).rejects.toThrow();
  });
});
