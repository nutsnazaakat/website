import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser, Credentials, RegisterInput } from '@nutwala/shared';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import { BusinessesService } from '../business/businesses.service';
import { SessionsService, type SessionMeta } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import { toAuthUser } from '../users/user.mapper';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthResult {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/** One message for every failed sign-in. See the tests and spec §13. */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly businesses: BusinessesService,
  ) {}

  async login(credentials: Credentials, meta: SessionMeta): Promise<AuthResult> {
    const user = await this.users.findByEmailWithPassword(credentials.email);

    // The unknown-email branch still performs a bcrypt comparison. Returning early here is
    // what makes an enumeration attack possible: the fast path is measurably faster.
    if (!user) {
      await this.passwords.compareAgainstDummy(credentials.password);
      throw this.loginFailure();
    }

    const matches = await this.passwords.compare(credentials.password, user.passwordHash);

    // A deactivated account gives the same message. Saying "this account is suspended"
    // confirms the address is registered.
    if (!matches || !user.isActive) throw this.loginFailure();

    await this.users.markLoggedIn(user.id);
    return this.issue(user.id, user.role, meta);
  }

  async register(input: RegisterInput, meta: SessionMeta): Promise<AuthResult> {
    const strength = this.passwords.validateStrength(input.password);
    if (!strength.ok) {
      throw new DomainError(
        ErrorCodes.WEAK_PASSWORD,
        strength.reason,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Normalised here rather than only inside `UsersService`, so the duplicate check and the
    // insert are provably asking about the same string.
    const email = UsersService.normaliseEmail(input.email);

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new DomainError(
        ErrorCodes.EMAIL_IN_USE,
        'An account with this email address already exists.',
        HttpStatus.CONFLICT,
      );
    }

    const role = input.isBusiness ? UserRole.BUSINESS : UserRole.CUSTOMER;
    const created = await this.users.create({
      name: input.name.trim(),
      email,
      phone: input.phone,
      passwordHash: await this.passwords.hash(input.password),
      role,
    });

    if (input.isBusiness && input.company) {
      await this.businesses.createFor(created.id, input.company);
    }

    return this.issue(created.id, role, meta);
  }

  /** Revoking the row is what makes logout real — spec §9. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new DomainError(
        ErrorCodes.SESSION_EXPIRED,
        'Your session has expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return toAuthUser(user);
  }

  /** Brief §46. */
  async upgradeToBusiness(userId: string): Promise<AuthUser> {
    await this.users.promoteToBusiness(userId);
    return this.me(userId);
  }

  private async issue(userId: string, role: UserRole, meta: SessionMeta): Promise<AuthResult> {
    const { session, refreshToken } = await this.sessions.issue(userId, meta);
    // Re-read so the response carries the `business` relation, including a company record
    // written moments ago during registration.
    const user = await this.users.findById(userId);
    if (!user) throw new Error(`User ${userId} vanished between creation and session issue`);

    return {
      user: toAuthUser(user),
      accessToken: this.tokens.signAccessToken({ sub: userId, role, sessionId: session.id }),
      refreshToken,
    };
  }

  private loginFailure(): DomainError {
    return new DomainError(
      ErrorCodes.INVALID_CREDENTIALS,
      GENERIC_LOGIN_FAILURE,
      HttpStatus.UNAUTHORIZED,
    );
  }
}
