import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PublicSettings } from '@nutwala/shared';
import { Public } from '../../common/auth/decorators/public.decorator';
import { SettingsService } from './settings.service';

/**
 * `GET /settings` — spec §6.1's *"public subset only"*.
 *
 * **Specced from the start and never built.** `Setting.isPublic`'s docblock describes this exact
 * response — "false keeps a setting out of the public `GET /settings` response" — and there was no
 * settings controller anywhere in the service, so the column had no consumer at all.
 * `SettingsModule`'s docblock recorded the absence as deliberate for Milestone 8, with
 * `GET /settings/public` named as the eventual route; the spelling that ships is §6.1's
 * `GET /settings`, because §6.1 is the contract the front-ends read.
 *
 * `@Public()` per handler rather than at the class, matching `CatalogController` and
 * `ContentController`: `JwtAuthGuard` is global, so the decorator marks the routes an anonymous
 * visitor may reach. **No `@Roles()` anywhere here**, which `admin-routes-guarded` asserts for every
 * route outside `admin/*` — one on a customer-facing route is a 403 for every legitimate caller and
 * reads in production as "the endpoint is broken".
 *
 * Not rate-limited beyond the global `{ ttl: 60s, limit: 120 }`. It is a cacheable read of a
 * fifteen-row table that every page of the storefront needs, so a tighter per-IP rule would fall on
 * the ordinary visitor first — and carrier-grade NAT is ordinary on Indian mobile networks, which
 * `docs/known-issues.md` item 3 already records as the reason a tight per-IP rule is riskier here
 * than it looks.
 */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Public settings, keyed by name — brief §26 and §37’s editable details',
  })
  list(): Promise<PublicSettings> {
    return this.settings.publicSettings();
  }
}
