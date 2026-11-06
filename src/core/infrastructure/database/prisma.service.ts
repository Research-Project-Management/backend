import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

declare global {
  interface BigInt {
    toJSON(): number | string;
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'warn' | 'error'>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private pool?: Pool;

  constructor(private configService: ConfigService) {
    const connectionString =
      configService.get<string>('DATABASE_URL') || process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL environment variable is missing for PrismaService',
      );
    }

    // High performance pool options tailored for high-throughput Postgres connection handling
    const pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      query_timeout: 30000,
      keepAlive: true,
    });

    const adapter = new PrismaPg(pool);
    const logQueries =
      (configService.get<string>('PRISMA_LOG_QUERIES') ||
        process.env.PRISMA_LOG_QUERIES) === 'true';
    const slowQueryThresholdMs = Number(
      configService.get<string>('SLOW_QUERY_THRESHOLD_MS') ||
        process.env.SLOW_QUERY_THRESHOLD_MS ||
        200,
    );

    super({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    this.pool = pool;

    this.$on('query', (event: Prisma.QueryEvent) => {
      if (event.duration >= slowQueryThresholdMs) {
        this.logger.warn(
          `[SlowQuery ${event.duration}ms] ${event.query} | params=${event.params}`,
        );
      } else if (logQueries) {
        this.logger.debug(
          `[Query ${event.duration}ms] ${event.query} | params=${event.params}`,
        );
      }
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Initial database connection attempt failed: ${msg}. Continuing boot for retry...`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    if (this.pool) {
      await this.pool.end();
    }
  }
}
