import { Module } from '@nestjs/common';
import { AccessRepository } from './access.repository';
import { AccessService } from './services/access.service';
import { DocumentAccessService } from './services/document.service';
import { SpaceAccessService } from './services/space.service';

@Module({
  providers: [
    AccessRepository,
    SpaceAccessService,
    DocumentAccessService,
    AccessService,
  ],
  exports: [AccessService, SpaceAccessService, DocumentAccessService],
})
export class AccessModule {}
