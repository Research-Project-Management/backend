import { Module, forwardRef } from '@nestjs/common';
import { PaperController } from './paper.controller';
import { PaperService } from './paper.service';
import { PaperRepository } from './paper.repository';
import { FileModule } from '@/modules/storage/file/file.module';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [FileModule, forwardRef(() => IngestionModule)],
  controllers: [PaperController],
  providers: [PaperService, PaperRepository, BibtexFormatter],
  exports: [PaperService, PaperRepository],
})
export class PaperModule {}
