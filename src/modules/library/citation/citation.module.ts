import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CitationService } from './citation.service';
import { CitationController } from './citation.controller';
import { BibtexParser } from './formatters/bibtex.parser';

@Module({
  imports: [CoreModule],
  controllers: [CitationController],
  providers: [CitationService, BibtexParser],
  exports: [CitationService, BibtexParser],
})
export class CitationContextModule {}
