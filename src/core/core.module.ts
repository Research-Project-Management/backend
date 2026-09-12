import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './database/prisma.module';
import { CacheModule } from './cache/cache.module';
import { LoggerModule } from './logger/logger.module';
import { GlobalExceptionFilter } from './filters/exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';
import { IdempotencyModule } from './idempotency/idempotency.module';

@Global()
@Module({
  imports: [PrismaModule, CacheModule, LoggerModule, IdempotencyModule],
  providers: [GlobalExceptionFilter, TransformInterceptor],
  exports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    IdempotencyModule,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
})
export class CoreModule {}
