import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../entities/enums';
import { User } from '../../entities/identity/user.entity';

export interface CreateUserInput {
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
  role: UserRole;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  /** Emails are stored and compared lowercased; the migration also indexes `LOWER(email)`. */
  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({
      where: { email: UsersService.normaliseEmail(email) },
      relations: { business: true },
    });
  }

  /**
   * Includes `passwordHash`, which the entity marks `select: false`. Only the login path
   * calls this, so a hash cannot reach a response by accident.
   */
  findByEmailWithPassword(email: string): Promise<User | null> {
    return this.users
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('LOWER(user.email) = :email', { email: UsersService.normaliseEmail(email) })
      .getOne();
  }

  findById(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id }, relations: { business: true } });
  }

  create(input: CreateUserInput): Promise<User> {
    return this.users.save(
      this.users.create({
        ...input,
        email: UsersService.normaliseEmail(input.email),
        isActive: true,
      }),
    );
  }

  async markLoggedIn(id: string): Promise<void> {
    await this.users.update({ id }, { lastLoginAt: new Date() });
  }

  /** Brief §46 — an existing retail customer turns on bulk buying rather than re-registering. */
  async promoteToBusiness(id: string): Promise<void> {
    await this.users.update({ id, role: UserRole.CUSTOMER }, { role: UserRole.BUSINESS });
  }
}
