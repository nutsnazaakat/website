import type { RfqGiftingDetail } from '../../../entities/b2b/rfq-gifting-detail.entity';
import type { RfqItem } from '../../../entities/b2b/rfq-item.entity';
import type { Rfq } from '../../../entities/b2b/rfq.entity';
import { RfqKind } from '../../../entities/enums';
import { toRfqDetail, toRfqSummary } from './rfq.mapper';

/**
 * The uuid primary key, kept distinct from the RFQ number in every fixture on purpose — mapping
 * `rfq.id` instead of `rfq.rfqNumber` typechecks, since both are `string`, so only a fixture where
 * the two differ can tell a mistake here from a coincidence.
 */
const RFQ_UUID = '3f1a9b7c-0000-4000-8000-000000000002';
const RFQ_NUMBER = 'RFQ-2026-100002';

const rfqItem = (overrides: Partial<RfqItem> = {}): RfqItem =>
  ({
    id: '9a2c1d44-0000-4000-8000-000000000002',
    rfqId: RFQ_UUID,
    productId: 'prod-cashews',
    productSlug: 'w320-cashews',
    kg: '120.00',
    ...overrides,
  }) as unknown as RfqItem;

const giftingDetail = (overrides: Partial<RfqGiftingDetail> = {}): RfqGiftingDetail =>
  ({
    rfqId: RFQ_UUID,
    occasion: 'Diwali',
    giftBoxSlug: 'festive-gift-box',
    boxes: 50,
    budgetPerBoxPaise: 150000n,
    brandingRequired: true,
    deliveryDate: '2026-10-15',
    message: 'Logo on the lid, please.',
    ...overrides,
  }) as unknown as RfqGiftingDetail;

/** A stored bulk RFQ, relations loaded. Every test starts here and overrides what it needs. */
const rfq = (overrides: Partial<Rfq> = {}): Rfq =>
  ({
    id: RFQ_UUID,
    rfqNumber: RFQ_NUMBER,
    userId: null,
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
    assignedSalespersonId: null,
    expectedValuePaise: null,
    createdAt: new Date('2026-08-11T06:20:00.000Z'),
    updatedAt: new Date('2026-08-11T06:20:00.000Z'),
    items: [rfqItem()],
    gifting: null,
    notesList: undefined,
    ...overrides,
  }) as unknown as Rfq;

describe('toRfqSummary', () => {
  it('names the RFQ by its number, and never leaks the primary key', () => {
    const summary = toRfqSummary(rfq());
    expect(summary.id).toBe(RFQ_NUMBER);
    expect(JSON.stringify(summary)).not.toContain(RFQ_UUID);
  });

  it('lowers the kind vocabulary, and only the kind vocabulary', () => {
    expect(toRfqSummary(rfq({ kind: RfqKind.BULK })).kind).toBe('bulk');
    expect(toRfqSummary(rfq({ kind: RfqKind.GIFTING })).kind).toBe('gifting');
  });

  it('passes a real status straight through, unchanged', () => {
    expect(toRfqSummary(rfq({ status: 'negotiation' })).status).toBe('negotiation');
  });

  /**
   * `rfqs.status` is a bare `varchar(20)`, not a Postgres enum — nothing at the database stops a
   * stray value, so this is the one place that can still refuse it before it reaches a
   * `Record<RfqStatus, …>` and renders an empty badge.
   */
  it('refuses a status that is not in the vocabulary, rather than rendering a blank badge', () => {
    expect(() => toRfqSummary(rfq({ status: 'quoted' }))).toThrow(/not an RFQ status/);
  });

  it('renders createdAt as an ISO string', () => {
    const summary = toRfqSummary(rfq({ createdAt: new Date('2026-08-11T06:20:00.000Z') }));
    expect(summary.createdAt).toBe('2026-08-11T06:20:00.000Z');
  });
});

describe('toRfqDetail', () => {
  it("maps every bulk line, kg as a number rather than the numeric column's string", () => {
    const detail = toRfqDetail(
      rfq({ items: [rfqItem({ productSlug: 'w320-cashews', kg: '120.00' })] }),
    );
    expect(detail.lines).toEqual([{ productSlug: 'w320-cashews', kg: 120 }]);
  });

  it('omits gifting entirely for a bulk enquiry, rather than sending it null', () => {
    const detail = toRfqDetail(rfq({ gifting: null }));
    expect('gifting' in detail).toBe(false);
  });

  it('maps the gifting detail, budgetPerBox in rupees off the paise column', () => {
    const detail = toRfqDetail(
      rfq({
        kind: RfqKind.GIFTING,
        items: [],
        gifting: giftingDetail({ budgetPerBoxPaise: 150000n }),
      }),
    );
    expect(detail.gifting).toEqual({
      occasion: 'Diwali',
      giftBoxSlug: 'festive-gift-box',
      boxes: 50,
      budgetPerBox: 1500,
      brandingRequired: true,
      deliveryDate: '2026-10-15',
      message: 'Logo on the lid, please.',
    });
    expect(detail.lines).toEqual([]);
  });

  /**
   * `packaging`/`frequency`/`notes`/`gstin` are all optional on the wire, not nullable — a
   * gifting enquiry genuinely has no packaging question, and the honest answer is an absent key,
   * not a client-visible `null` it has to special-case identically anyway.
   */
  it('omits packaging, frequency, notes and gstin when the row carries none', () => {
    const detail = toRfqDetail(rfq({ packaging: null, frequency: null, notes: null, gstin: null }));
    expect(detail).not.toHaveProperty('packaging');
    expect(detail).not.toHaveProperty('frequency');
    expect(detail).not.toHaveProperty('notes');
    expect(detail).not.toHaveProperty('gstin');
  });

  it('sends packaging, frequency, notes and gstin when the row does carry them', () => {
    const detail = toRfqDetail(
      rfq({
        packaging: 'Bulk sacks (25 kg)',
        frequency: 'Monthly',
        notes: 'Festive season ramp-up.',
        gstin: '29ABCDE1234F1Z5',
      }),
    );
    expect(detail.packaging).toBe('Bulk sacks (25 kg)');
    expect(detail.frequency).toBe('Monthly');
    expect(detail.notes).toBe('Festive season ramp-up.');
    expect(detail.gstin).toBe('29ABCDE1234F1Z5');
  });

  /**
   * Brief §34's own words for `RfqNote`: "Never exposed on a customer-facing endpoint." Neither
   * `notesList` nor the two internal columns have `select: false` to save this file if the
   * mapper ever started reading them, so the assertion is on the serialised body, not the field
   * name — the same reasoning Plan 3's Task 22 measured for `passwordHash`.
   */
  it('never serialises the internal sales fields, even when the entity carries them', () => {
    const detail = toRfqDetail(
      rfq({
        assignedSalespersonId: 'sales-1',
        expectedValuePaise: 5_000_000n,
        notesList: [{ body: 'Haggling over the rate, do not quote below 900/kg.' }] as never,
      }),
    );
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain('sales-1');
    expect(serialised).not.toContain('900/kg');
    expect(detail).not.toHaveProperty('assignedSalespersonId');
    expect(detail).not.toHaveProperty('expectedValuePaise');
    expect(detail).not.toHaveProperty('notesList');
  });

  /**
   * The guard `RfqsService.create`'s own docblock exists to make unreachable in production: a
   * caller that mapped `save()`'s raw result instead of the re-read would hand this function an
   * `Rfq` whose `items` is `undefined` while the type says `RfqItem[]`, and this must be loud
   * rather than answering `lines: []` on an enquiry that named three products.
   */
  it('refuses an RFQ whose items were never loaded', () => {
    expect(() => toRfqDetail(rfq({ items: undefined }))).toThrow(/items loaded/);
  });
});
