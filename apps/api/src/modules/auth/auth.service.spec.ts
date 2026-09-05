import { HttpStatus } from '@nestjs/common';
import type { Credentials } from '@nutwala/shared';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';
import type { CreateUserInput } from '../users/users.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

const meta = { userAgent: 'jest', ip: '127.0.0.1' };

/** Spec §13. Every failed sign-in produces exactly this string, whatever the reason. */
const GENERIC_LOGIN_FAILURE = 'Invalid email or password.';

function build(existing: User | null) {
  const passwords = new PasswordService();

  // The users double stays coherent: a user handed to `create` becomes findable by id
  // afterwards. `AuthService` re-reads the row after registering so the freshly written
  // company record is included in the response, and a double that returned null there would
  // be testing a repository that cannot exist.
  let created: User | null = null;
  const users = {
    findByEmail: jest.fn().mockResolvedValue(existing),
    findByEmailWithPassword: jest.fn().mockResolvedValue(existing),
    findById: jest.fn(() => Promise.resolve(created ?? existing)),
    create: jest.fn((input: CreateUserInput) => {
      created = {
        id: 'new-user',
        isActive: true,
        createdAt: new Date(),
        business: null,
        ...input,
      } as User;
      return Promise.resolve(created);
    }),
    markLoggedIn: jest.fn().mockResolvedValue(undefined),
    promoteToBusiness: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    issue: jest.fn().mockResolvedValue({
      session: { id: 's1', familyId: 'f1' },
      refreshToken: 'refresh-token',
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = { signAccessToken: jest.fn().mockReturnValue('access-token') };
  const businesses = { createFor: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    users as never,
    passwords,
    sessions as never,
    tokens as never,
    businesses as never,
  );

  return { service, users, sessions, tokens, passwords, businesses };
}

async function customerFixture(password: string): Promise<User> {
  const hash = await new PasswordService().hash(password);
  return {
    id: 'u1',
    name: 'Retail Customer',
    email: 'b2c@demo.in',
    phone: '9876543210',
    passwordHash: hash,
    role: UserRole.CUSTOMER,
    isActive: true,
    createdAt: new Date(),
    business: null,
  } as User;
}

/**
 * Returns the rejection instead of asserting on it, so the three failure paths can be
 * compared against each other. A `rejects.toThrow` per path proves each message in
 * isolation; the property under test is that the three are indistinguishable.
 */
async function loginRejection(
  service: AuthService,
  credentials: Credentials,
): Promise<DomainError> {
  try {
    await service.login(credentials, meta);
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Expected login to be rejected, but it resolved.');
}

describe('AuthService.login', () => {
  it('returns the user, an access token and a refresh token on success', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);

    const result = await service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta);

    expect(result.user).toMatchObject({ id: 'u1', role: 'b2c' });
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
  });

  it('records the login timestamp', async () => {
    const user = await customerFixture('Password123!');
    const { service, users } = build(user);
    await service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta);
    expect(users.markLoggedIn).toHaveBeenCalledWith('u1');
  });

  it('gives an identical error for an unknown email, a wrong password and a locked account', async () => {
    // Spec §13. Differing messages here turn login into an account-existence oracle, which
    // is exactly what the Phase 1 mock did with "No account found with that email address."
    const deactivated = await customerFixture('Password123!');
    deactivated.isActive = false;

    const wrongPassword = await loginRejection(
      build(await customerFixture('Password123!')).service,
      {
        email: 'b2c@demo.in',
        password: 'nope',
      },
    );
    const unknownEmail = await loginRejection(build(null).service, {
      email: 'nobody@demo.in',
      password: 'nope',
    });
    const inactive = await loginRejection(build(deactivated).service, {
      email: 'b2c@demo.in',
      password: 'Password123!',
    });

    for (const rejection of [wrongPassword, unknownEmail, inactive]) {
      expect(rejection.message).toBe(GENERIC_LOGIN_FAILURE);
      expect(rejection.code).toBe(ErrorCodes.INVALID_CREDENTIALS);
      expect(rejection.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }

    // The response body is what actually reaches the client, so compare it whole rather than
    // trusting that the message is the only field that differs.
    expect(unknownEmail.getResponse()).toEqual(wrongPassword.getResponse());
    expect(inactive.getResponse()).toEqual(wrongPassword.getResponse());
  });

  it('still runs a bcrypt comparison when the email is unknown', async () => {
    const { service, passwords } = build(null);
    const spy = jest.spyOn(passwords, 'compareAgainstDummy');
    await service.login({ email: 'nobody@demo.in', password: 'nope' }, meta).catch(() => undefined);
    expect(spy).toHaveBeenCalledWith('nope');
  });

  it('performs exactly one bcrypt comparison on either failing path, so timing cannot separate them', async () => {
    const known = build(await customerFixture('Password123!'));
    const knownCompare = jest.spyOn(known.passwords, 'compare');
    const knownDummy = jest.spyOn(known.passwords, 'compareAgainstDummy');
    await loginRejection(known.service, { email: 'b2c@demo.in', password: 'nope' });
    expect(knownCompare).toHaveBeenCalledTimes(1);
    expect(knownDummy).not.toHaveBeenCalled();

    const unknown = build(null);
    const unknownCompare = jest.spyOn(unknown.passwords, 'compare');
    const unknownDummy = jest.spyOn(unknown.passwords, 'compareAgainstDummy');
    await loginRejection(unknown.service, { email: 'nobody@demo.in', password: 'nope' });
    expect(unknownDummy).toHaveBeenCalledTimes(1);
    expect(unknownCompare).not.toHaveBeenCalled();
  });

  it('issues no session when the password is wrong', async () => {
    const user = await customerFixture('Password123!');
    const { service, sessions } = build(user);
    await service.login({ email: 'b2c@demo.in', password: 'nope' }, meta).catch(() => undefined);
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('refuses a deactivated account with the same generic message', async () => {
    const user = await customerFixture('Password123!');
    user.isActive = false;
    const { service, sessions } = build(user);
    await expect(
      service.login({ email: 'b2c@demo.in', password: 'Password123!' }, meta),
    ).rejects.toThrow('Invalid email or password.');
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('matches the email case-insensitively', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);
    await expect(
      service.login({ email: '  B2C@DEMO.IN  ', password: 'Password123!' }, meta),
    ).resolves.toMatchObject({ accessToken: 'access-token' });
  });
});

describe('AuthService.register', () => {
  const input = {
    name: 'New Customer',
    email: 'New@Demo.in',
    phone: '9876543210',
    password: 'Kaju1kgPlease',
    isBusiness: false,
  };

  it('creates a CUSTOMER and signs them in', async () => {
    const { service, users } = build(null);
    const result = await service.register(input, meta);

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@demo.in', role: UserRole.CUSTOMER }),
    );
    expect(result.accessToken).toBe('access-token');
  });

  it('stores a hash, never the password', async () => {
    const { service, users } = build(null);
    await service.register(input, meta);
    const created = users.create.mock.calls[0]?.[0];
    expect(created?.passwordHash).toMatch(/^\$2[aby]\$10\$/);
    expect(created).not.toHaveProperty('password');
  });

  it('creates a BUSINESS account and its company record when isBusiness is set', async () => {
    const { service, users, businesses } = build(null);
    await service.register(
      {
        ...input,
        isBusiness: true,
        company: {
          companyName: 'Sharma Sweets',
          contactPerson: 'R Sharma',
          businessType: 'Sweet shop',
        },
      },
      meta,
    );
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ role: UserRole.BUSINESS }));
    expect(businesses.createFor).toHaveBeenCalled();
  });

  it('rejects a duplicate email', async () => {
    const user = await customerFixture('Password123!');
    const { service } = build(user);
    await expect(service.register({ ...input, email: 'b2c@demo.in' }, meta)).rejects.toThrow(
      /already/i,
    );
  });

  it('rejects a weak password before touching the database', async () => {
    const { service, users } = build(null);
    await expect(service.register({ ...input, password: 'password' }, meta)).rejects.toThrow(
      /too common/i,
    );
    expect(users.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('revokes the session so the refresh token is dead immediately', async () => {
    const { service, sessions } = build(null);
    await service.logout('s1');
    expect(sessions.revoke).toHaveBeenCalledWith('s1', 'logout');
  });
});
