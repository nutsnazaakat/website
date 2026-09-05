// backend/test/integration/rfq-status.integration.spec.ts
import { HttpStatus } from '@nestjs/common';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { RfqKind } from '../../src/entities/enums';
import { RfqStatusService } from '../../src/modules/rfqs/rfq-status.service';
import { RfqsService } from '../../src/modules/rfqs/rfqs.service';
import { useIntegrationApp } from './helpers';

/**
 * `RfqStatusService` has no controller in this repository, so — like
 * `checkout-concurrency.integration.spec.ts` does for `CheckoutService` — it is reached directly
 * off the DI container rather than through an HTTP route. The concurrent-transition test below
 * borrows its shape and its "which refusal the loser gets is not pinned" reasoning from a
 * different file, though: `orders.integration.spec.ts`'s "answers one of two concurrent
 * cancellations and puts the stock back once" is the actually-relevant precedent for
 * `READ COMMITTED` race semantics, and its docblock is where the full argument lives.
 */
describe('RfqStatusService.transition, against real Postgres', () => {
  const integration = useIntegrationApp();

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  const freshRfq = () =>
    integration.app.get(RfqsService).create(
      {
        kind: RfqKind.BULK,
        businessName: 'Crumb & Co Bakery',
        contactPerson: 'Priya Menon',
        mobile: '9820098200',
        email: 'priya@crumbandco.example',
        businessType: 'Bakery',
        pincode: '400050',
        lines: [{ productSlug: 'premium-california-almonds', kg: 60 }],
        packaging: 'Vacuum packs (5 kg)',
        frequency: 'Fortnightly',
      },
      null,
    );

  // Filtered by template as well as by rfqNumber, deliberately: `RfqsService.create` queuing
  // `rfq.received` is Task 8's own concern to prove, and this file must not become order-
  // dependent on that task having already run.
  const statusChangedNotifications = (rfqNumber: string) =>
    integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
      `SELECT payload FROM notifications
        WHERE template = 'rfq.status-changed' AND payload->>'rfqNumber' = $1`,
      [rfqNumber],
    );

  it('moves a legal transition and queues rfq.status-changed', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    const result = await statuses.transition(rfq.rfqNumber, 'contacted');

    expect(result).toEqual({
      rfqId: rfq.id,
      rfqNumber: rfq.rfqNumber,
      from: 'new',
      to: 'contacted',
    });
    const rows = await statusChangedNotifications(rfq.rfqNumber);
    expect(rows).toEqual([{ payload: { rfqNumber: rfq.rfqNumber, from: 'new', to: 'contacted' } }]);
  });

  it('refuses an illegal transition with 422 and moves nothing', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    await expect(statuses.transition(rfq.rfqNumber, 'approved')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });

    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM rfqs WHERE "rfqNumber" = $1',
      [rfq.rfqNumber],
    );
    expect(row?.status).toBe('new');
    expect(await statusChangedNotifications(rfq.rfqNumber)).toEqual([]);
  });

  it('answers 404 for an unknown rfqNumber', async () => {
    const statuses = integration.app.get(RfqStatusService);

    await expect(statuses.transition('RFQ-2026-999999', 'contacted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('carries a full pipeline through to converted', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    await statuses.transition(rfq.rfqNumber, 'contacted');
    await statuses.transition(rfq.rfqNumber, 'quote-sent');
    await statuses.transition(rfq.rfqNumber, 'approved');
    const final = await statuses.transition(rfq.rfqNumber, 'converted');

    expect(final.to).toBe('converted');
    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM rfqs WHERE "rfqNumber" = $1',
      [rfq.rfqNumber],
    );
    expect(row?.status).toBe('converted');
    expect(await statusChangedNotifications(rfq.rfqNumber)).toHaveLength(4);
  });

  /**
   * **Two transitions at once queue one notification, and no lock was added to make that true.**
   *
   * `transition()` writes with the status it read in the predicate — `update({ id, status: from },
   * { status: to })` — so under `READ COMMITTED` the second `UPDATE` blocks on the first, re-checks
   * its `WHERE` against the committed row, matches nothing, reports `affected !== 1` and raises
   * **before** `notifications.queue` runs. `orders.integration.spec.ts`'s "answers one of two
   * concurrent cancellations" states the identical mechanism in full, for `OrderStatusService`'s own
   * guarded `UPDATE`.
   *
   * **Which refusal the loser gets is deliberately not pinned**, for the same reason that test
   * gives: if the two interleave, both read `new`, both pass `canTransitionRfq`, and the loser is
   * refused by the guarded `UPDATE` itself — a **409**. If the winner commits first, the loser reads
   * `contacted` and is refused earlier by `canTransitionRfq` — a **422**. Pinning one would make this
   * a timing detector rather than a proof that exactly one transition happened.
   *
   * `Promise.allSettled`, not `Promise.all`: the loser's call is expected to reject, and
   * `Promise.all` would short-circuit on that rejection rather than hand back the winner's result
   * alongside it.
   *
   * The notification count is the assertion a plain "one call succeeded" could miss — a mutant that
   * moved the `notifications.queue` call outside the guarded write (or dropped the guard entirely)
   * would still show one `OK` and one refusal here if the two calls happened not to interleave, and
   * only the count below would catch the interleaved case where both slipped past a broken guard and
   * each queued its own row.
   */
  it('answers one of two concurrent transitions and queues exactly one notification', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    const settled = await Promise.allSettled([
      statuses.transition(rfq.rfqNumber, 'contacted'),
      statuses.transition(rfq.rfqNumber, 'contacted'),
    ]);

    const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = settled.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toMatchObject({ code: 'ILLEGAL_STATUS_TRANSITION' });
    expect([HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY]).toContain(loser.status);

    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM rfqs WHERE "rfqNumber" = $1',
      [rfq.rfqNumber],
    );
    expect(row?.status).toBe('contacted');
    expect(await statusChangedNotifications(rfq.rfqNumber)).toHaveLength(1);
  });
});
