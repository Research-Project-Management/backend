import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './database/prisma.module';
import { CacheModule } from './cache/cache.module';
import { LoggerModule } from './logger/logger.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';
import { ObservabilityModule } from './observability/observability.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { SandboxModule } from './sandbox/sandbox.module';

@Global()
@Module({
  imports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    ObservabilityModule,
    IdempotencyModule,
    SandboxModule,
  ],
  providers: [GlobalExceptionFilter, TransformInterceptor],
  exports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    ObservabilityModule,
    IdempotencyModule,
    SandboxModule,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
})
export class CoreModule {}
