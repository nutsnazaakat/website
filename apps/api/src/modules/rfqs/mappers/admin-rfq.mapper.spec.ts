import { toPaise } from '@nutwala/shared';
import type { RfqItem } from '../../../entities/b2b/rfq-item.entity';
import type { RfqNote } from '../../../entities/b2b/rfq-note.entity';
import type { Rfq } from '../../../entities/b2b/rfq.entity';
import { RfqKind, UserRole } from '../../../entities/enums';
import type { User } from '../../../entities/identity/user.entity';
import { toAdminRfq, toAdminRfqNote, toAdminRfqSummary } from './admin-rfq.mapper';
import { toRfqDetail } from './rfq.mapper';

const RFQ_NUMBER = 'RFQ-2026-000123';

const item = (productSlug: string, kg: string): RfqItem =>
  ({ id: `item-${productSlug}`, rfqId: 'rfq-1', productId: null, productSlug, kg }) as RfqItem;

const admin = (overrides: Partial<User> = {}): User =>
  ({
    id: 'f0000000-0000-4000-8000-00000000000c',
    name: 'Priya Desk',
    email: 'priya@nutsandnazaakat.in',
    phone: '9000000000',
    passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
    role: UserRole.ADMIN,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as User;

const note = (overrides: Partial<RfqNote> = {}): RfqNote =>
  ({
    id: 'note-1',
    rfqId: 'rfq-1',
    authorUserId: 'f0000000-0000-4000-8000-00000000000c',
    authorUser: admin(),
    body: 'Rang the buyer; wants 200kg a month from October.',
    createdAt: new Date('2026-08-20T09:00:00.000Z'),
    ...overrides,
  }) as unknown as RfqNote;

const rfq = (overrides: Partial<Rfq> = {}): Rfq =>
  ({
    id: 'rfq-1',
    rfqNumber: RFQ_NUMBER,
    userId: 'f0000000-0000-4000-8000-00000000000a',
    kind: RfqKind.BULK,
    businessName: 'Anand Sweets',
    contactPerson: 'Ravi Kumar',
    mobile: '9812345670',
    email: 'ravi@anandsweets.in',
    gstin: '29ABCDE1234F1Z5',
    businessType: 'Sweet shop',
    pincode: '560058',
    packaging: 'Vacuum pack',
    frequency: 'Monthly',
    notes: 'Please quote for jute sacks as well.',
    status: 'contacted',
    assignedSalespersonId: null,
    expectedValuePaise: null,
    items: [item('california-almonds', '25.00'), item('cashews-w320', '10.50')],
    notesList: [note()],
    gifting: null,
    createdAt: new Date('2026-08-18T06:00:00.000Z'),
    updatedAt: new Date('2026-08-20T09:00:00.000Z'),
    ...overrides,
  }) as unknown as Rfq;

describe('toAdminRfqSummary', () => {
  it('answers brief §34’s columns, field for field', () => {
    expect(toAdminRfqSummary(rfq(), { salesperson: null })).toEqual({
      id: RFQ_NUMBER,
      kind: 'bulk',
      status: 'contacted',
      businessName: 'Anand Sweets',
      createdAt: '2026-08-18T06:00:00.000Z',
      contactPerson: 'Ravi Kumar',
      mobile: '9812345670',
      email: 'ravi@anandsweets.in',
      lines: [
        { productSlug: 'california-almonds', kg: 25 },
        { productSlug: 'cashews-w320', kg: 10.5 },
      ],
      totalKg: 35.5,
      expectedValue: null,
      assignedSalesperson: null,
    });
  });

  /** `kg` is `numeric(10,2)`, which `pg` hands back as a string — `'25.00' + '10.50'` would
   * concatenate, so the conversion is doing real work rather than satisfying a type. */
  it('sums the quantity as numbers, never as strings', () => {
    expect(toAdminRfqSummary(rfq(), { salesperson: null }).totalKg).toBe(35.5);
  });

  it('converts the expected value from paise once', () => {
    const mapped = toAdminRfqSummary(rfq({ expectedValuePaise: toPaise(84500) }), {
      salesperson: null,
    });
    expect(mapped.expectedValue).toBe(84500);
  });

  it('resolves the assigned salesperson without publishing their password hash', () => {
    const mapped = toAdminRfqSummary(rfq(), { salesperson: admin() });
    expect(mapped.assignedSalesperson).toEqual({
      id: 'f0000000-0000-4000-8000-00000000000c',
      name: 'Priya Desk',
      email: 'priya@nutsandnazaakat.in',
    });
    expect(JSON.stringify(mapped)).not.toContain('$2b$');
  });

  /**
   * TypeORM types `items` as always-present and leaves it `undefined` when the relation was never
   * selected, so a caller that forgot the `relations` clause would typecheck perfectly and turn
   * brief §34's "products, quantity" columns into blanks.
   */
  it('refuses to map without its items loaded', () => {
    const unloaded = rfq();
    // @ts-expect-error — the declared type says this is always an array; the unloaded case is
    // exactly what it is wrong about, and is what this guard exists for.
    unloaded.items = undefined;
    expect(() => toAdminRfqSummary(unloaded, { salesperson: null })).toThrow(/without its items/);
  });

  /** The status check lives in `toRfqSummary`, which this delegates to — a second cast here would
   * be the copy that stops checking a column Postgres does not police. */
  it('refuses a status outside the shared vocabulary', () => {
    expect(() => toAdminRfqSummary(rfq({ status: 'archived' }), { salesperson: null })).toThrow(
      /not an RFQ status/,
    );
  });

  it('answers zero quantity for a gifting enquiry, which has no lines', () => {
    const mapped = toAdminRfqSummary(rfq({ kind: RfqKind.GIFTING, items: [] }), {
      salesperson: null,
    });
    expect(mapped).toMatchObject({ kind: 'gifting', lines: [], totalKg: 0 });
  });
});

describe('toAdminRfqNote', () => {
  it('carries the author’s name beside their id and nothing else from the user row', () => {
    expect(toAdminRfqNote(note())).toEqual({
      id: 'note-1',
      body: 'Rang the buyer; wants 200kg a month from October.',
      authorUserId: 'f0000000-0000-4000-8000-00000000000c',
      authorName: 'Priya Desk',
      createdAt: '2026-08-20T09:00:00.000Z',
    });
  });

  it('refuses to map without its author loaded', () => {
    const unloaded = note();
    // @ts-expect-error — `authorUser` is declared always-present and is `undefined` when unjoined.
    unloaded.authorUser = undefined;
    expect(() => toAdminRfqNote(unloaded)).toThrow(/without its author/);
  });
});

describe('toAdminRfq', () => {
  /**
   * **The distinction this whole shape exists to keep.** `notes` is the prospect's own "additional
   * requirements" — the same string `RfqDetail.notes` shows them back — and `internalNotes` is
   * brief §34's sales history, which no customer-facing endpoint may load. Asserted together
   * against the customer's own mapper, because the failure would be silent in both directions: an
   * internal note appearing as the prospect's text, or the prospect's text overwritten by one.
   */
  it('keeps the prospect’s own notes and the internal ones apart', () => {
    const row = rfq();
    const detail = toAdminRfq(row, { salesperson: null });
    const customerFacing = toRfqDetail(row);

    expect(detail.notes).toBe('Please quote for jute sacks as well.');
    expect(detail.notes).toBe(customerFacing.notes);
    expect(detail.internalNotes).toHaveLength(1);
    expect(detail.internalNotes[0]?.body).toContain('Rang the buyer');
    expect(JSON.stringify(customerFacing)).not.toContain('Rang the buyer');
  });

  it('is the summary plus the enquiry’s own detail', () => {
    const detail = toAdminRfq(rfq(), { salesperson: null });
    expect(detail).toMatchObject({
      ...toAdminRfqSummary(rfq(), { salesperson: null }),
      userId: 'f0000000-0000-4000-8000-00000000000a',
      gstin: '29ABCDE1234F1Z5',
      businessType: 'Sweet shop',
      pincode: '560058',
      packaging: 'Vacuum pack',
      frequency: 'Monthly',
      gifting: null,
      updatedAt: '2026-08-20T09:00:00.000Z',
    });
  });

  it('refuses to map without its note history loaded', () => {
    const unloaded = rfq();
    // @ts-expect-error — `notesList` is declared always-present and is `undefined` when unjoined.
    unloaded.notesList = undefined;
    expect(() => toAdminRfq(unloaded, { salesperson: null })).toThrow(/note history/);
  });

  it('maps a gifting enquiry’s five extra questions through the shared converter', () => {
    const detail = toAdminRfq(
      rfq({
        kind: RfqKind.GIFTING,
        items: [],
        packaging: null,
        frequency: null,
        gifting: {
          occasion: 'Diwali',
          giftBoxSlug: 'corporate-gift-box',
          boxes: 200,
          budgetPerBoxPaise: toPaise(1500),
          brandingRequired: true,
          deliveryDate: '2026-10-15',
          message: 'Please emboss the logo.',
        },
      } as unknown as Partial<Rfq>),
      { salesperson: null },
    );

    expect(detail.gifting).toEqual({
      occasion: 'Diwali',
      giftBoxSlug: 'corporate-gift-box',
      boxes: 200,
      budgetPerBox: 1500,
      brandingRequired: true,
      deliveryDate: '2026-10-15',
      message: 'Please emboss the logo.',
    });
  });
});
