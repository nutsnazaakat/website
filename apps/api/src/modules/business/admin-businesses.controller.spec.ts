import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { AdminBusinessesController } from './admin-businesses.controller';
import type { AdminBusinessesService } from './admin-businesses.service';
import { BusinessesController } from './businesses.controller';
import { AdminBusinessQueryDto } from './dto/admin-business-query.dto';

const BUSINESS_ID = 'b0000000-0000-4000-8000-00000000000b';
const PAGE = { items: [], total: 0, page: 1, limit: 24 };

function harness() {
  const businesses = {
    list: jest.fn().mockResolvedValue(PAGE),
    get: jest.fn().mockResolvedValue({ id: BUSINESS_ID }),
  };
  return {
    controller: new AdminBusinessesController(businesses as unknown as AdminBusinessesService),
    businesses,
  };
}

/** The production pipe, imported rather than rebuilt — see `admin-orders.controller.spec.ts`. */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'query', metatype: AdminBusinessQueryDto }));

function declaredRoutes(): { name: string; method: string; path: string }[] {
  const prototype: object = AdminBusinessesController.prototype;
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

describe('AdminBusinessesController', () => {
  it('is restricted to admins at class level, carrying the database enum', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminBusinessesController)).toEqual([UserRole.ADMIN]);
  });

  /**
   * The two classes exist so that one role's routes cannot inherit the other's. `RolesGuard`
   * resolves handler metadata *over* class metadata, so a handler that lost its own decorator on a
   * merged class would inherit whichever role the class carried — and in one direction that hands a
   * customer the whole customer base.
   */
  it('leaves the customer-facing business controller at @Roles(BUSINESS)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, BusinessesController)).toEqual([UserRole.BUSINESS]);
    expect(Reflect.getMetadata(PATH_METADATA, BusinessesController)).toBe('business');
    expect(Reflect.getMetadata(PATH_METADATA, AdminBusinessesController)).toBe('admin/businesses');
  });

  it('declares the list above the detail, so the pattern cannot swallow a literal', () => {
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'get', method: 'GET', path: ':id' },
    ]);
  });

  it('hands the query and the uuid through to the service', async () => {
    const { controller, businesses } = harness();
    await controller.list({ q: 'sweet', segment: 'horeca' });
    await controller.get(BUSINESS_ID);
    expect(businesses.list).toHaveBeenCalledWith({ q: 'sweet', segment: 'horeca' });
    expect(businesses.get).toHaveBeenCalledWith(BUSINESS_ID);
  });
});

describe('AdminBusinessQueryDto', () => {
  it('accepts an empty query', async () => {
    await expect(validate({})).resolves.toEqual({});
  });

  it('accepts every band in the shared vocabulary', async () => {
    for (const segment of ['default', 'retailer', 'distributor', 'horeca']) {
      await expect(validate({ segment })).resolves.toEqual({ segment });
    }
  });

  /** The wire vocabulary is lowercase; the Postgres enum's spelling is not a legal query value. */
  it('refuses the column’s uppercase spelling', async () => {
    await expect(validate({ segment: 'HORECA' })).rejects.toThrow();
  });

  it('refuses an undeclared filter rather than ignoring it', async () => {
    await expect(validate({ assignedSalespersonId: 'someone' })).rejects.toThrow();
  });

  it('coerces the page window from strings and refuses a size above the cap', async () => {
    await expect(validate({ page: '3', limit: '10' })).resolves.toEqual({ page: 3, limit: 10 });
    await expect(validate({ limit: '61' })).rejects.toThrow();
  });
});
