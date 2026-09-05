import { Injectable } from '@nestjs/common';
import { toPaise } from '@nutwala/shared';
import { DataSource, In, type DeepPartial } from 'typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { NotificationChannel, RfqKind } from '../../entities/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { nextRfqNumber } from './rfq-number';

/** A bulk enquiry's one line — a product and a weight. Absent (`undefined`/empty) on a gifting
 * enquiry, whose quantity is `CreateRfqInput.gifting` instead. */
export interface CreateRfqLine {
  productSlug: string;
  kg: number;
}

/** Brief §24's five extra questions. Rupees on this boundary, the same as every other input this
 * service reads — `create` is what converts `budgetPerBox` to `budgetPerBoxPaise`. */
export interface CreateRfqGiftingInput {
  occasion: string;
  giftBoxSlug: string;
  boxes: number;
  budgetPerBox: number;
  brandingRequired: boolean;
  deliveryDate: string;
  message?: string;
}

/**
 * Both front doors' input, in one shape — Task 10's two DTOs each build one of these and hand it
 * to the same `create`. `kind` decides which of `lines`/`gifting` is read; the other is ignored
 * rather than validated as absent, because that validation belongs to the two DTOs that cannot
 * both be sent at once, not to this method.
 */
export interface CreateRfqInput {
  kind: RfqKind;
  businessName: string;
  contactPerson: string;
  mobile: string;
  email: string;
  gstin?: string;
  businessType: string;
  pincode: string;
  notes?: string;
  /** Bulk only. */
  lines?: CreateRfqLine[];
  packaging?: string;
  frequency?: string;
  /** Gifting only. */
  gifting?: CreateRfqGiftingInput;
}

@Injectable()
export class RfqsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * One method for both front doors, because a bulk enquiry and a gifting enquiry differ in what
   * they carry and in nothing else: one sequence, one number format, one status vocabulary, and
   * one `GET /rfqs` that lists both. `kind` is what tells them apart afterwards.
   *
   * `items` and `gifting` are both `cascade: ['insert']` on the `Rfq` entity, so one `save` writes
   * the whole enquiry — the shape `CheckoutService.place` uses for an order and its lines.
   *
   * **Re-reads with relations before returning, inside the same transaction.** `save()`'s own
   * return value does not carry `items`/`gifting` back — TypeORM does not reload a cascaded
   * relation after an insert — so returning it directly would hand `toRfqDetail` an `Rfq` whose
   * `items` is `undefined` while the type says `RfqItem[]`. That is the exact shape
   * `CheckoutService.place` shipped once, returning an order whose `events` was `undefined` while
   * `toAccountOrder` read it as `[]` — a confirmation page with no history rather than an error
   * anywhere. The mapper now throws instead of guessing; the re-read here is what keeps that
   * throw from firing on every single enquiry.
   */
  async create(input: CreateRfqInput, userId: string | null): Promise<Rfq> {
    return this.dataSource.transaction(async (manager) => {
      const rfqNumber = await nextRfqNumber(manager);

      const lines = input.lines ?? [];
      // `productId` resolves against the catalogue and is stored alongside the slug, never in
      // place of it — an unmatched slug is stored with a null `productId` rather than refusing
      // the enquiry. A prospect naming a product they saw in a brochure is a sales lead, and a
      // 422 on the public RFQ form turns it away; contrast placement, which does refuse an
      // unknown slug, because an order takes money and an enquiry does not.
      const slugs = [...new Set(lines.map((line) => line.productSlug))];
      const products =
        slugs.length === 0
          ? []
          : await manager.getRepository(Product).find({
              where: { slug: In(slugs) },
              select: { id: true, slug: true },
            });
      const productIdBySlug = new Map(products.map((product) => [product.slug, product.id]));

      const draft: DeepPartial<Rfq> = {
        rfqNumber,
        userId,
        kind: input.kind,
        businessName: input.businessName,
        contactPerson: input.contactPerson,
        mobile: input.mobile,
        email: input.email,
        gstin: input.gstin ?? null,
        businessType: input.businessType,
        pincode: input.pincode,
        packaging: input.packaging ?? null,
        frequency: input.frequency ?? null,
        notes: input.notes ?? null,
        status: 'new',
        assignedSalespersonId: null,
        expectedValuePaise: null,
        items: lines.map((line) => ({
          productSlug: line.productSlug,
          productId: productIdBySlug.get(line.productSlug) ?? null,
          kg: String(line.kg),
        })),
        gifting: input.gifting
          ? {
              occasion: input.gifting.occasion,
              giftBoxSlug: input.gifting.giftBoxSlug,
              boxes: input.gifting.boxes,
              budgetPerBoxPaise: toPaise(input.gifting.budgetPerBox),
              brandingRequired: input.gifting.brandingRequired,
              deliveryDate: input.gifting.deliveryDate,
              message: input.gifting.message ?? '',
            }
          : null,
      };

      // `save`, not `insert`: `items` and `gifting` both carry `cascade: ['insert']`, so the
      // whole graph is written together rather than needing the RFQ's id first.
      const saved = await manager.getRepository(Rfq).save(draft);

      await this.notifications.queue(manager, {
        userId,
        channel: NotificationChannel.EMAIL,
        template: 'rfq.received',
        payload: {
          rfqNumber: saved.rfqNumber,
          businessName: saved.businessName,
          email: saved.email,
          kind: saved.kind,
        },
      });

      const reloaded = await manager.getRepository(Rfq).findOne({
        where: { id: saved.id },
        relations: { items: true, gifting: true },
      });
      if (reloaded === null) {
        throw new Error(`RFQ ${rfqNumber} was created but could not be read back`);
      }
      return reloaded;
    });
  }

  /**
   * The caller's own enquiries, newest first — `OrdersService.list`'s identical shape, for the
   * identical reason. `userId` is a `string`, not `string | null`: both callers of this service
   * reach it through `@CurrentUser()`, which throws before a prospect's request gets here, so
   * there is no guest case to guard against the way `OrdersService` does for a route that is
   * genuinely reachable anonymously.
   *
   * Loads no relations. `toRfqSummary` reads only `Rfq`'s own scalar columns — no line list, no
   * gifting detail — so joining either here would be a cost this row shape never spends.
   */
  async list(userId: string): Promise<Rfq[]> {
    return this.dataSource.getRepository(Rfq).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * One enquiry of the caller's, by the number they can read down a phone line.
   *
   * **The owner is a clause in the query, never a check applied to a row already fetched.**
   * `findOne({ where: { rfqNumber } })` followed by `if (rfq.userId !== userId) return null` also
   * answers correctly today and is one refactor from someone deleting the check while the query
   * still succeeds — `OrdersService`'s own docblock makes the identical argument. `rfqNumber` is
   * unique, so `userId` narrows nothing on the happy path; its whole job is to make a stranger's
   * enquiry unreachable rather than merely unreturned.
   *
   * Answers `null` for both "no such RFQ" and "not yours", and cannot tell them apart — a
   * distinction only the controller could turn into a 403, and `RFQ_NUMBER_PATTERN`'s sequence is
   * exactly as guessable as an order number, so the same rule applies: one 404, never two answers
   * an attacker could tell apart by walking the sequence.
   *
   * Loads `items` and `gifting` — what `toRfqDetail` needs — and **not** `notesList`. Brief §34's
   * own words for that relation: "Never exposed on a customer-facing endpoint." Not loading it
   * here is the actual guard; the mapper omitting it from the wire shape is the second one, for a
   * reader who trusts neither the query nor the mapper alone.
   */
  async findOne(userId: string, rfqNumber: string): Promise<Rfq | null> {
    return this.dataSource.getRepository(Rfq).findOne({
      where: { userId, rfqNumber },
      relations: { items: true, gifting: true },
    });
  }
}
