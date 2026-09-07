import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { Setting } from '../../entities/ops/setting.entity';
import { SettingsService } from './settings.service';

/**
 * A repository that answers the rows it is asked for, honouring the `In([...])` criterion rather
 * than returning everything.
 *
 * Honouring it is the point: a fake that ignored the `where` would pass `payment()` even if it
 * queried the wrong keys entirely, and "reads both flags in one query" is one of the two things
 * this service is for.
 *
 * `find` is returned separately rather than read back off the repository, because
 * `@typescript-eslint/unbound-method` — at error in this repo — rejects `repository.find` as a bare
 * method reference on a typed `Repository`.
 */
function service(rows: { key: string; value: unknown }[]) {
  const find = jest.fn(({ where }: { where: { key: { _value: string[] } } }) => {
    const keys = where.key._value;
    return Promise.resolve(rows.filter((row) => keys.includes(row.key)));
  });
  return { service: new SettingsService({ find } as unknown as Repository<Setting>), find };
}

describe('SettingsService.payment', () => {
  it('reads both flags from the seeded rows', async () => {
    const { service: settings } = service([
      { key: 'codEnabled', value: true },
      { key: 'onlinePaymentEnabled', value: false },
      // Present so the query is shown to select rather than take the whole table: a service that
      // read every row and picked by index would answer wrongly here.
      { key: 'flatShippingRate', value: 79 },
    ]);

    await expect(settings.payment()).resolves.toEqual({
      codEnabled: true,
      onlinePaymentEnabled: false,
    });
  });

  /**
   * The state this service was created for. `codEnabled` was read by nothing, so an admin who
   * turned COD off changed nothing and believed they had stopped taking orders.
   */
  it('reports COD off when the admin has switched it off', async () => {
    const { service: settings } = service([
      { key: 'codEnabled', value: false },
      { key: 'onlinePaymentEnabled', value: false },
    ]);

    await expect(settings.payment()).resolves.toEqual({
      codEnabled: false,
      onlinePaymentEnabled: false,
    });
  });

  /**
   * Both off is a coherent state, not a contradiction to guard against: it means the business is not
   * taking orders, which is a legitimate thing for an admin to want — a supply failure, a holiday, a
   * pricing error being fixed. Nothing here forces at least one method on, because that would take
   * the decision away from the person whose decision it is. Asserted by the case above; asserted
   * here that turning online *on* is also just reported, not overridden.
   */
  it('keeps online payments disabled without gateway credentials', async () => {
    const { service: settings } = service([
      { key: 'codEnabled', value: false },
      { key: 'onlinePaymentEnabled', value: true },
    ]);

    await expect(settings.payment()).resolves.toEqual({
      codEnabled: false,
      onlinePaymentEnabled: false,
    });
  });

  /**
   * Both fallbacks, and they point in opposite directions on purpose. A lost `codEnabled` row must
   * not stop the shop taking the only orders it can take; a lost `onlinePaymentEnabled` row must not
   * switch on a payment method with no gateway behind it. A single "default false" or "default true"
   * would get one of the two wrong.
   */
  it('falls back to COD on and online off when the rows are missing', async () => {
    const { service: settings } = service([]);

    await expect(settings.payment()).resolves.toEqual({
      codEnabled: true,
      onlinePaymentEnabled: false,
    });
  });

  /**
   * `Setting.value` is `jsonb` typed `unknown`, so the column really can hold the string `"false"` —
   * an admin tool that posted a form field, a hand-run `UPDATE`. `Boolean('false')` is `true`, so a
   * truthiness test would read that as COD *enabled*: the exact failure this service exists to fix,
   * reintroduced one layer down. A non-boolean is not a value to coerce; it is a row that cannot be
   * read, and the fallback is the answer.
   */
  it('ignores a non-boolean value rather than coercing it', async () => {
    const { service: settings } = service([
      { key: 'codEnabled', value: 'false' },
      { key: 'onlinePaymentEnabled', value: 'true' },
    ]);

    await expect(settings.payment()).resolves.toEqual({
      codEnabled: true,
      onlinePaymentEnabled: false,
    });
  });

  it('asks for exactly the two payment keys, in one query', async () => {
    const { service: settings, find } = service([]);

    await settings.payment();

    expect(find).toHaveBeenCalledTimes(1);
    const [criteria] = find.mock.calls.at(0) as [{ where: { key: { _value: string[] } } }];
    expect(criteria.where.key._value).toEqual(['codEnabled', 'onlinePaymentEnabled']);
  });
});

it('enables online only when the flag and all gateway credentials are configured', async () => {
  const find = jest.fn(async () => [
    { key: 'onlinePaymentEnabled', value: true },
    { key: 'codEnabled', value: false },
  ]);
  const config = new ConfigService({
    app: { payments: { keyId: 'key', keySecret: 'secret', webhookSecret: 'webhook' } },
  });
  const enabled = new SettingsService({ find } as unknown as Repository<Setting>, config);
  expect((await enabled.payment()).onlinePaymentEnabled).toBe(true);
  config.set('app.payments.webhookSecret', '');
  expect((await enabled.payment()).onlinePaymentEnabled).toBe(false);
});
