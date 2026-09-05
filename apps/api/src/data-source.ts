import './load-env';
import { DataSource } from 'typeorm';
import { appConfig } from './common/config/app.config';
import { buildTypeOrmOptions } from './database/typeorm.options';

/**
 * Used only by the TypeORM CLI (`npm run migration:run`). It builds its options from the same
 * `buildTypeOrmOptions` the application uses, so there is no second copy to keep in sync — the
 * sibling mf-lenders-gateway keeps two hand-synced copies and warns about it in a comment.
 *
 * `registerAs(token, factory)` returns the factory itself; it only attaches non-enumerable
 * metadata for Nest's DI. So `appConfig()` is callable directly here with no container involved,
 * which beats rebuilding an `AppConfiguration` literal field by field: a hand-copied mapping
 * would not notice if `app.config.ts` ever computed a field differently, and nothing would flag
 * the drift.
 *
 * `loadEnv()` therefore runs a second time here, the first being inside `appConfig` during app
 * bootstrap. That is harmless rather than an oversight: this file only ever executes in a
 * separate CLI process that shares no state with the running app, so there is no window in which
 * the two parses could observe a different `process.env` and disagree.
 */
export default new DataSource(buildTypeOrmOptions(appConfig()));
