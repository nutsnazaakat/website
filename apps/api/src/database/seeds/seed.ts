import '../../load-env';
import '../../common/money/bigint-json';
import dataSource from '../../data-source';
import type { Seeder } from './seed-context';
import { seedCatalog } from './catalog.seed';
import { seedContent } from './content.seed';
import { seedCoupons } from './coupons.seed';
import { seedOrders } from './orders.seed';
import { seedPincodes } from './pincodes.seed';
import { seedRfqs } from './rfqs.seed';
import { assertSeedableEnvironment } from './seedable-environment';
import { seedSettings } from './settings.seed';
import { seedUsers } from './users.seed';

/**
 * Usage:
 *   npm run seed            — everything, in dependency order
 *   npm run seed -- catalog — one domain only
 *
 * Every seeder is idempotent: it upserts on the natural key (slug, email, code, key), so
 * running it twice does not duplicate rows. That matters because this is also how a developer
 * refreshes their database after pulling new seed data.
 *
 * The declaration order below is the dependency order: `orders` resolves users and variants,
 * `content` resolves products, so neither can run before what it references exists.
 */
const SEEDERS = {
  settings: seedSettings,
  users: seedUsers,
  catalog: seedCatalog,
  // After `catalog`: `ALMOND15` is scoped to the almonds category and cannot resolve without it.
  coupons: seedCoupons,
  content: seedContent,
  orders: seedOrders,
  pincodes: seedPincodes,
  // After `users` and `catalog`: resolves `b2b@demo.in`'s userId and every seeded product slug.
  rfqs: seedRfqs,
} as const satisfies Record<string, Seeder>;

type SeederName = keyof typeof SEEDERS;

function isSeederName(value: string): value is SeederName {
  return Object.prototype.hasOwnProperty.call(SEEDERS, value);
}

/**
 * Names are validated before `initialize()`, so a typo fails without opening a connection or
 * running the seeders that happened to be spelled correctly.
 */
function resolveNames(argv: readonly string[]): SeederName[] {
  const requested = argv.filter((arg) => !arg.startsWith('-'));
  if (requested.length === 0) return Object.keys(SEEDERS) as SeederName[];

  return requested.map((arg) => {
    if (!isSeederName(arg)) {
      throw new Error(`Unknown seeder "${arg}". Known: ${Object.keys(SEEDERS).join(', ')}`);
    }
    return arg;
  });
}

async function main(): Promise<void> {
  /**
   * Before anything else, including argument parsing and the connection.
   *
   * Every seeder here is destructive on re-run — `settings` overwrites all sixteen rows,
   * `catalog` deletes each product's `pricing_tiers` — so the guard belongs to the *runner*, not
   * to whichever seeder happened to be written with one. It used to live only inside `seedUsers`,
   * second in the order below, which meant a run against the wrong database wiped the settings
   * table before refusing. See `seedable-environment.ts`.
   */
  assertSeedableEnvironment('run the database seeders, which overwrite existing rows');

  const names = resolveNames(process.argv.slice(2));

  await dataSource.initialize();
  try {
    for (const name of names) {
      process.stdout.write(`Seeding ${name}… `);
      const count = await SEEDERS[name](dataSource);
      process.stdout.write(`${count} rows\n`);
    }
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
