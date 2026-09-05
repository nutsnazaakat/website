import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import { TICKET_NUMBER_PATTERN, type SupportTicketSummary } from '@nutwala/shared';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
} from './helpers';

const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const CONTACT = '/api/v1/contact';
const HEALTH = '/api/v1/health';
const LOGIN = '/api/v1/auth/login';
/** `seedUsers`'s own `DEV_PASSWORD`, which it does not export — the literal every other
 * integration spec that signs a seeded account in already spells out. */
const SEEDED_PASSWORD = 'Password123!';

const BODY = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order has not arrived after 6 days, and the tracking page shows nothing at all.',
};

describe('contact', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedUsers(integration.dataSource);
  });

  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(HEALTH).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  async function signedIn(email: string) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: SEEDED_PASSWORD }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  it('lets an anonymous visitor raise a ticket, and mints a real reference', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    expect(ticket.ticketNumber).toMatch(TICKET_NUMBER_PATTERN);
    const [row] = await integration.dataSource.query<{ user_id: string | null; status: string }[]>(
      'SELECT user_id, status FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row).toMatchObject({ user_id: null, status: 'new' });
  });

  it('attributes the ticket to a signed-in caller', async () => {
    const { client, csrf } = await signedIn('b2c@demo.in');

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    const [row] = await integration.dataSource.query<{ user_id: string | null }[]>(
      'SELECT user_id FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row?.user_id).not.toBeNull();
  });

  it('queues support.received', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    const rows = await integration.dataSource.query<{ template: string; user_id: string | null }[]>(
      `SELECT template, user_id FROM notifications WHERE payload->>'ticketNumber' = $1`,
      [ticket.ticketNumber],
    );
    expect(rows).toEqual([{ template: 'support.received', user_id: null }]);
  });

  it('creates a ticket even for an order number that does not exist', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, orderNumber: 'NN-2026-999999' })
        .expect(201),
    );

    const [row] = await integration.dataSource.query<{ orderNumber: string | null }[]>(
      'SELECT "orderNumber" FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row?.orderNumber).toBe('NN-2026-999999');
  });

  it('refuses a message shorter than 10 characters, with the field named', async () => {
    const { client, csrf } = await guest();

    const error = expectError(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, message: 'too short' })
        .expect(400),
    );
    expect(error.details).toHaveProperty('message');
  });

  it('refuses a topic outside CONTACT_TOPICS', async () => {
    const { client, csrf } = await guest();

    await client
      .post(CONTACT)
      .set(CSRF_HEADER, csrf)
      .send({ ...BODY, topic: 'Something not on the list' })
      .expect(400);
  });

  it('names an unexpected property rather than ignoring it', async () => {
    const { client, csrf } = await guest();

    const error = expectError(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, isVip: true })
        .expect(400),
    );
    expect(error.details).toHaveProperty('isVip');
  });

  it('refuses a request with no CSRF header', async () => {
    const client = request(integration.app);
    await client.post(CONTACT).send(BODY).expect(403);
  });

  it('throttles at 5 per hour per IP', async () => {
    const { client, csrf } = await guest();
    for (let i = 0; i < 5; i += 1) {
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201);
    }
    await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(429);
  });
});
