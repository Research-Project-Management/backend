import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';

import { WsAuthService } from './ws-auth.guard';
import { WsAllExceptionsFilter } from './ws-exception.filter';
import { CoreService } from './core.service';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [WsAuthService, WsAllExceptionsFilter, CoreService],
  exports: [WsAuthService, WsAllExceptionsFilter, CoreService],
})
export class CoreModule {}
