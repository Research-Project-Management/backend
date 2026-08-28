import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';
import { CatalogContextModule } from '../catalog/catalog.module';
import { AttachmentsContextModule } from '../attachments/attachments.module';
import { CitationContextModule } from '../citation/citation.module';
import { DiscoveryContextModule } from '../discovery/discovery.module';
import { MetadataModule } from './metadata/metadata.module';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { UrlCaptureConnector } from './url-capture.connector';
import { UNIFIED_INGESTION_SERVICE } from './ingestion.contracts';

@Module({
  imports: [
    CoreModule,
    SyncCoreContextModule,
    CatalogContextModule,
    AttachmentsContextModule,
    CitationContextModule,
    DiscoveryContextModule,
    MetadataModule,
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
export class IngestionContextModule {}
