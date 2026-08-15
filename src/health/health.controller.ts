import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Complete system health check (Database, Memory, Status)',
  })
  check() {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024), // 300 MB heap limit
      () => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024), // 500 MB RSS limit
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
}
