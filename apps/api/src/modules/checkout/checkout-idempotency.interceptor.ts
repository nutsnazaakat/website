import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { IdempotencyInterceptor } from '../../common/http/idempotency.interceptor';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';

/** Spec §10.4's namespace for order placement. Exported so the spec can assert it, not restate it. */
export const CHECKOUT_ORDERS_SCOPE = 'checkout:orders';

/**
 * `IdempotencyInterceptor` bound to spec §10.4's `checkout:orders` scope.
 *
 * A subclass rather than a factory provider because `@UseInterceptors()` takes a class or an
 * instance, and a string-token provider is neither. `IdempotencyInterceptor`'s own constructor is
 * `(keys, scope)`, and Nest cannot inject a plain `string` — so `@UseInterceptors(IdempotencyInterceptor)`
 * does not resolve and `@UseInterceptors(new IdempotencyInterceptor(...))` has no repository to hand
 * it. One subclass per scope keeps the namespace explicit at the route rather than hidden in a
 * module.
 *
 * The alternative that must not be taken is hardcoding the scope inside the base interceptor: `key`
 * is `idempotency_keys`' primary key and `scope` is only a column, so the composite string is the
 * only thing keeping two features' keys apart. One namespace for everything would defeat the column
 * and let a future feature's key collide with a customer's order.
 */
@Injectable()
export class CheckoutIdempotencyInterceptor extends IdempotencyInterceptor {
  constructor(@InjectRepository(IdempotencyKey) keys: Repository<IdempotencyKey>) {
    super(keys, CHECKOUT_ORDERS_SCOPE);
  }
}
