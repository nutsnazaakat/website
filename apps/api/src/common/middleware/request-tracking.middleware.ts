import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../logging/request-context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class RequestTrackingMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();

    // A caller-supplied correlation id is echoed so a trace can span services, but the
    // request id is always generated here: a client must not be able to choose it.
    const supplied = req.header(CORRELATION_ID_HEADER);
    const correlationId =
      typeof supplied === 'string' && /^[\w-]{1,64}$/.test(supplied) ? supplied : requestId;

    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext(
      { requestId, correlationId, method: req.method, url: req.originalUrl },
      () => next(),
    );
  }
}
