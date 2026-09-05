import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import {
  toPaise,
  type AdminRfq,
  type AdminRfqSummary,
  type Paginated,
  type RfqDetail,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { RfqNote } from '../../src/entities/b2b/rfq-note.entity';
import { Rfq } from '../../src/entities/b2b/rfq.entity';
import { RfqItem } from '../../src/entities/b2b/rfq-item.entity';
import { RfqKind, UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/rfqs';
const PUBLIC = '/api/v1/rfqs';
const CSRF_HEADER = 'X-CSRF-Token';

const OK: number = HttpStatus.OK;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;
const UNPROCESSABLE: number = HttpStatus.UNPROCESSABLE_ENTITY;

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_user_id: string;
}

let sequence = 0;

interface SeedRfqInput {
  status?: string;
  kind?: RfqKind;
  userId?: string | null;
  businessName?: string;
  contactPerson?: string;
  email?: string;
  notes?: string | null;
  assignedSalespersonId?: string | null;
  expectedValuePaise?: bigint | null;
  lines?: { productSlug: string; kg: string }[];
  createdAt?: Date;
}

/**
 * `GET /admin/rfqs` and `GET /admin/rfqs/:rfqNumber` — plan 9.3 Task 3, brief §34.
 *
 * What only a real database can answer:
 *
 * - **an internal note reaches the admin detail and never the customer's own.** The same enquiry is
 *   fetched from both endpoints in one test, with a real `rfq_notes` row behind it — the guard is
 *   two `relations` clauses in two services, and nothing but a real query proves both are right;
 * - **paging is stable across enquiries written inside one transaction**, where `@CreateDateColumn`
 *   stamps one `now()` on every row and `rfqNumber` is the only thing separating them;
 * - **`kg` really is `numeric(10,2)`**, so `totalKg` is arithmetic on values the driver hands back
 *   as strings rather than on numbers a fixture invented;
 * - **the `audit_logs` row and the status change it describes are one transaction.** A unit double
 *   has no transaction to roll back. The case below drives `PATCH /admin/rfqs/:rfqNumber` down a
 *   path that genuinely fails *after* the audit write — a salesperson id that is not an admin — and
 *   asserts the trail is empty and the enquiry unmoved.
 */
describe('admin RFQ surfaces', () => {
  const integration = useIntegrationApp();

  /** See `inventory.integration.spec.ts` — one app per file, so the throttler is shared. */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  const signIn = async (role: UserRole) => {
    const user = await createTestUser(integration.dataSource, { role });
    const client = agent(integration.app);
    const login = await client
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(OK);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);

  /**
   * Written directly rather than through `POST /rfqs`, for `order.factory.ts`'s reason: the public
   * route is throttled to five per hour per IP and is itself under test elsewhere, and a fixture
   * built out of the endpoint it is used to test cannot tell a broken endpoint from a broken
   * fixture. The `7` prefix keeps these clear of both the seeder's real numbers and
   * `admin-businesses`' `8`.
   */
  const seedRfq = async (input: SeedRfqInput = {}): Promise<Rfq> => {
    sequence += 1;
    const rfqs = integration.dataSource.getRepository(Rfq);
    const saved = await rfqs.save(
      rfqs.create({
        rfqNumber: `RFQ-2026-7${String(sequence).padStart(5, '0')}`,
        userId: input.userId ?? null,
        kind: input.kind ?? RfqKind.BULK,
        businessName: input.businessName ?? 'Anand Sweets',
        contactPerson: input.contactPerson ?? 'Ravi Kumar',
        mobile: '9812345670',
        email: input.email ?? 'ravi@anandsweets.in',
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
        pincode: '560058',
        packaging: 'Vacuum pack',
        frequency: 'Monthly',
        notes: input.notes ?? null,
        status: input.status ?? 'new',
        assignedSalespersonId: input.assignedSalespersonId ?? null,
        expectedValuePaise: input.expectedValuePaise ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      }),
    );

    const lines = input.lines ?? [{ productSlug: 'california-almonds', kg: '25.00' }];
    if (lines.length > 0) {
      await integration.dataSource
        .getRepository(RfqItem)
        .insert(
          lines.map((line) => ({ rfqId: saved.id, productSlug: line.productSlug, kg: line.kg })),
        );
    }

    return saved;
  };

  const addNote = async (rfqId: string, authorUserId: string, body: string): Promise<RfqNote> => {
    const notes = integration.dataSource.getRepository(RfqNote);
    return notes.save(notes.create({ rfqId, authorUserId, body }));
  };

  const auditRows = async (): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", before, after, actor_user_id
         FROM audit_logs ORDER BY "createdAt", action`,
    );

  const rowFor = async (rfqNumber: string) => {
    const [row] = await integration.dataSource.query<
      { status: string; notes: string | null; assigned: string | null; expected: string | null }[]
    >(
      `SELECT status, notes, assigned_salesperson_id AS assigned,
              "expectedValuePaise"::text AS expected
         FROM rfqs WHERE "rfqNumber" = $1`,
      [rfqNumber],
    );
    return row;
  };

  const notesFor = async (rfqId: string) =>
    integration.dataSource.query<{ body: string; author_user_id: string }[]>(
      'SELECT body, author_user_id FROM rfq_notes WHERE rfq_id = $1 ORDER BY "createdAt"',
      [rfqId],
    );

  describe('GET /admin/rfqs', () => {
    it('refuses an anonymous caller with 401 and a signed-in business with 403', async () => {
      await agent(integration.app).get(BASE).expect(UNAUTHORIZED);
      const { client } = await signIn(UserRole.BUSINESS);
      await client.get(BASE).expect(FORBIDDEN);
    });

    it('answers brief §34’s columns, lines and quantity included', async () => {
      const { client, user: admin } = await asAdmin();
      const rfq = await seedRfq({
        status: 'contacted',
        expectedValuePaise: toPaise(84500),
        assignedSalespersonId: admin.id,
        lines: [
          { productSlug: 'california-almonds', kg: '25.00' },
          { productSlug: 'cashews-w320', kg: '10.50' },
        ],
      });

      const page = expectSuccess<Paginated<AdminRfqSummary>>(await client.get(BASE).expect(OK));

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        id: rfq.rfqNumber,
        kind: 'bulk',
        status: 'contacted',
        businessName: 'Anand Sweets',
        contactPerson: 'Ravi Kumar',
        email: 'ravi@anandsweets.in',
        totalKg: 35.5,
        expectedValue: 84500,
        assignedSalesperson: { id: admin.id, name: admin.name, email: admin.email },
      });
      expect(page.items[0]?.lines).toHaveLength(2);
    });

    it('filters by status and by kind', async () => {
      const { client } = await asAdmin();
      const negotiating = await seedRfq({ status: 'negotiation' });
      const gifting = await seedRfq({ kind: RfqKind.GIFTING, lines: [] });

      const byStatus = expectSuccess<Paginated<AdminRfqSummary>>(
        await client.get(`${BASE}?status=negotiation`).expect(OK),
      );
      expect(byStatus.items.map((item) => item.id)).toEqual([negotiating.rfqNumber]);

      const byKind = expectSuccess<Paginated<AdminRfqSummary>>(
        await client.get(`${BASE}?kind=gifting`).expect(OK),
      );
      expect(byKind.items.map((item) => item.id)).toEqual([gifting.rfqNumber]);
    });

    it('searches the RFQ number, the business, the contact and the email', async () => {
      const { client } = await asAdmin();
      const target = await seedRfq({
        businessName: 'Blue Tokai Roasters',
        contactPerson: 'Meena Nair',
        email: 'meena@bluetokai.in',
      });
      await seedRfq();

      for (const q of [target.rfqNumber, 'tokai', 'meena', 'bluetokai.in']) {
        const page = expectSuccess<Paginated<AdminRfqSummary>>(
          await client.get(`${BASE}?q=${encodeURIComponent(q)}`).expect(OK),
        );
        expect(page.items.map((item) => item.id)).toEqual([target.rfqNumber]);
      }
    });

    it('refuses a status outside brief §34’s seven', async () => {
      const { client } = await asAdmin();
      const refusal = expectError(await client.get(`${BASE}?status=archived`).expect(BAD_REQUEST));
      expect(refusal.details).toHaveProperty('status');
    });

    /**
     * Every enquiry here is stamped with the **same** `createdAt`, which is the state
     * `@CreateDateColumn`'s transaction-start default produces for a batch — so `rfqNumber DESC` is
     * the only thing making the three pages disjoint.
     */
    it('pages without repeating or losing an enquiry, even on one timestamp', async () => {
      const { client } = await asAdmin();
      const at = new Date('2026-08-18T06:00:00.000Z');
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push((await seedRfq({ createdAt: at })).rfqNumber);
      }

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const answered = expectSuccess<Paginated<AdminRfqSummary>>(
          await client.get(`${BASE}?page=${String(page)}&limit=2`).expect(OK),
        );
        seen.push(...answered.items.map((item) => item.id));
      }

      expect(new Set(seen).size).toBe(5);
      expect(seen.sort()).toEqual([...created].sort());
    });

    /** The count comes from a second statement over the same `where`, so joining the lines cannot
     * make it count line items instead of enquiries. */
    it('counts enquiries, not their lines', async () => {
      const { client } = await asAdmin();
      await seedRfq({
        lines: [
          { productSlug: 'california-almonds', kg: '25.00' },
          { productSlug: 'cashews-w320', kg: '10.00' },
          { productSlug: 'pistachios', kg: '5.00' },
        ],
      });

      const page = expectSuccess<Paginated<AdminRfqSummary>>(await client.get(BASE).expect(OK));
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.lines).toHaveLength(3);
    });
  });

  describe('GET /admin/rfqs/:rfqNumber', () => {
    it('answers the enquiry in full, with its note history newest first', async () => {
      const { client, user: admin } = await asAdmin();
      const rfq = await seedRfq({ notes: 'Please quote for jute sacks as well.' });
      await addNote(rfq.id, admin.id, 'First contact made.');
      await addNote(rfq.id, admin.id, 'Buyer wants 200kg a month from October.');

      const detail = expectSuccess<AdminRfq>(
        await client.get(`${BASE}/${rfq.rfqNumber}`).expect(OK),
      );

      expect(detail).toMatchObject({
        id: rfq.rfqNumber,
        gstin: '29ABCDE1234F1Z5',
        businessType: 'Sweet shop',
        pincode: '560058',
        packaging: 'Vacuum pack',
        frequency: 'Monthly',
        notes: 'Please quote for jute sacks as well.',
        gifting: null,
      });
      expect(detail.internalNotes.map((note) => note.body)).toEqual([
        'Buyer wants 200kg a month from October.',
        'First contact made.',
      ]);
      expect(detail.internalNotes[0]?.authorName).toBe(admin.name);
    });

    /**
     * **The disclosure case.** `rfq-note.entity.ts`: *"Never exposed on a customer-facing endpoint.
     * `GET /rfqs/:rfqNumber` must not select this relation."* Both endpoints are called for the same
     * enquiry, so the assertion measures the guard rather than one service's `relations` clause.
     */
    it('returns internal notes where the customer’s own detail returns none', async () => {
      const { client: adminClient, user: admin } = await asAdmin();
      const { client: ownerClient, user: owner } = await signIn(UserRole.BUSINESS);
      const rfq = await seedRfq({ userId: owner.id, notes: 'Need jute sacks.' });
      await addNote(rfq.id, admin.id, 'Buyer is price-sensitive; hold at 620/kg.');

      const adminDetail = await adminClient.get(`${BASE}/${rfq.rfqNumber}`).expect(OK);
      const ownerDetail = await ownerClient.get(`${PUBLIC}/${rfq.rfqNumber}`).expect(OK);

      expect(JSON.stringify(adminDetail.body)).toContain('price-sensitive');
      expect(JSON.stringify(ownerDetail.body)).not.toContain('price-sensitive');
      // The prospect's own note survives on both, unchanged — it is a different field.
      expect(expectSuccess<AdminRfq>(adminDetail).notes).toBe('Need jute sacks.');
      expect(expectSuccess<RfqDetail>(ownerDetail).notes).toBe('Need jute sacks.');
    });

    it('publishes no password hash for the note author or the salesperson', async () => {
      const { client, user: admin } = await asAdmin();
      const rfq = await seedRfq({ assignedSalespersonId: admin.id });
      await addNote(rfq.id, admin.id, 'Called.');

      const response = await client.get(`${BASE}/${rfq.rfqNumber}`).expect(OK);
      expect(JSON.stringify(response.body)).not.toContain('$2b$');
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('answers 404 naming the reference for an unknown RFQ number', async () => {
      const { client } = await asAdmin();
      const refusal = expectError(await client.get(`${BASE}/RFQ-2026-999999`).expect(NOT_FOUND));
      expect(refusal.code).toBe('NOT_FOUND');
      expect(refusal.message).toContain('RFQ-2026-999999');
    });

    /** The parameter is a number, not a uuid, so a reference that happens to look like neither is
     * still a 404 rather than the 400 a `ParseUUIDPipe` would produce. */
    it('does not reject a non-uuid reference at the pipe', async () => {
      const { client } = await asAdmin();
      await client.get(`${BASE}/not-a-uuid`).expect(NOT_FOUND);
    });
  });

  describe('PATCH /admin/rfqs/:rfqNumber', () => {
    it('moves the status through RFQ_TRANSITIONS and audits it', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const rfq = await seedRfq({ status: 'new' });

      const detail = expectSuccess<AdminRfq>(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'contacted' })
          .expect(OK),
      );

      expect(detail.status).toBe('contacted');
      expect((await rowFor(rfq.rfqNumber))?.status).toBe('contacted');
      expect(await auditRows()).toEqual([
        {
          action: 'rfq.status-change',
          entity: 'rfq',
          entityId: rfq.id,
          before: { status: 'new' },
          after: { status: 'contacted', rfqNumber: rfq.rfqNumber },
          actor_user_id: admin.id,
        },
      ]);
    });

    /** `RFQ_TRANSITIONS` is the only rule about what may follow what, and the refusal carries what
     * *is* allowed so a console renders the real choices instead of guessing. */
    it('refuses an illegal move with 422 carrying allowed, and writes nothing', async () => {
      const { client, csrf } = await asAdmin();
      const rfq = await seedRfq({ status: 'new' });

      const refusal = expectError(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ status: 'approved' })
          .expect(UNPROCESSABLE),
      );

      expect(refusal.code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(refusal.details).toMatchObject({ allowed: ['contacted', 'rejected'] });
      expect((await rowFor(rfq.rfqNumber))?.status).toBe('new');
      expect(await auditRows()).toEqual([]);
    });

    it('refuses a no-op move to the status the enquiry already holds', async () => {
      const { client, csrf } = await asAdmin();
      const rfq = await seedRfq({ status: 'contacted' });

      await client
        .patch(`${BASE}/${rfq.rfqNumber}`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'contacted' })
        .expect(UNPROCESSABLE);

      expect(await auditRows()).toEqual([]);
    });

    it('sets and clears the expected value, recording paise as strings', async () => {
      const { client, csrf } = await asAdmin();
      const rfq = await seedRfq();

      const set = expectSuccess<AdminRfq>(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ expectedValue: 84500 })
          .expect(OK),
      );
      expect(set.expectedValue).toBe(84500);
      expect((await rowFor(rfq.rfqNumber))?.expected).toBe('8450000');

      const cleared = expectSuccess<AdminRfq>(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ expectedValue: null })
          .expect(OK),
      );
      expect(cleared.expectedValue).toBeNull();

      const rows = await auditRows();
      expect(rows.map((row) => row.action)).toEqual(['rfq.update', 'rfq.update']);
      expect(rows[0]?.after).toMatchObject({ expectedValuePaise: '8450000' });
      expect(rows[1]?.after).toMatchObject({ expectedValuePaise: null });
    });

    /**
     * Brief §34's assigned salesperson, on the column the plan says does not exist:
     * `rfqs.assigned_salesperson_id`, in the initial schema since 2026-08-19.
     */
    it('assigns and unassigns a salesperson', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const rfq = await seedRfq();

      const assigned = expectSuccess<AdminRfq>(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ assignedSalespersonId: admin.id })
          .expect(OK),
      );
      expect(assigned.assignedSalesperson).toEqual({
        id: admin.id,
        name: admin.name,
        email: admin.email,
      });

      const unassigned = expectSuccess<AdminRfq>(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ assignedSalespersonId: null })
          .expect(OK),
      );
      expect(unassigned.assignedSalesperson).toBeNull();
      expect((await rowFor(rfq.rfqNumber))?.assigned).toBeNull();
    });

    /** The column is a bare `users(id)` reference, so nothing at the database level stops an
     * enquiry being assigned to a customer — whose name would then appear on the operator's queue. */
    it('refuses to assign an enquiry to an account that is not an admin', async () => {
      const { client, csrf } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const rfq = await seedRfq();

      const refusal = expectError(
        await client
          .patch(`${BASE}/${rfq.rfqNumber}`)
          .set(CSRF_HEADER, csrf)
          .send({ assignedSalespersonId: customer.id })
          .expect(NOT_FOUND),
      );

      expect(refusal.code).toBe('NOT_FOUND');
      expect((await rowFor(rfq.rfqNumber))?.assigned).toBeNull();
    });

    /**
     * **The rollback case, and the reason the audit row lives inside `transition`'s transaction.**
     *
     * This request moves the status *and* names a salesperson who is not an admin. The transition
     * runs first and writes its `rfq.status-change` row; `requireAdmin` then throws, and the whole
     * transaction — audit row included — must die with it. An audit row written outside that
     * transaction would survive and claim a move the enquiry never made, and would be trusted,
     * which is worse than having no trail at all.
     */
    it('rolls the audit row back with the change when a later write in the same request fails', async () => {
      const { client, csrf } = await asAdmin();
      const customer = await createTestUser(integration.dataSource, { role: UserRole.CUSTOMER });
      const rfq = await seedRfq({ status: 'new' });

      await client
        .patch(`${BASE}/${rfq.rfqNumber}`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'contacted', assignedSalespersonId: customer.id })
        .expect(NOT_FOUND);

      expect((await rowFor(rfq.rfqNumber))?.status).toBe('new');
      expect(await auditRows()).toEqual([]);
    });

    /** Plan 9.1's rule: a write that changes nothing leaves no trace. */
    it('writes no audit row for a body that changes nothing', async () => {
      const { client, csrf } = await asAdmin();
      const rfq = await seedRfq();

      await client.patch(`${BASE}/${rfq.rfqNumber}`).set(CSRF_HEADER, csrf).send({}).expect(OK);
      await client
        .patch(`${BASE}/${rfq.rfqNumber}`)
        .set(CSRF_HEADER, csrf)
        .send({ expectedValue: null })
        .expect(OK);

      expect(await auditRows()).toEqual([]);
    });

    it('answers 404 for an unknown reference and 403 for a customer', async () => {
      const { client, csrf } = await asAdmin();
      await client
        .patch(`${BASE}/RFQ-2026-999999`)
        .set(CSRF_HEADER, csrf)
        .send({ status: 'contacted' })
        .expect(NOT_FOUND);

      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .patch(`${BASE}/RFQ-2026-999999`)
        .set(CSRF_HEADER, customer.csrf)
        .send({ status: 'contacted' })
        .expect(FORBIDDEN);
    });

    it('is refused without the CSRF header, like every other unsafe method', async () => {
      const { client } = await asAdmin();
      const rfq = await seedRfq();

      await client
        .patch(`${BASE}/${rfq.rfqNumber}`)
        .send({ status: 'contacted' })
        .expect(FORBIDDEN);
      expect((await rowFor(rfq.rfqNumber))?.status).toBe('new');
    });
  });

  describe('POST /admin/rfqs/:rfqNumber/notes', () => {
    /**
     * **The judgement this task exists to make.** `rfqs.notes` is the prospect's own "additional
     * requirements" from brief §17's public form, shown straight back to them by `RfqDetail.notes`.
     * `rfq_notes` is brief §34's internal history. A note writes the second and leaves the first
     * exactly as the prospect typed it.
     */
    it('writes rfq_notes and leaves the prospect’s own notes column untouched', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const rfq = await seedRfq({ notes: 'Please quote for jute sacks as well.' });

      const detail = expectSuccess<AdminRfq>(
        await client
          .post(`${BASE}/${rfq.rfqNumber}/notes`)
          .set(CSRF_HEADER, csrf)
          .send({ body: '  Buyer is price-sensitive; hold at 620/kg.  ' })
          .expect(OK),
      );

      expect(detail.internalNotes).toHaveLength(1);
      expect(detail.internalNotes[0]).toMatchObject({
        body: 'Buyer is price-sensitive; hold at 620/kg.',
        authorUserId: admin.id,
        authorName: admin.name,
      });
      expect(detail.notes).toBe('Please quote for jute sacks as well.');

      const row = await rowFor(rfq.rfqNumber);
      expect(row?.notes).toBe('Please quote for jute sacks as well.');
      expect(await notesFor(rfq.id)).toEqual([
        { body: 'Buyer is price-sensitive; hold at 620/kg.', author_user_id: admin.id },
      ]);
    });

    it('keeps the note off the prospect’s own view of the same enquiry', async () => {
      const { client: adminClient, csrf } = await asAdmin();
      const { client: ownerClient, user: owner } = await signIn(UserRole.BUSINESS);
      const rfq = await seedRfq({ userId: owner.id });

      await adminClient
        .post(`${BASE}/${rfq.rfqNumber}/notes`)
        .set(CSRF_HEADER, csrf)
        .send({ body: 'Hold at 620/kg.' })
        .expect(OK);

      const ownerView = await ownerClient.get(`${PUBLIC}/${rfq.rfqNumber}`).expect(OK);
      expect(JSON.stringify(ownerView.body)).not.toContain('620/kg');
    });

    /** The `rfq_notes` row is the record. Copying a confidential sales note into `audit_logs` would
     * be a second place it lives and a second place it has to be protected. */
    it('audits that a note was written, without copying its body', async () => {
      const { client, csrf, user: admin } = await asAdmin();
      const rfq = await seedRfq();

      await client
        .post(`${BASE}/${rfq.rfqNumber}/notes`)
        .set(CSRF_HEADER, csrf)
        .send({ body: 'Buyer is price-sensitive.' })
        .expect(OK);

      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'rfq.note-add',
        entity: 'rfq',
        entityId: rfq.id,
        before: null,
        actor_user_id: admin.id,
      });
      expect(rows[0]?.after).toMatchObject({ rfqNumber: rfq.rfqNumber });
      expect(JSON.stringify(rows[0]?.after)).not.toContain('price-sensitive');
    });

    it('refuses a blank note and one that is only whitespace', async () => {
      const { client, csrf } = await asAdmin();
      const rfq = await seedRfq();

      await client
        .post(`${BASE}/${rfq.rfqNumber}/notes`)
        .set(CSRF_HEADER, csrf)
        .send({ body: '' })
        .expect(BAD_REQUEST);
      await client
        .post(`${BASE}/${rfq.rfqNumber}/notes`)
        .set(CSRF_HEADER, csrf)
        .send({ body: '   ' })
        .expect(BAD_REQUEST);

      expect(await notesFor(rfq.id)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('answers 404 for an unknown reference and writes nothing', async () => {
      const { client, csrf } = await asAdmin();
      await client
        .post(`${BASE}/RFQ-2026-999999/notes`)
        .set(CSRF_HEADER, csrf)
        .send({ body: 'Called.' })
        .expect(NOT_FOUND);

      expect(await auditRows()).toEqual([]);
    });

    it('is refused without the CSRF header', async () => {
      const { client } = await asAdmin();
      const rfq = await seedRfq();

      await client
        .post(`${BASE}/${rfq.rfqNumber}/notes`)
        .send({ body: 'Called.' })
        .expect(FORBIDDEN);
      expect(await notesFor(rfq.id)).toEqual([]);
    });
  });
});
