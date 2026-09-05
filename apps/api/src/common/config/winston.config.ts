import { createLogger, format, transports, type Logger } from 'winston';

/**
 * CloudWatch-friendly JSON on stdout, matching Gateway. File transports are development-only
 * because in production the platform captures stdout.
 */
export function createWinstonLogger(level: string, isProduction: boolean): Logger {
  const logger = createLogger({
    // Production never emits `debug`, so a stray debug log cannot leak volume or detail.
    level: isProduction && level === 'debug' ? 'info' : level,
    format: format.combine(
      format.uncolorize(),
      format.timestamp(),
      format.errors({ stack: true }),
      format.json(),
    ),
    transports: [new transports.Console()],
  });

  if (!isProduction) {
    logger.add(new transports.File({ filename: 'logs/app.log', maxsize: 5_242_880, maxFiles: 3 }));
    logger.add(
      new transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 5_242_880,
        maxFiles: 3,
      }),
    );
  }

  return logger;
}
