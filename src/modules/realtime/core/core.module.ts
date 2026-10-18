import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { WsAuthService } from './ws-auth.guard';
import { WsAllExceptionsFilter } from './ws-exception.filter';
import { CoreService } from './core.service';
import { RealtimeConfigService } from './realtime.config';
import { WsRateLimiter } from './ws-rate-limiter';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [
    WsAuthService,
    WsAllExceptionsFilter,
    CoreService,
    RealtimeConfigService,
    WsRateLimiter,
  ],
  exports: [
    WsAuthService,
    WsAllExceptionsFilter,
    CoreService,
    RealtimeConfigService,
    WsRateLimiter,
  ],
})
export class CoreModule {}
