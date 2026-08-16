import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { ReferenceModule } from '../reference/reference.module';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [ReferenceModule, PaperModule],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
