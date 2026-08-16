import { Module } from '@nestjs/common';
import { PaperModule } from './paper/paper.module';
import { CollectionModule } from './collection/collection.module';
import { ReferenceModule } from './reference/reference.module';
import { IngestionModule } from './ingestion/ingestion.module';

@Module({
  imports: [
    PaperModule,
    CollectionModule,
    ReferenceModule,
    IngestionModule,
  ],
  exports: [
    PaperModule,
    CollectionModule,
    ReferenceModule,
    IngestionModule,
  ],
})
export class LibraryModule {}
