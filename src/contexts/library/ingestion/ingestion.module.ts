import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';
import { CatalogContextModule } from '../catalog/catalog.module';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';

@Module({
  imports: [CoreModule, SyncCoreContextModule, CatalogContextModule],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionContextModule {}
