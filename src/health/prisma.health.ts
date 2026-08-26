import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { PrismaService } from '../core/database/prisma.service';
import { getErrorMessage } from '../core/utils/error.util';

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.user.findFirst({ select: { id: true } });
      return this.getStatus(key, true, {
        message: 'Database connection is active',
      });
    } catch (err: unknown) {
      throw new HealthCheckError(
        'Prisma database health check failed',
        this.getStatus(key, false, { message: getErrorMessage(err) }),
      );
    }
  }
}
