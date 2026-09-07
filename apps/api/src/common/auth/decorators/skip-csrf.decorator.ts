import { SetMetadata } from '@nestjs/common';

/** CSRF bootstrap endpoints and provider webhooks authenticated by raw-body HMAC only. */
export const SKIP_CSRF_KEY = 'skipCsrf';
export const SkipCsrf = (): MethodDecorator => SetMetadata(SKIP_CSRF_KEY, true);
