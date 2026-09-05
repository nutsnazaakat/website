import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { AdminCustomersController } from './admin-customers.controller';
import type { AdminCustomersService } from './admin-customers.service';
import { AdminCustomerQueryDto } from './dto/admin-customer-query.dto';

const CUSTOMER_ID = 'f0000000-0000-4000-8000-00000000000a';
const PAGE = { items: [], total: 0, page: 1, limit: 24 };

function harness() {
  const customers = {
    list: jest.fn().mockResolvedValue(PAGE),
    get: jest.fn().mockResolvedValue({ id: CUSTOMER_ID }),
  };
  return {
    controller: new AdminCustomersController(customers as unknown as AdminCustomersService),
    customers,
  };
}

/**
 * The production pipe, imported rather than rebuilt — a locally-configured `new ValidationPipe({})`
 * would assert these decorators against *this file's* options, so a `forbidNonWhitelisted` dropped
 * in `app.module.ts` would leave every case below green while the server accepted what they claim
 * it refuses. `save-product.dto.spec.ts` records the same reasoning.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'query', metatype: AdminCustomerQueryDto }));

/** The routing table Nest built, in declaration order — which is matching order. See
 * `admin-orders.controller.spec.ts` for why the table is read rather than one route named. */
function declaredRoutes(): { name: string; method: string; path: string }[] {
  const prototype: object = AdminCustomersController.prototype;
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

describe('AdminCustomersController', () => {
  /**
   * `RolesGuard` is global and returns `true` early for a route carrying no `@Roles()`, so a
   * controller that loses the decorator is not refused — it is silently opened to every
   * authenticated customer. The **enum**, not the string: the token carries `ADMIN` while an auth
   * response body carries `admin`, so `@Roles('admin')` compiles and refuses every admin.
   */
  it('is restricted to admins at class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminCustomersController)).toEqual([UserRole.ADMIN]);
  });

  it('declares the list above the detail, so the pattern cannot swallow a literal', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminCustomersController)).toBe('admin/customers');
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'get', method: 'GET', path: ':id' },
    ]);
  });

  it('hands the query through to the service', async () => {
    const { controller, customers } = harness();
    await controller.list({ q: 'asha', role: 'b2b', page: 2 });
    expect(customers.list).toHaveBeenCalledWith({ q: 'asha', role: 'b2b', page: 2 });
  });

  it('hands the uuid through to the service', async () => {
    const { controller, customers } = harness();
    await controller.get(CUSTOMER_ID);
    expect(customers.get).toHaveBeenCalledWith(CUSTOMER_ID);
  });
});

describe('AdminCustomerQueryDto', () => {
  it('accepts an empty query — every filter is optional', async () => {
    await expect(validate({})).resolves.toEqual({});
  });

  it('coerces the page window from strings, since nothing else converts a query parameter', async () => {
    await expect(validate({ page: '2', limit: '10' })).resolves.toEqual({ page: 2, limit: 10 });
  });

  /**
   * `admin` is a `Role` but not a customer role. Allowing it would make this endpoint a way to
   * enumerate the operator accounts and would answer a page whose `total` disagrees with
   * `GET /admin/dashboard`'s `customers` card.
   */
  it('refuses ?role=admin', async () => {
    await expect(validate({ role: 'admin' })).rejects.toThrow();
  });

  it('refuses an undeclared filter rather than ignoring it', async () => {
    await expect(validate({ segment: 'retailer' })).rejects.toThrow();
  });

  it('refuses a page size above the cap', async () => {
    await expect(validate({ limit: '500' })).rejects.toThrow();
  });
});
