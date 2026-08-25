import { Module, forwardRef } from '@nestjs/common';
import { CitationController } from './citation.controller';
import { CitationService } from './citation.service';
import { BibtexFormatter } from './formatters/bibtex.formatter';
import { BibtexParser } from './parsers/bibtex.parser';
import { CslFormatter } from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';
import { DoiResolver } from './resolvers/doi.resolver';
import { CatalogModule } from '../catalog/catalog.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [forwardRef(() => CatalogModule), forwardRef(() => IngestionModule)],
  controllers: [CitationController],
  providers: [
    CitationService,
    BibtexFormatter,
    BibtexParser,
    CslFormatter,
    RisFormatter,
    DoiResolver,
  ],
  exports: [
    CitationService,
    BibtexFormatter,
    BibtexParser,
    CslFormatter,
    RisFormatter,
    DoiResolver,
  ],
})
export class CitationModule {}
