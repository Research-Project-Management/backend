/**
 * linked-files/linked-files.module.ts
 * NestJS Module for Manuscripts Linked Files (Overleaf LinkedFiles parity).
 */

import { Module } from '@nestjs/common';
import { CacheModule } from '@/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { CitationsModule } from '@/modules/manuscripts/citations/citations.module';

import { LinkedFilesController } from './linked-files.controller';
import { LinkedFilesService } from './linked-files.service';
import { LinkedFilesRepository } from './linked-files.repository';

// Ports
import { ILinkedFilesRepositoryPort } from './core/ports/linked-files-repository.port';

@Module({
  imports: [
    CacheModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    CitationsModule,
  ],
  controllers: [LinkedFilesController],
  providers: [
    LinkedFilesRepository,
    {
      provide: ILinkedFilesRepositoryPort,
      useExisting: LinkedFilesRepository,
    },
    LinkedFilesService,
  ],
  exports: [
    LinkedFilesService,
    LinkedFilesRepository,
    ILinkedFilesRepositoryPort,
  ],
})
export class LinkedFilesModule {}
