import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';
import { CatalogContextModule } from '../catalog/catalog.module';
import { CurationService } from './curation.service';
import { CurationController } from './curation.controller';

@Module({
  imports: [CoreModule, SyncCoreContextModule, CatalogContextModule],
  controllers: [CurationController],
  providers: [CurationService],
  exports: [CurationService],
})
export class CurationContextModule {}
