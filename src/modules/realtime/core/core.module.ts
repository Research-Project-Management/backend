import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { WsAuthService } from './ws-auth.service';
import { WsAllExceptionsFilter } from './ws-exception.filter';
import { RealtimeHealthService } from './realtime-health.service';
import { RealtimeConfigService } from './realtime.config';
import { WsRateLimiter } from './ws-rate-limiter';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [
    WsAuthService,
    WsAllExceptionsFilter,
    RealtimeHealthService,
    RealtimeConfigService,
    WsRateLimiter,
  ],
  exports: [
    WsAuthService,
    WsAllExceptionsFilter,
    RealtimeHealthService,
    RealtimeConfigService,
    WsRateLimiter,
  ],
})
export class RealtimeCoreModule {}
