import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ChatModule } from './chat/chat.module';
import { ExtractionModule } from '../library/extraction/extraction.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScientificChunkingService } from './ingestion/services/scientific-chunking.service';
import { DocumentAiIngestionService } from './ingestion/services/document-ai-ingestion.service';
import { FileUploadedAiListener } from './ingestion/listeners/file-uploaded-ai.listener';

import { VerifiedEmailGuard } from '@/modules/identity/auth';

@Module({
  imports: [EngineModule, ChatModule, ExtractionModule],
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
    ChatModule,
    ScientificChunkingService,
    DocumentAiIngestionService,
  ],
})
export class AiModule {}
