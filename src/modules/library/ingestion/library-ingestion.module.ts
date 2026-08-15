import { Module } from '@nestjs/common';
import { LibraryIngestionController } from './library-ingestion.controller';
import { LibraryIngestionService } from './library-ingestion.service';
import { ReferenceModule } from '../reference/reference.module';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [ReferenceModule, PaperModule],
  controllers: [LibraryIngestionController],
  providers: [LibraryIngestionService],
  exports: [LibraryIngestionService],
})
export class LibraryIngestionModule {}
