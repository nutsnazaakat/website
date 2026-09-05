import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import { createWinstonLogger } from '../config/winston.config';
import type { AppConfiguration } from '../config/app.config';
import { WINSTON_LOGGER, WinstonLoggerService } from './winston-logger.service';

@Global()
@Module({
  providers: [
    {
      provide: WINSTON_LOGGER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Logger => {
        const app = config.getOrThrow<AppConfiguration>('app');
        return createWinstonLogger(app.logging.level, app.isProduction);
      },
    },
    WinstonLoggerService,
  ],
  exports: [WinstonLoggerService],
})
export class LoggingModule {}
