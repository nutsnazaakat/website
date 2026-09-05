import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from '../../common/auth/jwt.strategy';
import { BusinessesModule } from '../business/businesses.module';
import { CartModule } from '../cart/cart.module';
import { SessionsModule } from '../sessions/sessions.module';
import { UsersModule } from '../users/users.module';
import { WishlistModule } from '../wishlist/wishlist.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CookieService } from './cookie.service';
import { PasswordService } from './password.service';

/**
 * `TokenService`, `TOKEN_SETTINGS` and `JwtModule` are **not** declared here. They live in
 * `SessionsModule`, which exports `TokenService`, and importing that module is what brings it into
 * scope.
 *
 * This is deliberate and was a bug in an earlier version of this task, which declared its own
 * `TokenService` and `TOKEN_SETTINGS` *and* imported `SessionsModule`. Nest would have built two
 * independent `TokenService` instances with two separate settings objects — one signing access
 * tokens for the login path, one hashing refresh tokens and computing refresh expiry for the
 * session path. Identical today, because both factories read the same `ConfigService`; silently
 * divergent the moment either is configured from anything else, and a refresh TTL that disagrees
 * with the one the session rows were written against is not a failure that announces itself.
 *
 * `JwtStrategy` needs only `ConfigService` and `SessionsService`, so it is satisfied by the same
 * import. `PassportModule` stays — it is what registers the strategy machinery.
 *
 * `CartModule` is imported for its exported `CartService`: `login` and `register` fold any guest
 * basket into the new session before they return. `WishlistModule` is imported for the same reason
 * and against the same `nn_guest_token` key — one guest key, one merge step, two independent merges.
 */
@Module({
  imports: [
    PassportModule,
    UsersModule,
    SessionsModule,
    BusinessesModule,
    CartModule,
    WishlistModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, CookieService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
