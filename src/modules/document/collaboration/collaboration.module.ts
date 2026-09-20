import { Module } from '@nestjs/common';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';
import { CollaborationGateway } from './collaboration.gateway';
import { YjsDocumentManager } from './yjs-document.manager';
import { PageModule } from '../page/page.module';
import { CoreModule } from '@/core/core.module';
import { AuthnModule } from '@/modules/iam/authn/authn.module';
import { BullModule } from '@nestjs/bullmq';
import { DOCUMENT_COLLABORATION_QUEUE } from './constants/collaboration-queue.constants';
import { CollaborationQueueConsumer } from './collaboration-queue.consumer';
import { shouldRunWorkerConsumers } from '@/core/utils/worker-mode.util';

const collaborationWorkerProviders = shouldRunWorkerConsumers()
  ? [CollaborationQueueConsumer]
  : [];

@Module({
  imports: [
    CoreModule,
    PageModule,
    AuthnModule,
    BullModule.registerQueue({
      name: DOCUMENT_COLLABORATION_QUEUE,
    }),
  ],
  controllers: [CollaborationController],
  providers: [
    CollaborationService,
    CollaborationGateway,
    YjsDocumentManager,
    ...collaborationWorkerProviders,
  ],
  exports: [
    CollaborationService,
    CollaborationGateway,
    YjsDocumentManager,
    CollaborationQueueConsumer,
  ],
})
export class CollaborationModule {}
