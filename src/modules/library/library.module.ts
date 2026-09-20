import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../core/core.module';

// Bounded Context Modules
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { CatalogModule } from './catalog/catalog.module';
import { ContentModule } from './content/content.module';
import { ProcessingModule } from './processing/processing.module';
import { DiscoveryModule } from './discovery/discovery.module';

import { LibraryFacade, LIBRARY_FACADE } from './library.facade';

/**
 * Macro Composition Root for the Library Module.
 *
 * Clean Architecture & DDD structure:
 * Consists of exactly 4 Bounded Contexts + 1 Shared Kernel:
 * 1. CatalogModule (Core Domain — Items, Collections, Tags, Types, State, Saved Searches)
 * 2. ContentModule (Supporting Domain — Attachments, Annotations, Notes)
 * 3. ProcessingModule (Supporting Domain — Ingestion Pipeline, Metadata Resolution, Curation, Retraction)
 * 4. DiscoveryModule (Generic Domain — Search, Citation CSL, Exports)
 * 5. SharedKernelModule (Shared Infrastructure, Outbox, Integration Event Bus)
 *
 * Zero submodule clutter. Each Bounded Context is a self-contained unit.
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,

    // Bounded Contexts
    SharedKernelModule,
    CatalogModule,
    ContentModule,
    ProcessingModule,
    DiscoveryModule,
  ],
  providers: [
    LibraryFacade,
    {
      provide: LIBRARY_FACADE,
      useExisting: LibraryFacade,
    },
  ],
  exports: [
    // Public Facades
    LibraryFacade,
    LIBRARY_FACADE,

    // Bounded Context Modules
    SharedKernelModule,
    CatalogModule,
    ContentModule,
    ProcessingModule,
    DiscoveryModule,
  ],
})
export class LibraryModule {}
