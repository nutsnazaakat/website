import { toPaise } from '@nutwala/shared';
import type { DataSource, EntityManager } from 'typeorm';
import { RfqGiftingDetail } from '../../entities/b2b/rfq-gifting-detail.entity';
import { RfqItem } from '../../entities/b2b/rfq-item.entity';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { RfqKind } from '../../entities/enums';
import { nextRfqNumber } from '../../modules/rfqs/rfq-number';
import { loadProductIdsBySlug, loadUserIdsByEmail, requireValue } from './seed-context';

/**
 * The three RFQs from `frontend/src/mocks/rfqs.ts` — spec §16's Milestone 1 row promises "3
 * RFQs" and, measured, `SELECT count(*) FROM rfqs` was 0: there was no seeder for them at all.
 *
 * The mock's statuses are the frontend's dead four-value vocabulary (`RfqStatus` before Task 7),
 * not the seven the database actually enforces, so each is remapped by what the row's own
 * content implies rather than by a mechanical rule:
 *
 * - "new" needs no remap — it is the one value both vocabularies share.
 * - "quoted" -> "quote-sent": a quote was sent and nothing in the fixture says what happened
 *   next.
 * - "accepted" -> "converted", not "approved": the fixture's own note is "Standing order, split
 *   dispatch across two warehouses" — language describing an already-running fulfilment
 *   arrangement, not a quote still awaiting a decision. The sales desk's pipeline says this
 *   prospect already became a customer.
 *
 * Task 9's Step 2 also asks this seeder to cover both `kind`s with at least one `GIFTING` row
 * carrying its detail, so the gifting read path has a fixture that does not depend on a test
 * creating one. The mock has none — all three are bulk enquiries — so the second row
 * (Crumb & Co Bakery, a prospect either way) is repurposed as the gifting fixture rather than
 * inventing a fourth row the mock never had.
 */
interface RfqLineSeed {
  productSlug: string;
  kg: number;
}

interface RfqGiftingSeed {
  occasion: string;
  giftBoxSlug: string;
  boxes: number;
  budgetPerBoxRupees: number;
  brandingRequired: boolean;
  deliveryDate: string;
  message: string;
}

interface RfqSeed {
  businessName: string;
  contactPerson: string;
  mobile: string;
  email: string;
  gstin: string | null;
  businessType: string;
  pincode: string;
  notes: string | null;
  status: string;
  kind: RfqKind;
  /** Bulk only. */
  lines?: RfqLineSeed[];
  packaging?: string;
  frequency?: string;
  /** Gifting only. */
  gifting?: RfqGiftingSeed;
  createdAt: string;
  /**
   * `b2b@demo.in`'s own company for exactly one row, so Task 13's ownership tests and Task 14's
   * frontend cases have a signed-in business that sees precisely one RFQ, not three — the same
   * reason `orders.seed.ts` splits its fixtures between one account and several prospects. The
   * other two stay prospects (`userId: null`): a genuine RFQ desk fields far more enquiries from
   * people who never register than from existing accounts.
   */
  ownerEmail: string | null;
}

const RFQ_SEEDS: RfqSeed[] = [
  {
    businessName: 'Anand Sweets & Namkeen',
    contactPerson: 'Rakesh Anand',
    mobile: '9845012345',
    email: 'purchase@anandsweets.example',
    gstin: '29ABCDE1234F1Z5',
    businessType: 'Sweet shop',
    pincode: '560004',
    notes: 'Festive season ramp-up. Need a locked rate through Diwali.',
    status: 'new',
    kind: RfqKind.BULK,
    lines: [
      { productSlug: 'w320-cashews', kg: 120 },
      { productSlug: 'premium-pistachios', kg: 40 },
    ],
    packaging: 'Bulk sacks (25 kg)',
    frequency: 'Monthly',
    createdAt: '2026-08-11T06:20:00.000Z',
    ownerEmail: 'b2b@demo.in',
  },
  {
    businessName: 'Crumb & Co Bakery',
    contactPerson: 'Priya Menon',
    mobile: '9820098200',
    email: 'priya@crumbandco.example',
    gstin: null,
    businessType: 'Bakery',
    pincode: '400050',
    notes: null,
    status: 'quote-sent',
    kind: RfqKind.GIFTING,
    gifting: {
      occasion: 'Client appreciation',
      giftBoxSlug: 'festive-gift-box',
      boxes: 40,
      budgetPerBoxRupees: 799,
      brandingRequired: true,
      deliveryDate: '2026-09-15',
      message: 'Logo card inside each box, please — samples attached separately.',
    },
    createdAt: '2026-07-29T11:05:00.000Z',
    ownerEmail: null,
  },
  {
    businessName: 'Northline Distributors',
    contactPerson: 'Vikram Sethi',
    mobile: '9711122233',
    email: 'vikram@northline.example',
    gstin: '07PQRST5678K1Z2',
    businessType: 'Distributor',
    pincode: '110020',
    notes: 'Standing order, split dispatch across two warehouses.',
    status: 'converted',
    kind: RfqKind.BULK,
    lines: [
      { productSlug: 'roasted-makhana', kg: 200 },
      { productSlug: 'afghani-black-raisins', kg: 150 },
    ],
    packaging: 'Retail-ready pouches',
    frequency: 'Monthly',
    createdAt: '2026-07-04T09:40:00.000Z',
    ownerEmail: null,
  },
];

interface Lookups {
  userIdByEmail: ReadonlyMap<string, string>;
  productIdBySlug: ReadonlyMap<string, string>;
}

export async function seedRfqs(dataSource: DataSource): Promise<number> {
  const [userIdByEmail, productIdBySlug] = await Promise.all([
    loadUserIdsByEmail(dataSource),
    loadProductIdsBySlug(dataSource),
  ]);

  if (userIdByEmail.size === 0 || productIdBySlug.size === 0) {
    throw new Error('No users or products found. Run the users and catalog seeders first.');
  }

  return dataSource.transaction(async (manager) => {
    let rows = 0;
    for (const seed of RFQ_SEEDS) {
      rows += await seedRfq(manager, seed, { userIdByEmail, productIdBySlug });
    }
    return rows;
  });
}

/**
 * `businessName` is this seeder's own natural key — **not** `rfqNumber`, which does not exist
 * until the first run assigns one. `nextRfqNumber` draws from `rfq_number_seq`, the same
 * sequence live traffic draws from, so a number can be allocated exactly once per fixture: the
 * first run finds no existing row, draws a fresh one, and every run after that finds the row by
 * `businessName` and reuses the number it already holds. Calling `nextRfqNumber` unconditionally
 * on every run would upsert a *different* row each time — a fresh number is a fresh conflict
 * target — and running `npm run seed -- rfqs` twice would leave two rows per fixture instead of
 * one.
 */
async function seedRfq(manager: EntityManager, seed: RfqSeed, lookups: Lookups): Promise<number> {
  const userId =
    seed.ownerEmail === null
      ? null
      : requireValue(
          lookups.userIdByEmail.get(seed.ownerEmail),
          `user "${seed.ownerEmail}" for RFQ "${seed.businessName}"`,
        );

  const existing = await manager
    .getRepository(Rfq)
    .findOne({ where: { businessName: seed.businessName }, select: { id: true, rfqNumber: true } });
  const rfqNumber = existing?.rfqNumber ?? (await nextRfqNumber(manager, new Date(seed.createdAt)));

  const lines = seed.lines ?? [];

  await manager.getRepository(Rfq).upsert(
    {
      rfqNumber,
      userId,
      kind: seed.kind,
      businessName: seed.businessName,
      contactPerson: seed.contactPerson,
      mobile: seed.mobile,
      email: seed.email,
      gstin: seed.gstin,
      businessType: seed.businessType,
      pincode: seed.pincode,
      packaging: seed.packaging ?? null,
      frequency: seed.frequency ?? null,
      notes: seed.notes,
      status: seed.status,
      assignedSalespersonId: null,
      expectedValuePaise: null,
      // The row's own creation date is when the enquiry was raised, not when the seed ran —
      // `orders.seed.ts` makes the identical override for `placedAt`.
      createdAt: new Date(seed.createdAt),
    },
    ['rfqNumber'],
  );
  let rows = 1;

  const rfq = requireValue(
    (await manager.getRepository(Rfq).findOne({ where: { rfqNumber }, select: { id: true } })) ??
      undefined,
    `RFQ ${rfqNumber} immediately after upserting it`,
  );

  // Items and the gifting detail have no natural key of their own, so they are replaced
  // wholesale on a re-run — `orders.seed.ts`'s identical reasoning for order items and events.
  await manager.getRepository(RfqItem).delete({ rfqId: rfq.id });
  if (lines.length > 0) {
    await manager.getRepository(RfqItem).insert(
      lines.map((line) => ({
        rfqId: rfq.id,
        productId: requireValue(
          lookups.productIdBySlug.get(line.productSlug),
          `product "${line.productSlug}" on RFQ ${rfqNumber}`,
        ),
        productSlug: line.productSlug,
        kg: String(line.kg),
      })),
    );
    rows += lines.length;
  }

  if (seed.gifting) {
    await manager.getRepository(RfqGiftingDetail).upsert(
      {
        rfqId: rfq.id,
        occasion: seed.gifting.occasion,
        giftBoxSlug: seed.gifting.giftBoxSlug,
        boxes: seed.gifting.boxes,
        budgetPerBoxPaise: toPaise(seed.gifting.budgetPerBoxRupees),
        brandingRequired: seed.gifting.brandingRequired,
        deliveryDate: seed.gifting.deliveryDate,
        message: seed.gifting.message,
      },
      ['rfqId'],
    );
    rows += 1;
  }

  return rows;
}
