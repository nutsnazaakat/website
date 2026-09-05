import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { AppConfiguration } from '../../common/config/app.config';
import { LoggingModule } from '../../common/logging/logging.module';
import { Session } from '../../entities/identity/session.entity';
import { TOKEN_SETTINGS, TokenService, tokenSettingsFactory } from '../auth/token.service';
import { SessionsService } from './sessions.service';

/**
 * Everything `SessionsService` needs is declared here, because Nest resolves a provider's
 * dependencies in its *declaring* module's scope and nowhere else.
 *
 * This module used to provide only `SessionsService`, while the service injects `TokenService` at
 * constructor index 1. Nest refused to build it — "Please make sure that the argument TokenService
 * at index [1] is available in the SessionsModule module" — and no consumer could have repaired
 * that from outside: an `AuthModule` that lists `TokenService` in its own `providers` and imports
 * this module puts the token in `AuthModule`'s scope, not this one's. The dependency has to be
 * satisfiable from here.
 *
 * `TokenService` in turn needs `JwtModule` and `TOKEN_SETTINGS`, so both are registered here and
 * `TokenService` is re-exported: a later `AuthModule` should import this module and use that one
 * instance rather than declaring a second `TokenService` of its own, which would silently give the
 * login path and the refresh path two different settings objects the moment they are configured
 * from anything but `ConfigService`.
 *
 * `LoggingModule` is imported explicitly even though it is `@Global()`. Global registration only
 * helps once something has loaded the module; a testing module that imports `SessionsModule` alone
 * would not have, and "stands up on its own" is the property this module is now tested for. The
 * one thing still assumed from the application shell is the global `ConfigModule`, exactly as every
 * other module in this service assumes it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Session]),
    LoggingModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<AppConfiguration>('app').auth.jwtSecret,
      }),
    }),
  ],
  providers: [
    { provide: TOKEN_SETTINGS, inject: [ConfigService], useFactory: tokenSettingsFactory },
    TokenService,
    SessionsService,
  ],
  exports: [SessionsService, TokenService],
})
export class SessionsModule {}
