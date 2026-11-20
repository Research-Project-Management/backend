import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeCoreModule } from '../../core/module';
import { WorkItemsRealtimeConfigService } from './config';
import { WorkItemsGateway } from './gateway';
import { WorkItemsWsGuard } from './guard';

@Module({
  imports: [ConfigModule, RealtimeCoreModule],
  providers: [
    WorkItemsRealtimeConfigService,
    WorkItemsWsGuard,
    WorkItemsGateway,
  ],
  exports: [WorkItemsRealtimeConfigService, WorkItemsWsGuard, WorkItemsGateway],
})
export class RealtimeWorkItemsChannelModule {}
