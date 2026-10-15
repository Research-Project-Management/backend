/**
 * document-updater/document-updater.module.ts
 * NestJS Module for Manuscripts Document Updater subsystem.
 */

import { Module } from '@nestjs/common';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { DocumentUpdaterController } from './document-updater.controller';
import { DocumentUpdaterService } from './document-updater.service';
import { DocumentUpdaterRepository } from './document-updater.repository';

// Ports & Adapters
import { IInFlightStorePort } from './core/ports/in-flight-store.port';
import { IDocstoreWriterPort } from './core/ports/docstore-writer.port';
import { IUpdaterLockPort } from './core/ports/updater-lock.port';
import { IDebounceTimerPort } from './core/ports/debounce-timer.port';
import { InMemoryInFlightStoreAdapter } from './core/adapters/storage/in-memory-in-flight-store.adapter';
import { RedisDistributedUpdaterLockAdapter } from './core/adapters/lock/redis-distributed-updater-lock.adapter';
import { LocalMutexUpdaterLockAdapter } from './core/adapters/lock/local-mutex-updater-lock.adapter';
import { NodeTimeoutDebounceAdapter } from './core/adapters/scheduler/node-timeout-debounce.adapter';
import { DocstoreBridgeAdapter } from './core/adapters/external/docstore-bridge.adapter';

@Module({
  imports: [DocstoreModule],
  controllers: [DocumentUpdaterController],
  providers: [
    DocumentUpdaterRepository,
    DocumentUpdaterService,

    // Adapters & Ports
    InMemoryInFlightStoreAdapter,
    RedisDistributedUpdaterLockAdapter,
    LocalMutexUpdaterLockAdapter,
    NodeTimeoutDebounceAdapter,
    DocstoreBridgeAdapter,
    {
      provide: IInFlightStorePort,
      useExisting: DocumentUpdaterRepository,
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
    DocumentUpdaterRepository,
    IInFlightStorePort,
    IUpdaterLockPort,
  ],
})
export class DocumentUpdaterModule {}
