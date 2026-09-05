// backend/src/modules/rfqs/rfq-status.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { canTransitionRfq, nextRfqStatuses, type RfqStatus } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { NotificationChannel } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface RfqTransitionResult {
  rfqId: string;
  rfqNumber: string;
  from: RfqStatus;
  to: RfqStatus;
}

/**
 * What a transition can be told, beyond the status it is moving to.
 *
 * **Added by plan 9.3, and the two members are exactly the two `OrderStatusService` gained in plan
 * 9.2** — `audit` and `manager` — for exactly the reasons that service's `TransitionOptions`
 * records at length. This file's own docblock used to argue that no options bag should exist here,
 * because `note` and `restock` have nowhere to land on an RFQ. That argument was about *those two
 * members* and it still holds: neither is added. What changed is that this service now has an
 * admin caller, and an admin caller brings a requirement neither of them had.
 */
export interface RfqTransitionOptions {
  /**
   * Present for an **admin-initiated** transition: the row `audit_logs` gets, written inside this
   * transition's own transaction.
   *
   * Spec §5 requires every admin status change to leave a trace, and `AuditLogService.record`
   * requires the caller's open transaction — *"an audit row committed separately from the change it
   * describes … can outlive a write that rolled back, claiming a change that never happened"*.
   * `transition` opens that transaction and nobody else holds it, so the write belongs here: an
   * audit call wrapped **around** `transition` in a controller or a service commits separately by
   * construction, whatever care is taken.
   *
   * An option rather than unconditional, because this service has a second, non-admin caller in
   * prospect — nothing today, but `RfqsService.create` writes `status: 'new'` directly and a future
   * automatic move (a quote expiring, say) would have no admin to attribute. `audit_logs` is the
   * *admin* trail; a row in it with an invented actor would be worse than no row.
   *
   * **It carries its own `actorUserId` rather than the options bag carrying a nullable one**, and
   * the shape is deliberate: `AuditLogInput.actorUserId` is not nullable, because an unattributable
   * admin mutation is one that service is unwilling to have made. Requiring it here makes "audit
   * this, by nobody" impossible to express rather than something to check for at runtime.
   */
  audit?: { actorUserId: string };
  /**
   * A transaction to join instead of opening one.
   *
   * `transition` owns its own transaction by default and that is the right default: the status
   * write, the audit row and the queued notification are one act, and no caller should have to
   * assemble that correctly. This exists for the caller whose act is *larger* than the transition —
   * `AdminRfqsService.update`, where `PATCH /admin/rfqs/:rfqNumber` may move the status **and** set
   * the expected value or the assigned salesperson in one request. Without it that route would
   * transition in one transaction and write the fields in another, and a failure between them
   * leaves an enquiry the operator was told had moved but whose value never changed, or the
   * reverse.
   *
   * **A caller that passes this owns the transaction and therefore owns the rollback.** Everything
   * `transition` writes lands in it, `options.audit` included, so atomicity with the caller's own
   * writes is automatic — but a caller that swallowed an exception thrown from here and committed
   * anyway would commit a half-applied change. There is exactly one such caller and it does not
   * catch.
   */
  manager?: EntityManager;
}

/**
 * The one server-side owner of "which RFQ status changes are legal" — `OrderStatusService`'s
 * sibling, at a fraction of the size. An RFQ has no stock consequence and no timeline table (no
 * `RfqEvent` exists), so a legal transition is a status write, an audit row and a queued
 * notification, and nothing else.
 *
 * **`RfqTransitionOptions` carries `audit` and `manager` and deliberately not `note` or `restock`.**
 * `OrderStatusService.transition`'s `options` carries those two — somewhere to attach free text to
 * the timeline, and a judgement about stock — and neither has anywhere to land here: there is no
 * timeline row to carry a note on, and no stock to make a judgement about. Brief §34's internal
 * notes are `rfq_notes`, written by `POST /admin/rfqs/:rfqNumber/notes`, which is a separate act an
 * operator performs deliberately rather than a side effect of moving a status.
 *
 * **This file used to say it had no controller.** Plan 9.3 gave it one:
 * `PATCH /admin/rfqs/:rfqNumber`, through `AdminRfqsService.update`, which is the caller
 * `RfqsModule`'s export was written for. The export stays regardless — §7.1's separate application
 * reaches this through the route, not the provider.
 */
@Injectable()
export class RfqStatusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Moves an RFQ to `to`, records the admin who did it, and queues the notification the prospect
   * gets — all in one transaction, so an audit row claiming a move that rolled back cannot exist.
   *
   * An illegal transition is a 422 carrying `allowed` and writes nothing. An unknown RFQ number is
   * a 404, because an operator who mistyped a reference must not be told the transition was
   * illegal.
   */
  async transition(
    rfqNumber: string,
    to: RfqStatus,
    options: RfqTransitionOptions = {},
  ): Promise<RfqTransitionResult> {
    const joined = options.manager;
    return joined === undefined
      ? this.dataSource.transaction((own) => this.apply(own, rfqNumber, to, options))
      : this.apply(joined, rfqNumber, to, options);
  }

  /**
   * The transition itself, against whichever transaction is in force.
   *
   * Split out from `transition` only so `options.manager` can be honoured; every line below was
   * previously the body of `this.dataSource.transaction(...)` and none of its logic changed.
   * Private, because "run this outside a transaction" is not a thing any caller may ask for — the
   * guarantee this service exists to give is that the status, the audit row and the notification
   * move together. `OrderStatusService.apply` carries the identical split for the identical reason.
   */
  private async apply(
    manager: EntityManager,
    rfqNumber: string,
    to: RfqStatus,
    options: RfqTransitionOptions,
  ): Promise<RfqTransitionResult> {
    const rfq = await manager.getRepository(Rfq).findOne({ where: { rfqNumber } });

    if (!rfq) {
      throw new DomainError(ErrorCodes.NOT_FOUND, `No RFQ ${rfqNumber}.`, HttpStatus.NOT_FOUND, {
        rfqNumber,
      });
    }

    // `ck_rfqs_status` guarantees the column holds one of the seven values, so the cast is a
    // claim the database already enforces — `OrderStatusService.transition`'s identical cast
    // of `order.status` states the same reasoning.
    const from = rfq.status as RfqStatus;

    if (!canTransitionRfq(from, to)) {
      throw new DomainError(
        ErrorCodes.ILLEGAL_STATUS_TRANSITION,
        `An RFQ that is "${from}" cannot become "${to}".`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { rfqNumber, from, to, allowed: nextRfqStatuses(from) },
      );
    }

    /**
     * Guarded on the status just read, the same reasoning `OrderStatusService.transition`
     * states in full: two admins moving the same RFQ at once both read `from`, both pass
     * `canTransitionRfq`, and the second `UPDATE` re-checks its own `WHERE` against the row the
     * first one committed and matches nothing — reporting a conflict rather than silently
     * overwriting or appending a duplicate.
     */
    const moved = await manager
      .getRepository(Rfq)
      .update({ id: rfq.id, status: from }, { status: to });

    if (moved.affected !== 1) {
      throw new DomainError(
        ErrorCodes.ILLEGAL_STATUS_TRANSITION,
        `RFQ ${rfqNumber} is no longer "${from}". Reload it and try again.`,
        HttpStatus.CONFLICT,
        { rfqNumber, from, to },
      );
    }

    /**
     * The audit row, on this transaction's manager — **before** the notification, not after.
     *
     * Position matters for the same reason it does in `OrderStatusService.apply`: everything after
     * this line can still fail, and an audit row written outside this transaction would survive a
     * rollback and claim a status change that never happened. `NotificationsService.queue` swallows
     * a driver error by design, so it is not itself a likely failure — but `options.manager` means
     * a *caller's* later write can be, and that caller's rollback must take this row with it.
     * `admin-rfqs.integration.spec.ts` measures exactly that by making the caller's second write
     * fail and asserting the trail stays empty and the status unmoved.
     *
     * `entityId` is the RFQ's **uuid**, its primary key, matching every other member of
     * `AuditEntity`; `after.rfqNumber` carries the reference an operator can read down a phone line,
     * so `GET /admin/audit-logs` (plan 9.4) can show it without joining `rfqs`.
     */
    if (options.audit !== undefined) {
      await this.audit.record(manager, {
        actorUserId: options.audit.actorUserId,
        action: AuditAction.RFQ_STATUS_CHANGE,
        entityType: AuditEntity.RFQ,
        entityId: rfq.id,
        before: { status: from },
        after: { status: to, rfqNumber: rfq.rfqNumber },
      });
    }

    await this.notifications.queue(manager, {
      userId: rfq.userId,
      channel: NotificationChannel.EMAIL,
      template: 'rfq.status-changed',
      payload: { rfqNumber, from, to },
    });

    return { rfqId: rfq.id, rfqNumber: rfq.rfqNumber, from, to };
  }
}
