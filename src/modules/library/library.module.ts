import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { CollectionsModule } from './collections/collections.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { MetadataModule } from './metadata/metadata.module';
import { CitationModule } from './citation/citation.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { QualityModule } from './quality/quality.module';
import { SearchModule } from './search/search.module';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [
    CatalogModule,
    CollectionsModule,
    IngestionModule,
    MetadataModule,
    CitationModule,
    AttachmentsModule,
    KnowledgeModule,
    QualityModule,
    SearchModule,
  ],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
