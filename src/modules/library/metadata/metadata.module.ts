import { Module, forwardRef } from '@nestjs/common';
import { MetadataController } from './metadata.controller';
import { MetadataService } from './metadata.service';
import { AcademicMetadataReducer } from './metadata-reducer';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { ArxivProvider } from './providers/arxiv.provider';
import { PubmedProvider } from './providers/pubmed.provider';
import { OpenlibraryProvider } from './providers/openlibrary.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';
import { CitationModule } from '../citation/citation.module';

@Module({
  imports: [forwardRef(() => CitationModule)],
  controllers: [MetadataController],
  providers: [
    MetadataService,
    AcademicMetadataReducer,
    SemanticScholarProvider,
    ArxivProvider,
    PubmedProvider,
    OpenlibraryProvider,
    OpenAlexProvider,
    UnpaywallProvider,
  ],
  exports: [MetadataService, AcademicMetadataReducer],
})
export class MetadataModule {}
