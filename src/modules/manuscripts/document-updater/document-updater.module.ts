/**
 * document-updater/document-updater.module.ts
 * NestJS Module for Manuscripts Document Updater subsystem (Hexagonal Architecture).
 */

import { Module } from '@nestjs/common';
import { DocstoreModule } from '../docstore/docstore.module';
import { DocumentUpdaterController } from './document-updater.controller';
import { DocumentUpdaterService } from './document-updater.service';

// Use Cases
import { QueueDocUpdateUseCase } from './core/use-cases/queue-doc-update.use-case';
import { FlushProjectDocsUseCase } from './core/use-cases/flush-project-docs.use-case';
import { FlushSingleDocUseCase } from './core/use-cases/flush-single-doc.use-case';
import { GetInFlightDocUseCase } from './core/use-cases/get-in-flight-doc.use-case';
import { EvictDocBufferUseCase } from './core/use-cases/evict-doc-buffer.use-case';

// Ports
import { IInFlightStorePort } from './core/ports/in-flight-store.port';
import { IDocstoreWriterPort } from './core/ports/docstore-writer.port';
import { IUpdaterLockPort } from './core/ports/updater-lock.port';
import { IDebounceTimerPort } from './core/ports/debounce-timer.port';

// Adapters
import { RedisInFlightStoreAdapter } from './core/adapters/storage/redis-in-flight-store.adapter';
import { InMemoryInFlightStoreAdapter } from './core/adapters/storage/in-memory-in-flight-store.adapter';
import { RedisDistributedUpdaterLockAdapter } from './core/adapters/lock/redis-distributed-updater-lock.adapter';
import { LocalMutexUpdaterLockAdapter } from './core/adapters/lock/local-mutex-updater-lock.adapter';
import { NodeTimeoutDebounceAdapter } from './core/adapters/scheduler/node-timeout-debounce.adapter';
import { DocstoreBridgeAdapter } from './core/adapters/external/docstore-bridge.adapter';

@Module({
  imports: [DocstoreModule],
  controllers: [DocumentUpdaterController],
  providers: [
    DocumentUpdaterService,

    // Use cases
    QueueDocUpdateUseCase,
    FlushProjectDocsUseCase,
    FlushSingleDocUseCase,
    GetInFlightDocUseCase,
    EvictDocBufferUseCase,

    // Adapter implementations
    RedisInFlightStoreAdapter,
    InMemoryInFlightStoreAdapter,
    RedisDistributedUpdaterLockAdapter,
    LocalMutexUpdaterLockAdapter,
    NodeTimeoutDebounceAdapter,
    DocstoreBridgeAdapter,

    // Port token bindings
    {
      provide: IInFlightStorePort,
      useClass: RedisInFlightStoreAdapter,
    },
    {
      provide: IDocstoreWriterPort,
      useClass: DocstoreBridgeAdapter,
    },
    {
      provide: IUpdaterLockPort,
      useClass: RedisDistributedUpdaterLockAdapter,
    },
    {
      provide: IDebounceTimerPort,
      useClass: NodeTimeoutDebounceAdapter,
    },
  ],
  exports: [
    DocumentUpdaterService,
    QueueDocUpdateUseCase,
    FlushProjectDocsUseCase,
    FlushSingleDocUseCase,
    GetInFlightDocUseCase,
    IInFlightStorePort,
    IUpdaterLockPort,
  ],
})
export class DocumentUpdaterModule {}
