import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import { PrismaClient } from 'prisma/generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL must be configured');
    const adapter = new PrismaPg({ connectionString });

    // Pass the adapter to the PrismaClient constructor
    super({ adapter });
  }
  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
    console.log('PostgreSQL connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
