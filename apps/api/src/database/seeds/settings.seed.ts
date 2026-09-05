import type { DataSource } from 'typeorm';
import { Setting } from '../../entities/ops/setting.entity';
import {
  BUSINESS_TIMEZONE_KEY,
  DEFAULT_BUSINESS_TIMEZONE,
} from '../../modules/settings/business-timezone';

/**
 * Seeds exactly the keys `frontend/src/config/settings.ts` declares, plus the three payment
 * and shipping flags.
 *
 * Certification fields seed **empty**. Brief §25 and §26 forbid claims that have not been
 * configured, and a placeholder FSSAI number would be precisely the unsupported claim the
 * brief rules out. `certifications` renders nothing until an admin fills it in.
 */
/**
 * The JSON shapes the settings table actually holds. Narrower than `Setting.value`'s `unknown`
 * on purpose: `unknown` is right on the entity, where a future setting may be any JSON, but a
 * literal list wants a type that documents what is in it — and TypeORM's
 * `QueryDeepPartialEntity` cannot accept a bare `unknown`.
 */
type SettingValue = string | number | boolean | string[];

const SETTINGS: { key: string; value: SettingValue; isPublic: boolean }[] = [
  { key: 'brandName', value: 'Nuts & Nazaakat', isPublic: true },
  { key: 'tagline', value: 'Small packs for home. Bulk supply for business.', isPublic: true },
  { key: 'whatsappNumber', value: '', isPublic: true },
  { key: 'supportEmail', value: '', isPublic: true },
  { key: 'supportPhone', value: '', isPublic: true },
  { key: 'freeShippingThreshold', value: 999, isPublic: true },
  { key: 'bulkPromptThresholdGrams', value: 5000, isPublic: true },
  { key: 'gstin', value: '', isPublic: true },
  { key: 'fssaiLicence', value: '', isPublic: true },
  { key: 'certifications', value: [], isPublic: true },
  { key: 'social', value: [], isPublic: true },
  { key: 'addressLines', value: [], isPublic: true },
  // Spec §10.4 — COD only until online payment is deliberately switched on.
  { key: 'codEnabled', value: true, isPublic: true },
  { key: 'onlinePaymentEnabled', value: false, isPublic: true },
  { key: 'flatShippingRate', value: 79, isPublic: true },
  /**
   * Spec §5b, added by plan 9.4. **The first `isPublic: false` row in this table**, and the flag
   * finally has a consumer to matter to: `GET /settings` filters on it.
   *
   * Private because no storefront reads it. It exists so that every *dated admin figure* — the
   * dashboard's sales-over-time bars and the `?from`/`?to` filter on `GET /admin/orders` — groups
   * and bounds days the way the business counts them, instead of by UTC day, where a 04:00 IST
   * order lands on the previous bar. Spec §5b required that it be applied to all of them at once,
   * because a per-endpoint fix is how two figures start disagreeing.
   *
   * `business-timezone.ts` holds the key, the default, and the reader that falls back to it.
   */
  { key: BUSINESS_TIMEZONE_KEY, value: DEFAULT_BUSINESS_TIMEZONE, isPublic: false },
];

export async function seedSettings(dataSource: DataSource): Promise<number> {
  const repository = dataSource.getRepository(Setting);
  for (const setting of SETTINGS) {
    await repository.upsert({ ...setting }, ['key']);
  }
  return SETTINGS.length;
}
