import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One key and the value to write into it. */
export class SettingEntryDto {
  @ApiProperty({ example: 'whatsappNumber' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  key: string;

  /**
   * Whatever JSON the setting holds — a string, a number, a boolean or an array.
   *
   * **`@IsDefined()` and nothing narrower.** `settings.value` is `jsonb` typed `unknown` on the
   * entity precisely because the fifteen seeded rows are four different shapes
   * (`freeShippingThreshold` a number, `codEnabled` a boolean, `certifications` an array), and a
   * DTO that named one would refuse the others. The decorator is not decoration either: the global
   * pipe runs with `whitelist: true`, which **strips any property carrying no validator at all**,
   * so a bare `value: unknown` would arrive as `undefined` on every request and every write would
   * silently store nothing.
   *
   * `@IsDefined()` refuses `null` as well as `undefined`, which is the intended reading: no seeded
   * setting holds `null`, and the empty forms the seed actually uses are `''` and `[]`. A client
   * clearing a setting sends one of those, and `''` is meaningfully different from "this setting
   * does not exist".
   */
  @ApiProperty({ example: '919876543210' })
  @IsDefined()
  value: unknown;
}

/**
 * `PUT /admin/settings` — brief §26's certification information and §37's WhatsApp number, made
 * editable.
 *
 * **An array of entries, not a flat map.** `{ "whatsappNumber": "…", "gstin": "…" }` is the shape
 * this would obviously take, and it cannot be validated: the global pipe runs with
 * `forbidNonWhitelisted`, so every real key would be rejected as an undeclared property, and a DTO
 * cannot declare keys it does not know at compile time. The array costs one level of nesting and
 * makes the payload checkable.
 *
 * **`isPublic` is deliberately absent from this shape.** Whether a setting reaches `GET /settings`
 * is a property of what the setting *is* rather than an operational choice — the WhatsApp number is
 * public because the storefront renders it, the business timezone is private because nothing
 * outside the console has a use for it — and the seed is where that is declared. Making it editable
 * would put "publish this to every anonymous visitor" one mistyped field away from a routine
 * settings save, on a table that holds a GSTIN. `AdminSetting` reports the flag so the console can
 * show it; nothing over HTTP can change it.
 *
 * **`PUT`, but not a whole-table replace.** The verb is spec §6.4's, and a literal PUT semantics —
 * anything absent is removed — would delete fourteen settings the moment a console saved one form
 * section. So it is an upsert over the keys named and nothing else, which is what every consumer
 * actually wants and what the audit trail (one row per *changed* key) is shaped for.
 */
export class ReplaceSettingsDto {
  /**
   * At least one entry — an empty array is a request that cannot do anything, and answering 200 for
   * it would look like a successful save. Capped at 200, comfortably above the fifteen rows that
   * exist, so a runaway client is refused rather than opening a transaction per key.
   */
  @ApiProperty({ type: [SettingEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SettingEntryDto)
  settings: SettingEntryDto[];
}
