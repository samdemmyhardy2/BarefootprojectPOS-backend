import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';
import { Role } from './generated/prisma/enums';

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 12) {
    throw new Error(`${name} must be set to a password of at least 12 characters`);
  }
  return value;
}

const connectionString = process.env.DATABASE_URL;
const adminPassword = requiredSecret('BOOTSTRAP_ADMIN_PASSWORD');
const agentPassword = requiredSecret('BOOTSTRAP_AGENT_PASSWORD');

if (!connectionString) throw new Error('DATABASE_URL must be configured');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function bootstrapUsers(): Promise<void> {
  const [adminHash, agentHash] = await Promise.all([
    bcrypt.hash(adminPassword, 12),
    bcrypt.hash(agentPassword, 12),
  ]);

  await prisma.$transaction([
    prisma.user.upsert({
      where: { email: 'admin@restaurant.com' },
      create: {
        name: 'Restaurant Admin',
        email: 'admin@restaurant.com',
        password: adminHash,
        role: Role.ADMIN,
      },
      update: {
        name: 'Restaurant Admin',
        password: adminHash,
        role: Role.ADMIN,
      },
    }),
    prisma.user.upsert({
      where: { email: 'agent@restaurant.com' },
      create: {
        name: 'Restaurant Agent',
        email: 'agent@restaurant.com',
        password: agentHash,
        role: Role.EMPLOYEE,
      },
      update: {
        name: 'Restaurant Agent',
        password: agentHash,
        role: Role.EMPLOYEE,
      },
    }),
  ]);

  console.info('Admin and agent accounts are ready. Passwords were read from environment variables.');
}

bootstrapUsers()
  .catch((error: unknown) => {
    console.error('Could not bootstrap accounts:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
