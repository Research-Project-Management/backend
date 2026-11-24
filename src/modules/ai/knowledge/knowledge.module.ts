import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { shouldRunWorkerConsumers } from '@/core';
import { VerifiedEmailGuard } from '@/modules/identity/auth';
import { ExperimentsModule } from '@/modules/experiments';
import { LibraryModule } from '@/modules/library';
import { AI_KNOWLEDGE_QUEUE } from '../ai.constant';
import { AccessModule } from '../access/access.module';
import { EngineModule } from '../engine/engine.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeEventListener } from './processors/knowledge.listener';
import { KnowledgeQueueProcessor } from './processors/knowledge.processor';
import { KnowledgeQueueProducer } from './processors/knowledge.producer';
import { KnowledgeIngestService } from './services/ingest.service';
import { KnowledgeService } from './services/knowledge.service';

const workerProviders = shouldRunWorkerConsumers()
  ? [KnowledgeQueueProcessor]
  : [];

@Module({
  imports: [
    EngineModule,
    AccessModule,
    ExperimentsModule,
    LibraryModule,
    BullModule.registerQueue({
      name: AI_KNOWLEDGE_QUEUE,
    }),
  ],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeRepository,
    KnowledgeIngestService,
    KnowledgeService,
    KnowledgeQueueProducer,
    KnowledgeEventListener,
    VerifiedEmailGuard,
    ...workerProviders,
  ],
})
export class KnowledgeModule {}
