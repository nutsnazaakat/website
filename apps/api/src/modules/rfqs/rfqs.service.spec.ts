import { toPaise } from '@nutwala/shared';
import type { DataSource } from 'typeorm';
import { RfqKind } from '../../entities/enums';
import type { Rfq } from '../../entities/b2b/rfq.entity';
import { RfqsService, type CreateRfqInput } from './rfqs.service';

/**
 * `RfqReadService` and `CartPricingService`'s counterpart for this file: `manager.getRepository`
 * is doubled per entity name rather than the whole `DataSource`, because `create` reaches two
 * repositories (`Rfq`, `Product`) through one transaction manager, and `checkout.service.spec.ts`
 * already establishes the pattern for exactly that shape.
 *
 * `rfqRepository.save` deliberately answers **without** `items`/`gifting` — real TypeORM does not
 * reload a cascaded relation after an insert, and a double that quietly gave them back would let
 * every test in this file pass whether or not `create` performs its own re-read.
 * `rfqRepository.findOne` is the *only* place relations are ever present, matching that re-read.
 */
function harness(
  options: {
    nextval?: string;
    products?: { id: string; slug: string }[];
    reloadedItems?: unknown[];
  } = {},
) {
  const recorded = {
    saved: [] as Record<string, unknown>[],
    findOneArgs: [] as unknown[],
    productFindWhere: [] as unknown[],
    queued: [] as unknown[],
  };

  const rfqRepository = {
    save: (draft: Record<string, unknown>) => {
      recorded.saved.push(draft);
      /**
       * The draft back with an id, **except `items`** — and both halves are deliberate.
       *
       * The rest of the draft is answered because TypeORM's `save` answers the merged entity, and
       * `create` now reads `businessName`, `email` and `kind` off it for the `rfq.received`
       * payload; a fake answering only `{ id, rfqNumber }` would leave all three `undefined` and
       * the notification test below asserting against nothing.
       *
       * `items` stays absent for the reason the re-read test further down states: it is what makes
       * a `create` that returned `saved` directly fail instead of pass.
       */
      return Promise.resolve({ ...draft, items: undefined, id: 'rfq-uuid-1' } as unknown as Rfq);
    },
    findOne: (args: { where: unknown; relations: unknown }) => {
      recorded.findOneArgs.push(args);
      const saved = recorded.saved[0];
      return Promise.resolve({
        id: 'rfq-uuid-1',
        rfqNumber: saved?.rfqNumber,
        ...saved,
        items: options.reloadedItems ?? saved?.items ?? [],
      } as unknown as Rfq);
    },
  };

  const productRepository = {
    find: ({ where }: { where: unknown }) => {
      recorded.productFindWhere.push(where);
      return Promise.resolve(options.products ?? []);
    },
  };

  const manager = {
    getRepository: (entity: { name: string }) =>
      entity.name === 'Rfq' ? rfqRepository : productRepository,
    query: () => Promise.resolve([{ nextval: options.nextval ?? '100000' }]),
  };

  const dataSource = {
    transaction: <T>(run: (manager: unknown) => Promise<T>) => run(manager),
  } as unknown as DataSource;

  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new RfqsService(dataSource, notifications as never),
    recorded,
    rfqRepository,
  };
}

const BULK_INPUT: CreateRfqInput = {
  kind: RfqKind.BULK,
  businessName: 'Crumb & Co Bakery',
  contactPerson: 'Priya Menon',
  mobile: '9820098200',
  email: 'priya@crumbandco.example',
  businessType: 'Bakery',
  pincode: '400050',
  packaging: 'Vacuum packs (5 kg)',
  frequency: 'Fortnightly',
  lines: [
    { productSlug: 'premium-california-almonds', kg: 60 },
    { productSlug: 'w320-cashews', kg: 25 },
  ],
};

const GIFTING_INPUT: CreateRfqInput = {
  kind: RfqKind.GIFTING,
  businessName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  email: 'purchase@anandsweets.example',
  businessType: 'Corporate gifting',
  pincode: '560004',
  gifting: {
    occasion: 'Diwali',
    giftBoxSlug: 'festive-gift-box',
    boxes: 50,
    budgetPerBox: 1500,
    brandingRequired: true,
    deliveryDate: '2026-10-15',
    message: 'Logo on the lid, please.',
  },
};

describe('RfqsService.create', () => {
  it('stores its number, kind BULK, status new, and one item per line', async () => {
    const { service, recorded } = harness();
    await service.create(BULK_INPUT, null);

    const saved = recorded.saved[0];
    // The year comes from the real clock, not a fixture, so only the sequence-derived suffix is
    // pinned — `rfq-number.spec.ts` already proves `formatRfqNumber`'s own shape in isolation.
    expect(saved?.rfqNumber).toMatch(/^RFQ-\d{4}-100000$/);
    expect(saved?.kind).toBe(RfqKind.BULK);
    expect(saved?.status).toBe('new');
    expect(saved?.items).toEqual([
      { productSlug: 'premium-california-almonds', productId: null, kg: '60' },
      { productSlug: 'w320-cashews', productId: null, kg: '25' },
    ]);
  });

  it('stores kind GIFTING, its detail row, and null packaging/frequency', async () => {
    const { service, recorded } = harness();
    await service.create(GIFTING_INPUT, null);

    const saved = recorded.saved[0];
    expect(saved?.kind).toBe(RfqKind.GIFTING);
    expect(saved?.packaging).toBeNull();
    expect(saved?.frequency).toBeNull();
    expect(saved?.gifting).toMatchObject({
      occasion: 'Diwali',
      giftBoxSlug: 'festive-gift-box',
      boxes: 50,
      brandingRequired: true,
      deliveryDate: '2026-10-15',
    });
  });

  it('resolves a known slug to its productId', async () => {
    const { service, recorded } = harness({
      products: [{ id: 'prod-almonds', slug: 'premium-california-almonds' }],
    });
    await service.create(BULK_INPUT, null);

    const items = recorded.saved[0]?.items as { productSlug: string; productId: string | null }[];
    expect(items.find((item) => item.productSlug === 'premium-california-almonds')?.productId).toBe(
      'prod-almonds',
    );
  });

  /**
   * Refusing is the tempting alternative and it is wrong here: a prospect naming a product they
   * saw in a brochure is a sales lead, and a 422 on the public RFQ form turns it away.
   */
  it('stores an unknown slug with a null productId, and does not throw', async () => {
    const { service, recorded } = harness({ products: [] });
    await expect(service.create(BULK_INPUT, null)).resolves.toBeDefined();

    const items = recorded.saved[0]?.items as { productSlug: string; productId: string | null }[];
    expect(items.every((item) => item.productId === null)).toBe(true);
  });

  it('queues rfq.received with the business name, email and kind', async () => {
    const { service, recorded } = harness();

    await service.create(BULK_INPUT, 'user-1');

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'rfq.received',
        payload: {
          rfqNumber: recorded.saved[0]?.rfqNumber,
          businessName: 'Crumb & Co Bakery',
          email: 'priya@crumbandco.example',
          kind: RfqKind.BULK,
        },
      }),
    ]);
  });

  /**
   * The `userId` on the notification is the caller's, not the RFQ's owner in some other sense —
   * and for a prospect there is no caller, so it is null. `NotificationsService` takes
   * `string | null` for exactly this reason: an enquiry from the public form has nobody to
   * attribute the row to, and inventing one would be worse than admitting it.
   */
  it('attributes the notification to nobody for an anonymous prospect', async () => {
    const { service, recorded } = harness();

    await service.create(GIFTING_INPUT, null);

    expect(recorded.queued).toEqual([expect.objectContaining({ userId: null })]);
  });

  it("stores a signed-in caller's userId, and null for a prospect", async () => {
    const { service, recorded } = harness();
    await service.create(BULK_INPUT, 'user-1');
    expect(recorded.saved[0]?.userId).toBe('user-1');

    const { service: anonService, recorded: anonRecorded } = harness();
    await anonService.create(BULK_INPUT, null);
    expect(anonRecorded.saved[0]?.userId).toBeNull();
  });

  it("stores budgetPerBoxPaise as paise off the wire's rupees", async () => {
    const { service, recorded } = harness();
    await service.create(GIFTING_INPUT, null);

    const gifting = recorded.saved[0]?.gifting as { budgetPerBoxPaise: bigint };
    expect(gifting.budgetPerBoxPaise).toBe(toPaise(1500));
    expect(gifting.budgetPerBoxPaise).toBe(150000n);
  });

  /**
   * The property `RfqsService.create`'s own docblock exists to guarantee: the returned `Rfq` is
   * the **re-read**, not `save()`'s own return value — the double's `save` deliberately answers
   * without `items`, so a `create` that skipped the re-read and returned `saved` directly would
   * hand back an `Rfq` with `items` absent, which is exactly the shape that made
   * `CheckoutService.place` ship an order whose `events` were silently `undefined`.
   */
  it('returns the re-read RFQ, with its items present, not the bare save() result', async () => {
    const { service } = harness({ reloadedItems: [{ productSlug: 'w320-cashews', kg: '25.00' }] });
    const result = await service.create(BULK_INPUT, null);

    expect(result.items).toEqual([{ productSlug: 'w320-cashews', kg: '25.00' }]);
  });

  it('asks for both items and gifting on the re-read, in the same relations clause', async () => {
    const { service, recorded } = harness();
    await service.create(BULK_INPUT, null);

    expect(recorded.findOneArgs[0]).toMatchObject({
      relations: { items: true, gifting: true },
    });
  });
});

/**
 * `list`/`findOne` read through `this.dataSource.getRepository(Rfq)` directly, not through a
 * transaction — there is nothing to write — so this doubles `DataSource.getRepository` itself
 * rather than `harness()`'s transaction-scoped manager above.
 */
function readHarness(options: { rows?: Rfq[]; foundOne?: Rfq | null } = {}) {
  const recorded = {
    findArgs: [] as unknown[],
    findOneArgs: [] as unknown[],
  };

  const rfqRepository = {
    find: (args: unknown) => {
      recorded.findArgs.push(args);
      return Promise.resolve(options.rows ?? []);
    },
    findOne: (args: unknown) => {
      recorded.findOneArgs.push(args);
      return Promise.resolve(options.foundOne ?? null);
    },
  };

  const dataSource = {
    getRepository: (entity: { name: string }) => {
      if (entity.name !== 'Rfq') {
        throw new Error(`readHarness: unexpected repository requested for "${entity.name}"`);
      }
      return rfqRepository;
    },
  } as unknown as DataSource;

  // `list`/`findOne` never queue anything; the constructor's second argument is satisfied and
  // nothing in this block can observe it.
  return {
    service: new RfqsService(dataSource, { queue: () => Promise.resolve() } as never),
    recorded,
  };
}

describe('RfqsService.list', () => {
  it("scopes to the caller's own userId, newest first", async () => {
    const { service, recorded } = readHarness();
    await service.list('user-1');

    expect(recorded.findArgs[0]).toEqual({
      where: { userId: 'user-1' },
      order: { createdAt: 'DESC' },
    });
  });
});

describe('RfqsService.findOne', () => {
  /**
   * The owner is a clause in the query, never a check applied to a row already fetched — asserted
   * on the query's own shape, which is what the mutation table's "owner check moved after the
   * read" and "userId dropped from the where" rows both need: either mutation changes this exact
   * object, so a looser assertion (only checking the return value) could pass with `userId`
   * silently missing from the criteria.
   *
   * `notesList` is asserted **absent**, not merely `items`/`gifting` asserted present — brief §34's
   * own words for that relation are "never exposed on a customer-facing endpoint," and a query
   * that loaded it would still let a mapper bug leak it, one guard closer to the wire than
   * `rfq.mapper.spec.ts`'s own check.
   */
  it('queries by userId and rfqNumber together, loading items and gifting but never notesList', async () => {
    const { service, recorded } = readHarness();
    await service.findOne('user-1', 'RFQ-2026-100000');

    expect(recorded.findOneArgs[0]).toEqual({
      where: { userId: 'user-1', rfqNumber: 'RFQ-2026-100000' },
      relations: { items: true, gifting: true },
    });
  });

  it('answers null for a stranger’s RFQ number, indistinguishably from one that does not exist', async () => {
    const { service } = readHarness({ foundOne: null });
    await expect(service.findOne('user-1', 'RFQ-2026-999999')).resolves.toBeNull();
  });
});
