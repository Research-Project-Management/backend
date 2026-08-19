import { Module } from '@nestjs/common';
import { PaperModule } from './paper/paper.module';
import { CollectionModule } from './collection/collection.module';
import { ReferenceModule } from './reference/reference.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { QualityModule } from './quality/quality.module';
import { AnnotationModule } from './annotation/annotation.module';
import { RelationModule } from './relation/relation.module';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

@Module({
  imports: [
    PaperModule,
    CollectionModule,
    ReferenceModule,
    IngestionModule,
    QualityModule,
    AnnotationModule,
    RelationModule,
  ],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [
    LibraryService,
    PaperModule,
    CollectionModule,
    ReferenceModule,
    IngestionModule,
    QualityModule,
    AnnotationModule,
    RelationModule,
  ],
})
export class LibraryModule {}
