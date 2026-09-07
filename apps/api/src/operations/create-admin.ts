import 'reflect-metadata';
import '../load-env';
import * as bcrypt from 'bcrypt';
import db from '../data-source';
import { User } from '../entities/identity/user.entity';
import { UserRole } from '../entities/enums';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const phone = process.env.ADMIN_PHONE?.trim();
  const name = process.env.ADMIN_NAME?.trim() || 'Nazaakat Admin';
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !password ||
    password.length < 16 ||
    Buffer.byteLength(password) > 72 ||
    !phone ||
    !/^[6-9]\d{9}$/.test(phone)
  )
    throw new Error(
      'Set ADMIN_EMAIL, ADMIN_PASSWORD (16–72 bytes) and ADMIN_PHONE (Indian mobile).',
    );
  await db.initialize();
  try {
    await db.transaction(async (manager) => {
      const users = manager.getRepository(User);
      if (await users.findOneBy({ email }))
        throw new Error('This email already exists. No account was modified.');
      await users.insert({
        email,
        name,
        phone,
        passwordHash: await bcrypt.hash(password, 12),
        role: UserRole.ADMIN,
        isActive: true,
      });
    });
    console.log('Admin account created. Remove ADMIN_PASSWORD from the deployment environment.');
  } finally {
    await db.destroy();
  }
}
void main().catch(() => {
  console.error(
    'Admin creation failed. Verify inputs, migrations and database connectivity. No existing account is overwritten.',
  );
  process.exitCode = 1;
});
