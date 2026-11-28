/**
 * templates/templates.module.ts
 * Encapsulated NestJS Module for Pages Templates & Gallery (aligned with Flux Space & FilesModule).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/pages/docstore';
import { GalleryService } from './services/gallery.service';
import { InstantiateService } from './services/instantiate.service';
import { PublishService } from './services/publish.service';
import { TemplatesController } from './templates.controller';
import { TemplatesRepository } from './templates.repository';

@Module({
  imports: [PrismaModule, AccessModule, FilesModule, DocstoreModule],
  controllers: [TemplatesController],
  providers: [
    TemplatesRepository,
    GalleryService,
    PublishService,
    InstantiateService,
  ],
  exports: [GalleryService, PublishService, InstantiateService],
})
export class TemplatesModule {}
