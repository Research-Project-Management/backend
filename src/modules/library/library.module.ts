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
import { AcademicBundleModule } from './academic-bundle/academic-bundle.module';
import { LibraryReportModule } from './report/report.module';

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
    AcademicBundleModule,
    LibraryReportModule,
  ],
  exports: [AcademicBundleModule, LibraryReportModule],
})
export class LibraryModule {}
