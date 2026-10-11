import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { CacheModule } from './infrastructure/redis/cache.module';
import { LoggerModule } from './logger/logger.module';
import { IdempotencyModule } from './infrastructure/idempotency/idempotency.module';
import { HealthModule } from './infrastructure/health/health.module';
import { GlobalExceptionFilter } from './http/filters/exception.filter';
import { TransformInterceptor } from './http/interceptors/transform.interceptor';

@Global()
@Module({
  imports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    IdempotencyModule,
    HealthModule,
  ],
  providers: [GlobalExceptionFilter, TransformInterceptor],
  exports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    IdempotencyModule,
    HealthModule,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
})
export class CoreModule {}
