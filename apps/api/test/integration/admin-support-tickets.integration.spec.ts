import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type {
  AdminSupportTicket,
  AdminSupportTicketSummary,
  Paginated,
  SupportTicketSummary,
} from '@nutwala/shared';
import { TICKET_NUMBER_PATTERN } from '@nutwala/shared';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, cookieValue, expectError, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_TICKETS = '/api/v1/admin/support/tickets';
const CONTACT = '/api/v1/contact';
const HEALTH = '/api/v1/health';
const LOGIN = '/api/v1/auth/login';
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/support/tickets` — spec §6.4, brief §38. Plan 9.4 Task 4.
 *
 * Milestone 8 built `POST /contact` and deliberately no read routes; these are them, so every
 * fixture below is raised **through the contact form** rather than inserted. That is the only way
 * to be sure the ticket number an operator addresses is the one the customer was given.
 */
describe('admin support tickets', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
  });

  const signIn = async (role: UserRole, overrides: Record<string, unknown> = {}) => {
    const user = await createTestUser(integration.dataSource, { role, ...overrides });
    const client = agent(integration.app);
    const login = await client
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);
  type Admin = Awaited<ReturnType<typeof asAdmin>>;

  const CONTACT_BODY = {
    name: 'Ravi Menon',
    email: 'ravi@example.in',
    phone: '9876500011',
    topic: 'Bulk and wholesale pricing',
    message: 'What is the per-kg price on 25kg of W240 cashews, delivered to Kochi?',
  };

  /**
   * Raised the way a visitor raises one: anonymously, through the contact form.
   *
   * The `GET /health` primer is `support-tickets.integration.spec.ts`'s own `guest()` helper:
   * `CsrfBootstrapMiddleware` issues `nn_csrf` on a *response*, so an anonymous client has nothing
   * to echo until it has made one request.
   */
  const raise = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const client = agent(integration.app);
    const primer = await client.get(HEALTH).expect(200);
    const response = await client
      .post(CONTACT)
      .set(CSRF_HEADER, cookieValue(primer, CSRF_COOKIE))
      .send({ ...CONTACT_BODY, ...overrides })
      .expect(201);
    return expectSuccess<SupportTicketSummary>(response).ticketNumber;
  };

  const patch = async (
    admin: Admin,
    ticketNumber: string,
    body: Record<string, unknown>,
    status = 200,
  ) =>
    admin.client
      .patch(`${ADMIN_TICKETS}/${ticketNumber}`)
      .set(CSRF_HEADER, admin.csrf)
      .send(body)
      .expect(status);

  const addNote = async (
    admin: Admin,
    ticketNumber: string,
    body: Record<string, unknown>,
    status = 200,
  ) =>
    admin.client
      .post(`${ADMIN_TICKETS}/${ticketNumber}/notes`)
      .set(CSRF_HEADER, admin.csrf)
      .send(body)
      .expect(status);

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  describe('GET /admin/support/tickets', () => {
    it('lists what the contact form wrote, newest first', async () => {
      const first = await raise();
      const second = await raise({ topic: 'Shipping or delivery', name: 'Neha S.' });
      const admin = await asAdmin();

      const page = expectSuccess<Paginated<AdminSupportTicketSummary>>(
        await admin.client.get(ADMIN_TICKETS).expect(200),
      );

      expect(page.total).toBe(2);
      expect(page.items.map((ticket) => ticket.ticketNumber)).toEqual([second, first]);
      expect(page.items[1]).toMatchObject({
        ticketNumber: first,
        name: CONTACT_BODY.name,
        email: CONTACT_BODY.email,
        phone: CONTACT_BODY.phone,
        topic: CONTACT_BODY.topic,
        // The column's defaults, surfaced rather than assumed.
        status: 'new',
        priority: 2,
        assignedToUserId: null,
        resolvedAt: null,
        // Raised anonymously, so no account behind it.
        userId: null,
      });
      expect(first).toMatch(TICKET_NUMBER_PATTERN);
      // A page of tickets is not a page of essays.
      expect(page.items[0]).not.toHaveProperty('message');
    });

    it('filters by status, topic and assignee', async () => {
      const first = await raise();
      await raise({ topic: 'Shipping or delivery' });
      const admin = await asAdmin();
      await patch(admin, first, { status: 'open', assignedToUserId: admin.user.id });

      const open = expectSuccess<Paginated<AdminSupportTicketSummary>>(
        await admin.client.get(`${ADMIN_TICKETS}?status=open`).expect(200),
      );
      expect(open.items.map((ticket) => ticket.ticketNumber)).toEqual([first]);

      const shipping = expectSuccess<Paginated<AdminSupportTicketSummary>>(
        await admin.client
          .get(`${ADMIN_TICKETS}?topic=${encodeURIComponent('Shipping or delivery')}`)
          .expect(200),
      );
      expect(shipping.total).toBe(1);

      const mine = expectSuccess<Paginated<AdminSupportTicketSummary>>(
        await admin.client.get(`${ADMIN_TICKETS}?assignedToUserId=${admin.user.id}`).expect(200),
      );
      expect(mine.items.map((ticket) => ticket.ticketNumber)).toEqual([first]);

      await admin.client.get(`${ADMIN_TICKETS}?status=archived`).expect(400);
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_TICKETS).expect(403);
      await agent(integration.app).get(ADMIN_TICKETS).expect(401);
    });
  });

  describe('GET /admin/support/tickets/:ticketNumber', () => {
    it('answers with the message and an empty note trail', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      const ticket = expectSuccess<AdminSupportTicket>(
        await admin.client.get(`${ADMIN_TICKETS}/${ticketNumber}`).expect(200),
      );

      expect(ticket.ticketNumber).toBe(ticketNumber);
      expect(ticket.message).toBe(CONTACT_BODY.message);
      expect(ticket.notes).toEqual([]);
    });

    it('carries the order number the customer typed, unresolved and unvalidated', async () => {
      // `SupportTicket.orderNumber` is a soft link: it may name no real order and the ticket must
      // still exist, so nothing here joins it to `orders`.
      const ticketNumber = await raise({ orderNumber: 'NN-2026-999999' });
      const admin = await asAdmin();

      const ticket = expectSuccess<AdminSupportTicket>(
        await admin.client.get(`${ADMIN_TICKETS}/${ticketNumber}`).expect(200),
      );
      expect(ticket.orderNumber).toBe('NN-2026-999999');
    });

    /** A malformed reference and an unknown one are both "no such ticket" — see `loadOrThrow`. */
    it('404s for an unknown number and for a malformed one alike', async () => {
      const admin = await asAdmin();
      await admin.client.get(`${ADMIN_TICKETS}/ST-2026-000999`).expect(404);
      await admin.client.get(`${ADMIN_TICKETS}/not-a-ticket`).expect(404);
    });
  });

  describe('PATCH /admin/support/tickets/:ticketNumber', () => {
    it('moves status, priority and assignment in one write, and audits what changed', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      const updated = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, {
          status: 'open',
          priority: 1,
          assignedToUserId: admin.user.id,
        }),
      );

      expect(updated).toMatchObject({
        status: 'open',
        priority: 1,
        assignedToUserId: admin.user.id,
        resolvedAt: null,
      });

      const rows = await auditRows(ticketNumber);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('support-ticket.update');
      expect(rows[0]?.entity).toBe('support-ticket');
      expect(rows[0]?.actor_user_id).toBe(admin.user.id);
      expect(rows[0]?.before).toEqual({ status: 'new', priority: 2, assignedToUserId: null });
      expect(rows[0]?.after).toEqual({
        status: 'open',
        priority: 1,
        assignedToUserId: admin.user.id,
      });
    });

    /** The three rules in `resolvedAtFor`, each one a case an operator meets. */
    it('keeps resolvedAt in step with the status in all three directions', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      const resolved = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'resolved' }),
      );
      expect(resolved.resolvedAt).not.toBeNull();

      // Reopened: a resolution date on an open ticket would be false.
      const reopened = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'open' }),
      );
      expect(reopened.resolvedAt).toBeNull();

      // Re-resolved: a *new* date, because the first resolution did not hold.
      const again = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'resolved' }),
      );
      expect(again.resolvedAt).not.toBeNull();

      // Closing a resolved ticket does not unresolve it.
      const closed = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'closed' }),
      );
      expect(closed.resolvedAt).toBe(again.resolvedAt);
    });

    it('leaves resolvedAt null for a ticket closed without ever being resolved', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      const closed = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'closed' }),
      );
      expect(closed.status).toBe('closed');
      expect(closed.resolvedAt).toBeNull();
    });

    /** A queue is not a state machine: a resolved ticket goes back to new if someone replies. */
    it('allows a move backwards through the vocabulary', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      await patch(admin, ticketNumber, { status: 'resolved' });
      const back = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { status: 'new' }),
      );
      expect(back.status).toBe('new');
    });

    it('refuses assigning a ticket to a customer', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();
      const customer = await signIn(UserRole.CUSTOMER);

      const body = expectError(
        await patch(admin, ticketNumber, { assignedToUserId: customer.user.id }, 422),
      );
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toMatchObject({ field: 'assignedToUserId' });
    });

    it('puts a ticket back in the pool with an explicit null', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      await patch(admin, ticketNumber, { assignedToUserId: admin.user.id });
      const unassigned = expectSuccess<AdminSupportTicket>(
        await patch(admin, ticketNumber, { assignedToUserId: null }),
      );
      expect(unassigned.assignedToUserId).toBeNull();
    });

    /** Plan 9.1's rule, and the right answer for a form that submits every field. */
    it('writes no audit row for a body that changes nothing, or an empty one', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      await patch(admin, ticketNumber, { status: 'new', priority: 2 });
      await patch(admin, ticketNumber, {});

      expect(await auditRows(ticketNumber)).toEqual([]);
    });

    it('404s for a ticket that does not exist', async () => {
      const admin = await asAdmin();
      await patch(admin, 'ST-2026-000999', { status: 'open' }, 404);
    });
  });

  describe('POST /admin/support/tickets/:ticketNumber/notes', () => {
    it('appends a note with its author’s name, oldest first', async () => {
      const ticketNumber = await raise();
      // A named admin, because the assertion is that the note carries the author's *name* rather
      // than a bare uuid — `createTestUser`'s default would make that indistinguishable.
      const agentA = await signIn(UserRole.ADMIN, { name: 'Priya (support)' });

      const first = expectSuccess<AdminSupportTicket>(
        await addNote(agentA, ticketNumber, { body: 'Called back; quoting 25kg.' }),
      );
      expect(first.notes).toHaveLength(1);
      expect(first.notes[0]).toMatchObject({
        body: 'Called back; quoting 25kg.',
        // Staff-only unless the caller says otherwise, matching the column default.
        isInternal: true,
        authorUserId: agentA.user.id,
        authorName: 'Priya (support)',
      });

      const second = expectSuccess<AdminSupportTicket>(
        await addNote(agentA, ticketNumber, { body: 'Quote sent.', isInternal: false }),
      );
      expect(second.notes.map((note) => note.body)).toEqual([
        'Called back; quoting 25kg.',
        'Quote sent.',
      ]);
      expect(second.notes[1]?.isInternal).toBe(false);
    });

    /**
     * A note is an append, not a change: two identical notes are two things somebody said. The
     * no-op rule is about a change that did not happen, and treating a repeated note as one would
     * swallow a second agent's identical observation.
     */
    it('writes an audit row for every note, including an identical repeat', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      await addNote(admin, ticketNumber, { body: 'Chasing.' });
      await addNote(admin, ticketNumber, { body: 'Chasing.' });

      const rows = await auditRows(ticketNumber);
      expect(rows.map((row) => row.action)).toEqual(['support-ticket.note', 'support-ticket.note']);
      // The note's id and visibility, not its text — the note itself lives in its own table.
      expect(rows[0]?.after).toHaveProperty('noteId');
      expect(rows[0]?.after).toMatchObject({ isInternal: true });
      expect(rows[0]?.after).not.toHaveProperty('body');
    });

    /** Adding a note is not triage: the ticket's own columns are untouched. */
    it('does not move the ticket’s status', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      const ticket = expectSuccess<AdminSupportTicket>(
        await addNote(admin, ticketNumber, { body: 'Noted.' }),
      );
      expect(ticket.status).toBe('new');
      expect(ticket.assignedToUserId).toBeNull();
    });

    it('refuses an empty note and 404s for an unknown ticket', async () => {
      const ticketNumber = await raise();
      const admin = await asAdmin();

      await addNote(admin, ticketNumber, { body: '' }, 400);
      await addNote(admin, 'ST-2026-000999', { body: 'Hello?' }, 404);
    });

    it('refuses a customer', async () => {
      const ticketNumber = await raise();
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .post(`${ADMIN_TICKETS}/${ticketNumber}/notes`)
        .set(CSRF_HEADER, customer.csrf)
        .send({ body: 'Let me in.' })
        .expect(403);
    });
  });
});
