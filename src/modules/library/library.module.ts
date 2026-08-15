import { Module } from '@nestjs/common';
import { PaperModule } from './paper/paper.module';
import { CollectionModule } from './collection/collection.module';
import { ReferenceModule } from './reference/reference.module';
import { LibraryIngestionModule } from './ingestion/library-ingestion.module';

@Module({
  imports: [
    PaperModule,
    CollectionModule,
    ReferenceModule,
    LibraryIngestionModule,
  ],
  exports: [
    PaperModule,
    CollectionModule,
    ReferenceModule,
    LibraryIngestionModule,
  ],
})
export class LibraryModule {}
