import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WinstonLoggerService } from '../logging/winston-logger.service';

const MINIMUM_MAJOR = 15;

@Injectable()
export class PostgresVersionAssertionService implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext('PostgresVersionAssertion');
  }

  async onApplicationBootstrap(): Promise<void> {
    const rows =
      await this.dataSource.query<{ server_version_num: string }[]>('SHOW server_version_num');
    const versionNum = Number(rows[0]?.server_version_num ?? 0);
    const major = Math.floor(versionNum / 10_000);

    if (major < MINIMUM_MAJOR) {
      throw new Error(
        `PostgreSQL ${MINIMUM_MAJOR} or newer is required; connected server reports major ${major}`,
      );
    }
    this.logger.log('Database version verified', { major });
  }
}
