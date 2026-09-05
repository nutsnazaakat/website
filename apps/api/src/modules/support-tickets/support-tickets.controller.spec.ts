import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { SupportTicketsController } from './support-tickets.controller';
import type { SupportTicketsService } from './support-tickets.service';

const DTO: CreateContactMessageDto = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order has not arrived after 6 days.',
};

function harness() {
  const calls: { input: unknown; userId: string | null }[] = [];
  const tickets = {
    create: (input: unknown, userId: string | null) => {
      calls.push({ input, userId });
      return Promise.resolve({ ticketNumber: 'ST-2026-100000' });
    },
  };
  return {
    controller: new SupportTicketsController(tickets as unknown as SupportTicketsService),
    calls,
  };
}

describe('SupportTicketsController.create', () => {
  it('forwards the DTO fields and the caller’s id, and answers only the ticket number', async () => {
    const { controller, calls } = harness();
    const user = { id: 'user-1' } as AuthenticatedUser;

    const result = await controller.create(DTO, user);

    expect(result).toEqual({ ticketNumber: 'ST-2026-100000' });
    expect(calls).toEqual([
      {
        input: {
          name: 'Asha Menon',
          email: 'asha@demo.in',
          phone: undefined,
          topic: 'An order I have placed',
          orderNumber: undefined,
          message: 'My order has not arrived after 6 days.',
        },
        userId: 'user-1',
      },
    ]);
  });

  it('attributes the ticket to nobody when the caller has no session', async () => {
    const { controller, calls } = harness();

    await controller.create(DTO, undefined);

    expect(calls[0]?.userId).toBeNull();
  });
});
