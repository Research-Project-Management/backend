import { Controller, Get, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';
import { RedisCacheService } from '../redis/redis.service';
import {
  getDefaultResourceGovernor,
  SystemResourceGovernor,
} from '../resource/system-resource-governor';

@ApiTags('Health')
@Controller(['health', 'api/health'])
export class HealthController {
  private readonly governor: SystemResourceGovernor;

  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    @Optional() private readonly redisCache?: RedisCacheService,
    @Optional() resourceGovernor?: SystemResourceGovernor,
  ) {
    this.governor = resourceGovernor ?? getDefaultResourceGovernor();
  }

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Complete system health check (Database, Memory, Status)',
  })
  check() {
    const budgets = this.governor.getTierBudgets();
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', budgets.healthHeapLimitBytes),
      () => this.memory.checkRSS('memory_rss', budgets.healthRssLimitBytes),
    ]);
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Container liveness probe' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('readiness')
  @HealthCheck()
  @ApiOperation({ summary: 'Container readiness probe' })
  readiness() {
    return this.health.check([() => this.prismaHealth.isHealthy('database')]);
  }

  @Get('queues')
  @ApiOperation({
    summary: 'Queue & Background Worker Monitoring (Redis & Jobs)',
  })
  async getQueueMetrics() {
    const isRedisReady = this.redisCache?.isReady() ?? false;
    let redisStats: Record<string, unknown> = { connected: isRedisReady };

    if (isRedisReady && this.redisCache) {
      try {
        const client = this.redisCache.getClient();
        if (client) {
          const rawInfo = await client.info('stats');
          const lines = rawInfo
            .split('\r\n')
            .filter((l) => l && !l.startsWith('#'));
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
      } catch (_err) {
        redisStats = {
          connected: false,
          error: 'Redis connection unavailable',
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
