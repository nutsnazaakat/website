import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { PublicSettings } from '@nutwala/shared';
import { In, Repository } from 'typeorm';
import { Setting } from '../../entities/ops/setting.entity';

/**
 * Which payment methods the shop is currently accepting, as the admin set them.
 *
 * Both flags, not just the one placement reads today. They are one decision from the business's
 * side — "how may a customer pay" — and reading them in two queries would let an admin's simultaneous
 * edit of the pair be observed half-applied.
 */
export interface PaymentSettings {
  codEnabled: boolean;
  onlinePaymentEnabled: boolean;
}

/**
 * Fallbacks for a row that is missing or holds something that is not a boolean.
 *
 * Chosen for safety in each direction rather than as a pair of defaults: a lost `codEnabled` row
 * must not stop the shop taking the only orders it can take, and a lost `onlinePaymentEnabled` row
 * must not switch on a payment method that has no gateway behind it. They are also the seeded
 * state (`settings.seed.ts`), so a fresh database and a database whose settings table was truncated
 * behave identically.
 */
const FALLBACK: PaymentSettings = { codEnabled: true, onlinePaymentEnabled: false };

/**
 * The reader for admin-editable `Setting` rows that are **not** money.
 *
 * Created for one reason: `codEnabled` was seeded `true` and read by nothing at all, so an admin
 * who switched COD off changed nothing and believed they had stopped taking orders. Spec §10.4's
 * only accepted payment method was governed by a switch with no effect.
 *
 * **Why a new service rather than a second method on `CartReadService`.** `shippingSettings()`
 * there is the only other reader of this table, and its docblock explains why it is public:
 * *"reading the rows itself would be the third copy of the free-shipping threshold in this codebase
 * rather than the second."* That argument is about a duplicated **number** — the ₹79 and the ₹999
 * that also live in `frontend/src/config/settings.ts` and `PincodeChecker.tsx`. It does not extend
 * to a payment flag, which is duplicated nowhere, and a `codEnabled` read has no business on the
 * cart's read service.
 *
 * Two readers of `settings` therefore coexist, and that is **recorded debt rather than an
 * oversight**: Milestone 8 folds `shippingSettings()` in here alongside removing the frontend's
 * hardcoded copies, which is the change that has a reason to touch the cart's tested surface.
 * Moving it now would put cart tests in the blast radius of a checkout task for no gain today.
 */
@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * `GET /settings` — every row an anonymous visitor may see, keyed by setting name.
   *
   * **This is the endpoint `Setting.isPublic`'s docblock has always described and nothing ever
   * built.** That column says "false keeps a setting out of the public `GET /settings` response";
   * spec §6.1 lists the route; `SettingsModule`'s own docblock recorded the absence as deliberate
   * for Milestone 8 and it never happened. Until now `isPublic` was read by nothing outside the
   * entity, the migration and the seed — a flag with no consumer, which is indistinguishable from a
   * flag that does not work.
   *
   * **It is what unblocks the storefront's deliberately-empty contact details.**
   * `nutwala-client`'s `src/config/settings.ts` is still the Phase-1 mock, with the WhatsApp
   * number, support email, GSTIN and certifications left empty because brief §26 and §37 forbid
   * inventing them and require every one to be admin-editable. Those keys are seeded empty for the
   * same reason, and this is the route that now carries whatever the business has configured.
   * Rewiring the client is a different repository and not this plan's job.
   *
   * A `Record`, not an array: a consumer wants `settings.whatsappNumber`, and the private rows are
   * absent from the response rather than merely flagged in it.
   */
  async publicSettings(): Promise<PublicSettings> {
    const rows = await this.settings.find({ where: { isPublic: true }, order: { key: 'ASC' } });
    const result = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    // Never advertise a gateway that has no server-side credentials.
    result.onlinePaymentEnabled = result.onlinePaymentEnabled === true && this.gatewayReady();
    return result;
  }

  /**
   * Both payment flags, in one query, with the same read shape `shippingSettings()` uses.
   *
   * `typeof row?.value === 'boolean'` rather than a truthiness test or a cast: `Setting.value` is
   * `jsonb` typed `unknown`, so the column can legitimately hold a string, a number or an array,
   * and `Boolean('false')` is `true`. A row an admin tool wrote as the *string* `"false"` would
   * otherwise read as COD enabled — the exact failure this service exists to fix, reintroduced one
   * layer down.
   *
   * `In([...])` rather than two `find` calls or `findOne` per key, so the pair is one snapshot.
   */
  async payment(): Promise<PaymentSettings> {
    const rows = await this.settings.find({
      where: { key: In(['codEnabled', 'onlinePaymentEnabled']) },
    });

    const flag = (key: keyof PaymentSettings): boolean => {
      const row = rows.find((candidate) => candidate.key === key);
      return typeof row?.value === 'boolean' ? row.value : FALLBACK[key];
    };

    return {
      codEnabled: flag('codEnabled'),
      onlinePaymentEnabled: flag('onlinePaymentEnabled') && this.gatewayReady(),
    };
  }
  private gatewayReady(): boolean {
    return !!(
      this.config?.get('app.payments.keyId') &&
      this.config?.get('app.payments.keySecret') &&
      this.config?.get('app.payments.webhookSecret')
    );
  }
}
