import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { ApiSuccess, Enveloped } from '@nutwala/shared';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnveloped(value: unknown): value is Enveloped<unknown> {
  return isPlainObject(value) && value.__envelope === true && 'data' in value;
}

/**
 * Applies the one success envelope, globally.
 *
 * Spec §3.1 departure 2: cug wraps in `{ success, data }` from 65 controllers but returns
 * bare DTOs from auth, and gateway returns raw payloads. Doing it in an interceptor means a
 * controller cannot forget, and there is exactly one shape on the wire.
 *
 * A handler may return `{ data, message }` when it wants to set a message; anything else is
 * taken as the payload.
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<ApiSuccess<unknown>> {
    return next.handle().pipe(
      map((value: unknown): ApiSuccess<unknown> => {
        // Already enveloped — a controller that built its own response, or a nested call.
        if (isPlainObject(value) && value.success === true && 'data' in value) {
          return value as unknown as ApiSuccess<unknown>;
        }

        // Nominal, not shape-sniffed. A handler opts in with `withMessage(...)` from
        // @nutwala/shared; nothing else is treated as an envelope. Inferring this from the mere
        // presence of `data` and `message` would misfire on a real DTO — SupportTicket has a
        // `message` column.
        if (isEnveloped(value)) {
          return {
            success: true,
            data: value.data ?? null,
            ...(value.message === undefined ? {} : { message: value.message }),
          };
        }

        // `undefined` means the handler returned nothing; `null`, `0` and `false` are data.
        return { success: true, data: value === undefined ? null : value };
      }),
    );
  }
}
