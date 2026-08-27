import { Module } from '@nestjs/common';
import { MetadataController } from './metadata.controller';
import { MetadataService } from './metadata.service';
import { ReconciliationService } from './reconciliation.service';
import {
  MetadataReducer,
  AcademicMetadataReducer,
} from './utils/metadata.util';

import { SemanticScholarProvider } from './providers/semantic.provider';
import { ArxivProvider } from './providers/arxiv.provider';

import { PubmedProvider } from './providers/pubmed.provider';
import { OpenlibraryProvider } from './providers/openlibrary.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';

import { CiteModule } from '../cite/cite.module';

@Module({
  imports: [CiteModule],
  controllers: [MetadataController],

  providers: [
    MetadataService,
    ReconciliationService,
    AcademicMetadataReducer,
    SemanticScholarProvider,
    ArxivProvider,
    PubmedProvider,
    OpenlibraryProvider,
    OpenAlexProvider,
    UnpaywallProvider,
  ],
  exports: [
    MetadataService,
    ReconciliationService,
    AcademicMetadataReducer,
    SemanticScholarProvider,
    ArxivProvider,
    PubmedProvider,
    OpenlibraryProvider,
    OpenAlexProvider,
    UnpaywallProvider,
  ],
})
export class MetadataModule {}
