import { Global, Module } from '@nestjs/common';
import { PrismaModule } from './database/prisma.module';
import { CacheModule } from './cache/cache.module';
import { LoggerModule } from './logger/logger.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { TransformInterceptor } from './interceptors/transform.interceptor';

@Global()
@Module({
  imports: [PrismaModule, CacheModule, LoggerModule],
  providers: [GlobalExceptionFilter, TransformInterceptor],
  exports: [
    PrismaModule,
    CacheModule,
    LoggerModule,
    GlobalExceptionFilter,
    TransformInterceptor,
  ],
})
export class CoreModule {}
