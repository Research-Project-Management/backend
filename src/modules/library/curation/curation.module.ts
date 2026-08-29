import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CurationService } from './curation.service';
import { CurationController } from './curation.controller';

@Module({
  imports: [CoreModule, SyncModule, CatalogModule],
  controllers: [CurationController],
  providers: [CurationService],
  exports: [CurationService],
})
export class CurationModule {}
