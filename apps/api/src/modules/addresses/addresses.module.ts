import { Module } from '@nestjs/common';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';

/**
 * The account address book behind five URLs.
 *
 * **No `imports`, and no `TypeOrmModule.forFeature([Address])`** — which looks like an omission and is
 * not. `forFeature` exists to provide an injectable *repository token*, and `AddressesService` injects
 * none: it takes the `DataSource` and reaches `Repository<Address>` through
 * `manager.getRepository(Address)` inside each transaction, exactly as `OrderStatusService` does.
 * `TypeOrmModule.forRoot`'s core module is `@Global()`, so `DataSource` resolves here with nothing
 * imported. `addresses.module.spec.ts` compiles this graph with a stubbed `DataSource`, so a
 * constructor that gains a real repository dependency fails there rather than at production bootstrap.
 *
 * One dependency rather than two is deliberate. Every write on this table is a transaction — the
 * clear-then-set the partial unique index forces, plus the promotion that keeps a book from having no
 * default — and each of them ends by reading the book back. A separate `@InjectRepository(Address)`
 * for the read path would be a second route to the same rows, on a different connection, and the
 * ordering and the `deletedAt IS NULL` filter would then exist in two places.
 *
 * **Nothing is exported.** No other module reads a customer's address book: checkout takes its address
 * from the request body and snapshots it (`address.entity.ts` — orders never reference this table), and
 * the admin console is §7.1's separate application. An export nothing imports is an invitation to
 * reach past the controller and its `@CurrentUser()` scoping, which is the whole IDOR defence here.
 */
@Module({
  controllers: [AddressesController],
  providers: [AddressesService],
})
export class AddressesModule {}
