/**
 * linked-files/linked-files.module.ts
 * NestJS Module for Manuscripts Linked Files (Overleaf LinkedFiles parity).
 */

import { Module, forwardRef } from '@nestjs/common';
import { CacheModule } from '@/core/cache/cache.module';
import { StructureModule } from '../structure/structure.module';
import { DocstoreModule } from '../docstore/docstore.module';
import { FilestoreModule } from '../filestore/filestore.module';
import { CitationsModule } from '../citations/citations.module';
import { RealtimeModule } from '@/modules/realtime/realtime.module';

import { LinkedFilesController } from './linked-files.controller';
import { LinkedFilesService } from './linked-files.service';

import { CreateLinkedFileUseCase } from './core/use-cases/create-linked-file.use-case';
import { RefreshLinkedFileUseCase } from './core/use-cases/refresh-linked-file.use-case';
import { ListLinkedFilesUseCase } from './core/use-cases/list-linked-files.use-case';
import { DeleteLinkedFileUseCase } from './core/use-cases/delete-linked-file.use-case';

import { ILinkedFilesRepositoryPort } from './core/ports/linked-files-repository.port';
import { RedisLinkedFilesRepository } from './core/adapters/persistence/redis-linked-files.repository';

@Module({
  imports: [
    CacheModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    CitationsModule,
    forwardRef(() => RealtimeModule),
  ],
  controllers: [LinkedFilesController],
  providers: [
    LinkedFilesService,
    CreateLinkedFileUseCase,
    RefreshLinkedFileUseCase,
    ListLinkedFilesUseCase,
    DeleteLinkedFileUseCase,
    RedisLinkedFilesRepository,
    {
      provide: ILinkedFilesRepositoryPort,
      useClass: RedisLinkedFilesRepository,
    },
  ],
  exports: [
    LinkedFilesService,
    ILinkedFilesRepositoryPort,
    CreateLinkedFileUseCase,
    RefreshLinkedFileUseCase,
    ListLinkedFilesUseCase,
    DeleteLinkedFileUseCase,
  ],
})
export class LinkedFilesModule {}
