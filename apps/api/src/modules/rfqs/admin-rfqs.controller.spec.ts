import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminRfqsController } from './admin-rfqs.controller';
import type { AdminRfqsService } from './admin-rfqs.service';
import { AddRfqNoteDto } from './dto/add-rfq-note.dto';
import { AdminRfqQueryDto } from './dto/admin-rfq-query.dto';
import { UpdateRfqDto } from './dto/update-rfq.dto';
import { RfqsController } from './rfqs.controller';

const RFQ_NUMBER = 'RFQ-2026-000123';
const PAGE = { items: [], total: 0, page: 1, limit: 24 };
const ADMIN: AuthenticatedUser = {
  id: 'f0000000-0000-4000-8000-00000000000c',
  role: UserRole.ADMIN,
  sessionId: 'session-1',
};

function harness() {
  const rfqs = {
    list: jest.fn().mockResolvedValue(PAGE),
    get: jest.fn().mockResolvedValue({ id: RFQ_NUMBER }),
    update: jest.fn().mockResolvedValue({ id: RFQ_NUMBER }),
    addNote: jest.fn().mockResolvedValue({ id: RFQ_NUMBER }),
  };
  return {
    controller: new AdminRfqsController(rfqs as unknown as AdminRfqsService),
    rfqs,
  };
}

/** The production pipe, imported rather than rebuilt — see `admin-orders.controller.spec.ts`. */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'query', metatype: AdminRfqQueryDto }));
const validateUpdate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: UpdateRfqDto }));
const validateNote = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: AddRfqNoteDto }));

function declaredRoutes(): { name: string; method: string; path: string }[] {
  const prototype: object = AdminRfqsController.prototype;
  const routes: { name: string; method: string; path: string }[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path !== 'string') continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    routes.push({ name, method: RequestMethod[verb], path });
  }

  return routes;
}

describe('AdminRfqsController', () => {
  it('is restricted to admins at class level, carrying the database enum', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminRfqsController)).toEqual([UserRole.ADMIN]);
  });

  /**
   * The public RFQ controller carries no `@Roles()` at all — two of its routes are `@Public()`.
   * That is exactly why the admin routes are a separate class: `RolesGuard` fails *open* for a
   * route with no `@Roles()`, so an admin handler that ended up on that class and lost its own
   * decorator would be reachable by every prospect on the internet, `rfq_notes` included.
   */
  it('leaves the public RFQ controller unguarded, which is why these are a separate class', () => {
    expect(Reflect.getMetadata(ROLES_KEY, RfqsController)).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, RfqsController)).toBe('rfqs');
    expect(Reflect.getMetadata(PATH_METADATA, AdminRfqsController)).toBe('admin/rfqs');
  });

  /**
   * **`:rfqNumber`, not `:id`.** Spec §6.4 spells these `/admin/rfqs/:id`, and an RFQ does have a
   * uuid — but `RfqSummary.id` *is* the number and nothing addresses one by the uuid. Pinned here
   * because the two spell identically to `tsc`: both are `@Param(...): string`.
   */
  it('addresses an enquiry by its number, not by a uuid', () => {
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'get', method: 'GET', path: ':rfqNumber' },
      { name: 'update', method: 'PATCH', path: ':rfqNumber' },
      { name: 'addNote', method: 'POST', path: ':rfqNumber/notes' },
    ]);
  });

  /**
   * The audit trail's "who" and a note's author come from the signed token, never the request.
   *
   * `whitelist: true` strips an unknown body property before the handler sees it, so this is the
   * second line of defence rather than the first — and worth pinning because the defence *is* the
   * key order in the object literal, a one-token change no assertion about the response would
   * notice.
   */
  it('takes the actor from the token even if the body carries one', async () => {
    const { controller, rfqs } = harness();
    const forgedUpdate = { status: 'contacted', actorUserId: 'someone-else' } as UpdateRfqDto;
    const forgedNote = { body: 'Called.', actorUserId: 'someone-else' } as AddRfqNoteDto;

    await controller.update(RFQ_NUMBER, ADMIN, forgedUpdate);
    await controller.addNote(RFQ_NUMBER, ADMIN, forgedNote);

    expect(rfqs.update).toHaveBeenCalledWith(
      RFQ_NUMBER,
      expect.objectContaining({ actorUserId: ADMIN.id }),
    );
    expect(rfqs.addNote).toHaveBeenCalledWith(
      RFQ_NUMBER,
      expect.objectContaining({ actorUserId: ADMIN.id }),
    );
  });

  /** Nest answers a `POST` with 201 by default; the body here is the whole enquiry, not the created
   * note, so a 201 with no `Location` would describe something other than what it returned. */
  it('answers the note route 200, not 201', () => {
    const handler: unknown = Object.getOwnPropertyDescriptor(
      AdminRfqsController.prototype,
      'addNote',
    )?.value;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler as object)).toBe(200);
  });

  it('hands the query and the reference through to the service', async () => {
    const { controller, rfqs } = harness();
    await controller.list({ status: 'new', kind: 'bulk' });
    await controller.get(RFQ_NUMBER);
    expect(rfqs.list).toHaveBeenCalledWith({ status: 'new', kind: 'bulk' });
    expect(rfqs.get).toHaveBeenCalledWith(RFQ_NUMBER);
  });
});

describe('AdminRfqQueryDto', () => {
  it('accepts every one of brief §34’s seven statuses and refuses an eighth', async () => {
    for (const status of [
      'new',
      'contacted',
      'quote-sent',
      'negotiation',
      'approved',
      'rejected',
      'converted',
    ]) {
      await expect(validate({ status })).resolves.toEqual({ status });
    }
    await expect(validate({ status: 'archived' })).rejects.toThrow();
  });

  it('accepts both kinds and refuses the column’s uppercase spelling', async () => {
    await expect(validate({ kind: 'bulk' })).resolves.toEqual({ kind: 'bulk' });
    await expect(validate({ kind: 'gifting' })).resolves.toEqual({ kind: 'gifting' });
    await expect(validate({ kind: 'BULK' })).rejects.toThrow();
  });

  it('refuses an undeclared filter rather than ignoring it', async () => {
    await expect(validate({ assignedSalespersonId: 'someone' })).rejects.toThrow();
  });

  it('coerces the page window from strings and refuses a size above the cap', async () => {
    await expect(validate({ page: '2', limit: '5' })).resolves.toEqual({ page: 2, limit: 5 });
    await expect(validate({ limit: '61' })).rejects.toThrow();
  });
});

describe('UpdateRfqDto', () => {
  it('accepts a body that names nothing — an omitted field is left unchanged', async () => {
    await expect(validateUpdate({})).resolves.toEqual({});
  });

  /**
   * **`null` and "omitted" have to be different**, or there is no way to unassign an enquiry or
   * clear its value. `@IsOptional()` alone treats `null` as absent, so the pair `@IsOptional()` +
   * `@IsUUID()` would accept `null` *and* discard it silently.
   */
  it('carries an explicit null through, which is the only way to clear either field', async () => {
    await expect(
      validateUpdate({ assignedSalespersonId: null, expectedValue: null }),
    ).resolves.toEqual({ assignedSalespersonId: null, expectedValue: null });
  });

  it('refuses a salesperson id that is not a uuid', async () => {
    await expect(validateUpdate({ assignedSalespersonId: 'priya' })).rejects.toThrow();
  });

  it('refuses a status outside brief §34’s seven', async () => {
    await expect(validateUpdate({ status: 'archived' })).rejects.toThrow();
  });

  /** Sub-paise input is refused here so the answer is a 400 naming the field rather than a 422 out
   * of `toPaise`. */
  it('refuses sub-paise and negative expected values, and an absurd one', async () => {
    await expect(validateUpdate({ expectedValue: 1.234 })).rejects.toThrow();
    await expect(validateUpdate({ expectedValue: -1 })).rejects.toThrow();
    await expect(validateUpdate({ expectedValue: 10_000_001 })).rejects.toThrow();
    await expect(validateUpdate({ expectedValue: 84500.5 })).resolves.toEqual({
      expectedValue: 84500.5,
    });
  });

  /** `rfqs.notes` is the prospect's own text, shown straight back to them on
   * `GET /rfqs/:rfqNumber`. This route may not write it. */
  it('refuses a notes field, which belongs to the prospect and not to the operator', async () => {
    await expect(validateUpdate({ notes: 'overwritten' })).rejects.toThrow();
  });
});

describe('AddRfqNoteDto', () => {
  it('accepts a note', async () => {
    await expect(validateNote({ body: 'Rang the buyer.' })).resolves.toEqual({
      body: 'Rang the buyer.',
    });
  });

  it('refuses an empty body and one over the cap', async () => {
    await expect(validateNote({ body: '' })).rejects.toThrow();
    await expect(validateNote({ body: 'x'.repeat(4001) })).rejects.toThrow();
  });

  it('refuses an author supplied by the caller rather than taken from the token', async () => {
    await expect(validateNote({ body: 'Called.', authorUserId: 'someone-else' })).rejects.toThrow();
  });
});
