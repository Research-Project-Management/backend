import { Module } from '@nestjs/common';
import { EngineModule } from './engine/engine.module';
import { ThreadModule } from './thread/thread.module';
import { ItemsModule } from '../library/items/items.module';
import { AttachmentsModule } from '../library/attachments/attachments.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ScientificChunkingService } from './ingestion/services/scientific-chunking.service';
import { DocumentAiIngestionService } from './ingestion/services/document-ai-ingestion.service';
import { FileUploadedAiListener } from './ingestion/listeners/file-uploaded-ai.listener';

@Module({
  imports: [EngineModule, ThreadModule, ItemsModule, AttachmentsModule],
  controllers: [AiController],
  providers: [
    AiService,
    ScientificChunkingService,
    DocumentAiIngestionService,
    FileUploadedAiListener,
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
