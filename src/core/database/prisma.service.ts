import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

if (typeof (BigInt.prototype as any).toJSON !== 'function') {
  (BigInt.prototype as any).toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private pool?: Pool;

  constructor(private readonly configService: ConfigService) {
    const isProd = process.env.NODE_ENV === 'production';

    let connectionString =
      configService.get<string>('DATABASE_URL') || process.env.DATABASE_URL;

    // Fallback: Dynamically assemble from Docker PostgreSQL environment configuration
    if (!connectionString) {
      if (isProd) {
        throw new Error(
          '[PrismaService] DATABASE_URL must be configured in production.',
        );
      }
      const user =
        configService.get<string>('DB_USER') ||
        process.env.DB_USER ||
        'postgres';
      const password =
        configService.get<string>('DB_PASSWORD') ||
        process.env.DB_PASSWORD ||
        '';
      const host =
        configService.get<string>('DB_HOST') ||
        process.env.DB_HOST ||
        '127.0.0.1';
      const port =
        configService.get<string>('DB_PORT') || process.env.DB_PORT || '5433';
      const dbName =
        configService.get<string>('DB_NAME') ||
        process.env.DB_NAME ||
        'flux-db';

      const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
      connectionString = `postgresql://${auth}@${host}:${port}/${dbName}?schema=public`;
    }

    // Bulkhead safety headroom: Background workers (Outbox: 5, Ingest: 3, Retraction: 3, OCR: 2)
    // require at least 13 connections. We allocate at least 15 extra connections for real-time web users.
    const defaultPoolMax = isProd ? 35 : 25;
    const poolMax = process.env.DATABASE_POOL_MAX
      ? parseInt(process.env.DATABASE_POOL_MAX, 10)
      : defaultPoolMax;
    const pool = new Pool({
      connectionString,
      max: poolMax,
      idleTimeoutMillis: isProd ? 30000 : 10000,
      connectionTimeoutMillis: 20000,
    });
    pool.on('error', (err) => {
      console.warn('[Prisma pg pool error]:', err.message);
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
  }

  async onModuleInit() {
    const dbUrl =
      this.configService.get<string>('DATABASE_URL') ||
      process.env.DATABASE_URL;
    if (process.env.NODE_ENV !== 'test' && dbUrl) {
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
