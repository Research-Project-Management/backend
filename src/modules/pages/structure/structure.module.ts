/**
 * modules/pages/structure/structure.module.ts
 * NestJS Module for Pages File Tree & Hierarchy Subsystem.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { StructureRepository } from './structure.repository';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [StructureController],
  providers: [StructureService, StructureRepository],
  exports: [StructureService, StructureRepository],
})
export class StructureModule {}
