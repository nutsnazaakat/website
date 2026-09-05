import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { RfqKind } from '../../entities/enums';
import type { CreateGiftingRfqDto } from './dto/create-gifting-rfq.dto';
import type { CreateRfqDto } from './dto/create-rfq.dto';
import { RfqsController } from './rfqs.controller';
import type { RfqsService } from './rfqs.service';

interface DeclaredRoute {
  name: string;
  httpMethod: RequestMethod;
  path: string;
  handler: (...args: never[]) => unknown;
}

/**
 * The controller's routes, in the order the class declares them — `catalog.controller.spec.ts`'s
 * own helper, extended with the HTTP method: this controller has two routes at the same path
 * (`POST /` and `GET /`), so `path` alone no longer names one handler.
 *
 * `@Post()`/`@Get()` with no argument both register at `'/'`, not `''` — verified against
 * `@nestjs/common`'s own `RequestMapping`, whose `defaultMetadata` sets exactly that.
 */
function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = RfqsController.prototype;
  const routes: DeclaredRoute[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    const httpMethod: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof path === 'string' && typeof httpMethod === 'number') {
      routes.push({ name, httpMethod, path, handler: handler as (...args: never[]) => unknown });
    }
  }

  return routes;
}

describe('RfqsController routing', () => {
  it('exposes exactly the four enquiry routes', () => {
    expect(declaredRoutes().map((route) => [RequestMethod[route.httpMethod], route.path])).toEqual([
      ['POST', '/'],
      ['POST', 'gifting'],
      ['GET', '/'],
      ['GET', ':rfqNumber'],
    ]);
  });

  /**
   * The two writes are `@Public()` — a prospect has no session to raise an enquiry with — and the
   * two reads are not: `JwtAuthGuard` is global, so a read route without `@Public()` 401s an
   * anonymous caller, which is exactly what "there is no such thing as a prospect's RFQ list"
   * requires. Asserted per route, not as a blanket count, so a route added to the wrong half of
   * this file fails by name.
   */
  it('marks only the two create routes public, and neither read route', () => {
    const publicByName = new Map(
      declaredRoutes().map((route) => [
        route.name,
        Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) === true,
      ]),
    );
    expect(publicByName).toEqual(
      new Map([
        ['create', true],
        ['createGifting', true],
        ['list', false],
        ['findOne', false],
      ]),
    );
  });
});

const BUSINESS_USER: AuthenticatedUser = { id: 'user-1', role: 'BUSINESS', sessionId: 'session-1' };

const BULK_DTO: CreateRfqDto = {
  businessName: 'Crumb & Co Bakery',
  contactPerson: 'Priya Menon',
  mobile: '9820098200',
  email: 'priya@crumbandco.example',
  businessType: 'Bakery',
  pincode: '400050',
  lines: [{ productSlug: 'premium-california-almonds', kg: 60 }],
  packaging: 'Vacuum packs (5 kg)',
  frequency: 'Fortnightly',
};

const GIFTING_DTO: CreateGiftingRfqDto = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  email: 'purchase@anandsweets.example',
  businessType: 'Corporate gifting',
  pincode: '560004',
  occasion: 'Diwali',
  giftBoxSlug: 'festive-gift-box',
  boxes: 50,
  budgetPerBox: 1500,
  brandingRequired: true,
  deliveryDate: '2026-10-15',
};

/** A stubbed re-read, just complete enough for `toRfqDetail` to map without throwing. */
function rfqFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rfq-uuid-1',
    rfqNumber: 'RFQ-2026-100000',
    kind: RfqKind.BULK,
    businessName: 'Crumb & Co Bakery',
    contactPerson: 'Priya Menon',
    mobile: '9820098200',
    email: 'priya@crumbandco.example',
    gstin: null,
    businessType: 'Bakery',
    pincode: '400050',
    packaging: 'Vacuum packs (5 kg)',
    frequency: 'Fortnightly',
    notes: null,
    status: 'new',
    createdAt: new Date('2026-08-11T06:20:00.000Z'),
    items: [],
    gifting: null,
    ...overrides,
  } as never;
}

describe('RfqsController.create', () => {
  it('resolves a prospect to a null userId', async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture());
    const controller = new RfqsController({ create } as unknown as RfqsService);

    await controller.create(BULK_DTO, undefined);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: RfqKind.BULK }), null);
  });

  it("attributes a signed-in business's enquiry to their own id", async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture());
    const controller = new RfqsController({ create } as unknown as RfqsService);

    await controller.create(BULK_DTO, BUSINESS_USER);

    expect(create).toHaveBeenCalledWith(expect.anything(), BUSINESS_USER.id);
  });

  it('maps every DTO field through to CreateRfqInput, unchanged', async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture());
    const controller = new RfqsController({ create } as unknown as RfqsService);

    await controller.create(
      { ...BULK_DTO, gstin: '29ABCDE1234F1Z5', notes: 'Rush order' },
      undefined,
    );

    expect(create).toHaveBeenCalledWith(
      {
        kind: RfqKind.BULK,
        businessName: BULK_DTO.businessName,
        contactPerson: BULK_DTO.contactPerson,
        mobile: BULK_DTO.mobile,
        email: BULK_DTO.email,
        gstin: '29ABCDE1234F1Z5',
        businessType: BULK_DTO.businessType,
        pincode: BULK_DTO.pincode,
        lines: BULK_DTO.lines,
        packaging: BULK_DTO.packaging,
        frequency: BULK_DTO.frequency,
        notes: 'Rush order',
      },
      null,
    );
  });

  it("returns the RFQ number prominently — 'id' on the mapped response", async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture({ rfqNumber: 'RFQ-2026-100042' }));
    const controller = new RfqsController({ create } as unknown as RfqsService);

    const response = await controller.create(BULK_DTO, undefined);

    expect(response.id).toBe('RFQ-2026-100042');
  });
});

describe('RfqsController.createGifting', () => {
  it("maps the form's companyName onto businessName, and nests the gifting block", async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture({ kind: RfqKind.GIFTING }));
    const controller = new RfqsController({ create } as unknown as RfqsService);

    await controller.createGifting(GIFTING_DTO, undefined);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: RfqKind.GIFTING,
        businessName: GIFTING_DTO.companyName,
        gifting: {
          occasion: GIFTING_DTO.occasion,
          giftBoxSlug: GIFTING_DTO.giftBoxSlug,
          boxes: GIFTING_DTO.boxes,
          budgetPerBox: GIFTING_DTO.budgetPerBox,
          brandingRequired: GIFTING_DTO.brandingRequired,
          deliveryDate: GIFTING_DTO.deliveryDate,
          message: undefined,
        },
      }),
      null,
    );
  });

  it("attributes a signed-in caller's gifting enquiry to their own id", async () => {
    const create = jest.fn().mockResolvedValue(rfqFixture({ kind: RfqKind.GIFTING }));
    const controller = new RfqsController({ create } as unknown as RfqsService);

    await controller.createGifting(GIFTING_DTO, BUSINESS_USER);

    expect(create).toHaveBeenCalledWith(expect.anything(), BUSINESS_USER.id);
  });
});

describe('RfqsController.list', () => {
  it("asks the service for the caller's own userId, and maps every row to a summary", async () => {
    const list = jest.fn().mockResolvedValue([rfqFixture(), rfqFixture({ kind: RfqKind.GIFTING })]);
    const controller = new RfqsController({ list } as unknown as RfqsService);

    const result = await controller.list(BUSINESS_USER);

    expect(list).toHaveBeenCalledWith(BUSINESS_USER.id);
    expect(result).toEqual([
      expect.objectContaining({ id: 'RFQ-2026-100000', kind: 'bulk' }),
      expect.objectContaining({ id: 'RFQ-2026-100000', kind: 'gifting' }),
    ]);
  });
});

describe('RfqsController.findOne', () => {
  it("asks the service for the caller's own userId together with the rfqNumber", async () => {
    const findOneSpy = jest.fn().mockResolvedValue(rfqFixture());
    const controller = new RfqsController({ findOne: findOneSpy } as unknown as RfqsService);

    await controller.findOne(BUSINESS_USER, 'RFQ-2026-100000');

    expect(findOneSpy).toHaveBeenCalledWith(BUSINESS_USER.id, 'RFQ-2026-100000');
  });

  /**
   * The one 404 both misses share — the mutation table's "404 → 403" and "the indistinguishability
   * case". `RfqsService.findOne` cannot tell "not yours" from "does not exist" apart, so there is
   * only one body this controller can ever produce from a `null`, and this pins it rather than
   * leaving it to whatever `DomainError`'s own default status happens to be.
   */
  it('answers a 404 naming NOT_FOUND when the service reports a miss, never a 403', async () => {
    const findOneSpy = jest.fn().mockResolvedValue(null);
    const controller = new RfqsController({ findOne: findOneSpy } as unknown as RfqsService);

    const failure: unknown = await controller
      .findOne(BUSINESS_USER, 'RFQ-2026-999999')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'NOT_FOUND',
      details: { rfqNumber: 'RFQ-2026-999999' },
    });
    expect((failure as { getStatus(): number }).getStatus()).toBe(404);
  });

  it('maps a found RFQ through toRfqDetail, lines and all', async () => {
    const findOneSpy = jest
      .fn()
      .mockResolvedValue(rfqFixture({ items: [{ productSlug: 'w320-cashews', kg: '25.00' }] }));
    const controller = new RfqsController({ findOne: findOneSpy } as unknown as RfqsService);

    const result = await controller.findOne(BUSINESS_USER, 'RFQ-2026-100000');

    expect(result.lines).toEqual([{ productSlug: 'w320-cashews', kg: 25 }]);
  });
});
