import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GrobidClient } from './grobid/grobid.client';
import { ZoteroTranslatorClient } from './zotero/zotero-translator.client';

/**
 * Infrastructure module encapsulating external sidecar microservices:
 * - GROBID Extraction Server (port 8070)
 * - Zotero Translation Server (port 1969)
 *
 * Provides singleton clients with built-in graceful degradation and circuit-breaking.
 */
@Module({
  imports: [ConfigModule],
  providers: [GrobidClient, ZoteroTranslatorClient],
  exports: [GrobidClient, ZoteroTranslatorClient],
})
export class InfraModule {}
