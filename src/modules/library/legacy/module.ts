import { Module } from '@nestjs/common';
import { ItemsModule } from './items/items.module';
import { CollectionsModule } from './collections/collections.module';
import { TranslationModule } from './translation/translation.module';
import { CiteModule } from './cite/cite.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { MetadataModule } from './metadata/metadata.module';
import { AnnotationsModule } from './annotations/annotations.module';
import { NotesModule } from './notes/notes.module';
import { SearchModule } from './search/search.module';
import { RelationsModule } from './relations/relations.module';
import { QualityModule } from './quality/quality.module';
import { ReportModule } from './report/report.module';
import { ContextModule } from './context/context.module';
import { SyncModule } from './sync/sync.module';

import { APP_INTERCEPTOR } from '@nestjs/core';
import { LibraryDeprecationInterceptor } from './common/library-deprecation.interceptor';

@Module({
  imports: [
    ItemsModule,
    CollectionsModule,
    TranslationModule,
    MetadataModule,
    CiteModule,
    AttachmentsModule,
    NotesModule,
    AnnotationsModule,
    SearchModule,
    RelationsModule,
    QualityModule,
    ReportModule,
    ContextModule,
    SyncModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: LibraryDeprecationInterceptor,
    },
  ],
  exports: [
    ItemsModule,
    CollectionsModule,
    TranslationModule,
    MetadataModule,
    CiteModule,
    AttachmentsModule,
    NotesModule,
    AnnotationsModule,
    SearchModule,
    RelationsModule,
    QualityModule,
    ReportModule,
    ContextModule,
    SyncModule,
  ],
})
export class LegacyLibraryModule {}
