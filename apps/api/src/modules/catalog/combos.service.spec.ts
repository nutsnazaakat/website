import type { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { CombosService } from './combos.service';

/**
 * A box product: the thing a customer actually buys. Its 1kg retail pack is the combo price.
 *
 * `channel` is a parameter rather than a constant because "the 1kg pack" is not enough to identify
 * it — a bulk pack of the same weight would price a gift card off a wholesale rate.
 */
const box = (slug: string, price: number, mrp: number, channel = 'retail') => ({
  slug,
  name: `Box ${slug}`,
  subtitle: 'A box',
  images: ['/box.jpg'],
  variants: [
    {
      size: '1kg',
      grams: 1000,
      channel,
      price,
      mrp,
      available: 10,
      soldOut: false,
      sku: 'X',
      moq: 1,
    },
  ],
});

const pack = (slug: string, price: number, mrp: number) => ({
  slug,
  name: `Pack ${slug}`,
  subtitle: 'A pack',
  images: ['/pack.jpg'],
  variants: [
    {
      size: '250g',
      grams: 250,
      channel: 'retail',
      price,
      mrp,
      available: 10,
      soldOut: false,
      sku: 'Y',
      moq: 1,
    },
  ],
});

interface RecordedWarning {
  message: string;
  meta?: unknown;
}

/**
 * Records what the service logged.
 *
 * Not optional scaffolding: the constant's own doc comment promises that an unresolvable slug
 * "surfaces as an omitted combo, which `combos.service.ts` logs rather than hides". A combo
 * vanishing from the page with nothing in the logs is the failure mode that promise exists to rule
 * out, so the omission tests assert the warning as well as the omission.
 */
function fakeLogger(): { logger: WinstonLoggerService; warnings: RecordedWarning[] } {
  const warnings: RecordedWarning[] = [];
  const logger = {
    setContext: () => logger,
    warn: (message: string, meta?: unknown) => void warnings.push({ message, meta }),
    log: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return { logger: logger as unknown as WinstonLoggerService, warnings };
}

function build(products: unknown[], compositions: unknown[]) {
  const productsBySlugs = jest.fn((_slugs: readonly string[]) => Promise.resolve(products));
  const { logger, warnings } = fakeLogger();
  const service = new CombosService({ productsBySlugs } as never, compositions as never, logger);
  return { service, productsBySlugs, warnings };
}

describe('CombosService.list', () => {
  const composition = [
    {
      slug: 'gift-box',
      occasion: 'Diwali',
      blurb: 'A blurb',
      components: [
        { slug: 'almonds', size: '250g' },
        { slug: 'cashews', size: '250g' },
      ],
    },
  ];

  /** The whole box, plus both packs it names. The happy path for the two tests that follow. */
  const wholeCatalogue = [
    box('gift-box', 599, 699),
    pack('almonds', 299, 349),
    pack('cashews', 329, 379),
  ];

  it('prices the combo from the box product, not from the sum of its parts', async () => {
    const { service } = build(wholeCatalogue, composition);
    const [combo] = await service.list();
    // 599, not 628 (the parts' prices) and not 728 (their MRPs).
    expect(combo?.price).toBe(599);
  });

  it('derives the parts figures and the savings from the live catalogue', async () => {
    const { service } = build(wholeCatalogue, composition);
    const [combo] = await service.list();
    expect(combo?.partsPrice).toBe(628);
    expect(combo?.partsMrp).toBe(728);
    // Against MRP, which is the comparison a savings claim is allowed to make.
    expect(combo?.savings).toBe(728 - 599);
    expect(combo?.savingsPercent).toBe(18);
    expect(combo?.totalGrams).toBe(500);
  });

  /**
   * A combo whose box costs more than its parts' MRP has negative savings. Rendering "save -₹1401"
   * would be worse than rendering nothing, and brief §1 forbids unsupported claims — so the figure
   * is floored at zero and `savingsPercent` with it.
   */
  it('never claims a negative saving', async () => {
    const { service } = build(
      [box('gift-box', 2000, 2000), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    const [combo] = await service.list();
    expect(combo?.savings).toBe(0);
    expect(combo?.savingsPercent).toBe(0);
  });

  /**
   * A composition naming a product that no longer exists must not take the whole combos page down,
   * and must not silently price the box as though the missing pack were free. The component is
   * dropped and the combo is omitted, because a box advertising four things and listing three is a
   * worse outcome than one fewer card on the page.
   */
  it('omits a combo whose composition references a missing product', async () => {
    const { service, warnings } = build(
      [box('gift-box', 599, 699), pack('almonds', 299, 349)],
      composition,
    );
    expect(await service.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.meta).toMatchObject({ comboSlug: 'gift-box', componentSlug: 'cashews' });
  });

  it('omits a combo whose own box product is missing', async () => {
    const { service, warnings } = build(
      [pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    expect(await service.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('omits a component whose named pack size does not exist on that product', async () => {
    const wrongSize = [
      {
        slug: 'gift-box',
        occasion: 'D',
        blurb: 'B',
        components: [{ slug: 'almonds', size: '900g' }],
      },
    ];
    const { service, warnings } = build(
      [box('gift-box', 599, 699), pack('almonds', 299, 349)],
      wrongSize,
    );
    expect(await service.list()).toEqual([]);
    expect(warnings[0]?.meta).toMatchObject({ componentSlug: 'almonds', size: '900g' });
  });

  /**
   * The box's own pack must be a retail one. A bulk pack of the same weight is priced per a
   * wholesale rate, and pricing a gift card off it understates the price on a public page — so the
   * combo is omitted rather than mispriced.
   */
  it('does not price a box from a bulk pack of the same weight', async () => {
    const { service, warnings } = build(
      [box('gift-box', 599, 699, 'bulk'), pack('almonds', 299, 349), pack('cashews', 329, 379)],
      composition,
    );
    expect(await service.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  /**
   * One lookup for every product involved, not one per combo — the property the service's own
   * comment claims, and the reason `productsBySlugs` exists at all. Two combos sharing a component
   * must still be a single call, with the shared slug asked for once.
   */
  it('resolves every combo in one lookup, with each slug asked for once', async () => {
    const twoCombos = [
      composition[0],
      {
        slug: 'other-box',
        occasion: 'Eid',
        blurb: 'B',
        components: [{ slug: 'almonds', size: '250g' }],
      },
    ];
    const { service, productsBySlugs } = build(wholeCatalogue, twoCombos);
    await service.list();

    expect(productsBySlugs).toHaveBeenCalledTimes(1);
    const asked = productsBySlugs.mock.calls[0]?.[0] ?? [];
    expect([...asked].sort()).toEqual(['almonds', 'cashews', 'gift-box', 'other-box']);
  });
});
