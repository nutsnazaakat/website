import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/identity/user.entity';
import { UsersModule } from '../users/users.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

/**
 * The two profile routes.
 *
 * **Its own module rather than two more methods on `AuthModule`**, and the reason is blast radius
 * rather than tidiness. `AuthModule` provides password hashing, token signing and session issue; a
 * profile edit needs none of the three, and a route that lives there acquires them as reachable
 * collaborators. Kept separate, the one place a customer writes to `users` has exactly two things in
 * scope: the row and the session's id.
 *
 * **`UsersModule` for the read, `forFeature([User])` for the write.** `ProfileService` injects both,
 * for the reason its own docblock gives — `UsersService.findById` is the single definition of "the
 * current user, with their company", shared with `GET /auth/me`, while the scoped `UPDATE` stays here
 * where a spec can prove its owner clause. `UsersModule` already declares `forFeature([User])` of its
 * own; registering it again is not a conflict, because `forFeature` provides an injectable repository
 * *token* per module injector rather than a second connection — both resolve the same `DataSource`,
 * which `TypeOrmModule.forRoot`'s `@Global()` core module provides.
 *
 * **Nothing is exported.** No other module reads or writes a customer's profile: `AuthModule` reaches
 * the same row through `UsersService`, which it already imports, and the admin console is §7.1's
 * separate application. An export nothing imports is an invitation to reach past the controller and
 * its `@CurrentUser()` scoping, which is the only thing making this row the caller's own.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User]), UsersModule],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
