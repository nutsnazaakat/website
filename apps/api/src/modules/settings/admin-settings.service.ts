import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminSetting } from '@nutwala/shared';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Setting } from '../../entities/ops/setting.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { ReplaceSettingsDto } from './dto/replace-settings.dto';

function toAdminSetting(setting: Setting): AdminSetting {
  return {
    key: setting.key,
    value: setting.value,
    isPublic: setting.isPublic,
    updatedByUserId: setting.updatedByUserId,
    updatedAt: setting.updatedAt.toISOString(),
  };
}

/**
 * `GET` and `PUT /admin/settings` — spec §6.4, brief §26's editable certification information and
 * §37's *"do not hardcode a fake number — make it configurable from Admin Settings"*.
 *
 * **`PUT` writes only keys that already exist**, and an unknown one is refused by name. That is a
 * judgment call and it cuts against `Setting`'s own docblock, which says the key/value shape exists
 * "so adding a setting in a later phase is an insert rather than a migration" — so it is worth
 * being precise about what is preserved and what is not. Adding a setting is still an insert: it is
 * `settings.seed.ts` that does it, in the same commit as the code that reads the new key. What is
 * refused is an insert arriving *over HTTP*, where a typo — `whatsapNumber` for `whatsappNumber` —
 * would create a real row that looks saved in the console, is returned by `GET /admin/settings`,
 * and is read by nothing at all. There is no route that deletes a setting either, so such a row
 * would be permanent. A named 422 listing the unknown keys is a better answer than a dead row.
 *
 * **`isPublic` cannot be changed over HTTP.** `ReplaceSettingsDto` records why: it is a property of
 * what a setting is, not an operational choice, and this table holds a GSTIN.
 *
 * **One audit row per key that actually changed**, all inside the transaction that writes them.
 * A `PUT` carrying five keys of which two differ writes two rows, and a `PUT` that changes nothing
 * writes none — plan 9.1's rule, applied per key rather than per request, because "when did the
 * WhatsApp number last change" is the question this trail is asked.
 */
@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/settings` — **every** row, private ones included.
   *
   * Unpaginated, matching `GET /admin/categories`: the table is a fixed configuration surface
   * rather than a growing collection, and a settings form paginated at row 24 would be a settings
   * form missing half its fields. Ordered by `key` so the console renders a stable list.
   */
  async list(): Promise<AdminSetting[]> {
    const rows = await this.dataSource.getRepository(Setting).find({ order: { key: 'ASC' } });
    return rows.map(toAdminSetting);
  }

  async replace(input: ReplaceSettingsDto & { actorUserId: string }): Promise<AdminSetting[]> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(Setting);
      const keys = input.settings.map((entry) => entry.key);

      /**
       * A duplicate key in one payload is refused rather than last-write-wins.
       *
       * Two entries for `gstin` in a single request are a client bug, and silently applying the
       * second would make the audit row disagree with what the operator believes they sent — the
       * trail would show one change from a payload that asked for two.
       */
      const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
      if (duplicates.length > 0) {
        throw new DomainError(
          ErrorCodes.VALIDATION_FAILED,
          'The same setting appears more than once in this request.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { keys: [...new Set(duplicates)] },
        );
      }

      const existing = await repository.find({ where: { key: In(keys) } });
      const byKey = new Map(existing.map((row) => [row.key, row]));

      const unknown = keys.filter((key) => !byKey.has(key));
      if (unknown.length > 0) {
        throw new DomainError(
          ErrorCodes.NOT_FOUND,
          'No such setting. A new setting is added by the seed, alongside the code that reads it.',
          HttpStatus.NOT_FOUND,
          { keys: unknown },
        );
      }

      for (const entry of input.settings) {
        const row = byKey.get(entry.key);
        // Unreachable: `unknown` above has already refused every key not in this map. Spelled out
        // because `noUncheckedIndexedAccess` is on and the honest alternative — a non-null
        // assertion — would be a claim about the loop rather than about the data.
        if (row === undefined) continue;

        // `JSON.stringify` rather than `===`, because a jsonb value is legitimately an array or an
        // object and `['FSSAI'] === ['FSSAI']` is false. This is `AdminCategoriesService.diff`'s
        // comparison, for the same reason it uses it on `seo`.
        if (JSON.stringify(row.value) === JSON.stringify(entry.value)) continue;

        const before = row.value;
        row.value = entry.value;
        row.updatedByUserId = input.actorUserId;
        await repository.save(row);

        await this.audit.record(manager, {
          actorUserId: input.actorUserId,
          action: AuditAction.SETTING_UPDATE,
          entityType: AuditEntity.SETTING,
          // The key itself, which *is* `settings`' primary key — so this member keeps the trail's
          // original convention, unlike `coupon` and `post`.
          entityId: row.key,
          before: { value: before },
          after: { value: row.value },
        });
      }

      return this.readBack(manager, keys);
    });
  }

  /**
   * The rows just written, re-read inside the transaction.
   *
   * Re-read rather than mapped from the in-memory entities, so `updatedAt` is the value the
   * `@UpdateDateColumn` actually stamped rather than whatever the loaded entity was carrying
   * before the save — which is what a console re-rendering "last changed" from this response needs.
   */
  private async readBack(manager: EntityManager, keys: string[]): Promise<AdminSetting[]> {
    const rows = await manager
      .getRepository(Setting)
      .find({ where: { key: In(keys) }, order: { key: 'ASC' } });
    return rows.map(toAdminSetting);
  }
}
