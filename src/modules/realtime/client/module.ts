import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@/core';
import { LiveCollaborationPort } from '@/modules/pages/core/ports/live-collaboration.port';
import { PagesEventsPublisher } from '../adapters/pages';
import { WorkItemsEventsBridge } from '../adapters/work-items';
import { RealtimeCoreModule } from '../core/module';
import { RealtimeControlClient } from '../internal/client';
import { RemoteLiveCollaborationAdapter } from '../internal/remote-collab';
import { RealtimeFacade } from '../realtime.facade';

@Global()
@Module({
  imports: [ConfigModule, CacheModule, RealtimeCoreModule.forPublisher()],
  providers: [
    RealtimeControlClient,
    RemoteLiveCollaborationAdapter,
    {
      provide: LiveCollaborationPort,
      useExisting: RemoteLiveCollaborationAdapter,
    },
    WorkItemsEventsBridge,
    PagesEventsPublisher,
    RealtimeFacade,
  ],
  exports: [
    RealtimeCoreModule,
    RealtimeControlClient,
    LiveCollaborationPort,
    RealtimeFacade,
  ],
})
export class RealtimeClientModule {}
