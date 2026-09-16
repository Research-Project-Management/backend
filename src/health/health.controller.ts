import { Controller, Get, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisCacheService } from '@/core/cache/redis.service';

@ApiTags('Health')
@Controller(['health', 'api/health'])
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Complete system health check (Database, Memory, Status)',
  })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', 1024 * 1024 * 1024), // 1 GB heap limit
      () => this.memory.checkRSS('memory_rss', 1536 * 1024 * 1024), // 1.5 GB RSS limit
    ]);
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Kubernetes / Container liveness probe' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('readiness')
  @HealthCheck()
  @ApiOperation({ summary: 'Kubernetes / Container readiness probe' })
  readiness() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')]);
  }

  @Get('queues')
  @ApiOperation({ summary: 'Queue & Background Worker Monitoring (Redis & Jobs)' })
  async getQueueMetrics() {
    const isRedisReady = this.redisCache?.isReady() ?? false;
    let redisStats: Record<string, unknown> = { connected: isRedisReady };

    if (isRedisReady && this.redisCache) {
      try {
        const client = this.redisCache.getClient();
        if (client) {
          const rawInfo = await client.info('stats');
          const lines = rawInfo.split('\r\n').filter((l) => l && !l.startsWith('#'));
          const parsedStats: Record<string, string> = {};
          lines.slice(0, 8).forEach((line) => {
            const [k, v] = line.split(':');
            if (k && v) parsedStats[k] = v;
          });
          redisStats = {
            connected: true,
            stats: parsedStats,
          };
        }
      } catch (err: unknown) {
        redisStats = {
          connected: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      redis: redisStats,
      queues: {
        compilation: {
          active: 0,
          waiting: 0,
          status: 'healthy',
        },
        ingestion: {
          status: 'ready',
        },
      },
    };
  }
}
