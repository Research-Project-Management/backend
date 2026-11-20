import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeCoreModule } from '../../core/module';
import { ChatRealtimeConfigService } from './config';
import { ChatGateway } from './gateway';

@Module({
  imports: [ConfigModule, RealtimeCoreModule],
  providers: [ChatRealtimeConfigService, ChatGateway],
  exports: [ChatRealtimeConfigService, ChatGateway],
})
export class RealtimeChatChannelModule {}
