import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private pool?: Pool;

  constructor(configService: ConfigService) {
    const connectionString =
      configService.get<string>('DATABASE_URL') ||
      process.env.DATABASE_URL ||
      'postgresql://localhost:5432/rpm';

    const pool = new Pool({ connectionString });
    pool.on('error', (err) => {
      console.warn('[Prisma pg pool error]:', err.message);
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    if (process.env.NODE_ENV !== 'test' && process.env.DATABASE_URL) {
      await this.$connect().catch((err) => {
        console.warn('[Prisma] Database connection deferred:', err.message);
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.pool) {
      await this.pool.end().catch(() => {});
    }
  }
}
