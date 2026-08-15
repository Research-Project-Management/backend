import { Global, Module } from '@nestjs/common';
import { AppLogger } from './app-logger.service';
import { LoggingInterceptor } from './logging.interceptor';

@Global()
@Module({
  providers: [
    {
      provide: AppLogger,
      useFactory: () => AppLogger.getInstance(),
    },
    LoggingInterceptor,
  ],
  exports: [AppLogger, LoggingInterceptor],
})
export class LoggerModule {}
