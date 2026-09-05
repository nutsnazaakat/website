import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request values that every log line should carry without being threaded through every
 * function signature. Same approach as both existing services.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  method?: string;
  url?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches the authenticated user to the active context once a guard has resolved it, so
 * logs after that point are attributable.
 */
export function setContextUserId(userId: string): void {
  const context = storage.getStore();
  if (context) context.userId = userId;
}
