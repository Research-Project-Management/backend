/**
 * modules/manuscripts/structure/structure.module.ts
 * NestJS Module for Manuscript Project File Tree & Hierarchy Subsystem.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { StructureRepository } from './structure.repository';
import { IStructureRepository } from './domain';

@Module({
  imports: [PrismaModule, DocstoreModule, FilestoreModule],
  controllers: [StructureController],
  providers: [
    StructureService,
    StructureRepository,
    { provide: IStructureRepository, useExisting: StructureRepository },
  ],
  exports: [StructureService, StructureRepository, IStructureRepository],
})
export class StructureModule {}
