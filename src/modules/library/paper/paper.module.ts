import { Module } from '@nestjs/common';
import { PaperController } from './paper.controller';
import { PaperService } from './paper.service';
import { PaperRepository } from './paper.repository';
import { FileModule } from '@/modules/storage/file/file.module';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';

@Module({
  imports: [FileModule],
  controllers: [PaperController],
  providers: [PaperService, PaperRepository, BibtexFormatter],
  exports: [PaperService, PaperRepository],
})
export class PaperModule {}
