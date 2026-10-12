import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { LoggerInterceptor } from '../http/interceptors/logger.interceptor';

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
