/**
 * templates/templates.module.ts
 * Encapsulated NestJS Module for Manuscripts Templates & Gallery (zero leaked internals).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { GalleryService } from './services/gallery.service';
import { PublishService } from './services/publish.service';
import { ScaffoldService } from './services/scaffold.service';
import { TemplatesController } from './templates.controller';
import { TemplatesRepository } from './templates.repository';

@Module({
  imports: [
    PrismaModule,
    AccessModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
  ],
  controllers: [TemplatesController],
  providers: [
    TemplatesRepository,
    GalleryService,
    PublishService,
    ScaffoldService,
  ],
})
export class TemplatesModule {}
