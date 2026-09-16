import { Module } from '@nestjs/common';
import { CollaborationController } from './collaboration.controller';
import { CollaborationService } from './collaboration.service';
import { CollaborationGateway } from './collaboration.gateway';
import { CoreModule } from '@/core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [CollaborationController],
  providers: [CollaborationService, CollaborationGateway],
  exports: [CollaborationService, CollaborationGateway],
})
export class CollaborationModule {}
