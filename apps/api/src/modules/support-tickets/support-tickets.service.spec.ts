import { SupportTicketsService } from './support-tickets.service';

function harness(options: { nextval?: string } = {}) {
  const recorded = { saved: [] as Record<string, unknown>[], queued: [] as unknown[] };

  const manager = {
    getRepository: () => ({
      save: (draft: Record<string, unknown>) => {
        const saved = { ...draft, id: 'ticket-uuid-1' };
        recorded.saved.push(saved);
        return Promise.resolve(saved);
      },
    }),
    query: () => Promise.resolve([{ nextval: options.nextval ?? '100000' }]),
  };

  const dataSource = { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new SupportTicketsService(dataSource as never, notifications as never),
    recorded,
  };
}

const INPUT = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order NN-2026-100000 has not arrived after 6 days.',
};

describe('SupportTicketsService.create', () => {
  it('saves the ticket with a minted number and queues support.received', async () => {
    const { service, recorded } = harness();

    const ticket = await service.create(INPUT, 'user-1');

    expect(ticket.ticketNumber).toMatch(/^ST-\d{4}-100000$/);
    expect(recorded.saved).toEqual([
      {
        ticketNumber: ticket.ticketNumber,
        userId: 'user-1',
        name: 'Asha Menon',
        email: 'asha@demo.in',
        phone: null,
        topic: 'An order I have placed',
        orderNumber: null,
        message: 'My order NN-2026-100000 has not arrived after 6 days.',
        status: 'new',
        priority: 2,
        assignedToUserId: null,
        resolvedAt: null,
        id: 'ticket-uuid-1',
      },
    ]);
    expect(recorded.queued).toEqual([
      {
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'support.received',
        payload: {
          ticketNumber: ticket.ticketNumber,
          email: 'asha@demo.in',
          topic: 'An order I have placed',
        },
      },
    ]);
  });

  it('stores null for a prospect with no account, and for the optional fields left blank', async () => {
    const { service, recorded } = harness();

    await service.create(INPUT, null);

    expect(recorded.saved[0]).toMatchObject({ userId: null, phone: null, orderNumber: null });
  });

  it('records the phone and the order number when the caller sent them', async () => {
    const { service, recorded } = harness();

    await service.create({ ...INPUT, phone: '9876543210', orderNumber: 'NN-2026-100000' }, null);

    expect(recorded.saved[0]).toMatchObject({
      phone: '9876543210',
      orderNumber: 'NN-2026-100000',
    });
  });
});
