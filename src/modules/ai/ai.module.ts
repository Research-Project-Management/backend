import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ChatModule } from './chat/chat.module';
import { BibliographyModule } from '../library/bibliography/bibliography.module';
import { ReaderModule } from '../library/reader/reader.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScientificChunkingService } from './ingestion/services/scientific-chunking.service';
import { DocumentAiIngestionService } from './ingestion/services/document-ai-ingestion.service';
import { FileUploadedAiListener } from './ingestion/listeners/file-uploaded-ai.listener';

import { VerifiedEmailGuard } from '@/modules/identity/auth';

@Module({
  imports: [EngineModule, ChatModule, BibliographyModule, ReaderModule],
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
