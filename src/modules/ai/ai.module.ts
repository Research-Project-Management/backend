import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ThreadModule } from './thread/thread.module';
import { CatalogModule } from '../library/catalog/catalog.module';
import { ContentModule } from '../library/content/content.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScientificChunkingService } from './ingestion/services/scientific-chunking.service';
import { DocumentAiIngestionService } from './ingestion/services/document-ai-ingestion.service';
import { FileUploadedAiListener } from './ingestion/listeners/file-uploaded-ai.listener';

import { VerifiedEmailGuard } from '../iam/authn/guards/verified-email.guard';

@Module({
  imports: [EngineModule, ThreadModule, CatalogModule, ContentModule],
  controllers: [AiController],
  providers: [
    AiService,
    ScientificChunkingService,
    DocumentAiIngestionService,
    FileUploadedAiListener,
    VerifiedEmailGuard,
  ],
  exports: [
    AiService,
    EngineModule,
    ThreadModule,
    ScientificChunkingService,
    DocumentAiIngestionService,
  ],
})
export class AiModule {}
