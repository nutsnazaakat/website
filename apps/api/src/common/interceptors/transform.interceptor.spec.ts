import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { withMessage } from '@nutwala/shared';
import { TransformInterceptor } from './transform.interceptor';

function contextFor(statusCode = 200): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('TransformInterceptor', () => {
  it('wraps a plain object', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning({ id: 'p1' })),
    );
    expect(result).toEqual({ success: true, data: { id: 'p1' } });
  });

  it('wraps an array without flattening it', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning([1, 2])),
    );
    expect(result).toEqual({ success: true, data: [1, 2] });
  });

  it('represents an empty handler response as null data, never a missing key', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(204), handlerReturning(undefined)),
    );
    expect(result).toEqual({ success: true, data: null });
  });

  it('lifts a withMessage() envelope, setting the message', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(
        contextFor(201),
        handlerReturning(withMessage({ id: 'o1' }, 'Order placed')),
      ),
    );
    expect(result).toEqual({ success: true, data: { id: 'o1' }, message: 'Order placed' });
  });

  it('does NOT lift a bare { data, message } object — opting in is nominal, not shape-based', async () => {
    // The guard used to be `'data' in value && typeof value.message === 'string'`, which would
    // silently unwrap a genuine DTO. SupportTicket has a `message` column, so this is a real
    // collision, not a hypothetical: such a response must survive as its own payload.
    const ticket = { data: { id: 'o1' }, message: 'Customer asked about delivery' };
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning(ticket)),
    );
    expect(result).toEqual({ success: true, data: ticket });
  });

  it('omits message when withMessage was not used', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(contextFor(), handlerReturning({ id: 'p1' })),
    );
    expect(result).not.toHaveProperty('message');
  });

  it('does not double-wrap an already-enveloped response', async () => {
    const result = await firstValueFrom(
      new TransformInterceptor().intercept(
        contextFor(),
        handlerReturning({ success: true, data: { id: 'p1' } }),
      ),
    );
    expect(result).toEqual({ success: true, data: { id: 'p1' } });
  });

  it('treats a falsy scalar as data rather than as absence', async () => {
    await expect(
      firstValueFrom(new TransformInterceptor().intercept(contextFor(), handlerReturning(0))),
    ).resolves.toEqual({ success: true, data: 0 });
    await expect(
      firstValueFrom(new TransformInterceptor().intercept(contextFor(), handlerReturning(false))),
    ).resolves.toEqual({ success: true, data: false });
  });
});
