import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { LoggerModule } from './logger/logger.module';
import { IdempotencyModule } from './infrastructure/idempotency/idempotency.module';
import { HealthModule } from './infrastructure/health/health.module';
import { ResourceModule } from './infrastructure/resource/resource.module';
import { GlobalExceptionFilter } from './http/filters/exception.filter';
import { TransformInterceptor } from './http/interceptors/transform.interceptor';
import { RateLimitConfigService } from './http/rate-limit/rate-limit.config';
import { UserRateLimitGuard } from './http/rate-limit/user-rate-limit.guard';

@Global()
@Module({
  imports: [
    ResourceModule,
    PrismaModule,
    RedisModule,
    LoggerModule,
    IdempotencyModule,
    HealthModule,
  ],
  providers: [
    GlobalExceptionFilter,
    TransformInterceptor,
    RateLimitConfigService,
    UserRateLimitGuard,
    {
      provide: APP_GUARD,
      useClass: UserRateLimitGuard,
    },
  ],
  exports: [
    ResourceModule,
    PrismaModule,
    RedisModule,
    LoggerModule,
    IdempotencyModule,
    HealthModule,
    GlobalExceptionFilter,
    TransformInterceptor,
    RateLimitConfigService,
    UserRateLimitGuard,
  ],
})
export class CoreModule {}
