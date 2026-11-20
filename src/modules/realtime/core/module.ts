import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { CacheModule } from '@/core';

import { WsAuthService } from './auth';
import { REALTIME_BUS_MODE, RealtimeEventBus } from './bus';
import { RealtimeConfigService } from './config';
import { WsAllExceptionsFilter } from './errors';
import { WsRateLimiter } from './rate-limit';

@Module({
  imports: [ConfigModule, CacheModule, JwtModule.register({})],
  providers: [
    WsAuthService,
    WsAllExceptionsFilter,
    RealtimeConfigService,
    WsRateLimiter,
    RealtimeEventBus,
  ],
  exports: [
    WsAuthService,
    WsAllExceptionsFilter,
    RealtimeConfigService,
    WsRateLimiter,
    RealtimeEventBus,
  ],
})
export class RealtimeCoreModule {
  public static forPublisher(): DynamicModule {
    return {
      module: RealtimeCoreModule,
      imports: [ConfigModule, CacheModule],
      providers: [
        RealtimeConfigService,
        { provide: REALTIME_BUS_MODE, useValue: 'publisher' },
        RealtimeEventBus,
      ],
      exports: [RealtimeConfigService, RealtimeEventBus],
    };
  }
}
