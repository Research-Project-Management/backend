import { Module, forwardRef } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { IngestionJobService } from './ingestion-job.service';
import { MetadataModule } from '../metadata/metadata.module';
import { CitationModule } from '../citation/citation.module';
import { CatalogModule } from '../catalog/catalog.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [
    forwardRef(() => MetadataModule),
    forwardRef(() => CitationModule),
    forwardRef(() => CatalogModule),
    forwardRef(() => AttachmentsModule),
  ],
  controllers: [IngestionController],
  providers: [IngestionService, IngestionJobService],
  exports: [IngestionService, IngestionJobService],
})
export class IngestionModule {}
