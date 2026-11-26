import { Controller, Get, Optional } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';
import { PrismaService } from '../database/prisma.service';
import { RedisCacheService } from '../redis/cache.service';
import { QueueHealthService } from '../queue/queue.health';
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
    @Optional() private readonly queueHealth?: QueueHealthService,
    @Optional() private readonly prisma?: PrismaService,
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
      const parsedStats = await this.redisCache.getServerInfoStats(8);
      redisStats = parsedStats
        ? { connected: true, stats: parsedStats }
        : { connected: false, error: 'Redis connection unavailable' };
    }

    const queues = this.queueHealth
      ? await this.queueHealth.getAllQueueMetrics()
      : null;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      dbPool: this.prisma?.getPoolStats() ?? null,
      redis: redisStats,
      cache: this.redisCache?.getStats() ?? null,
      queues,
    };
  }
}
