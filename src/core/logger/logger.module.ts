import { Global, Module } from '@nestjs/common';
import { LoggerService, AppLogger } from './logger.service';
import { LoggerInterceptor, LoggingInterceptor } from './logger.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: LoggerService,
      useFactory: () => LoggerService.getInstance(),
    },
    LoggerInterceptor,
    LoggingInterceptor,
  ],
  exports: [LoggerService, LoggerInterceptor, LoggingInterceptor],
})
export class LoggerModule {}
