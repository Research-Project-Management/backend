import { Module } from '@nestjs/common';
import { CiteController } from './cite.controller';
import { CiteService } from './cite.service';
import { BibtexFormatter } from './formatters/bibtex.formatter';
import { BibtexParser } from './parsers/bibtex.parser';
import { CslFormatter } from './formatters/csl.formatter';
import { RisFormatter } from './formatters/ris.formatter';
import { DoiResolver } from './resolvers/doi.resolver';
import { ItemsModule } from '../items/items.module';
import { ReferenceManagerMapperService } from './mapper.service';

@Module({
  imports: [ItemsModule],
  controllers: [CiteController],
  providers: [
    CiteService,
    BibtexFormatter,
    BibtexParser,
    CslFormatter,
    RisFormatter,
    DoiResolver,
    ReferenceManagerMapperService,
  ],
  exports: [
    CiteService,
    BibtexFormatter,
    BibtexParser,
    CslFormatter,
    RisFormatter,
    DoiResolver,
    ReferenceManagerMapperService,
  ],
})
export class CiteModule {}
export const CitationModule = CiteModule;
export const CitationService = CiteService;
export const CitationController = CiteController;
