import { Global, Module } from '@nestjs/common';
import { LoggerService, AppLogger } from './logger.service';
import { LoggerInterceptor, LoggingInterceptor } from '../http/interceptors/logger.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: LoggerService,
      useFactory: () => LoggerService.getInstance('Application'),
    },
    LoggerInterceptor,
  ],
  exports: [LoggerService, LoggerInterceptor],
})
export class LoggerModule {}
