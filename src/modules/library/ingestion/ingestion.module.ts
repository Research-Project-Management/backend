import { Module, forwardRef } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { ReferenceModule } from '../reference/reference.module';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [forwardRef(() => ReferenceModule), forwardRef(() => PaperModule)],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
