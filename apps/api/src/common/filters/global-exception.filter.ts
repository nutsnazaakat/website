import {
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ApiError } from '@nutwala/shared';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/app.config';
import { getRequestContext } from '../logging/request-context';
import { WinstonLoggerService } from '../logging/winston-logger.service';
import { redact } from '../logging/pii-redactor';

interface NestValidationBody {
  message?: string | string[];
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Widened to `number` deliberately. `exception.getStatus()` returns a plain `number`, and
 * comparing that against an `HttpStatus` member trips `no-unsafe-enum-comparison` — which is on
 * here via `recommendedTypeChecked`. Naming the boundary once keeps the intent readable without
 * scattering casts or a bare `500` through the filter.
 */
const SERVER_ERROR_THRESHOLD: number = HttpStatus.INTERNAL_SERVER_ERROR;

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: WinstonLoggerService,
    private readonly config: ConfigService,
  ) {
    this.logger.setContext('GlobalExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const app = this.config.getOrThrow<AppConfiguration>('app');
    const requestContext = getRequestContext();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // Fail closed: verbose output is opt-in for development only, so a staging box left
    // off NODE_ENV=production, or any future environment value, gets the safe behaviour.
    const isDevelopment = app.env === 'development';
    const { message, code, details } = this.describe(exception, status, isDevelopment);
    const errorId = `err_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

    const body: ApiError = {
      success: false,
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
      method: request.method,
      message,
      ...(code ? { code } : {}),
      errorId,
      requestId: requestContext?.requestId ?? 'unknown',
      ...(details ? { details } : {}),
      // Stack never crosses the wire in production. Spec §13, "internal detail leakage".
      ...(isDevelopment && exception instanceof Error ? { stack: exception.stack } : {}),
    };

    const logMeta = {
      errorId,
      statusCode: status,
      path: request.originalUrl,
      method: request.method,
      body: redact(request.body),
      query: redact(request.query),
    };

    // 5xx is our fault and gets a stack; 4xx is the caller's and would be log spam at error.
    if (status >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(message, { ...logMeta, error: exception });
    } else {
      this.logger.warn(message, logMeta);
    }

    response.status(status).json(body);
  }

  private describe(
    exception: unknown,
    status: number,
    isDevelopment: boolean,
  ): { message: string; code?: string; details?: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'string') return { message: payload };

      const shaped = payload as NestValidationBody;

      // ValidationPipe emits `message: string[]`, one entry per failed constraint.
      if (Array.isArray(shaped.message)) {
        return {
          message: 'Validation failed',
          code: 'VALIDATION_FAILED',
          details: { _errors: shaped.message },
        };
      }

      return {
        message: shaped.message ?? exception.message,
        ...(shaped.code ? { code: shaped.code } : {}),
        ...(shaped.details ? { details: shaped.details } : {}),
      };
    }

    // An unclassified throw. In production the caller learns nothing beyond the error id:
    // a driver message can name a column, a constraint, or a query.
    // Anything that is not development gets the generic message. A driver error can name a
    // column, a constraint or a whole query, so the caller learns only the error id.
    if (!isDevelopment) return { message: 'Internal server error' };
    return { message: exception instanceof Error ? exception.message : String(exception) };
  }
}
