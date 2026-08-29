import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CitationModule } from '../citation/citation.module';
import { SearchModule } from '../search/search.module';
import { MetadataModule } from './metadata/metadata.module';
import { StorageModule } from '../../storage/storage.module';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { UrlCaptureConnector } from './providers/url-capture.connector';
import { UNIFIED_INGESTION_SERVICE } from './types/ingestion.contracts';

@Module({
  imports: [
    CoreModule,
    SyncModule,
    CatalogModule,
    AttachmentsModule,
    CitationModule,
    SearchModule,
    MetadataModule,
    StorageModule,
  ],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    {
      provide: UNIFIED_INGESTION_SERVICE,
      useExisting: IngestionService,
    },
    UrlCaptureConnector,
  ],
  exports: [
    UNIFIED_INGESTION_SERVICE,
    IngestionService,
    UrlCaptureConnector,
    MetadataModule,
  ],
})
export class IngestionModule {}
