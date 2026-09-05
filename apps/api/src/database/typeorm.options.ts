import type { DataSourceOptions } from 'typeorm';
import type { AppConfiguration } from '../common/config/app.config';

export function buildTypeOrmOptions(app: AppConfiguration): DataSourceOptions {
  const neonHost = app.database.host.includes('.neon.tech');

  return {
    type: 'postgres',
    host: app.database.host,
    port: app.database.port,
    username: app.database.username,
    password: app.database.password,
    database: app.database.database,
    schema: app.database.schema,
    // Neon refuses plaintext; local Docker does not speak TLS.
    ssl: neonHost ? { rejectUnauthorized: true } : false,
    // Entities and migrations are globbed from dist at runtime and from src under ts-node.
    entities: [`${__dirname}/../entities/**/*.entity.{ts,js}`],
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
    // Never true. The migration chain is the only way the schema changes.
    synchronize: false,
    migrationsRun: app.database.migrationsRun,
    // Postgres refuses `ALTER TYPE ... ADD VALUE` inside a transaction that later uses the
    // new value (55P04), so each migration gets its own transaction. Same as both repos.
    migrationsTransactionMode: 'each',
    logging: app.isProduction ? ['error', 'warn'] : ['error', 'warn', 'schema'],
  };
}
